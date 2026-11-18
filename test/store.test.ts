import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  mkdirSync as mkdirSyncImpl,
  openSync,
  readdirSync,
  readFileSync,
  renameSync as renameSyncImpl,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  BusyStoreError,
  MissingRecordError,
  openStore,
  PersistenceError,
  ValidationError,
  type Store,
} from "../src/store.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "workspace-"));
  roots.push(dir);
  return dir;
}

function fsError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`simulated ${code}`);
  error.code = code;
  return error;
}

const enoent = () => fsError("ENOENT");

interface FailOn {
  /**
   * Fail when opening the given path with the exclusive-create flag.
   * "before" fails without creating anything; "collide" leaves a foreign file
   * at the exact requested path and reports EEXIST, as a real collision would.
   */
  openSync?: (path: string) => "before" | "collide" | "after" | false;
  writeSync?: (fd: number, isTemp: boolean, path: string) => boolean;
  fsyncSync?: (fd: number, isTemp: boolean) => boolean;
  /** Fail the close, reporting EBADF as if the descriptor were already gone. */
  closeSync?: (fd: number, isTemp: boolean) => boolean;
  /** Fail the write after the exclusive create has already produced a file. */
  createThenFailWriteLock?: (path: string) => boolean;
  renameSync?: (path: string) => boolean;
  readFileSync?: (path: string) => boolean;
  unlinkSync?: (path: string) => boolean;
  mkdirSync?: (path: string) => boolean;
  fsyncDirectorySync?: (path: string) => boolean;
}

/**
 * A file-system adapter that delegates to the real module but lets a test make
 * named operations fail. It is injected through openStore's internal option.
 */
function failingFs(failOn: FailOn) {
  const descriptors = new Map<number, string>();
  /** Bytes acknowledged by earlier writes on each descriptor. */
  const written = new Map<number, number>();
  /** Paths at which a simulated collision was placed. */
  const collisions = new Set<string>();
  const pathOf = (fd: number) => descriptors.get(fd) ?? "";
  const isTemp = (fd: number) => pathOf(fd).endsWith(".tmp");
  const adapter = {
    existsSync: (path: string) => existsSync(path),
    mkdirSync: (path: string, options: { recursive: true }) => {
      if (failOn.mkdirSync?.(path)) throw fsError("EACCES");
      mkdirSyncImpl(path, options);
    },
    openSync: (path: string, flags: "wx") => {
      const mode = failOn.openSync?.(path) ?? false;
      if (mode === "before") throw fsError("EIO");
      if (mode === "collide") {
        writeFileSync(path, "not ours", "utf8");
        collisions.add(path);
        throw fsError("EEXIST");
      }
      const fd = openSync(path, flags);
      descriptors.set(fd, path);
      if (mode === "after") throw fsError("EIO");
      return fd;
    },
    writeSync: (fd: number, data: Uint8Array) => {
      if (failOn.writeSync?.(fd, isTemp(fd), pathOf(fd))) throw fsError("EIO");
      if (
        failOn.createThenFailWriteLock &&
        pathOf(fd).split(/[\\/]/).at(-1) === "workspace.lock" &&
        failOn.createThenFailWriteLock(pathOf(fd))
      ) {
        throw fsError("EIO");
      }
      // Track the descriptor's position so writes honor the store's byte offset.
      const offset = written.get(fd) ?? 0;
      const bytes = writeSync(fd, data, 0, data.length, null);
      written.set(fd, offset + bytes);
      return bytes;
    },
    fsyncSync: (fd: number) => {
      if (failOn.fsyncSync?.(fd, isTemp(fd))) throw fsError("EIO");
      fsyncSync(fd);
    },
    closeSync: (fd: number) => {
      // The descriptor is always really closed, so a simulated close failure
      // never leaves it open; the caller sees the failure all the same.
      const shouldFail = failOn.closeSync?.(fd, isTemp(fd)) ?? false;
      closeSync(fd);
      descriptors.delete(fd);
      written.delete(fd);
      if (shouldFail) throw fsError("EBADF");
    },
    renameSync: (oldPath: string, newPath: string) => {
      if (failOn.renameSync?.(oldPath)) throw fsError("EIO");
      renameSyncImpl(oldPath, newPath);
    },
    readFileSync: (path: string, encoding: "utf8") => {
      if (failOn.readFileSync?.(path)) {
        if (failOn.readFileSync === alwaysMissing) throw enoent();
        throw fsError("EIO");
      }
      return readFileSync(path, encoding);
    },
    unlinkSync: (path: string) => {
      if (failOn.unlinkSync?.(path)) throw fsError("EIO");
      rmSync(path, { force: true });
    },
    fsyncDirectorySync: (path: string) => {
      if (failOn.fsyncDirectorySync?.(path)) throw fsError("EIO");
      // Simulated directory flush: this adapter reports success unless a test
      // injects a failure, and the store treats any throw as a real failure.
    },
  };
  return Object.assign(adapter, { collisions });
}

const alwaysMissing = () => true;

function lockPath(dir: string): string {
  return join(dir, "workspace.lock");
}

function storePath(dir: string): string {
  return join(dir, "workspace.json");
}

