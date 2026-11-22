import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync as writeSyncImpl,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  archivedReason,
  isEffectivelyArchived,
  ARCHIVE_KINDS,
  type ArchiveKind,
} from "../src/archive.ts";
import {
  MissingRecordError,
  openStore,
  PersistenceError,
  ValidationError,
  type FileSystem,
  type Store,
} from "../src/store.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "archive-"));
  roots.push(dir);
  return dir;
}

function storePath(dir: string): string {
  return join(dir, "workspace.json");
}

function fsError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** A client with an engagement, a project, a task, an item and a meeting. */
async function workspace(store: Store) {
  const client = await store.createClient({ name: "Acme" });
  const engagement = await store.createEngagement({
    clientId: client.id,
    name: "Eng",
    objectives: "Objectives",
    status: "active",
  });
  const project = await store.createProject({
    engagementId: engagement.id,
    name: "Project",
    objectives: "Project objectives",
    status: "on_hold",
  });
  const task = await store.createTask({
    clientId: client.id,
    engagementId: engagement.id,
    projectId: project.id,
    title: "Task",
    status: "in_progress",
    priority: "high",
    owner: "Dana",
    dueDate: "2027-06-30",
    context: "Context",
  });
  const item = await store.createItem({
    clientId: client.id,
    engagementId: engagement.id,
    projectId: project.id,
    kind: "blocker",
    title: "Item",
    context: "Item context",
    state: "closed",
  });
  const meeting = await store.createMeeting({
    clientId: client.id,
    engagementId: engagement.id,
    projectId: project.id,
    title: "Meeting",
    date: "2026-05-01",
    notes: "Notes",
  });
  return { client, engagement, project, task, item, meeting };
}

/** The persisted record for a kind in the stored workspace file. */
function storedRecord(dir: string, kind: ArchiveKind, id: string): Record<string, unknown> {
  const document = JSON.parse(readFileSync(storePath(dir), "utf8")) as Record<string, unknown>;
  const key = {
    client: "clients",
    engagement: "engagements",
    project: "projects",
    task: "tasks",
    item: "items",
  }[kind];
  const records = document[key] as { id: string }[];
  const found = records.find((record) => record.id === id);
  assert.ok(found, `stored ${kind} ${id} present`);
  return found as unknown as Record<string, unknown>;
}

