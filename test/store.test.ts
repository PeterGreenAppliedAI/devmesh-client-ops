import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync as renameSyncImpl, rmSync, writeFileSync } from "node:fs";
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

function enoent(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error("simulated missing file");
  error.code = "ENOENT";
  return error;
}

/**
 * A file-system adapter that delegates to the real module but lets a test make
 * one named operation fail. It is injected through openStore's internal option.
 */
function failingFs(failOn: {
  writeFileSync?: (path: string) => boolean;
  /** Create the file, then fail the write, to simulate a partially written file. */
  createThenFailWriteFileSync?: (path: string) => boolean;
  renameSync?: (path: string) => boolean;
  readFileSync?: (path: string) => boolean;
  unlinkSync?: (path: string) => boolean;
}) {
  return {
    writeFileSync: (path: string, data: string, options: { encoding: "utf8"; flag?: string }) => {
      if (failOn.createThenFailWriteFileSync?.(path)) {
        writeFileSync(path, "", options);
        const error: NodeJS.ErrnoException = new Error("simulated write failure");
        error.code = "EIO";
        throw error;
      }
      if (failOn.writeFileSync?.(path)) {
        const error: NodeJS.ErrnoException = new Error("simulated write failure");
        error.code = "EIO";
        throw error;
      }
      writeFileSync(path, data, options);
    },
    renameSync: (oldPath: string, newPath: string) => {
      if (failOn.renameSync?.(oldPath)) {
        const error: NodeJS.ErrnoException = new Error("simulated rename failure");
        error.code = "EIO";
        throw error;
      }
      renameSyncImpl(oldPath, newPath);
    },
    readFileSync: (path: string, encoding: "utf8") => {
      if (failOn.readFileSync?.(path)) {
        if (failOn.readFileSync === alwaysMissing) throw enoent();
        const error: NodeJS.ErrnoException = new Error("simulated read failure");
        error.code = "EIO";
        throw error;
      }
      return readFileSync(path, encoding);
    },
    unlinkSync: (path: string) => {
      if (failOn.unlinkSync?.(path)) {
        const error: NodeJS.ErrnoException = new Error("simulated unlink failure");
        error.code = "EIO";
        throw error;
      }
      rmSync(path, { force: true });
    },
  };
}

const alwaysMissing = () => true;

describe("client creation and editing", () => {
  it("creates clients with defaults and edits partial fields", async () => {
    const store = await openStore(tempDir());
    try {
      const client = await store.createClient({ name: "Acme" });
      assert.equal(client.name, "Acme");
      assert.equal(client.background, "");
      assert.deepEqual(client.contacts, []);
      assert.deepEqual(client.stakeholders, []);
      assert.deepEqual(client.requirements, []);
      assert.deepEqual(client.objectives, []);
      assert.match(client.id, /\S/);

      const edited = await store.updateClient(client.id, {
        background: "An industrial supplier.",
        contacts: [{ name: "Dana", email: "dana@example.com", phone: "", role: "Owner" }],
        requirements: ["Ship in 2027"],
        objectives: [{ title: "Cut waste", description: "Reduce scrap" }],
        stakeholders: [{ name: "Sam", role: "Sponsor", influence: "high", notes: "" }],
      });
      assert.equal(edited.name, "Acme");
      assert.equal(edited.background, "An industrial supplier.");
      assert.equal(edited.contacts[0].name, "Dana");
      assert.equal(edited.requirements[0], "Ship in 2027");
      assert.equal(edited.objectives[0].title, "Cut waste");
      assert.equal(edited.stakeholders[0].name, "Sam");

      const renamed = await store.updateClient(client.id, { name: "Acme Holdings" });
      assert.equal(renamed.name, "Acme Holdings");
      assert.equal(renamed.background, "An industrial supplier.");
      assert.equal(renamed.contacts.length, 1);

      const snapshot = store.snapshot();
      assert.equal(snapshot.clients.length, 1);
      assert.equal(snapshot.clients[0].name, "Acme Holdings");
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
          contacts: [],
          stakeholders: [],
          requirements: [],
          objectives: [],
        });
      });
      assert.throws(() => {
        (snapshot.clients[0] as { name: string }).name = "Mutated";
      });
      assert.equal(snapshot.clients[0].name, "Acme");
      created.name = "Local change";
      assert.equal(store.snapshot().clients[0].name, "Acme");
    } finally {
      await store.close();
    }
  });

  it("rejects blank names and invalid status values", async () => {
    const store = await openStore(tempDir());
    try {
      await assert.rejects(store.createClient({ name: "   " }), ValidationError);
      const client = await store.createClient({ name: "Acme" });
      await assert.rejects(
        store.createEngagement({
          clientId: client.id,
          name: "Engagement",
          status: "unknown" as never,
        }),
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

      const active = await store.updateEngagement(first.id, { status: "active" });
      assert.equal(active.status, "active");
      assert.equal(active.clientId, client.id);
      assert.equal(active.name, "First");

      const done = await store.updateProject(firstProject.id, { status: "completed" });
      assert.equal(done.status, "completed");
      assert.equal(done.engagementId, first.id);
    } finally {
      await store.close();
    }
  });

  it("rejects missing parents", async () => {
    const store = await openStore(tempDir());
    try {
      await assert.rejects(
        store.createEngagement({ clientId: "client-999", name: "Engagement" }),
        MissingRecordError,
      );
      await assert.rejects(
        store.createProject({ engagementId: "engagement-999", name: "Project" }),
        MissingRecordError,
      );
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
      // Parent links supplied in an edit are ignored, not accepted.
      const edited = await store.updateEngagement(engagement.id, {
        clientId: other.id,
        name: "First",
      } as never);
      assert.equal(edited.clientId, client.id);

      const project = await store.createProject({ engagementId: engagement.id, name: "A" });
      const editedProject = await store.updateProject(project.id, {
        engagementId: "engagement-bogus",
      } as never);
      assert.equal(editedProject.engagementId, engagement.id);

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
    } finally {
      await reopened.close();
    }
  });
});