describe("client creation and editing", () => {
  it("creates clients with defaults and edits partial fields", async () => {
    const store = await openStore(tempDir());
    try {
      const client = await store.createClient({ name: "Acme" });
      assert.equal(client.name, "Acme");
      assert.equal(client.background, "");
      assert.equal(client.contacts, "");
      assert.equal(client.stakeholders, "");
      assert.equal(client.requirements, "");
      assert.equal(client.objectives, "");
      assert.match(client.id, /^client-\d+$/);

      const edited = await store.updateClient(client.id, {
        background: "An industrial supplier.",
        contacts: "Dana <dana@example.com>",
        requirements: "Ship in 2027",
        objectives: "Cut waste",
        stakeholders: "Sam the sponsor",
      });
      assert.equal(edited.name, "Acme");
      assert.equal(edited.background, "An industrial supplier.");
      assert.equal(edited.contacts, "Dana <dana@example.com>");
      assert.equal(edited.requirements, "Ship in 2027");
      assert.equal(edited.objectives, "Cut waste");
      assert.equal(edited.stakeholders, "Sam the sponsor");

      const renamed = await store.updateClient(client.id, { name: "Acme Holdings" });
      assert.equal(renamed.name, "Acme Holdings");
      assert.equal(renamed.background, "An industrial supplier.");
      assert.equal(renamed.contacts, "Dana <dana@example.com>");

      const snapshot = store.snapshot();
      assert.equal(snapshot.clients.length, 1);
      assert.equal(snapshot.clients[0].name, "Acme Holdings");
    } finally {
      await store.close();
    }
  });

  it("keeps omitted edit fields and rejects explicitly supplied invalid values", async () => {
    const store = await openStore(tempDir());
    try {
      const client = await store.createClient({
        name: "Acme",
        background: "Existing",
        contacts: "Existing contact",
      });
      await assert.rejects(store.updateClient(client.id, { background: null as never }), ValidationError);
      await assert.rejects(store.updateClient(client.id, { name: null as never }), ValidationError);
      await assert.rejects(store.updateClient(client.id, { contacts: null as never }), ValidationError);
      await assert.rejects(store.updateClient(client.id, { name: "   " }), ValidationError);
      await assert.rejects(store.updateClient(client.id, { contacts: 42 as never }), ValidationError);
      await assert.rejects(
        store.updateClient(client.id, { objectives: ["a list is not text"] as never }),
        ValidationError,
      );
      assert.equal(store.snapshot().clients[0].background, "Existing");
      assert.equal(store.snapshot().clients[0].name, "Acme");

      // An empty edit changes nothing and still succeeds.
      const unchanged = await store.updateClient(client.id, {});
      assert.deepEqual(unchanged, client);

      const engagement = await store.createEngagement({
        clientId: client.id,
        name: "Eng",
        status: "active",
      });
      await assert.rejects(
        store.updateEngagement(engagement.id, { status: null as never }),
        ValidationError,
      );
      await assert.rejects(
        store.updateEngagement(engagement.id, { name: null as never }),
        ValidationError,
      );
      await assert.rejects(
        store.updateEngagement(engagement.id, { objectives: null as never }),
        ValidationError,
      );
      const kept = await store.updateEngagement(engagement.id, { objectives: "New goal" });
      assert.equal(kept.status, "active");
      assert.equal(kept.name, "Eng");
      assert.equal(kept.objectives, "New goal");
    } finally {
      await store.close();
    }
  });

  it("returns detached read-only snapshots", async () => {
    const store = await openStore(tempDir());
    try {
      const created = await store.createClient({ name: "Acme" });
      const snapshot = store.snapshot();
      assert.throws(() => {
        (snapshot.clients as unknown as Record<string, unknown>[]).push({
          id: "x",
          name: "y",
          background: "",
          contacts: "",
          stakeholders: "",
          requirements: "",
          objectives: "", 
        });
      });
      assert.throws(() => {
        (snapshot.clients[0] as { name: string }).name = "Mutated";
      });
      created.name = "Local change";
      assert.equal(snapshot.clients[0].name, "Acme");
      assert.equal(store.snapshot().clients[0].name, "Acme");
    } finally {
      await store.close();
    }
  });

  it("rejects blank names and invalid status values", async () => {
    const store = await openStore(tempDir());
    try {
      await assert.rejects(store.createClient({ name: "   " }), ValidationError);
      await assert.rejects(store.createClient({ name: 42 as never }), ValidationError);
      await assert.rejects(store.createClient({ background: "x" } as never), ValidationError);
      // Explicit nulls are invalid values, not omitted fields that take defaults.
      await assert.rejects(
        store.createClient({ name: "Acme", background: null as never }),
        ValidationError,
      );
      await assert.rejects(
        store.createClient({ name: "Acme", contacts: null as never }),
        ValidationError,
      );
      await assert.rejects(
        store.createClient({ name: "Acme", objectives: null as never }),
        ValidationError,
      );
      const client = await store.createClient({ name: "Acme" });
      await assert.rejects(
        store.createEngagement({ clientId: client.id, name: "Engagement", status: null as never }),
        ValidationError,
      );
      await assert.rejects(
        store.createEngagement({ clientId: client.id, name: "Engagement", objectives: null as never }),
        ValidationError,
      );
      await assert.rejects(
        store.createEngagement({
          clientId: client.id,
          name: "Engagement",
          status: "unknown" as never,
        }),
        ValidationError,
      );
      await assert.rejects(
        store.createEngagement({ clientId: client.id, name: "" }),
        ValidationError,
      );
    } finally {
      await store.close();
    }
  });
});