describe("archival flags", () => {
  const kinds: readonly ArchiveKind[] = ["client", "engagement", "project", "task", "item"];

  it("archives and restores each family without changing other fields", async () => {
    for (const kind of kinds) {
      const store = await openStore(tempDir());
      try {
        const w = await workspace(store);
        const before = store.snapshot();
        const record = {
          client: w.client,
          engagement: w.engagement,
          project: w.project,
          task: w.task,
          item: w.item,
        }[kind];
        await store.setArchived(kind, record.id, true);
        const archived = store.snapshot();
        const flags = {
          client: archived.clients,
          engagement: archived.engagements,
          project: archived.projects,
          task: archived.tasks,
          item: archived.items,
        }[kind] as readonly { id: string; archived?: boolean }[];
        assert.equal(flags.find((r) => r.id === record.id)?.archived, true, `${kind} archived`);
        // Every other record is unchanged, flags and fields included.
        const others = {
          client: before.clients,
          engagement: before.engagements,
          project: before.projects,
          task: before.tasks,
          item: before.items,
        }[kind];
        const otherIds = others.map((r) => r.id).filter((id) => id !== record.id);
        for (const id of otherIds) {
          assert.equal(flags.find((r) => r.id === id)?.archived, undefined, `${kind} other unchanged`);
        }
        // Fields, links and ids are preserved.
        const after = flags.find((r) => r.id === record.id) as Record<string, unknown>;
        const original = record as unknown as Record<string, unknown>;
        for (const [field, value] of Object.entries(original)) {
          assert.deepEqual(after[field], value, `${kind}.${field} preserved`);
        }

        await store.setArchived(kind, record.id, false);
        const restored = {
          client: store.snapshot().clients,
          engagement: store.snapshot().engagements,
          project: store.snapshot().projects,
          task: store.snapshot().tasks,
          item: store.snapshot().items,
        }[kind] as readonly { id: string; archived?: boolean }[];
        const restoredRecord = restored.find((r) => r.id === record.id) as Record<string, unknown>;
        assert.equal("archived" in restoredRecord, false, `${kind} flag removed`);
        assert.deepEqual(restoredRecord, original, `${kind} record restored`);
      } finally {
        await store.close();
      }
    }
  });

  it("persists flags across restart and only true is stored", async () => {
    for (const kind of kinds) {
      const dir = tempDir();
      const store = await openStore(dir);
      const record = await (async () => {
        try {
          const w = await workspace(store);
          const target = {
            client: w.client.id,
            engagement: w.engagement.id,
            project: w.project.id,
            task: w.task.id,
            item: w.item.id,
          }[kind];
          await store.setArchived(kind, target, true);
          return target;
        } finally {
          await store.close();
        }
      })();
      assert.equal(storedRecord(dir, kind, record).archived, true, `${kind} stored as true`);
      const reopened = await openStore(dir);
      try {
        const flags = {
          client: reopened.snapshot().clients,
          engagement: reopened.snapshot().engagements,
          project: reopened.snapshot().projects,
          task: reopened.snapshot().tasks,
          item: reopened.snapshot().items,
        }[kind] as readonly { id: string; archived?: boolean }[];
        assert.equal(flags.find((r) => r.id === record)?.archived, true, `${kind} survives restart`);
        // Restoring removes the flag from the stored document too.
        await reopened.setArchived(kind, record, false);
        assert.equal("archived" in storedRecord(dir, kind, record), false, `${kind} unarchived persisted`);
      } finally {
        await reopened.close();
      }
      const again = await openStore(dir);
      try {
        const flags = {
          client: again.snapshot().clients,
          engagement: again.snapshot().engagements,
          project: again.snapshot().projects,
          task: again.snapshot().tasks,
          item: again.snapshot().items,
        }[kind] as readonly { id: string; archived?: boolean }[];
        assert.equal(flags.find((r) => r.id === record)?.archived, undefined, `${kind} stays restored`);
      } finally {
        await again.close();
      }
    }
  });

  it("follows normal commit rules on repeated archive and unarchive", async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    let clientId: string;
    try {
      const w = await workspace(store);
      clientId = w.client.id;
      for (let i = 0; i < 3; i += 1) {
        await store.setArchived("client", clientId, true);
        assert.equal(store.snapshot().clients[0].archived, true);
        await store.setArchived("client", clientId, true);
        assert.equal(store.snapshot().clients[0].archived, true);
        await store.setArchived("client", clientId, false);
        assert.equal("archived" in store.snapshot().clients[0], false);
        await store.setArchived("client", clientId, false);
        assert.equal("archived" in store.snapshot().clients[0], false);
      }
      // Counters are untouched by archival, so the next create continues.
      const next = await store.createClient({ name: "Next" });
      assert.equal(next.id, "client-2");
      // An edit preserves the flag it was given, even when it edits other fields.
      await store.setArchived("client", clientId, true);
      const edited = await store.updateClient(clientId, { name: "Renamed" });
      assert.equal(edited.archived, true);
      assert.equal(edited.name, "Renamed");
      // An ordinary edit input cannot set or clear the flag.
      const editedTask = await store.updateTask(store.snapshot().tasks[0].id, {
        title: "New title",
      } as never);
      assert.equal("archived" in editedTask, false);
      await store.setArchived("task", editedTask.id, true);
      const cleared = await store.updateTask(editedTask.id, {
        title: "Again",
        archived: false,
      } as never);
      assert.equal(cleared.archived, true, "edit input cannot clear the flag");
    } finally {
      await store.close();
    }
    const reopened = await openStore(dir);
    try {
      assert.equal(reopened.snapshot().clients[0].archived, true);
      const task = reopened.snapshot().tasks[0];
      assert.equal(task.archived, true);
      assert.equal(task.title, "Again");
    } finally {
      await reopened.close();
    }
  });

  it("keeps independently archived children when restoring a parent", async () => {
    const store = await openStore(tempDir());
    try {
      const w = await workspace(store);
      const extra = await store.createTask({
        clientId: w.client.id,
        engagementId: w.engagement.id,
        title: "Sibling task",
      });
      await store.setArchived("client", w.client.id, true);
      await store.setArchived("task", extra.id, true);
      // Descendants are never changed by archiving a parent.
      const tasks = store.snapshot().tasks;
      assert.equal(tasks.find((t) => t.id === w.task.id)?.archived, undefined);
      assert.equal(tasks.find((t) => t.id === extra.id)?.archived, true);
      assert.equal(store.snapshot().items[0].archived, undefined);
      // Restoring the parent preserves the child's own flag.
      await store.setArchived("client", w.client.id, false);
      assert.equal(store.snapshot().clients[0].archived, undefined);
      assert.equal(
        store.snapshot().tasks.find((t) => t.id === extra.id)?.archived,
        true,
        "independently archived child preserved",
      );
      // The sibling task is visible again because only its own flag matters.
      assert.equal(
        store.snapshot().tasks.find((t) => t.id === w.task.id)?.archived,
        undefined,
      );
    } finally {
      await store.close();
    }
  });

  it("rejects invalid arguments and unknown ids without mutating", async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    try {
      const w = await workspace(store);
      const before = store.snapshot();
      const saved = readFileSync(storePath(dir), "utf8");
      const invalidArgs: [unknown, unknown, unknown][] = [
        ["meeting", w.meeting.id, true],
        ["bogus", w.client.id, true],
        ["", w.client.id, true],
        [undefined, w.client.id, true],
        ["client", w.client.id, "yes"],
        ["client", w.client.id, 1],
        ["client", w.client.id, undefined],
        ["client", w.client.id, null],
        ["client", "", true],
        ["client", "   ", true],
        ["client", 42, true],
        ["client", undefined, true],
      ];
      for (const [kind, id, archived] of invalidArgs) {
        await assert.rejects(
          store.setArchived(
            kind as ArchiveKind,
            id as string,
            archived as boolean,
          ),
          ValidationError,
        );
      }
      // An unknown but valid id is a missing record, refused the same way.
      for (const kind of ARCHIVE_KINDS) {
        await assert.rejects(
          store.setArchived(kind, `${kind}-999`, true),
          MissingRecordError,
        );
      }
      assert.deepEqual(store.snapshot(), before);
      assert.equal(readFileSync(storePath(dir), "utf8"), saved);
    } finally {
      await store.close();
    }
  });

  it("reads schema 1 and 3 strictly as active without inventing flags", async () => {
    for (const version of [1, 3]) {
      const dir = tempDir();
      const document = {
        schemaVersion: version,
        clients: [
          { id: "client-1", name: "A", background: "", contacts: "", stakeholders: "", requirements: "", objectives: "" },
        ],
        engagements: [
          { id: "engagement-1", clientId: "client-1", name: "E", objectives: "", status: "planned" },
        ],
        projects: version === 1 ? [] : [
          { id: "project-1", engagementId: "engagement-1", name: "P", objectives: "", status: "planned" },
        ],
        ...(version === 1 ? {} : { tasks: [], items: [], meetings: [] }),
        nextIds: version === 1
          ? { clients: 2, engagements: 2 }
          : { clients: 2, engagements: 2, projects: 2 },
      };
      writeFileSync(storePath(dir), JSON.stringify(document), "utf8");
      const store = await openStore(dir);
      try {
        const snapshot = store.snapshot();
        assert.equal("archived" in snapshot.clients[0], false, `v${version} client active`);
        assert.equal("archived" in snapshot.engagements[0], false, `v${version} engagement active`);
        // Reading does not rewrite the file at open time.
        assert.equal(JSON.parse(readFileSync(storePath(dir), "utf8")).schemaVersion, version);
      } finally {
        await store.close();
      }
    }
  });

  it("refuses legacy archive keys and corrupt flags without resetting data", async () => {
    const dir = tempDir();
    const base = {
      clients: [
        { id: "client-1", name: "A", background: "", contacts: "", stakeholders: "", requirements: "", objectives: "" },
        { id: "client-2", name: "B", background: "", contacts: "", stakeholders: "", requirements: "", objectives: "" },
      ],
      engagements: [
        { id: "engagement-1", clientId: "client-1", name: "E", objectives: "", status: "planned" },
      ],
      projects: [
        { id: "project-1", engagementId: "engagement-1", name: "P", objectives: "", status: "planned" },
      ],
    };
    const cases: unknown[] = [
      // A legacy archive key is refused in any version.
      { ...base, schemaVersion: 4, tasks: [], items: [], meetings: [], archived: true, nextIds: { clients: 3, engagements: 2, projects: 2 } },
      { ...base, schemaVersion: 3, tasks: [], items: [], meetings: [], archive: [], nextIds: { clients: 3, engagements: 2, projects: 2 } },
      // Schema 3 cannot carry flags on records.
      { ...base, schemaVersion: 3, clients: [{ ...base.clients[0], archived: true }, base.clients[1]], tasks: [], items: [], meetings: [], nextIds: { clients: 3, engagements: 2, projects: 2 } },
      // Corrupt flags: wrong type, false, and unknown keys in records.
      { ...base, schemaVersion: 4, clients: [{ ...base.clients[0], archived: "true" }, base.clients[1]], tasks: [], items: [], meetings: [], nextIds: { clients: 3, engagements: 2, projects: 2 } },
      { ...base, schemaVersion: 4, clients: [], tasks: [], items: [], meetings: [], nextIds: {} },
      { ...base, schemaVersion: 4, clients: [{ ...base.clients[0], archived: false }, base.clients[1]], engagements: base.engagements, projects: base.projects, tasks: [], items: [], meetings: [], nextIds: { clients: 3, engagements: 2, projects: 2 } },
      { ...base, schemaVersion: 4, clients: [{ ...base.clients[0], archivedAt: "now" }, base.clients[1]], engagements: base.engagements, projects: base.projects, tasks: [], items: [], meetings: [], nextIds: { clients: 3, engagements: 2, projects: 2 } },
      { ...base, schemaVersion: 4, clients: base.clients, engagements: [{ ...base.engagements[0], archived: 1 }], projects: base.projects, tasks: [], items: [], meetings: [], nextIds: { clients: 3, engagements: 2, projects: 2 } },
      // Meetings never carry a flag.
      { ...base, schemaVersion: 4, clients: base.clients, engagements: base.engagements, projects: base.projects, tasks: [], items: [], meetings: [{ id: "meeting-1", clientId: "client-1", engagementId: "engagement-1", title: "M", date: "2026-01-01", notes: "", archived: true }], nextIds: { clients: 3, engagements: 2, projects: 2, meetings: 2 } },
      // Broken references still fail opening, even with flags present.
      { ...base, schemaVersion: 4, clients: [{ ...base.clients[0], archived: true }], engagements: [{ ...base.engagements[0], clientId: "client-9" }], projects: base.projects, tasks: [], items: [], meetings: [], nextIds: { clients: 3, engagements: 2, projects: 2 } },
    ];
    for (const value of cases) {
      const content = JSON.stringify(value);
      writeFileSync(storePath(dir), content, "utf8");
      await assert.rejects(openStore(dir), PersistenceError);
      assert.equal(readFileSync(storePath(dir), "utf8"), content, "data left untouched");
      assert.equal(existsSync(join(dir, "workspace.lock")), false, "lock released");
    }

    // A valid schema 4 document with flags opens.
    writeFileSync(
      storePath(dir),
      JSON.stringify({
        ...base,
        schemaVersion: 4,
        clients: [{ ...base.clients[0], archived: true }, base.clients[1]],
        tasks: [],
        items: [],
        meetings: [],
        nextIds: { clients: 3, engagements: 2, projects: 2 },
      }),
      "utf8",
    );
    const store = await openStore(dir);
    try {
      assert.equal(store.snapshot().clients[0].archived, true);
      assert.equal("archived" in store.snapshot().clients[1], false);
    } finally {
      await store.close();
    }
  });
});