describe("persistence", () => {
  it("persists full fields across restart and allows reopen after close", async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    let clientId: string;
    try {
      const client = await store.createClient({
        name: "Acme",
        background: "Full background text",
        contacts: [{ name: "Dana", email: "d@example.com", phone: "123", role: "Owner" }],
        stakeholders: [{ name: "Sam", role: "Sponsor", influence: "high", notes: "n" }],
        requirements: ["Req 1", "Req 2"],
        objectives: [{ title: "Goal", description: "Desc" }],
      });
      clientId = client.id;
      const engagement = await store.createEngagement({
        clientId,
        name: "Eng",
        objectives: [{ title: "EG", description: "ED" }],
        status: "on_hold",
      });
      await store.createProject({
        engagementId: engagement.id,
        name: "Proj",
        objectives: [{ title: "PG", description: "PD" }],
        status: "active",
      });
    } finally {
      await store.close();
    }
    // Lock is released on close, so a new writer may open the directory.
    assert.equal(existsSync(join(dir, "workspace.lock")), false);

    const reopened = await openStore(dir);
    try {
      const snapshot = reopened.snapshot();
      assert.deepEqual(snapshot.clients[0], {
        id: clientId,
        name: "Acme",
        background: "Full background text",
        contacts: [{ name: "Dana", email: "d@example.com", phone: "123", role: "Owner" }],
        stakeholders: [{ name: "Sam", role: "Sponsor", influence: "high", notes: "n" }],
        requirements: ["Req 1", "Req 2"],
        objectives: [{ title: "Goal", description: "Desc" }],
      });
      assert.equal(snapshot.engagements[0].status, "on_hold");
      assert.deepEqual(snapshot.engagements[0].objectives, [{ title: "EG", description: "ED" }]);
      assert.equal(snapshot.projects[0].status, "active");
    } finally {
      await reopened.close();
    }
  });

  it("refuses corrupt stored data without overwriting it", async () => {
    const dir = tempDir();
    const path = join(dir, "workspace.json");
    writeFileSync(path, "{ not json", "utf8");
    await assert.rejects(openStore(dir), PersistenceError);
    assert.equal(readFileSync(path, "utf8"), "{ not json");
    // Ownership was released after failed initialization.
    assert.equal(existsSync(join(dir, "workspace.lock")), false);

    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 1, clients: [{ id: "c", name: "" }], engagements: [], projects: [], nextIds: {} }),
      "utf8",
    );
    const before = readFileSync(path, "utf8");
    await assert.rejects(openStore(dir), PersistenceError);
    assert.equal(readFileSync(path, "utf8"), before);
  });

  it("refuses unsupported schema versions without overwriting them", async () => {
    const dir = tempDir();
    const path = join(dir, "workspace.json");
    const content = JSON.stringify({ schemaVersion: 2, clients: [], engagements: [], projects: [], nextIds: {} });
    writeFileSync(path, content, "utf8");
    await assert.rejects(openStore(dir), (error: unknown) => {
      assert.ok(error instanceof PersistenceError);
      assert.match(error.message, /schema version/i);
      return true;
    });
    assert.equal(readFileSync(path, "utf8"), content);
  });

  it("refuses stored data with a dangling parent link", async () => {
    const dir = tempDir();
    const path = join(dir, "workspace.json");
    const content = JSON.stringify({
      schemaVersion: 1,
      clients: [],
      engagements: [{ id: "engagement-1", clientId: "client-9", name: "E", objectives: [], status: "planned" }],
      projects: [],
      nextIds: {},
    });
    writeFileSync(path, content, "utf8");
    await assert.rejects(openStore(dir), PersistenceError);
    assert.equal(readFileSync(path, "utf8"), content);
  });

  it("refuses a second writer and permits reopening after close", async () => {
    const dir = tempDir();
    const first = await openStore(dir);
    try {
      await assert.rejects(openStore(dir), BusyStoreError);
    } finally {
      await first.close();
    }
    const second = await openStore(dir);
    await second.close();
  });
});