describe("hierarchy", () => {
  it("supports two engagements with separate projects", async () => {
    const store = await openStore(tempDir());
    try {
      const client = await store.createClient({ name: "Acme" });
      const first = await store.createEngagement({ clientId: client.id, name: "First" });
      const second = await store.createEngagement({ clientId: client.id, name: "Second" });
      assert.equal(first.status, "planned");
      assert.equal(second.status, "planned");
      assert.notEqual(first.id, second.id);

      const firstProject = await store.createProject({ engagementId: first.id, name: "A" });
      const secondProject = await store.createProject({ engagementId: second.id, name: "B" });
      assert.equal(firstProject.engagementId, first.id);
      assert.equal(secondProject.engagementId, second.id);
      assert.notEqual(firstProject.id, secondProject.id);

      const active = await store.updateEngagement(first.id, { status: "active" });
      assert.equal(active.status, "active");
      assert.equal(active.clientId, client.id);
      assert.equal(active.name, "First");

      const done = await store.updateProject(firstProject.id, { status: "completed" });
      assert.equal(done.status, "completed");
      assert.equal(done.engagementId, first.id);

      const snapshot = store.snapshot();
      assert.equal(snapshot.clients.length, 1);
      assert.equal(snapshot.engagements.length, 2);
      assert.equal(snapshot.projects.length, 2);
      assert.deepEqual(
        snapshot.projects.map((p) => p.engagementId).sort(),
        [first.id, second.id].sort(),
      );
    } finally {
      await store.close();
    }
  });

  it("rejects missing and invalid parents", async () => {
    const store = await openStore(tempDir());
    try {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Eng" });
      await assert.rejects(
        store.createEngagement({ clientId: "client-999", name: "Engagement" }),
        MissingRecordError,
      );
      await assert.rejects(
        store.createProject({ engagementId: "engagement-999", name: "Project" }),
        MissingRecordError,
      );
      // Invalid parent values are validation errors, not missing-record errors.
      await assert.rejects(
        store.createEngagement({ clientId: "", name: "Engagement" }),
        ValidationError,
      );
      await assert.rejects(
        store.createEngagement({ clientId: 42 as never, name: "Engagement" }),
        ValidationError,
      );
      await assert.rejects(
        store.createProject({ engagementId: null as never, name: "Project" }),
        ValidationError,
      );
      await assert.rejects(
        store.createProject({ engagementId: "   ", name: "Project" }),
        ValidationError,
      );
      // A client id is not a valid engagement parent.
      await assert.rejects(
        store.createProject({ engagementId: client.id, name: "Project" }),
        MissingRecordError,
      );
      // Nothing was added by the rejected creates.
      assert.equal(store.snapshot().engagements.length, 1);
      assert.equal(store.snapshot().projects.length, 0);
      assert.equal(store.snapshot().engagements[0].id, engagement.id);

      // Stored data with an invalid parent value is refused as corrupt.
      const dir = tempDir();
      const content = JSON.stringify({
        schemaVersion: 1,
        clients: [],
        engagements: [{ id: "engagement-1", clientId: "", name: "E", objectives: "", status: "planned" }],
        projects: [],
        nextIds: { engagements: 2 },
      });
      writeFileSync(storePath(dir), content, "utf8");
      await assert.rejects(openStore(dir), PersistenceError);
      assert.equal(readFileSync(storePath(dir), "utf8"), content);
    } finally {
      await store.close();
    }
  });

  it("keeps parent links immutable on edit and rejects unknown records", async () => {
    const store = await openStore(tempDir());
    try {
      const client = await store.createClient({ name: "Acme" });
      const other = await store.createClient({ name: "Other" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "First" });
      const edited = await store.updateEngagement(engagement.id, {
        clientId: other.id,
        name: "First renamed",
      } as never);
      assert.equal(edited.clientId, client.id);
      assert.equal(edited.name, "First renamed");

      const project = await store.createProject({ engagementId: engagement.id, name: "A" });
      const editedProject = await store.updateProject(project.id, {
        engagementId: "engagement-bogus",
        name: "A renamed",
      } as never);
      assert.equal(editedProject.engagementId, engagement.id);
      assert.equal(editedProject.name, "A renamed");

      // The client edit cannot change its generated id either.
      const editedClient = await store.updateClient(client.id, { id: "client-999" } as never);
      assert.equal(editedClient.id, client.id);

      await assert.rejects(
        store.updateClient("client-missing", { name: "x" }),
        MissingRecordError,
      );
      await assert.rejects(
        store.updateEngagement("engagement-missing", { name: "x" }),
        MissingRecordError,
      );
      await assert.rejects(
        store.updateProject("project-missing", { name: "x" }),
        MissingRecordError,
      );
    } finally {
      await store.close();
    }
  });

  it("serializes concurrent mutations and generates stable IDs", async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    let ids: string[] = [];
    try {
      const client = await store.createClient({ name: "Acme" });
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          store.createEngagement({ clientId: client.id, name: `E${i}` }),
        ),
      );
      ids = results.map((r) => r.id);
      assert.equal(new Set(ids).size, 10);
      assert.equal(store.snapshot().engagements.length, 10);
    } finally {
      await store.close();
    }

    const reopened = await openStore(dir);
    try {
      const snapshot = reopened.snapshot();
      assert.deepEqual(
        snapshot.engagements.map((e) => e.id).sort(),
        [...ids].sort(),
      );
      const next = await reopened.createEngagement({
        clientId: snapshot.clients[0].id,
        name: "After restart",
      });
      assert.ok(!ids.includes(next.id));
    } finally {
      await reopened.close();
    }
  });
});

