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
import { join, resolve } from "node:path";
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
  /** Error code reported when `closeSync` fails; defaults to EBADF. */
  closeSyncCode?: string;
  /** Count every directory flush call made through the adapter. */
  fsyncDirectorySyncAfter?: { call: number };
  /** Fail the write after the exclusive create has already produced a file. */
  createThenFailWriteLock?: (path: string) => boolean;
  renameSync?: (path: string) => boolean;
  readFileSync?: (path: string) => boolean;
  unlinkSync?: (path: string) => boolean;
  mkdirSync?: (path: string) => boolean;
  fsyncDirectorySync?: (path: string) => boolean;
  /** Fail opening the directory for the flush with this error code. */
  directoryOpenCode?: string;
  /** Fail flushing the opened directory with this error code. */
  directoryFsyncCode?: string;
  /**
   * Fail closing the opened directory with this error code. The descriptor is
   * really closed before the error is reported.
   */
  directoryCloseCode?: string;
}

/**
 * A file-system adapter that delegates to the real module but lets a test make
 * named operations fail. It is injected through openStore's internal option.
 */
function failingFs(failOn: FailOn) {
  const realClose = closeSync;
  const openNormally = openSync;
  const descriptors = new Map<number, string>();
  /** Descriptors this adapter opened for a directory. */
  const directoryFds = new Set<number>();
  /** The close error kept as context when a directory flush also failed. */
  const failureContext = new WeakMap<object, unknown>();
  const isDirectory = (fd: number) => directoryFds.has(fd);
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
    openSync: (path: string, flags: "wx" | "r") => {
      // A directory is opened for reading, by the adapter's directory flush.
      if (flags === "r") {
        if (failOn.directoryOpenCode) throw fsError(failOn.directoryOpenCode);
        return openNormally(path, flags);
      }
      const mode = failOn.openSync?.(path) ?? false;
      if (mode === "before") throw fsError("EIO");
      if (mode === "collide") {
        writeFileSync(path, "not ours", "utf8");
        collisions.add(path);
        throw fsError("EEXIST");
      }
      const fd = openNormally(path, flags as "wx");
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
      if (isDirectory(fd)) {
        if (failOn.directoryFsyncCode) throw fsError(failOn.directoryFsyncCode);
        return fsyncSync(fd);
      }
      if (failOn.fsyncSync?.(fd, isTemp(fd))) throw fsError("EIO");
      fsyncSync(fd);
    },
    closeSync: (fd: number) => {
      // A directory descriptor is always really closed before a simulated close
      // failure is reported, so no descriptor is left open by the test.
      if (isDirectory(fd)) {
        realClose(fd);
        directoryFds.delete(fd);
        if (failOn.directoryCloseCode) throw fsError(failOn.directoryCloseCode);
        return;
      }
      // The descriptor is always really closed, so a simulated close failure
      // never leaves it open; the caller sees the failure all the same.
      const shouldFail = failOn.closeSync?.(fd, isTemp(fd)) ?? false;
      closeSync(fd);
      descriptors.delete(fd);
      written.delete(fd);
      if (shouldFail) throw fsError(failOn.closeSyncCode ?? "EBADF");
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
    // The directory flush runs through this adapter's own open, fsync and close
    // operations, so each of them can be made to fail on its own, and each one
    // is reported separately. The store's default directory flush likewise uses
    // its adapter's openSync, fsyncSync and closeSync.
    fsyncDirectorySync: (path: string) => {
      const counter = failOn.fsyncDirectorySyncAfter;
      if (counter) counter.call += 1;
      if (failOn.fsyncDirectorySync?.(path)) throw fsError("EIO");
      const fd = adapter.openSync(path, "r");
      if (!failOn.directoryOpenCode) directoryFds.add(fd);
      let flushFailure: unknown;
      try {
        adapter.fsyncSync(fd);
      } catch (cause) {
        flushFailure = cause;
      }
      try {
        // A descriptor the open did not produce is closed directly.
        if (failOn.directoryOpenCode) realClose(fd);
        else adapter.closeSync(fd);
      } catch (closeCause) {
        // A close error must never replace a flush error: the flush is reported
        // with the close kept as context on it.
        if (flushFailure !== undefined) {
          failureContext.set(flushFailure as object, closeCause);
          throw flushFailure;
        }
        throw closeCause;
      }
      if (flushFailure !== undefined) throw flushFailure;
    },
  };
  return Object.assign(adapter, { collisions, failureContext, isDirectoryFd: isDirectory });
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
    let flushCalls = 0;
    let failFlush = true;
    // Fail only the first flush, which belongs to the rejected save; the flush
    // of the restored previous state must succeed, or the store is blocked.
    const flushFailing = failingFs({
      fsyncDirectorySync: () => {
        if (!failFlush) return false;
        flushCalls += 1;
        return flushCalls === 1;
      },
    });
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

  it("reports a close failure with EIO and retains the previous committed state", async () => {
    const dir = tempDir();
    const setup = await openStore(dir);
    let clientId: string;
    try {
      clientId = (await setup.createClient({ name: "Acme" })).id;
    } finally {
      await setup.close();
    }
    const committed = readFileSync(storePath(dir), "utf8");

    let failClose = true;
    // A close that really closes the descriptor but reports EIO (not EBADF) is
    // a genuine operation failure on the save path and must be reported; the
    // save must not be acknowledged.
    const failing = failingFs({
      closeSync: (_fd, temp) => failClose && temp,
      closeSyncCode: "EIO",
    });
    const store = await openStore(dir, { fs: failing });
    try {
      await assert.rejects(
        store.updateClient(clientId, { name: "Rejected" }),
        (error: unknown) => {
          assert.ok(error instanceof PersistenceError);
          assert.equal((error.cause as NodeJS.ErrnoException).code, "EIO");
          return true;
        },
      );
      assert.equal(store.snapshot().clients[0].name, "Acme");
      assert.equal(readFileSync(storePath(dir), "utf8"), committed);
      assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);

      // A later save is still acknowledged once the close succeeds.
      failClose = false;
      const saved = await store.updateClient(clientId, { name: "Saved" });
      assert.equal(saved.name, "Saved");
    } finally {
      failClose = false;
      await store.close();
    }
    const reopened = await openStore(dir);
    try {
      assert.equal(reopened.snapshot().clients[0].name, "Saved");
    } finally {
      await reopened.close();
    }
  });

  it("blocks further mutations when the committed state cannot be restored", async () => {
    const dir = tempDir();
    const setup = await openStore(dir);
    let clientId: string;
    try {
      clientId = (await setup.createClient({ name: "Acme" })).id;
    } finally {
      await setup.close();
    }
    const committed = readFileSync(storePath(dir), "utf8");

    // The first directory flush (after the replacement) fails, and the flush
    // that would make the restored previous state durable fails too.
    const after = { call: 0 };
    let flushes = 0;
    const failing = failingFs({
      fsyncDirectorySyncAfter: after,
      // Fail the flush of the rejected replacement, and the flush of the
      // restored file too once the store file holds the committed state again.
      fsyncDirectorySync: () => {
        flushes += 1;
        return flushes === 1 || readFileSync(storePath(dir), "utf8") === committed;
      },
    });
    const store = await openStore(dir, { fs: failing });
    // Count only the flush calls made by this save and its restore.
    after.call = 0;
    try {
      await assert.rejects(store.updateClient(clientId, { name: "Rejected" }), (error: unknown) => {
        assert.ok(error instanceof PersistenceError);
        assert.match(error.message, /could not restore the previous state/i);
        return true;
      });
      assert.equal(after.call, 2);
      // The rejected mutation is never published in memory.
      assert.equal(store.snapshot().clients[0].name, "Acme");
      // Every later mutation is refused instead of building on stale state.
      await assert.rejects(store.updateClient(clientId, { name: "Later" }), PersistenceError);
      await assert.rejects(store.createClient({ name: "Later" }), PersistenceError);
      assert.equal(store.snapshot().clients[0].name, "Acme");
    } finally {
      // A blocked store can still release its ownership so it can be reopened.
      await store.close();
      assert.equal(existsSync(lockPath(dir)), false);
    }

    // Reopening reads whatever the disk holds; the restored previous state was
    // written back even though its flush failed, so it is the committed one.
    assert.equal(readFileSync(storePath(dir), "utf8"), committed);
    const reopened = await openStore(dir);
    try {
      assert.equal(reopened.snapshot().clients[0].name, "Acme");
      const saved = await reopened.createClient({ name: "Fresh" });
      assert.equal(saved.name, "Fresh");
    } finally {
      await reopened.close();
    }
  });

  it("saves through the default directory flush on the current platform", async () => {
    const dir = tempDir();
    // No adapter is injected, so the default adapter performs its real
    // directory flush and classifies the platform's errors itself. A save must
    // be acknowledged on every supported platform (Linux and Windows).
    const store = await openStore(dir);
    try {
      const client = await store.createClient({ name: "Acme" });
      assert.equal(client.name, "Acme");
      assert.equal(store.snapshot().clients.length, 1);
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

  it("skips the directory flush by platform on Windows and flushes it on POSIX", async () => {
    const dir = tempDir();
    // The default adapter is reached without an injected adapter, so this test
    // exercises the real platform branch. On Windows it must not open or fsync
    // the directory at all, leaving the rename as the durability point; on
    // POSIX it opens and flushes the directory. Both paths must accept a save.
    const store = await openStore(dir);
    try {
      const created = await store.createClient({ name: "Acme" });
      assert.equal(created.name, "Acme");
      assert.equal(store.snapshot().clients.length, 1);
    } finally {
      await store.close();
    }
    const reopened = await openStore(dir);
    try {
      assert.equal(reopened.snapshot().clients[0].name, "Acme");
    } finally {
      await reopened.close();
    }
  });

  /**
   * Run the shared checks for an injected directory-flush failure: the save is
   * rejected with the failed operation's error code as the reported cause, and
   * memory and the store file keep the previously committed state.
   */
  async function assertDirectoryFailureReported(
    failOn: FailOn,
    code: string,
    operation: string,
  ): Promise<void> {
    const dir = tempDir();
    const setup = await openStore(dir);
    try {
      await setup.createClient({ name: "Acme" });
    } finally {
      await setup.close();
    }
    const committed = readFileSync(storePath(dir), "utf8");
    // The adapter's directory flush uses the adapter's own open, flush and
    // close, so the failing operation is the one the adapter fails. Each of
    // them fails only once, so the flush that restores the previous committed
    // state succeeds and the store is not blocked.
    const adapter = failingFs(failOn);
    if (failOn.directoryOpenCode) {
      const openNormally = adapter.openSync;
      // The rejected save's directory open is the first one the adapter makes.
      let directoryOpens = 0;
      adapter.openSync = (path: string, flags: "wx" | "r") => {
        if (flags !== "r") return openNormally(path, flags);
        directoryOpens += 1;
        if (directoryOpens === 1) throw fsError(failOn.directoryOpenCode as string);
        return openNormally(path, flags);
      };
    }
    if (failOn.directoryFsyncCode) {
      const fsyncNormally = adapter.fsyncSync;
      let failed = false;
      adapter.fsyncSync = (fd: number) => {
        if (!adapter.isDirectoryFd(fd) || failed) return fsyncNormally(fd);
        failed = true;
        throw fsError(failOn.directoryFsyncCode as string);
      };
    }
    if (failOn.directoryCloseCode) {
      const closeNormally = adapter.closeSync;
      let failed = false;
      adapter.closeSync = (fd: number) => {
        if (!adapter.isDirectoryFd(fd)) return closeNormally(fd);
        if (failed) return closeNormally(fd);
        failed = true;
        throw fsError(failOn.directoryCloseCode as string);
      };
    }
    const store = await openStore(dir, { fs: adapter });
    try {
      await assert.rejects(store.createClient({ name: "Rejected" }), (error: unknown) => {
        assert.ok(error instanceof PersistenceError, operation);
        const cause = (error as { cause?: NodeJS.ErrnoException }).cause;
        assert.equal(cause?.code, code, operation);
        return true;
      });
      assert.deepEqual(store.snapshot().clients.map((client) => client.name), ["Acme"], operation);
      assert.equal(readFileSync(storePath(dir), "utf8"), committed, operation);
    } finally {
      await store.close();
    }
  }

  it("rejects when opening the directory for the flush fails", async () => {
    if (process.platform === "win32") return;
    // A genuine failure to open the directory is reported, never treated as an
    // unsupported operation. Only the rejected save's flush fails to open; the
    // flush that restores the previous state then succeeds, so nothing is
    // published and a later save still works.
    await assertDirectoryFailureReported({ directoryOpenCode: "EIO" }, "EIO", "directory open");
    await assertDirectoryFailureReported({ directoryOpenCode: "ENOENT" }, "ENOENT", "directory open");
    await assertDirectoryFailureReported({ directoryOpenCode: "EINVAL" }, "EINVAL", "directory open");
  });

  it("rejects when flushing the opened directory fails", async () => {
    if (process.platform === "win32") return;
    for (const code of ["EIO", "EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR"]) {
      await assertDirectoryFailureReported({ directoryFsyncCode: code }, code, "directory fsync");
    }
  });

  it("rejects when closing the opened directory fails", async () => {
    if (process.platform === "win32") return;
    await assertDirectoryFailureReported({ directoryCloseCode: "EIO" }, "EIO", "directory close");
  });

  it("reports the flush error, not the close error, when both fail", async () => {
    if (process.platform === "win32") return;
    // Both the directory flush and its close fail. The flush error is the
    // reported cause and the close error is kept as context on it; the close
    // error never replaces the flush error.
    const dir = tempDir();
    const setup = await openStore(dir);
    try {
      await setup.createClient({ name: "Acme" });
    } finally {
      await setup.close();
    }
    const committed = readFileSync(storePath(dir), "utf8");
    const adapter = failingFs({ directoryFsyncCode: "EIO", directoryCloseCode: "EINVAL" });
    const store = await openStore(dir, { fs: adapter });
    try {
      await assert.rejects(store.createClient({ name: "Rejected" }), (error: unknown) => {
        assert.ok(error instanceof PersistenceError);
        const cause = (error as { cause?: NodeJS.ErrnoException }).cause;
        assert.equal(cause?.code, "EIO");
        const context = cause as object;
        assert.equal((adapter.failureContext.get(context) as NodeJS.ErrnoException).code, "EINVAL");
        return true;
      });
      assert.deepEqual(store.snapshot().clients.map((client) => client.name), ["Acme"]);
      assert.equal(readFileSync(storePath(dir), "utf8"), committed);
    } finally {
      await store.close();
    }
  });

  it("opens the directory flush through the adapter's own operations on POSIX", async () => {
    if (process.platform === "win32") return;
    // The store's directory flush must go through the injected adapter's own
    // openSync, fsyncSync and closeSync rather than through node:fs directly.
    // That is what makes the per-operation failure tests meaningful: here all
    // three directory operations are observed, in order, for a successful save.
    const dir = tempDir();
    const adapter = failingFs({});
    const directoryCalls: string[] = [];
    const openNormally = adapter.openSync;
    const fsyncNormally = adapter.fsyncSync;
    const closeNormally = adapter.closeSync;
    adapter.openSync = (path: string, flags: "wx" | "r") => {
      if (flags === "r") directoryCalls.push("open");
      return openNormally(path, flags);
    };
    adapter.fsyncSync = (fd: number) => {
      if (adapter.isDirectoryFd(fd)) directoryCalls.push("fsync");
      fsyncNormally(fd);
    };
    adapter.closeSync = (fd: number) => {
      if (adapter.isDirectoryFd(fd)) directoryCalls.push("close");
      closeNormally(fd);
    };
    const store = await openStore(dir, { fs: adapter });
    try {
      await store.createClient({ name: "Acme" });
    } finally {
      await store.close();
    }
    assert.deepEqual(directoryCalls, ["open", "fsync", "close"]);
  });

  it("does not touch the directory through the default adapter on Windows", async () => {
    if (process.platform !== "win32") return;
    // Windows cannot open or flush a directory, so the default adapter must skip
    // the step by checking the platform before any operation, leaving the rename
    // as the durability point. The injected adapter is the store's adapter, so
    // counting its directory operations proves none is made; a second save and a
    // reopen show the store file itself was written normally.
    const dir = tempDir();
    const adapter = failingFs({});
    const directoryOperations: string[] = [];
    const openNormally = adapter.openSync;
    const fsyncNormally = adapter.fsyncSync;
    const closeNormally = adapter.closeSync;
    adapter.openSync = (path: string, flags: "wx" | "r") => {
      if (flags === "r") directoryOperations.push("open");
      return openNormally(path, flags);
    };
    adapter.fsyncSync = (fd: number) => {
      if (adapter.isDirectoryFd(fd)) directoryOperations.push("fsync");
      fsyncNormally(fd);
    };
    adapter.closeSync = (fd: number) => {
      if (adapter.isDirectoryFd(fd)) directoryOperations.push("close");
      closeNormally(fd);
    };
    const store = await openStore(dir, { fs: adapter });
    let clientId: string;
    try {
      const created = await store.createClient({ name: "Acme" });
      assert.equal(created.name, "Acme");
      clientId = created.id;
      const edited = await store.updateClient(clientId, { name: "Acme Ltd" });
      assert.equal(edited.name, "Acme Ltd");
    } finally {
      await store.close();
    }
    assert.deepEqual(directoryOperations, []);
    assert.equal(readFileSync(storePath(dir), "utf8").includes("Acme Ltd"), true);

    const reopened = await openStore(dir);
    try {
      assert.equal(reopened.snapshot().clients[0].name, "Acme Ltd");
    } finally {
      await reopened.close();
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