describe("failures", () => {
  it("retains the previous committed state when a save fails", async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    try {
      const client = await store.createClient({ name: "Acme" });

      // Swap in an adapter whose writes fail, by constructing a new store that
      // shares the directory after close, with the injected failure.
      await store.close();

      let failWrites = false;
      const failing = failingFs({ writeFileSync: () => failWrites });
      const reopened = await openStore(dir, { fs: failing });
      try {
        assert.equal(reopened.snapshot().clients.length, 1);
        await reopened.updateClient(client.id, { name: "Changed" });
        failWrites = true;
        await assert.rejects(
          reopened.createClient({ name: "New" }),
          PersistenceError,
        );
        const snapshot = reopened.snapshot();
        assert.equal(snapshot.clients.length, 1);
        assert.equal(snapshot.clients[0].name, "Changed");
        await assert.rejects(
          reopened.updateClient(client.id, { name: "Renamed" }),
          PersistenceError,
        );
      } finally {
        await reopened.close();
      }

      // On disk, the last successful save is still the committed state.
      const last = await openStore(dir);
      try {
        assert.equal(last.snapshot().clients.length, 1);
        assert.equal(last.snapshot().clients[0].name, "Changed");
      } finally {
        await last.close();
      }
    } finally {
      await store.close();
    }
  });

  it("removes the lock when creating the lock succeeds but writing it fails", async () => {
    const dir = tempDir();
    // Creating the lock succeeds, then writing its contents fails.
    let failedOnce = false;
    const failing = failingFs({
      createThenFailWriteFileSync: (path) => {
        if (!failedOnce && path.endsWith("workspace.lock")) {
          failedOnce = true;
          return true;
        }
        return false;
      },
    });
    await assert.rejects(openStore(dir, { fs: failing }), PersistenceError);
    // The half-written lock was removed before failing.
    assert.equal(existsSync(join(dir, "workspace.lock")), false);
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
    } finally {
      failUnlink = false;
      await store.close();
    }
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

  it("cleans up the temporary file when replacement fails", async () => {
    const dir = tempDir();
    const failing = failingFs({ renameSync: () => true });
    const store = await openStore(dir, { fs: failing });
    try {
      await assert.rejects(store.createClient({ name: "Acme" }), PersistenceError);
      const snapshot = store.snapshot();
      assert.equal(snapshot.clients.length, 0);
      const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
      assert.deepEqual(leftovers, []);
    } finally {
      await store.close();
    }
  });

  it("fails initialization when the stored data cannot be read", async () => {
    const dir = tempDir();
    const failing = failingFs({
      readFileSync: (path) => path.endsWith("workspace.json"),
    });
    writeFileSync(join(dir, "workspace.json"), JSON.stringify({
      schemaVersion: 1,
      clients: [],
      engagements: [],
      projects: [],
      nextIds: {},
    }), "utf8");
    await assert.rejects(openStore(dir, { fs: failing }), PersistenceError);
    assert.equal(existsSync(join(dir, "workspace.lock")), false);
  });
});