describe("persistence", () => {
  it("persists full fields and hierarchy across restart", async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    let clientId: string;
    let engagementId: string;
    let projectId: string;
    try {
      const client = await store.createClient({
        name: "Acme",
        background: "Full background text",
        contacts: "Dana <d@example.com> and a second contact",
        stakeholders: "Sam the sponsor",
        requirements: "Req 1, Req 2",
        objectives: "Goal one",
      });
      clientId = client.id;
      const engagement = await store.createEngagement({
        clientId,
        name: "Eng",
        objectives: "Engagement goal",
        status: "on_hold",
      });
      engagementId = engagement.id;
      const project = await store.createProject({
        engagementId: engagement.id,
        name: "Proj",
        objectives: "Project goal, second project goal",
        status: "active",
      });
      projectId = project.id;
    } finally {
      await store.close();
    }
    // Lock is released on close, so a new writer may open the directory.
    assert.equal(existsSync(lockPath(dir)), false);

    const reopened = await openStore(dir);
    try {
      const snapshot = reopened.snapshot();
      assert.deepEqual(snapshot.clients, [
        {
          id: clientId,
          name: "Acme",
          background: "Full background text",
          contacts: "Dana <d@example.com> and a second contact",
          stakeholders: "Sam the sponsor",
          requirements: "Req 1, Req 2",
          objectives: "Goal one",
        },
      ]);
      assert.deepEqual(snapshot.engagements, [
        {
          id: engagementId,
          clientId,
          name: "Eng",
          objectives: "Engagement goal",
          status: "on_hold",
        },
      ]);
      assert.deepEqual(snapshot.projects, [
        {
          id: projectId,
          engagementId,
          name: "Proj",
          objectives: "Project goal, second project goal",
          status: "active",
        },
      ]);
    } finally {
      await reopened.close();
    }

    // Editing persists every field as well.
    const third = await openStore(dir);
    try {
      await third.updateClient(clientId, {
        background: "Changed background",
        contacts: "New contact",
        objectives: "Changed objective",
      });
    } finally {
      await third.close();
    }
    const fourth = await openStore(dir);
    try {
      assert.deepEqual(fourth.snapshot().clients[0], {
        id: clientId,
        name: "Acme",
        background: "Changed background",
        contacts: "New contact",
        stakeholders: "Sam the sponsor",
        requirements: "Req 1, Req 2",
        objectives: "Changed objective",
      });
    } finally {
      await fourth.close();
    }
  });

  it("refuses corrupt stored data without overwriting it", async () => {
    const dir = tempDir();
    writeFileSync(storePath(dir), "{ not json", "utf8");
    await assert.rejects(openStore(dir), PersistenceError);
    assert.equal(readFileSync(storePath(dir), "utf8"), "{ not json");
    // Ownership was released after failed initialization.
    assert.equal(existsSync(lockPath(dir)), false);

    writeFileSync(
      storePath(dir),
      JSON.stringify({
        schemaVersion: 1,
        clients: [{ id: "client-1", name: "", background: "", contacts: "", stakeholders: "", requirements: "", objectives: "" }],
        engagements: [],
        projects: [],
        nextIds: { clients: 2 },
      }),
      "utf8",
    );
    const before = readFileSync(storePath(dir), "utf8");
    await assert.rejects(openStore(dir), PersistenceError);
    assert.equal(readFileSync(storePath(dir), "utf8"), before);
    assert.equal(existsSync(lockPath(dir)), false);
  });

  it("refuses unsupported schema versions without overwriting them", async () => {
    const dir = tempDir();
    const content = JSON.stringify({ schemaVersion: 2, clients: [], engagements: [], projects: [], nextIds: {} });
    writeFileSync(storePath(dir), content, "utf8");
    await assert.rejects(openStore(dir), (error: unknown) => {
      assert.ok(error instanceof PersistenceError);
      assert.match(error.message, /schema version/i);
      return true;
    });
    assert.equal(readFileSync(storePath(dir), "utf8"), content);
    assert.equal(existsSync(lockPath(dir)), false);
  });

  it("refuses unexpected stored fields and collections without overwriting them", async () => {
    const dir = tempDir();
    const valid = {
      schemaVersion: 1,
      clients: [],
      engagements: [],
      projects: [],
      nextIds: {},
    };
    const cases: unknown[] = [
      { ...valid, notes: [{ text: "unexpected" }] },
      { ...valid, clients: [{ id: "client-1", name: "A", background: "", contacts: "", stakeholders: "", requirements: "", objectives: "", extra: true }], nextIds: { clients: 2 } },
      { ...valid, nextIds: { tasks: 1 } },
      { ...valid, nextIds: { client: 2 } },
    ];
    for (const value of cases) {
      const content = JSON.stringify(value);
      writeFileSync(storePath(dir), content, "utf8");
      await assert.rejects(openStore(dir), PersistenceError);
      assert.equal(readFileSync(storePath(dir), "utf8"), content);
      assert.equal(existsSync(lockPath(dir)), false);
    }
  });

  it("refuses stored data with a dangling parent link", async () => {
    const dir = tempDir();
    const content = JSON.stringify({
      schemaVersion: 1,
      clients: [],
      engagements: [{ id: "engagement-1", clientId: "client-9", name: "E", objectives: "", status: "planned" }],
      projects: [],
      nextIds: { engagements: 2 },
    });
    writeFileSync(storePath(dir), content, "utf8");
    await assert.rejects(openStore(dir), PersistenceError);
    assert.equal(readFileSync(storePath(dir), "utf8"), content);

    const projectContent = JSON.stringify({
      schemaVersion: 1,
      clients: [],
      engagements: [],
      projects: [{ id: "project-1", engagementId: "engagement-9", name: "P", objectives: "", status: "planned" }],
      nextIds: { projects: 2 },
    });
    writeFileSync(storePath(dir), projectContent, "utf8");
    await assert.rejects(openStore(dir), PersistenceError);
    assert.equal(readFileSync(storePath(dir), "utf8"), projectContent);
  });

  it("refuses duplicate ids and counters that cannot advance", async () => {
    const dir = tempDir();
    const client = { id: "client-1", name: "A", background: "", contacts: "", stakeholders: "", requirements: "", objectives: "" };
    const cases: unknown[] = [
      { schemaVersion: 1, clients: [client, { ...client, name: "B" }], engagements: [], projects: [], nextIds: { clients: 2 } },
      { schemaVersion: 1, clients: [client], engagements: [], projects: [], nextIds: {} },
      { schemaVersion: 1, clients: [client], engagements: [], projects: [], nextIds: { clients: 1 } },
      { schemaVersion: 1, clients: [client], engagements: [], projects: [], nextIds: { clients: 0 } },
      { schemaVersion: 1, clients: [], engagements: [], projects: [], nextIds: { clients: 1.5 } },
      { schemaVersion: 1, clients: [{ ...client, id: "client-0001" }], engagements: [], projects: [], nextIds: { clients: 2 } },
      { schemaVersion: 1, clients: [{ ...client, id: "bogus" }], engagements: [], projects: [], nextIds: { clients: 2 } },
      // A counter at the safe-integer ceiling cannot advance without overflow.
      { schemaVersion: 1, clients: [], engagements: [], projects: [], nextIds: { clients: Number.MAX_SAFE_INTEGER } },
      { schemaVersion: 1, clients: [client], engagements: [], projects: [], nextIds: { clients: 2 } },
    ];
    for (const value of cases.slice(0, -1)) {
      const content = JSON.stringify(value);
      writeFileSync(storePath(dir), content, "utf8");
      await assert.rejects(openStore(dir), PersistenceError);
      assert.equal(readFileSync(storePath(dir), "utf8"), content);
      assert.equal(existsSync(lockPath(dir)), false);
    }
    // A consistent snapshot with a counter above the used id is accepted.
    const content = JSON.stringify(cases.at(-1));
    writeFileSync(storePath(dir), content, "utf8");
    const store = await openStore(dir);
    try {
      const created = await store.createClient({ name: "B" });
      assert.equal(created.id, "client-2");
    } finally {
      await store.close();
    }
  });

  it("refuses to allocate an id whose counter cannot advance safely", async () => {
    const dir = tempDir();
    const content = JSON.stringify({
      schemaVersion: 1,
      clients: [],
      engagements: [],
      projects: [],
      nextIds: { clients: Number.MAX_SAFE_INTEGER },
    });
    writeFileSync(storePath(dir), content, "utf8");
    await assert.rejects(openStore(dir), PersistenceError);
    assert.equal(readFileSync(storePath(dir), "utf8"), content);
    assert.equal(existsSync(lockPath(dir)), false);
  });

  it("persists a counter the loader accepts after allocating at the boundary", async () => {
    const dir = tempDir();
    const content = JSON.stringify({
      schemaVersion: 1,
      clients: [],
      engagements: [],
      projects: [],
      nextIds: { clients: Number.MAX_SAFE_INTEGER - 1 },
    });
    writeFileSync(storePath(dir), content, "utf8");
    const store = await openStore(dir);
    let createdId: string;
    try {
      // The highest allocatable id is one below the ceiling.
      const created = await store.createClient({ name: "Last" });
      createdId = created.id;
      assert.equal(created.id, `client-${Number.MAX_SAFE_INTEGER - 1}`);
    } finally {
      await store.close();
    }
    // The save succeeded, so the loader must accept what was persisted.
    const reopened = await openStore(dir);
    try {
      assert.equal(reopened.snapshot().clients[0].id, createdId);
      // No further client can be allocated without producing a duplicate id.
      await assert.rejects(reopened.createClient({ name: "Overflow" }), PersistenceError);
      assert.equal(reopened.snapshot().clients.length, 1);
    } finally {
      await reopened.close();
    }
    // The refused allocation did not corrupt the persisted document.
    const again = await openStore(dir);
    try {
      assert.equal(again.snapshot().clients[0].id, createdId);
    } finally {
      await again.close();
    }
  });

  it("refuses a second writer and permits reopening after close", async () => {
    const dir = tempDir();
    const first = await openStore(dir);
    try {
      await assert.rejects(openStore(dir), BusyStoreError);
      // The losing opener must not remove the owner's lock.
      assert.equal(existsSync(lockPath(dir)), true);
    } finally {
      await first.close();
    }
    const second = await openStore(dir);
    await second.close();
    assert.equal(existsSync(lockPath(dir)), false);
  });
});