describe("inherited visibility", () => {
  it("treats a record as effectively archived through any stored ancestor", async () => {
    const store = await openStore(tempDir());
    try {
      const w = await workspace(store);
      const state = () => store.snapshot();
      assert.equal(isEffectivelyArchived(state(), w.task), false);
      assert.equal(isEffectivelyArchived(state(), w.meeting), false);
      assert.equal(archivedReason(state(), w.meeting), null);

      await store.setArchived("project", w.project.id, true);
      assert.equal(isEffectivelyArchived(state(), w.task), true);
      assert.equal(archivedReason(state(), w.task), `project:${w.project.id}`);
      assert.equal(isEffectivelyArchived(state(), w.item), true);
      // A meeting inherits visibility without a flag of its own.
      assert.equal(isEffectivelyArchived(state(), w.meeting), true);
      assert.equal(archivedReason(state(), w.meeting), `project:${w.project.id}`);
      assert.equal("archived" in store.snapshot().meetings[0], false);

      // An engagement flag hides the project and every descendant.
      await store.setArchived("engagement", w.engagement.id, true);
      assert.equal(
        archivedReason(state(), {
          clientId: w.client.id,
          engagementId: w.engagement.id,
          projectId: w.project.id,
        }),
        `engagement:${w.engagement.id}`,
      );
      assert.equal(archivedReason(state(), w.meeting), `engagement:${w.engagement.id}`);

      // A client flag hides the whole tree; the record's own flag still wins
      // as the nearest reason.
      await store.setArchived("client", w.client.id, true);
      assert.equal(archivedReason(state(), w.meeting), `client:${w.client.id}`);
      await store.setArchived("task", w.task.id, true);
      const ownFlag = store.snapshot().tasks.find((t) => t.id === w.task.id)!;
      assert.equal(archivedReason(state(), ownFlag), "self");

      // Restoring the ancestors makes the unflagged descendants visible again.
      await store.setArchived("client", w.client.id, false);
      await store.setArchived("engagement", w.engagement.id, false);
      await store.setArchived("project", w.project.id, false);
      assert.equal(archivedReason(state(), w.meeting), null);
      assert.equal(isEffectivelyArchived(state(), w.meeting), false);
      // The task keeps its own flag.
      const flaggedTask = store.snapshot().tasks.find((t) => t.id === w.task.id)!;
      assert.equal(isEffectivelyArchived(state(), flaggedTask), true);
      assert.equal(flaggedTask.archived, true);
    } finally {
      await store.close();
    }
  });

  it("does not change descendants when a parent is archived", async () => {
    const store = await openStore(tempDir());
    try {
      const w = await workspace(store);
      const before = store.snapshot();
      await store.setArchived("client", w.client.id, true);
      await store.setArchived("engagement", w.engagement.id, true);
      await store.setArchived("project", w.project.id, true);
      const after = store.snapshot();
      assert.deepEqual(after.tasks, before.tasks);
      assert.deepEqual(after.items, before.items);
      assert.deepEqual(after.meetings, before.meetings);
      assert.equal(after.clients[0].archived, true);
      assert.equal(after.engagements[0].archived, true);
      assert.equal(after.projects[0].archived, true);
    } finally {
      await store.close();
    }
  });
});

