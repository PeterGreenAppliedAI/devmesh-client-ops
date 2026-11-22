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
  ancestorsOf,
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

/** Open the store for a kind's collection from a snapshot. */
function collectionOf(
  snapshot: ReturnType<Store["snapshot"]>,
  kind: ArchiveKind,
) {
  return {
    client: snapshot.clients,
    engagement: snapshot.engagements,
    project: snapshot.projects,
    task: snapshot.tasks,
    item: snapshot.items,
  }[kind] as unknown as readonly Record<string, unknown>[];
}

/** The record of a kind in a snapshot, by id. */
function recordOf(
  snapshot: ReturnType<Store["snapshot"]>,
  kind: ArchiveKind,
  id: string,
): Record<string, unknown> | undefined {
  return collectionOf(snapshot, kind).find((record) => record.id === id);
}

function idsOf(w: Awaited<ReturnType<typeof workspace>>): Record<ArchiveKind, string> {
  return {
    client: w.client.id,
    engagement: w.engagement.id,
    project: w.project.id,
    task: w.task.id,
    item: w.item.id,
  };
}

describe("archival flags", () => {
  const kinds: readonly ArchiveKind[] = ["client", "engagement", "project", "task", "item"];

  it("archives and restores each family, preserving fields and sibling records", async () => {
    for (const kind of kinds) {
      const store = await openStore(tempDir());
      try {
        const w = await workspace(store);
        // A real sibling in the same collection, unaffected by the flag.
        const siblingId = await (async () => {
          if (kind === "client") return (await store.createClient({ name: "Other client" })).id;
          if (kind === "engagement") {
            return (
              await store.createEngagement({ clientId: w.client.id, name: "Other engagement" })
            ).id;
          }
          if (kind === "project") {
            return (
              await store.createProject({ engagementId: w.engagement.id, name: "Other project" })
            ).id;
          }
          const input = { clientId: w.client.id, engagementId: w.engagement.id };
          if (kind === "task") return (await store.createTask({ ...input, title: "Other task" })).id;
          return (
            await store.createItem({ ...input, kind: "follow_up", title: "Other item" })
          ).id;
        })();
        const before = store.snapshot();
        const record = recordOf(before, kind, idsOf(w)[kind])!;
        const sibling = recordOf(before, kind, siblingId)!;
        assert.notEqual(siblingId, record.id, `${kind} sibling is a distinct record`);

        await store.setArchived(kind, record.id as string, true);
        const archived = store.snapshot();
        assert.equal(recordOf(archived, kind, record.id as string)?.archived, true, `${kind} archived`);
        // The sibling record is unchanged in full: fields, links and no flag.
        assert.deepEqual(recordOf(archived, kind, siblingId), sibling, `${kind} sibling unchanged`);
        // Fields, links and ids of the target are preserved.
        const after = recordOf(archived, kind, record.id as string)!;
        for (const [field, value] of Object.entries(record)) {
          assert.deepEqual(after[field], value, `${kind}.${field} preserved`);
        }
        // The persisted document stores the flag as true, not a second spelling.
        const archiveDir = roots[roots.length - 1];
        assert.equal(storedRecord(archiveDir, kind, record.id as string).archived, true);

        await store.setArchived(kind, record.id as string, false);
        assert.equal("archived" in recordOf(store.snapshot(), kind, record.id as string)!, false, `${kind} flag removed`);
        assert.deepEqual(
          recordOf(store.snapshot(), kind, record.id as string),
          record,
          `${kind} record restored`,
        );
      } finally {
        await store.close();
      }
    }
  });

  it("persists flags across restart and removes the flag when restored", async () => {
    for (const kind of kinds) {
      const dir = tempDir();
      const store = await openStore(dir);
      const record = await (async () => {
        try {
          const w = await workspace(store);
          const ids = idsOf(w);
          await store.setArchived(kind, ids[kind], true);
          return ids[kind];
        } finally {
          await store.close();
        }
      })();
      assert.equal(storedRecord(dir, kind, record).archived, true, `${kind} stored as true`);
      const reopened = await openStore(dir);
      try {
        assert.equal(
          recordOf(reopened.snapshot(), kind, record)?.archived,
          true,
          `${kind} survives restart`,
        );
        // Restoring removes the flag from the stored document too.
        await reopened.setArchived(kind, record, false);
        assert.equal(
          "archived" in storedRecord(dir, kind, record),
          false,
          `${kind} unarchived persisted`,
        );
      } finally {
        await reopened.close();
      }
      const again = await openStore(dir);
      try {
        assert.equal(
          "archived" in recordOf(again.snapshot(), kind, record)!,
          false,
          `${kind} stays restored`,
        );
      } finally {
        await again.close();
      }
    }
  });

  it("follows normal commit rules on repeated archive and unarchive across families", async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    try {
      const w = await workspace(store);
      const ids = idsOf(w);
      const baseline = store.snapshot();
      for (const kind of kinds) {
        for (let round = 0; round < 3; round += 1) {
          for (const flag of [true, true, false, false]) {
            await store.setArchived(kind, ids[kind], flag);
            const current = recordOf(store.snapshot(), kind, ids[kind])!;
            if (flag) assert.equal(current.archived, true, `${kind} round ${round} archived`);
            else assert.equal("archived" in current, false, `${kind} round ${round} restored`);
            // Nothing but the target's flag changes in its full record, and
            // no counter field is exposed or changed by archival.
            const expected: Record<string, unknown> = {
              ...recordOf(baseline, kind, ids[kind])!,
            };
            if (flag) expected.archived = true;
            assert.deepEqual(current, expected, `${kind} round ${round} full record`);
          }
        }
      }
      // The persisted document reflects the final restored state.
      await store.close();
      const reopened = await openStore(dir);
      try {
        for (const kind of kinds) {
          assert.equal(
            "archived" in recordOf(reopened.snapshot(), kind, ids[kind])!,
            false,
            `${kind} restored after restart`,
          );
        }
        // Counters are untouched by archival: allocation continues past them
        // and archival never consumes or reuses an id.
        const next = await reopened.createClient({ name: "Next" });
        assert.equal(next.id, "client-2");
      } finally {
        await reopened.close();
      }
    } finally {
      await store.close().catch(() => undefined);
    }
  });

  it("preserves counters and flags across ordinary edits", async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    try {
      const w = await workspace(store);
      for (const kind of kinds) {
        await store.setArchived(kind, idsOf(w)[kind], true);
      }
      const counters = JSON.parse(readFileSync(storePath(dir), "utf8")).nextIds;
      const editedClient = await store.updateClient(w.client.id, { name: "Renamed" });
      assert.equal(editedClient.archived, true);
      assert.equal(editedClient.name, "Renamed");
      const editedTask = await store.updateTask(w.task.id, { title: "New title" });
      assert.equal(editedTask.archived, true);
      assert.equal(editedTask.title, "New title");
      assert.deepEqual(JSON.parse(readFileSync(storePath(dir), "utf8")).nextIds, counters);
      // A restore of every family leaves counters exactly unchanged.
      for (const kind of kinds) {
        await store.setArchived(kind, idsOf(w)[kind], false);
      }
      assert.deepEqual(JSON.parse(readFileSync(storePath(dir), "utf8")).nextIds, counters);
      // An ordinary edit input cannot set or clear the flag.
      const created = await store.createTask({
        clientId: w.client.id,
        engagementId: w.engagement.id,
        title: "Plain",
      });
      assert.equal("archived" in created, false, "create input cannot archive");
      // A flagged task keeps its flag when an ordinary edit supplies another.
      await store.setArchived("task", w.task.id, true);
      const cleared = await store.updateTask(w.task.id, {
        title: "Again",
        archived: false,
      } as never);
      assert.equal(cleared.archived, true, "edit input cannot clear the flag");
      const flagged = await store.updateTask(w.task.id, { archived: true } as never);
      assert.equal(flagged.archived, true, "edit input cannot set the flag either");
    } finally {
      await store.close();
    }
  });

  it("keeps independently archived children when restoring a parent", async () => {
    const store = await openStore(tempDir());
    try {
      const w = await workspace(store);
      const extraTask = await store.createTask({
        clientId: w.client.id,
        engagementId: w.engagement.id,
        title: "Sibling task",
      });
      const extraItem = await store.createItem({
        clientId: w.client.id,
        engagementId: w.engagement.id,
        kind: "follow_up",
        title: "Sibling item",
      });
      const extraProject = await store.createProject({
        engagementId: w.engagement.id,
        name: "Sibling project",
      });
      await store.setArchived("client", w.client.id, true);
      await store.setArchived("engagement", w.engagement.id, true);
      await store.setArchived("task", extraTask.id, true);
      await store.setArchived("item", extraItem.id, true);
      await store.setArchived("project", extraProject.id, true);
      // Descendants are never changed by archiving a parent.
      const tasks = store.snapshot().tasks;
      assert.equal(tasks.find((t) => t.id === w.task.id)?.archived, undefined);
      assert.equal(tasks.find((t) => t.id === extraTask.id)?.archived, true);
      assert.equal(store.snapshot().items[0].archived, undefined);
      assert.equal(
        store.snapshot().projects.find((p) => p.id === extraProject.id)?.archived,
        true,
      );
      assert.equal(
        store.snapshot().projects.find((p) => p.id === w.project.id)?.archived,
        undefined,
      );
      // Restoring the parents preserves each child's own flag.
      await store.setArchived("client", w.client.id, false);
      await store.setArchived("engagement", w.engagement.id, false);
      assert.equal(store.snapshot().clients[0].archived, undefined);
      assert.equal(store.snapshot().engagements[0].archived, undefined);
      for (const [kind, id] of [
        ["task", extraTask.id],
        ["item", extraItem.id],
        ["project", extraProject.id],
      ] as const) {
        assert.equal(
          recordOf(store.snapshot(), kind, id)?.archived,
          true,
          `independently archived ${kind} preserved`,
        );
      }
      // The unflagged descendants are visible again because only flags matter.
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
      // Legacy archive keys in a legacy version are still refused.
      for (const extra of [{ archived: true }, { archive: [] }]) {
        const content = JSON.stringify({ ...document, ...extra });
        writeFileSync(storePath(dir), content, "utf8");
        await assert.rejects(openStore(dir), PersistenceError);
        assert.equal(readFileSync(storePath(dir), "utf8"), content);
      }
    }
  });

  it("accepts stored boolean flags on all five families and reads false as active", async () => {
    const dir = tempDir();
    const flags = [true, false, true, false, true] as const;
    const document = {
      schemaVersion: 4,
      clients: [
        { id: "client-1", name: "A", background: "", contacts: "", stakeholders: "", requirements: "", objectives: "", archived: flags[0] },
        { id: "client-2", name: "B", background: "", contacts: "", stakeholders: "", requirements: "", objectives: "" },
      ],
      engagements: [
        { id: "engagement-1", clientId: "client-1", name: "E", objectives: "", status: "planned", archived: flags[1] },
      ],
      projects: [
        { id: "project-1", engagementId: "engagement-1", name: "P", objectives: "", status: "planned", archived: flags[2] },
      ],
      tasks: [
        { id: "task-1", clientId: "client-1", engagementId: "engagement-1", projectId: "project-1", title: "T", status: "open", priority: "normal", owner: "", context: "", archived: flags[3] },
      ],
      items: [
        { id: "item-1", clientId: "client-1", engagementId: "engagement-1", projectId: "project-1", kind: "blocker", title: "I", context: "", state: "open", archived: flags[4] },
      ],
      meetings: [],
      nextIds: { clients: 3, engagements: 2, projects: 2, tasks: 2, items: 2 },
    };
    writeFileSync(storePath(dir), JSON.stringify(document), "utf8");
    const store = await openStore(dir);
    try {
      const snapshot = store.snapshot();
      // Only true means archived; a stored false reads as active.
      assert.equal(snapshot.clients[0].archived, true);
      assert.equal("archived" in snapshot.clients[1], false);
      assert.equal(snapshot.engagements[0].archived, false);
      assert.equal(snapshot.projects[0].archived, true);
      assert.equal(snapshot.tasks[0].archived, false);
      assert.equal(snapshot.items[0].archived, true);
      // A stored false is not rewritten by reading, and setArchived(false)
      // removes the flag while setArchived(true) adds it.
      assert.equal(JSON.parse(readFileSync(storePath(dir), "utf8")).clients[0].archived, true);
      await store.setArchived("engagement", "engagement-1", false);
      assert.equal("archived" in storedRecord(dir, "engagement", "engagement-1"), false);
      await store.setArchived("project", "project-1", false);
      assert.equal("archived" in storedRecord(dir, "project", "project-1"), false);
    } finally {
      await store.close();
    }
    // After restoring, the stored flags the user removed stay removed.
    writeFileSync(storePath(dir), JSON.stringify(document), "utf8");
    const store2 = await openStore(dir);
    try {
      assert.equal(store2.snapshot().engagements[0].archived, false);
      assert.equal(store2.snapshot().projects[0].archived, true);
    } finally {
      await store2.close();
    }
  });

  it("refuses corrupt flags, unknown keys and broken references without touching data", async () => {
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
      // Schema 1 and 3 cannot carry flags on records.
      { ...base, schemaVersion: 3, clients: [{ ...base.clients[0], archived: true }, base.clients[1]], tasks: [], items: [], meetings: [], nextIds: { clients: 3, engagements: 2, projects: 2 } },
      { ...base, schemaVersion: 1, clients: [{ ...base.clients[0], archived: false }, base.clients[1]], nextIds: { clients: 3, engagements: 2, projects: 2 } },
      // Corrupt flags: wrong types, null, and unknown keys in records.
      { ...base, schemaVersion: 4, clients: [{ ...base.clients[0], archived: "true" }, base.clients[1]], tasks: [], items: [], meetings: [], nextIds: { clients: 3, engagements: 2, projects: 2 } },
      { ...base, schemaVersion: 4, clients: [{ ...base.clients[0], archived: 1 }, base.clients[1]], tasks: [], items: [], meetings: [], nextIds: { clients: 3, engagements: 2, projects: 2 } },
      { ...base, schemaVersion: 4, clients: [{ ...base.clients[0], archived: null }, base.clients[1]], tasks: [], items: [], meetings: [], nextIds: { clients: 3, engagements: 2, projects: 2 } },
      { ...base, schemaVersion: 4, clients: [{ ...base.clients[0], archivedAt: "now" }, base.clients[1]], tasks: [], items: [], meetings: [], nextIds: { clients: 3, engagements: 2, projects: 2 } },
      { ...base, schemaVersion: 4, clients: base.clients, engagements: [{ ...base.engagements[0], archived: {} }], projects: base.projects, tasks: [], items: [], meetings: [], nextIds: { clients: 3, engagements: 2, projects: 2 } },
      { ...base, schemaVersion: 4, clients: base.clients, engagements: base.engagements, projects: [{ ...base.projects[0], archived: "yes" }], tasks: [], items: [], meetings: [], nextIds: { clients: 3, engagements: 2, projects: 2 } },
      // Meetings never carry a flag.
      { ...base, schemaVersion: 4, clients: base.clients, engagements: base.engagements, projects: base.projects, tasks: [], items: [], meetings: [{ id: "meeting-1", clientId: "client-1", engagementId: "engagement-1", title: "M", date: "2026-01-01", notes: "", archived: true }], nextIds: { clients: 3, engagements: 2, projects: 2, meetings: 2 } },
      { ...base, schemaVersion: 4, clients: base.clients, engagements: base.engagements, projects: base.projects, tasks: [], items: [], meetings: [{ id: "meeting-1", clientId: "client-1", engagementId: "engagement-1", title: "M", date: "2026-01-01", notes: "", archived: false }], nextIds: { clients: 3, engagements: 2, projects: 2, meetings: 2 } },
      // Broken references still fail opening, even with flags present.
      { ...base, schemaVersion: 4, clients: [{ ...base.clients[0], archived: true }], engagements: [{ ...base.engagements[0], clientId: "client-9" }], projects: base.projects, tasks: [], items: [], meetings: [], nextIds: { clients: 3, engagements: 2, projects: 2 } },
      { ...base, schemaVersion: 4, clients: base.clients, engagements: base.engagements, projects: [{ ...base.projects[0], engagementId: "engagement-9", archived: false }], tasks: [], items: [], meetings: [], nextIds: { clients: 3, engagements: 2, projects: 2 } },
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
  it("archives an unflagged project through an archived client without an engagement flag", async () => {
    const store = await openStore(tempDir());
    try {
      const w = await workspace(store);
      const snapshot = () => store.snapshot();
      await store.setArchived("client", w.client.id, true);
      // The engagement is unflagged, yet the project is hidden through its
      // stored client, resolved via the engagement's clientId.
      const project = snapshot().projects.find((p) => p.id === w.project.id)!;
      assert.equal("archived" in project, false);
      assert.equal(isEffectivelyArchived(snapshot(), project), true);
      assert.equal(archivedReason(snapshot(), project), `client:${w.client.id}`);
      // The engagement itself is also hidden through its stored client.
      const engagement = snapshot().engagements.find((e) => e.id === w.engagement.id)!;
      assert.equal("archived" in engagement, false);
      assert.equal(isEffectivelyArchived(snapshot(), engagement), true);
      assert.equal(archivedReason(snapshot(), engagement), `client:${w.client.id}`);
    } finally {
      await store.close();
    }
  });

  it("resolves real records through their stored parent chains", async () => {
    const store = await openStore(tempDir());
    try {
      const w = await workspace(store);
      const snapshot = () => store.snapshot();
      const client = () => snapshot().clients.find((c) => c.id === w.client.id)!;
      const engagement = () => snapshot().engagements.find((e) => e.id === w.engagement.id)!;
      const project = () => snapshot().projects.find((p) => p.id === w.project.id)!;
      const task = () => snapshot().tasks.find((t) => t.id === w.task.id)!;
      const item = () => snapshot().items.find((i) => i.id === w.item.id)!;
      const meeting = () => snapshot().meetings.find((m) => m.id === w.meeting.id)!;

      // Nothing archived: every actual record is visible, including a client
      // (which has no ancestors) and an engagement (client not archived).
      for (const record of [client(), engagement(), project(), task(), item(), meeting()]) {
        assert.equal(isEffectivelyArchived(snapshot(), record), false);
        assert.equal(archivedReason(snapshot(), record), null);
      }
      assert.deepEqual(ancestorsOf(snapshot(), client()), []);
      assert.deepEqual(
        ancestorsOf(snapshot(), engagement()).map((a) => a.id),
        [w.client.id],
      );
      assert.deepEqual(
        ancestorsOf(snapshot(), project()).map((a) => a.id),
        [w.client.id, w.engagement.id],
      );
      assert.deepEqual(
        ancestorsOf(snapshot(), meeting()).map((a) => a.id),
        [w.client.id, w.engagement.id, w.project.id],
      );

      // Project flag: project, task, item and meeting are hidden; the
      // project's own ancestors stay visible.
      await store.setArchived("project", w.project.id, true);
      assert.equal(isEffectivelyArchived(snapshot(), client()), false);
      assert.equal(isEffectivelyArchived(snapshot(), engagement()), false);
      assert.equal(isEffectivelyArchived(snapshot(), project()), true);
      assert.equal(archivedReason(snapshot(), project()), "self");
      for (const record of [task(), item(), meeting()]) {
        assert.equal(isEffectivelyArchived(snapshot(), record), true);
        assert.equal(archivedReason(snapshot(), record), `project:${w.project.id}`);
      }
      // A meeting inherits visibility without a flag of its own.
      assert.equal("archived" in meeting(), false);

      // Engagement flag: the project and its descendants are hidden, the
      // project reason now names the engagement.
      // A project's own flag is the nearest reason even under an archived
      // parent, so restore it to see the engagement's reason take over.
      await store.setArchived("project", w.project.id, false);
      assert.equal(archivedReason(snapshot(), project()), null);
      await store.setArchived("engagement", w.engagement.id, true);
      assert.equal(archivedReason(snapshot(), engagement()), "self");
      assert.equal(isEffectivelyArchived(snapshot(), project()), true);
      assert.equal(archivedReason(snapshot(), project()), `engagement:${w.engagement.id}`);
      assert.equal(archivedReason(snapshot(), task()), `engagement:${w.engagement.id}`);
      assert.equal(archivedReason(snapshot(), meeting()), `engagement:${w.engagement.id}`);

      // Client flag: the whole tree is hidden; each record's nearest reason is
      // its own flag when set, otherwise the client.
      await store.setArchived("client", w.client.id, true);
      assert.equal(archivedReason(snapshot(), client()), "self");
      // The engagement's own flag is nearer than the client's.
      assert.equal(archivedReason(snapshot(), engagement()), "self");
      assert.equal(archivedReason(snapshot(), meeting()), `client:${w.client.id}`);
      assert.equal(archivedReason(snapshot(), task()), `client:${w.client.id}`);
      await store.setArchived("engagement", w.engagement.id, false);
      assert.equal(archivedReason(snapshot(), engagement()), `client:${w.client.id}`);

      // A record's own flag is the nearest reason even under archived parents.
      await store.setArchived("task", w.task.id, true);
      assert.equal(archivedReason(snapshot(), task()), "self");

      // Restoring the ancestors makes the unflagged descendants visible again
      // while the task keeps its own flag.
      await store.setArchived("client", w.client.id, false);
      await store.setArchived("project", w.project.id, false);
      assert.equal(archivedReason(snapshot(), meeting()), null);
      assert.equal(isEffectivelyArchived(snapshot(), meeting()), false);
      assert.equal(isEffectivelyArchived(snapshot(), task()), true);
      assert.equal(task().archived, true);
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

  /** Seed a persisted workspace and return its directory and record ids. */
  async function seeded(): Promise<{ dir: string; ids: Record<ArchiveKind, string> }> {
    const dir = tempDir();
    const setup = await openStore(dir);
    try {
      const w = await workspace(setup);
      return { dir, ids: idsOf(w) };
    } finally {
      await setup.close();
    }
  }

  it("keeps committed memory when a save fails and never publishes the flag", async () => {
    const { dir, ids } = await seeded();
    const committed = readFileSync(storePath(dir), "utf8");

    const { fs, state } = failingFs();
    const store = await openStore(dir, { fs });
    try {
      assert.equal("archived" in store.snapshot().clients[0], false);
      state.failWrites = true;
      await assert.rejects(store.setArchived("client", ids.client, true), PersistenceError);
      // The failed mutation is never published, in memory or on disk.
      assert.equal("archived" in store.snapshot().clients[0], false);
      assert.equal(readFileSync(storePath(dir), "utf8"), committed);
      assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
      // After the failure, a later save builds on the committed state.
      state.failWrites = false;
      await store.setArchived("client", ids.client, true);
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

  it("rejects a failed archive and unarchive of already-flagged records, then persists later saves", async () => {
    for (const kind of ["task", "item"] as const) {
      const { dir, ids } = await seeded();
      const { fs, state } = failingFs();
      const store = await openStore(dir, { fs });
      try {
        // Reach an archived state, then fail a repeat archive: the record stays
        // archived in memory and on disk, and the failure is rejected.
        await store.setArchived(kind, ids[kind], true);
        const archivedBytes = readFileSync(storePath(dir), "utf8");
        state.failWrites = true;
        await assert.rejects(store.setArchived(kind, ids[kind], true), PersistenceError);
        assert.equal(recordOf(store.snapshot(), kind, ids[kind])?.archived, true);
        assert.equal(readFileSync(storePath(dir), "utf8"), archivedBytes);
        // Fail the restore of the flagged record: it stays archived.
        await assert.rejects(store.setArchived(kind, ids[kind], false), PersistenceError);
        assert.equal(recordOf(store.snapshot(), kind, ids[kind])?.archived, true);
        assert.equal(readFileSync(storePath(dir), "utf8"), archivedBytes);
        state.failWrites = false;
        // Once writes work again the unarchive is committed and persisted.
        await store.setArchived(kind, ids[kind], false);
        assert.equal("archived" in recordOf(store.snapshot(), kind, ids[kind])!, false);
        // A failing flush of the repeated archive likewise publishes nothing.
        state.flushes = 0;
        state.failFirstFlush = true;
        await assert.rejects(store.setArchived(kind, ids[kind], true), PersistenceError);
        assert.equal("archived" in recordOf(store.snapshot(), kind, ids[kind])!, false);
        state.failFirstFlush = false;
        await store.setArchived(kind, ids[kind], true);
        assert.equal(recordOf(store.snapshot(), kind, ids[kind])?.archived, true);
      } finally {
        await store.close();
      }
      const reopened = await openStore(dir);
      try {
        assert.equal(recordOf(reopened.snapshot(), kind, ids[kind])?.archived, true);
      } finally {
        await reopened.close();
      }
    }
  });

  it("restores the prior disk state when a directory flush fails", async () => {
    const { dir, ids } = await seeded();
    const committed = readFileSync(storePath(dir), "utf8");

    const { fs, state } = failingFs();
    const store = await openStore(dir, { fs, platform: "linux" });
    state.flushes = 0;
    state.failFirstFlush = true;
    try {
      // The first directory flush after the replacement fails; the restore's
      // flush then succeeds, so disk and memory keep the committed state.
      await assert.rejects(store.setArchived("client", ids.client, true), PersistenceError);
      assert.equal("archived" in store.snapshot().clients[0], false);
      assert.equal(readFileSync(storePath(dir), "utf8"), committed);
      // A later save is still accepted once the injected failure is removed.
      state.failFirstFlush = false;
      await store.setArchived("client", ids.client, true);
      assert.equal(store.snapshot().clients[0].archived, true);
    } finally {
      await store.close();
    }
  });

  it("blocks mutations when recovery fails and refuses later writes", async () => {
    const { dir, ids } = await seeded();
    const committed = readFileSync(storePath(dir), "utf8");

    const { fs, state } = failingFs();
    const store = await openStore(dir, { fs, platform: "linux" });
    // Fail the replacement's flush and the restore's flush alike.
    state.failFlushes = true;
    try {
      await assert.rejects(store.setArchived("client", ids.client, true), (error: unknown) => {
        assert.ok(error instanceof PersistenceError);
        assert.match(error.message, /could not restore the previous state/i);
        return true;
      });
      // The failed flag is never published, and every later mutation is refused
      // until the store is reopened, including a valid unarchive of the record.
      assert.equal("archived" in store.snapshot().clients[0], false);
      await assert.rejects(store.setArchived("client", ids.client, true), PersistenceError);
      await assert.rejects(store.setArchived("client", ids.client, false), PersistenceError);
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
      await reopened.setArchived("client", ids.client, true);
      assert.equal(reopened.snapshot().clients[0].archived, true);
    } finally {
      await reopened.close();
    }
  });

  it("refuses mutations on a closed store with lifecycle precedence", async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    const w = await workspace(store);
    await store.close();
    // A closed store refuses the mutation with a persistence error, exactly as
    // it refuses every other mutation, even when the arguments are invalid.
    await assert.rejects(store.setArchived("client", w.client.id, true), PersistenceError);
    await assert.rejects(
      store.setArchived("bogus" as ArchiveKind, w.client.id, true),
      (error: unknown) => error instanceof PersistenceError && /closed/i.test(error.message),
    );
    await assert.rejects(
      store.setArchived("client", 42 as unknown as string, "yes" as unknown as boolean),
      PersistenceError,
    );
    // Reopening shows nothing was published.
    const reopened = await openStore(dir);
    try {
      assert.equal("archived" in reopened.snapshot().clients[0], false);
    } finally {
      await reopened.close();
    }
  });

  it("refuses archival on a blocked store before validating arguments", async () => {
    const { dir, ids } = await seeded();
    const { fs, state } = failingFs();
    const store = await openStore(dir, { fs, platform: "linux" });
    state.failFlushes = true;
    try {
      await assert.rejects(store.setArchived("client", ids.client, true), PersistenceError);
      // The store is now blocked; even a bad kind is refused by the lifecycle
      // check, never published and never validated first.
      await assert.rejects(
        store.setArchived("bogus" as ArchiveKind, ids.client, true),
        (error: unknown) =>
          error instanceof PersistenceError &&
          /cannot accept further mutations/i.test(error.message),
      );
      assert.equal("archived" in store.snapshot().clients[0], false);
    } finally {
      state.failFlushes = false;
      await store.close();
    }
  });
});