describe("failures", () => {
  it("retains the previous committed state when a save fails", async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    let clientId: string;
    let committed: string;
    try {
      const client = await store.createClient({ name: "Acme" });
      clientId = client.id;
      await store.close();
    } finally {
      await store.close();
    }
    committed = readFileSync(storePath(dir), "utf8");

    let failWrites = false;
    const failing = failingFs({ writeSync: () => failWrites });
    const reopened = await openStore(dir, { fs: failing });
    try {
      assert.equal(reopened.snapshot().clients.length, 1);
      await reopened.updateClient(clientId, { name: "Changed" });
      const afterUpdate = readFileSync(storePath(dir), "utf8");
      assert.notEqual(afterUpdate, committed);
      failWrites = true;
      await assert.rejects(reopened.createClient({ name: "New" }), PersistenceError);
      const snapshot = reopened.snapshot();
      assert.equal(snapshot.clients.length, 1);
      assert.equal(snapshot.clients[0].name, "Changed");
      await assert.rejects(reopened.updateClient(clientId, { name: "Renamed" }), PersistenceError);
      // The in-memory state and the on-disk file both still hold the last success.
      assert.equal(reopened.snapshot().clients[0].name, "Changed");
      assert.equal(readFileSync(storePath(dir), "utf8"), afterUpdate);
      const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
      assert.deepEqual(leftovers, []);
    } finally {
      await reopened.close();
    }

    // After the failure, further saves still build on the committed state.
    const recovered = await openStore(dir);
    try {
      assert.equal(recovered.snapshot().clients.length, 1);
      assert.equal(recovered.snapshot().clients[0].name, "Changed");
      const extra = await recovered.createClient({ name: "Later" });
      assert.notEqual(extra.id, clientId);
    } finally {
      await recovered.close();
    }
  });

  it("retains the previous committed state when rename fails", async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    let clientId: string;
    try {
      clientId = (await store.createClient({ name: "Acme" })).id;
    } finally {
      await store.close();
    }
    const committed = readFileSync(storePath(dir), "utf8");

    let failRename = true;
    const renameFailing = failingFs({ renameSync: () => failRename });
    const first = await openStore(dir, { fs: renameFailing });
    try {
      await assert.rejects(first.updateClient(clientId, { name: "Renamed" }), PersistenceError);
      assert.equal(first.snapshot().clients[0].name, "Acme");
      assert.equal(readFileSync(storePath(dir), "utf8"), committed);
      assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
    } finally {
      failRename = false;
      await renameFailing.unlinkSync(lockPath(dir));
      await openStore(dir).then((s) => s.close());
    }

    // A directory flush failure is reported after the rename has already
    // replaced the store file. The rejected mutation is not published, and the
    // store writes the previously committed state back, so both the snapshot
    // and the file keep the last acknowledged value; a later write builds on it.
    let failFlush = true;
    const flushFailing = failingFs({ fsyncDirectorySync: () => failFlush });
    const second = await openStore(dir, { fs: flushFailing });
    try {
      const before = second.snapshot().clients[0].name;
      await assert.rejects(second.updateClient(clientId, { name: "Flushed" }), PersistenceError);
      assert.equal(second.snapshot().clients[0].name, before);
      assert.equal(readFileSync(storePath(dir), "utf8").includes("Flushed"), false);
      assert.equal(readFileSync(storePath(dir), "utf8").includes(before), true);
      failFlush = false;
      const persisted = await second.updateClient(clientId, { name: "AfterFlush" });
      assert.equal(persisted.name, "AfterFlush");
      assert.equal(second.snapshot().clients[0].name, "AfterFlush");
    } finally {
      await flushFailing.unlinkSync(lockPath(dir));
      await openStore(dir).then(async (s) => {
        assert.equal(s.snapshot().clients[0].name, "AfterFlush");
        await s.close();
      });
    }
  });

  it("removes the temporary file when writing or closing it fails", async () => {
    const dir = tempDir();
    let failWrite = true;
    let failClose = false;
    const failing = failingFs({
      writeSync: (_fd, temp) => failWrite && temp,
      closeSync: (_fd, temp) => failClose && temp,
    });
    const store = await openStore(dir, { fs: failing });
    try {
      await assert.rejects(store.createClient({ name: "Acme" }), PersistenceError);
      assert.equal(store.snapshot().clients.length, 0);
      assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);

      failWrite = false;
      failClose = true;
      await assert.rejects(store.createClient({ name: "Acme" }), PersistenceError);
      assert.equal(store.snapshot().clients.length, 0);
      assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
      // The failed save never replaced the store file, so nothing was persisted
      // for the rejected create before the following successful save runs.
      assert.equal(existsSync(storePath(dir)), false);

      // The failed close is retried during cleanup, so a later save succeeds.
      failClose = false;
      const created = await store.createClient({ name: "Acme" });
      assert.equal(created.name, "Acme");
      assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
    } finally {
      await store.close();
    }
    // The save that followed the failed close was persisted.
    const reopened = await openStore(dir);
    try {
      assert.equal(reopened.snapshot().clients.length, 1);
      assert.equal(reopened.snapshot().clients[0].name, "Acme");
    } finally {
      await reopened.close();
    }
  });

  it("reports a cleanup failure when the temporary file cannot be removed", async () => {
    const dir = tempDir();
    const failing = failingFs({
      renameSync: () => true,
      unlinkSync: (path) => path.endsWith(".tmp"),
    });
    const store = await openStore(dir, { fs: failing });
    try {
      await assert.rejects(store.createClient({ name: "Acme" }), (error: unknown) => {
        assert.ok(error instanceof PersistenceError);
        assert.match(error.message, /temporary file/i);
        return true;
      });
      assert.equal(store.snapshot().clients.length, 0);
    } finally {
      await failing.unlinkSync(lockPath(dir));
      await openStore(dir).then((s) => s.close());
    }
  });

  it("removes the lock when creating the lock succeeds but writing it fails", async () => {
    const dir = tempDir();
    let failedOnce = false;
    const failing = failingFs({
      createThenFailWriteLock: (path) => {
        if (!failedOnce && path.endsWith("workspace.lock")) {
          failedOnce = true;
          return true;
        }
        return false;
      },
    });
    await assert.rejects(openStore(dir, { fs: failing }), PersistenceError);
    assert.equal(failedOnce, true);
    // The half-written lock was removed before failing.
    assert.equal(existsSync(lockPath(dir)), false);
    const store = await openStore(dir);
    await store.close();
  });

  it("reports a lock-write cleanup failure instead of hiding it", async () => {
    const dir = tempDir();
    const failing = failingFs({
      createThenFailWriteLock: (path) => path.endsWith("workspace.lock"),
      unlinkSync: (path) => path.endsWith("workspace.lock"),
    });
    await assert.rejects(openStore(dir, { fs: failing }), (error: unknown) => {
      assert.ok(error instanceof PersistenceError);
      assert.match(error.message, /partial lock/i);
      return true;
    });
  });

  it("does not remove another writer's lock when its own lock open fails", async () => {
    const dir = tempDir();
    // Another writer owns the directory and its lock file is present.
    const owner = await openStore(dir);
    const ownerLock = readFileSync(lockPath(dir), "utf8");
    try {
      // This opener fails before acquisition (as EMFILE could), so it never
      // owns the lock and must leave the existing one untouched.
      const failing = failingFs({
        openSync: (path) => (path.endsWith("workspace.lock") ? "before" : false),
      });
      await assert.rejects(openStore(dir, { fs: failing }), PersistenceError);
      assert.equal(readFileSync(lockPath(dir), "utf8"), ownerLock);
      // The owner is still the sole writer.
      await assert.rejects(openStore(dir), BusyStoreError);
    } finally {
      await owner.close();
    }
  });

  it("reports an initial temporary-file close failure instead of acknowledging a save", async () => {
    const dir = tempDir();
    let failInitialClose = true;
    // The adapter really closes the descriptor but reports EBADF, as if the
    // descriptor were already gone. On the successful persistence path this is
    // a genuine failure that must be reported, not treated as released.
    const failing = failingFs({
      closeSync: (_fd, temp) => failInitialClose && temp,
    });
    const store = await openStore(dir, { fs: failing });
    try {
      await assert.rejects(store.createClient({ name: "Acme" }), PersistenceError);
      assert.equal(store.snapshot().clients.length, 0);
      assert.equal(existsSync(storePath(dir)), false);
      assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
      failInitialClose = false;
      const created = await store.createClient({ name: "Acme" });
      assert.equal(created.name, "Acme");
    } finally {
      await store.close();
    }
    const reopened = await openStore(dir);
    try {
      assert.equal(reopened.snapshot().clients.length, 1);
    } finally {
      await reopened.close();
    }
  });

  it("fails initialization when closing the acquired lock descriptor fails", async () => {
    const dir = tempDir();
    // Closing the lock descriptor on the successful acquisition path reports
    // EBADF; initialization must fail and release the lock rather than treating
    // the descriptor as already closed.
    const failing = failingFs({
      closeSync: (_fd, temp) => !temp,
    });
    await assert.rejects(openStore(dir, { fs: failing }), PersistenceError);
    assert.equal(existsSync(lockPath(dir)), false);
    const store = await openStore(dir);
    await store.close();
  });

  it("reports a lock release failure on close and allows retrying close", async () => {
    const dir = tempDir();
    let failUnlink = true;
    const failing = failingFs({
      unlinkSync: (path) => failUnlink && path.endsWith("workspace.lock"),
    });
    const store = await openStore(dir, { fs: failing });
    try {
      await assert.rejects(store.close(), PersistenceError);
      failUnlink = false;
      await store.close();
      await store.close();
    } finally {
      failUnlink = false;
      if (existsSync(lockPath(dir))) await failing.unlinkSync(lockPath(dir));
    }
    assert.equal(existsSync(lockPath(dir)), false);
    const reopened = await openStore(dir);
    await reopened.close();
  });

  it("reports a lock read failure on close and allows retrying close", async () => {
    const dir = tempDir();
    let failRead = true;
    const failing = failingFs({
      readFileSync: (path) => failRead && path.endsWith("workspace.lock"),
    });
    const store = await openStore(dir, { fs: failing });
    try {
      await assert.rejects(store.close(), PersistenceError);
      failRead = false;
      await store.close();
    } finally {
      failRead = false;
      if (existsSync(lockPath(dir))) await failing.unlinkSync(lockPath(dir));
    }
    assert.equal(existsSync(lockPath(dir)), false);
    const reopened = await openStore(dir);
    await reopened.close();
  });

  it("treats a missing lock on close as success", async () => {
    const dir = tempDir();
    const failing = failingFs({ readFileSync: alwaysMissing });
    const store = await openStore(dir, { fs: failing });
    await store.close();
    await store.close();
  });

  it("rejects operations after close", async () => {
    const store = await openStore(tempDir());
    await store.close();
    await assert.rejects(store.createClient({ name: "Late" }), PersistenceError);
  });

  it("reports a directory-creation failure as a persistence error", async () => {
    const dir = join(tempDir(), "nested");
    const failing = failingFs({ mkdirSync: (path) => path === dir });
    await assert.rejects(openStore(dir, { fs: failing }), PersistenceError);
    assert.equal(existsSync(dir), false);
  });

  it("fails initialization when the stored data cannot be read", async () => {
    const dir = tempDir();
    const failing = failingFs({
      readFileSync: (path) => path.endsWith("workspace.json"),
    });
    writeFileSync(storePath(dir), JSON.stringify({
      schemaVersion: 1,
      clients: [],
      engagements: [],
      projects: [],
      nextIds: {},
    }), "utf8");
    await assert.rejects(openStore(dir, { fs: failing }), PersistenceError);
    assert.equal(existsSync(lockPath(dir)), false);
    const reopened = await openStore(dir);
    await reopened.close();
  });

  it("completes short writes before replacing the store file", async () => {
    const dir = tempDir();
    let truncateWrites = true;
    // A real adapter that only ever accepts part of each write.
    const shortWriting = {
      ...failingFs({}),
      writeSync: (fd: number, data: Uint8Array) => {
        const slice = truncateWrites ? data.subarray(0, Math.max(1, Math.floor(data.length / 2))) : data;
        return writeSync(fd, slice);
      },
    };
    const store = await openStore(dir, { fs: shortWriting });
    let clientId: string;
    try {
      clientId = (await store.createClient({
        name: "Acme",
        background: "A long background so the document spans several short writes.",
        contacts: Array.from({ length: 20 }, (_, i) => `Contact ${i} with a reasonably long line`).join("; "),
      })).id;
    } finally {
      await store.close();
    }
    const onDisk = JSON.parse(readFileSync(storePath(dir), "utf8"));
    assert.equal(onDisk.clients[0].id, clientId);
    assert.equal(onDisk.clients[0].contacts.split("; ").length, 20);

    truncateWrites = false;
    const reopened = await openStore(dir);
    try {
      assert.equal(reopened.snapshot().clients[0].background.length > 20, true);
      assert.equal(reopened.snapshot().clients[0].contacts.split("; ").length, 20);
    } finally {
      await reopened.close();
    }
  });

  it("leaves a colliding temporary file alone when exclusive creation fails", async () => {
    const dir = tempDir();
    // A foreign file exists at the exact path the store tries to open, so the
    // adapter reports EEXIST there. The store must not remove that file.
    let collideOnce = true;
    const colliding = failingFs({
      openSync: (path) => {
        if (collideOnce && path.endsWith(".tmp")) {
          collideOnce = false;
          return "collide";
        }
        return false;
      },
    });
    const store = await openStore(dir, { fs: colliding });
    try {
      await assert.rejects(store.createClient({ name: "Acme" }), PersistenceError);
      assert.equal(store.snapshot().clients.length, 0);
      // The injected collision happened at the store's attempted temp path.
      assert.equal(colliding.collisions.size, 1);
      const attempted = [...colliding.collisions][0];
      assert.ok(attempted.startsWith(storePath(dir)) && attempted.endsWith(".tmp"));
      // That exact file is untouched, and no other temporary file was created.
      assert.equal(readFileSync(attempted, "utf8"), "not ours");
      assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), [attempted.split(/[\\/]/).at(-1)]);
      // A later save succeeds and replaces the store file.
      const created = await store.createClient({ name: "Second" });
      assert.equal(created.name, "Second");
    } finally {
      await store.close();
    }
  });

  it("reports a lock cleanup failure when initialization fails later", async () => {
    const dir = tempDir();
    writeFileSync(storePath(dir), "{ not json", "utf8");
    const failing = failingFs({
      unlinkSync: (path) => path.endsWith("workspace.lock"),
    });
    await assert.rejects(openStore(dir, { fs: failing }), (error: unknown) => {
      assert.ok(error instanceof PersistenceError);
      assert.match(error.message, /lock could not be released/i);
      return true;
    });
    assert.equal(existsSync(lockPath(dir)), true);
    rmSync(lockPath(dir), { force: true });
  });
});