describe("archival persistence failures", () => {
  /**
   * Wrap the real file system so a test can fail a store write or a directory
   * flush. The operations read the mutable state each time they run, so a test
   * can change the behaviour after the store was opened; the merged adapter
   * the store keeps delegates to these same closures.
   */
  interface FailureState {
    /** Fail every temporary-file write while set. */
    failWrites: boolean;
    /** Fail every directory flush while set. */
    failFlushes: boolean;
    /** Fail only the first directory flush; reset with `flushes = 0`. */
    failFirstFlush: boolean;
    /** Number of directory flushes performed. */
    flushes: number;
  }

  function failingFs(): { fs: Partial<FileSystem>; state: FailureState } {
    const state: FailureState = {
      failWrites: false,
      failFlushes: false,
      failFirstFlush: false,
      flushes: 0,
    };
    const fs: Partial<FileSystem> = {
      writeSync: (fd: number, data: Uint8Array) => {
        if (state.failWrites) throw fsError("EIO");
        return writeSyncImpl(fd, data);
      },
      fsyncDirectorySync: () => {
        state.flushes += 1;
        if (state.failFlushes) throw fsError("EIO");
        if (state.failFirstFlush && state.flushes === 1) throw fsError("EIO");
      },
    };
    return { fs, state };
  }

  it("keeps committed memory when a save fails and never publishes the flag", async () => {
    const dir = tempDir();
    const setup = await openStore(dir);
    let clientId: string;
    try {
      const w = await workspace(setup);
      clientId = w.client.id;
    } finally {
      await setup.close();
    }
    const committed = readFileSync(storePath(dir), "utf8");

    const { fs, state } = failingFs();
    const store = await openStore(dir, { fs });
    try {
      assert.equal("archived" in store.snapshot().clients[0], false);
      state.failWrites = true;
      await assert.rejects(store.setArchived("client", clientId, true), PersistenceError);
      // The failed mutation is never published, in memory or on disk.
      assert.equal("archived" in store.snapshot().clients[0], false);
      assert.equal(readFileSync(storePath(dir), "utf8"), committed);
      assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
      // After the failure, a later save builds on the committed state.
      state.failWrites = false;
      await store.setArchived("client", clientId, true);
      assert.equal(store.snapshot().clients[0].archived, true);
    } finally {
      await store.close();
    }
    const reopened = await openStore(dir);
    try {
      assert.equal(reopened.snapshot().clients[0].archived, true);
    } finally {
      await reopened.close();
    }
  });

  it("restores the prior disk state when a directory flush fails", async () => {
    const dir = tempDir();
    const setup = await openStore(dir);
    let clientId: string;
    try {
      const w = await workspace(setup);
      clientId = w.client.id;
    } finally {
      await setup.close();
    }
    const committed = readFileSync(storePath(dir), "utf8");

    const { fs, state } = failingFs();
    const store = await openStore(dir, { fs, platform: "linux" });
    state.flushes = 0;
    state.failFirstFlush = true;
    try {
      // The first directory flush after the replacement fails; the restore's
      // flush then succeeds, so disk and memory keep the committed state.
      await assert.rejects(store.setArchived("client", clientId, true), PersistenceError);
      assert.equal("archived" in store.snapshot().clients[0], false);
      assert.equal(readFileSync(storePath(dir), "utf8"), committed);
      // A later save is still accepted once the injected failure is removed.
      state.failFirstFlush = false;
      await store.setArchived("client", clientId, true);
      assert.equal(store.snapshot().clients[0].archived, true);
    } finally {
      await store.close();
    }
  });

  it("blocks mutations when recovery fails and refuses later writes", async () => {
    const dir = tempDir();
    const setup = await openStore(dir);
    let clientId: string;
    try {
      const w = await workspace(setup);
      clientId = w.client.id;
    } finally {
      await setup.close();
    }
    const committed = readFileSync(storePath(dir), "utf8");

    const { fs, state } = failingFs();
    const store = await openStore(dir, { fs, platform: "linux" });
    // Fail the replacement's flush and the restore's flush alike.
    state.failFlushes = true;
    try {
      await assert.rejects(store.setArchived("client", clientId, true), (error: unknown) => {
        assert.ok(error instanceof PersistenceError);
        assert.match(error.message, /could not restore the previous state/i);
        return true;
      });
      // The failed flag is never published, and every later mutation is refused
      // until the store is reopened.
      assert.equal("archived" in store.snapshot().clients[0], false);
      await assert.rejects(store.setArchived("client", clientId, true), PersistenceError);
      await assert.rejects(store.createClient({ name: "Later" }), PersistenceError);
      assert.equal("archived" in store.snapshot().clients[0], false);
    } finally {
      await store.close();
    }
    // Reopening reads whatever the disk holds; the restored previous bytes are
    // the committed state.
    assert.equal(readFileSync(storePath(dir), "utf8"), committed);
    const reopened = await openStore(dir);
    try {
      assert.equal("archived" in reopened.snapshot().clients[0], false);
      await reopened.setArchived("client", clientId, true);
      assert.equal(reopened.snapshot().clients[0].archived, true);
    } finally {
      await reopened.close();
    }
  });

  it("refuses mutations on a closed store but validates arguments first", async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    const w = await workspace(store);
    await store.close();
    // A closed store refuses the mutation with a persistence error.
    await assert.rejects(store.setArchived("client", w.client.id, true), PersistenceError);
    // A bad argument is still a validation error, checked before the store.
    await assert.rejects(
      store.setArchived("bogus" as ArchiveKind, w.client.id, true),
      ValidationError,
    );
    // Reopening shows nothing was published.
    const reopened = await openStore(dir);
    try {
      assert.equal("archived" in reopened.snapshot().clients[0], false);
    } finally {
      await reopened.close();
    }
  });
});
