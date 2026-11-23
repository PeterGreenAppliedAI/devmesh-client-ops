import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  ACTIVITY_ACTIONS,
  ACTIVITY_TARGET_KINDS,
  allocateActivityId,
  parseActivityEvent,
  type ActivityEvent,
} from "../src/activity.ts";
import {
  openStore,
  PersistenceError,
  ValidationError,
  type Snapshot,
  type Store,
} from "../src/store.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "activity-"));
  roots.push(dir);
  return dir;
}

function storePath(dir: string): string {
  return join(dir, "workspace.json");
}

function lockPath(dir: string): string {
  return join(dir, "workspace.lock");
}

/** A stored document with one record of every target family. */
function documentWithEveryFamily(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 5,
    clients: [
      {
        id: "client-1",
        name: "Acme",
        background: "",
        contacts: "",
        stakeholders: "",
        requirements: "",
        objectives: "",
      },
    ],
    engagements: [
      { id: "engagement-1", clientId: "client-1", name: "E", objectives: "", status: "planned" },
    ],
    projects: [
      { id: "project-1", engagementId: "engagement-1", name: "P", objectives: "", status: "planned" },
    ],
    tasks: [
      {
        id: "task-1",
        clientId: "client-1",
        engagementId: "engagement-1",
        title: "T",
        status: "open",
        priority: "normal",
        owner: "",
        context: "",
      },
    ],
    items: [
      {
        id: "item-1",
        clientId: "client-1",
        engagementId: "engagement-1",
        kind: "blocker",
        title: "I",
        context: "",
        state: "open",
      },
    ],
    meetings: [
      {
        id: "meeting-1",
        clientId: "client-1",
        engagementId: "engagement-1",
        title: "M",
        date: "2026-01-01",
        notes: "",
      },
    ],
    activity: [],
    nextActivityId: 1,
    nextIds: { clients: 2, engagements: 2, projects: 2, tasks: 2, items: 2, meetings: 2 },
    ...overrides,
  };
}

/** A valid base event; overrides are untyped so malformed values can be built. */
function event(overrides: Record<string, unknown> = {}): ActivityEvent {
  return {
    id: 1,
    at: "2026-02-03T04:05:06.007Z",
    action: "create",
    targetKind: "client",
    targetId: "client-1",
    ...overrides,
  } as ActivityEvent;
}

/** Write a document, expect opening to fail, and check file and lock are kept. */
async function assertRefused(dir: string, value: unknown, pattern?: RegExp): Promise<void> {
  const content = JSON.stringify(value);
  writeFileSync(storePath(dir), content, "utf8");
  await assert.rejects(openStore(dir), (error: unknown) => {
    assert.ok(error instanceof PersistenceError, `expected PersistenceError, got ${String(error)}`);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
  assert.equal(readFileSync(storePath(dir), "utf8"), content, "stored file left untouched");
  assert.equal(existsSync(lockPath(dir)), false, "lock released");
}

/** Create a client in an otherwise empty workspace, for valid targets. */
async function hierarchy(store: Store) {
  const client = await store.createClient({ name: "Acme" });
  const engagement = await store.createEngagement({ clientId: client.id, name: "Eng" });
  const project = await store.createProject({ engagementId: engagement.id, name: "P" });
  return { client, engagement, project };
}

describe("activity journal storage", () => {
  it("starts new workspaces with an empty journal and round-trips it", async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    try {
      const snapshot = store.snapshot();
      assert.deepEqual(snapshot.activity, []);

      // The first ordinary save writes the schema 5 document with an empty
      // journal; opening an empty directory writes nothing on its own.
      await hierarchy(store);
    } finally {
      await store.close();
    }
    const saved = JSON.parse(readFileSync(storePath(dir), "utf8"));
    assert.equal(saved.schemaVersion, 5);
    assert.deepEqual(saved.activity, []);
    assert.equal(saved.nextActivityId, 1);

    const reopened = await openStore(dir);
    try {
      assert.deepEqual(reopened.snapshot().activity, []);
    } finally {
      await reopened.close();
    }
  });

  it("reads and rewrites a stored journal faithfully", async () => {
    const dir = tempDir();
    const journal = [
      event({ id: 1 }),
      event({ id: 3, action: "edit", targetKind: "task", targetId: "task-1" }),
      event({ id: 4, action: "archive", targetKind: "project", targetId: "project-1" }),
      event({ id: 5, action: "restore", targetKind: "item", targetId: "item-1" }),
      event({ id: 6, action: "edit", targetKind: "meeting", targetId: "meeting-1" }),
      event({ id: 7, action: "edit", targetKind: "engagement", targetId: "engagement-1" }),
    ];
    writeFileSync(
      storePath(dir),
      JSON.stringify(documentWithEveryFamily({ activity: journal, nextActivityId: 8 })),
      "utf8",
    );
    const store = await openStore(dir);
    try {
      const snapshot = store.snapshot();
      assert.deepEqual(snapshot.activity, journal);
      // The snapshot journal is detached and frozen, so callers cannot mutate
      // the committed journal.
      assert.ok(Object.isFrozen(snapshot.activity));
      assert.ok(Object.isFrozen(snapshot.activity![0]));
      assert.notEqual(snapshot.activity, store.snapshot().activity);
      // An ordinary save rewrites the journal unchanged at the current schema.
      await store.updateClient("client-1", { name: "Renamed" });
    } finally {
      await store.close();
    }
    const saved = JSON.parse(readFileSync(storePath(dir), "utf8"));
    assert.equal(saved.schemaVersion, 5);
    assert.deepEqual(saved.activity, journal);
    assert.equal(saved.nextActivityId, 8);

    const reopened = await openStore(dir);
    try {
      assert.deepEqual(reopened.snapshot().activity, journal);
      assert.equal(reopened.snapshot().clients[0].name, "Renamed");
    } finally {
      await reopened.close();
    }
  });

  it("accepts schemas 1, 3 and 4 with an empty in-memory journal and no open-time rewrite", async () => {
    const documents: unknown[] = [
      {
        schemaVersion: 1,
        clients: [
          {
            id: "client-1",
            name: "Acme",
            background: "",
            contacts: "",
            stakeholders: "",
            requirements: "",
            objectives: "",
          },
        ],
        engagements: [],
        projects: [],
        nextIds: { clients: 2 },
      },
      {
        schemaVersion: 3,
        clients: [],
        engagements: [],
        projects: [],
        tasks: [],
        items: [],
        meetings: [],
        nextIds: {},
      },
      {
        schemaVersion: 4,
        clients: [{ id: "client-1", name: "Acme", background: "", contacts: "", stakeholders: "", requirements: "", objectives: "", archived: true }],
        engagements: [],
        projects: [],
        tasks: [],
        items: [],
        meetings: [],
        nextIds: { clients: 2 },
      },
    ];
    for (const document of documents) {
      const dir = tempDir();
      const content = JSON.stringify(document);
      writeFileSync(storePath(dir), content, "utf8");
      const store = await openStore(dir);
      try {
        const snapshot = store.snapshot();
        assert.deepEqual(snapshot.activity, [], `schema ${(document as { schemaVersion: number }).schemaVersion} journal`);
        assert.equal(existsSync(lockPath(dir)), true, "store holds its lock while open");
        // Opening never rewrites the file, so no history is invented on read.
        assert.equal(readFileSync(storePath(dir), "utf8"), content);
      } finally {
        await store.close();
      }
      assert.equal(readFileSync(storePath(dir), "utf8"), content);
      // An ordinary successful save upgrades to schema 5 with an empty journal.
      if ((document as { schemaVersion: number }).schemaVersion === 4) {
        const saving = await openStore(dir);
        try {
          await saving.setArchived("client", "client-1", false);
        } finally {
          await saving.close();
        }
        const saved = JSON.parse(readFileSync(storePath(dir), "utf8"));
        assert.equal(saved.schemaVersion, 5);
        assert.deepEqual(saved.activity, []);
        assert.equal(saved.nextActivityId, 1);
      }
      if ((document as { schemaVersion: number }).schemaVersion === 1) {
        const saving = await openStore(dir);
        try {
          await saving.updateClient("client-1", { name: "Renamed" });
        } finally {
          await saving.close();
        }
        const saved = JSON.parse(readFileSync(storePath(dir), "utf8"));
        assert.equal(saved.schemaVersion, 5);
        assert.deepEqual(saved.activity, []);
        assert.equal(saved.nextActivityId, 1);
      }
    }
  });

  it("refuses a failed save's upgrade without rewriting the file", async () => {
    // A save that fails must leave the legacy file exactly as it was, so the
    // upgrade only happens on an ordinary successful save.
    const dir = tempDir();
    const content = JSON.stringify({
      schemaVersion: 1,
      clients: [
        { id: "client-1", name: "Acme", background: "", contacts: "", stakeholders: "", requirements: "", objectives: "" },
      ],
      engagements: [],
      projects: [],
      nextIds: { clients: 2 },
    });
    writeFileSync(storePath(dir), content, "utf8");
    // Inject a write failure only for the store's temporary save file, so lock
    // acquisition still succeeds but the save cannot complete.
    // The injected failure starts only after the store is open.
    let failing = false;
    const store = await openStore(dir, {
      fs: {
        writeSync: (fd: number, data: Uint8Array) => {
          if (failing) throw new Error("simulated write failure");
          return writeSync(fd, data);
        },
      },
    });
    failing = true;
    try {
      await assert.rejects(store.updateClient("client-1", { name: "Renamed" }), PersistenceError);
      assert.equal(readFileSync(storePath(dir), "utf8"), content);
      assert.deepEqual(store.snapshot().activity, []);
    } finally {
      await store.close();
    }
  });

  it("refuses a version 4 document that already carries journal fields", async () => {
    const dir = tempDir();
    const base = documentWithEveryFamily({ schemaVersion: 4 });
    delete (base as Record<string, unknown>).activity;
    delete (base as Record<string, unknown>).nextActivityId;
    for (const extra of [{ activity: [] }, { nextActivityId: 1 }, { activity: [], nextActivityId: 1 }]) {
      await assertRefused(dir, { ...base, ...extra }, /unsupported field/);
    }
  });

  it("refuses a schema 5 document that lacks or misplaces the journal fields", async () => {
    const dir = tempDir();
    const base = documentWithEveryFamily();
    const withoutActivity = { ...base };
    delete (withoutActivity as Record<string, unknown>).activity;
    await assertRefused(dir, withoutActivity, /invalid/);
    const withoutCounter = { ...base };
    delete (withoutCounter as Record<string, unknown>).nextActivityId;
    await assertRefused(dir, withoutCounter, /invalid/);
    await assertRefused(dir, { ...base, activity: {} });
    await assertRefused(dir, { ...base, activity: "none" });
    await assertRefused(dir, { ...base, nextIds: { clients: 2 } });
    await assertRefused(dir, { ...base, extra: true }, /unsupported field/);
  });

  it("refuses malformed events under the strict event rules", async () => {
    // Each case names the rule it isolates, so a case that is refused for some
    // other reason cannot hide a missing check. Every journal here carries a
    // counter of 2, which is valid for the single event id 1 these cases use,
    // so the only possible refusal is that event's own rule.
    const dir = tempDir();
    const single: unknown[][] = [
      // Exact keys: an unknown field is refused.
      [{ ...event(), extra: true }],
      // Every missing field is refused, one case per field.
      [{ at: "2026-02-03T04:05:06.007Z", action: "create", targetKind: "client", targetId: "client-1" }],
      [{ id: 1, action: "create", targetKind: "client", targetId: "client-1" }],
      [{ id: 1, at: "2026-02-03T04:05:06.007Z", targetKind: "client", targetId: "client-1" }],
      [{ id: 1, at: "2026-02-03T04:05:06.007Z", action: "create", targetId: "client-1" }],
      [{ id: 1, at: "2026-02-03T04:05:06.007Z", action: "create", targetKind: "client" }],
      // An event must be an object.
      ["not an event"],
      [null],
      [[event()]],
      // Invalid IDs: non-positive, non-integer, unsafe, at the ceiling, string.
      [event({ id: 0 })],
      [event({ id: -1 })],
      [event({ id: 1.5 })],
      [event({ id: Number.MAX_SAFE_INTEGER })],
      [event({ id: Number.MAX_SAFE_INTEGER + 2 })],
      [event({ id: "1" })],
      [event({ id: null })],
      // Invalid timestamps: not canonical UTC, impossible, or offset.
      [event({ at: "2026-02-03T04:05:06Z" })],
      [event({ at: "2026-02-03T04:05:06.07Z" })],
      [event({ at: "2026-02-03T04:05:06.007+00:00" })],
      [event({ at: "2026-02-03T04:05:06.007" })],
      [event({ at: "2026-02-03 04:05:06.007Z" })],
      [event({ at: "2026-02-03T04:05:06.007Z\n" })],
      [event({ at: "2026-02-03T04:05:06.007Z\r\n" })],
      [event({ at: "2023-02-29T00:00:00.000Z" })],
      [event({ at: "2026-13-01T00:00:00.000Z" })],
      [event({ at: "2026-02-03T24:00:00.000Z" })],
      [event({ at: "" })],
      [event({ at: 1700000000000 })],
      // Invalid actions and target kinds.
      [event({ action: "delete" })],
      [event({ action: "CREATE" })],
      [event({ action: null })],
      [event({ targetKind: "workspace" })],
      [event({ targetKind: "Client" })],
      // A target id must be a string.
      [event({ targetId: 42 })],
      [event({ targetId: null })],
      // Targets must exist.
      [event({ targetKind: "task", targetId: "task-9" })],
      [event({ targetKind: "task", targetId: "client-1" })],
      [event({ targetKind: "engagement", targetId: "engagement-9" })],
      [event({ targetKind: "project", targetId: "project-9" })],
      [event({ targetKind: "item", targetId: "item-9" })],
      [event({ targetKind: "meeting", targetId: "meeting-9" })],
      [event({ targetKind: "meeting", targetId: "client-1" })],
      // Meetings are never archived or restored.
      [event({ action: "archive", targetKind: "meeting", targetId: "meeting-1" })],
      [event({ action: "restore", targetKind: "meeting", targetId: "meeting-1" })],
    ];
    for (const activity of single) {
      await assertRefused(
        dir,
        documentWithEveryFamily({ activity, nextActivityId: 2 }),
      );
    }
    // Duplicate IDs: the counter is valid either way, so the duplicate alone is
    // what refuses the journal.
    for (const activity of [
      [event({ id: 1 }), event({ id: 1, action: "edit" })],
      [event({ id: 2 }), event({ id: 2, action: "edit" })],
      [event({ id: 1 }), event({ id: 2, action: "edit" }), event({ id: 1 })],
    ]) {
      await assertRefused(
        dir,
        documentWithEveryFamily({ activity, nextActivityId: 3 }),
      );
    }
    // The same strict rules apply when parsing an event directly. These cases
    // need no document, so their target-existence cases are checked above.
    const perEventCases = [
      { ...event(), extra: true },
      { at: "2026-02-03T04:05:06.007Z", action: "create", targetKind: "client", targetId: "client-1" },
      { id: 1, action: "create", targetKind: "client", targetId: "client-1" },
      { id: 1, at: "2026-02-03T04:05:06.007Z", targetKind: "client", targetId: "client-1" },
      { id: 1, at: "2026-02-03T04:05:06.007Z", action: "create", targetId: "client-1" },
      { id: 1, at: "2026-02-03T04:05:06.007Z", action: "create", targetKind: "client" },
      "not an event",
      null,
      [event()],
      event({ id: 0 }),
      event({ id: -1 }),
      event({ id: 1.5 }),
      event({ id: Number.MAX_SAFE_INTEGER }),
      event({ id: Number.MAX_SAFE_INTEGER + 2 }),
      event({ id: "1" }),
      event({ id: null }),
      event({ at: "2026-02-03T04:05:06Z" }),
      event({ at: "2026-02-03T04:05:06.07Z" }),
      event({ at: "2026-02-03T04:05:06.007+00:00" }),
      event({ at: "2026-02-03T04:05:06.007" }),
      event({ at: "2026-02-03 04:05:06.007Z" }),
      event({ at: "2026-02-03T04:05:06.007Z\n" }),
      event({ at: "2026-02-03T04:05:06.007Z\r\n" }),
      event({ at: "2023-02-29T00:00:00.000Z" }),
      event({ at: "2026-13-01T00:00:00.000Z" }),
      event({ at: "2026-02-03T24:00:00.000Z" }),
      event({ at: "" }),
      event({ at: 1700000000000 }),
      event({ action: "delete" }),
      event({ action: "CREATE" }),
      event({ action: null }),
      event({ targetKind: "workspace" }),
      event({ targetKind: "Client" }),
      event({ targetId: 42 }),
      event({ targetId: null }),
      event({ action: "archive", targetKind: "meeting", targetId: "meeting-1" }),
      event({ action: "restore", targetKind: "meeting", targetId: "meeting-1" }),
    ];
    for (const value of perEventCases) {
      assert.throws(() => parseActivityEvent(value), ValidationError);
    }
    // A canonical UTC timestamp is accepted at the calendar extremes that are
    // real instants, including year zero.
    for (const at of [
      "0000-01-01T00:00:00.000Z",
      "0000-02-29T00:00:00.000Z",
      "2024-02-29T23:59:59.999Z",
      "9999-12-31T23:59:59.999Z",
    ]) {
      assert.equal(parseActivityEvent(event({ at })).at, at);
    }
  });

  it("accepts a stored journal whose events are not in id order", async () => {
    // Validation is about unique identity, not storage order: a journal with
    // ids 2 then 1 and a counter of 3 is a valid journal.
    const dir = tempDir();
    const activity = [
      event({ id: 2, action: "edit" }),
      event({ id: 1, action: "create" }),
    ];
    writeFileSync(
      storePath(dir),
      JSON.stringify(documentWithEveryFamily({ activity, nextActivityId: 3 })),
      "utf8",
    );
    const store = await openStore(dir);
    try {
      assert.deepEqual(store.snapshot().activity, activity);
    } finally {
      await store.close();
    }
  });

  it("refuses counter values that cannot advance past every event id", async () => {
    const dir = tempDir();
    const twoEvents = [event({ id: 1 }), event({ id: 2, action: "edit", targetId: "client-1" })];
    for (const nextActivityId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2, "2", null]) {
      await assertRefused(dir, documentWithEveryFamily({ activity: twoEvents, nextActivityId }));
    }
    // A counter equal to or below an existing id would reproduce it.
    for (const nextActivityId of [1, 2]) {
      await assertRefused(dir, documentWithEveryFamily({ activity: twoEvents, nextActivityId }));
    }
    // A counter above the highest id is accepted and survives a save unchanged.
    writeFileSync(
      storePath(dir),
      JSON.stringify(documentWithEveryFamily({ activity: twoEvents, nextActivityId: 3 })),
      "utf8",
    );
    const store = await openStore(dir);
    try {
      assert.equal(store.snapshot().activity!.length, 2);
      await store.updateClient("client-1", { name: "Renamed" });
    } finally {
      await store.close();
    }
    assert.equal(JSON.parse(readFileSync(storePath(dir), "utf8")).nextActivityId, 3);
  });

  it("accepts an exhausted journal and keeps its ceiling counter on save", async () => {
    // The highest usable event id is the ceiling minus one; the counter that
    // follows it is the ceiling itself, which the task allows as a stored
    // value. It is not clamped, and the exhausted journal can still be saved.
    const dir = tempDir();
    const highest = Number.MAX_SAFE_INTEGER - 1;
    const activity = [event({ id: highest })];
    writeFileSync(
      storePath(dir),
      JSON.stringify(documentWithEveryFamily({ activity, nextActivityId: Number.MAX_SAFE_INTEGER })),
      "utf8",
    );
    const store = await openStore(dir);
    try {
      assert.deepEqual(store.snapshot().activity, activity);
      await store.updateClient("client-1", { name: "Renamed" });
    } finally {
      await store.close();
    }
    const saved = JSON.parse(readFileSync(storePath(dir), "utf8"));
    assert.equal(saved.nextActivityId, Number.MAX_SAFE_INTEGER);
    assert.deepEqual(saved.activity, activity);

    const reopened = await openStore(dir);
    try {
      assert.equal(reopened.snapshot().activity![0].id, highest);
    } finally {
      await reopened.close();
    }
  });

  it("refuses journal allocation once the counter reaches the ceiling", () => {
    // Allocation at the ceiling fails and leaves the state unchanged: no event
    // is captured and the counter does not move past what can be represented.
    const state: { activity: ActivityEvent[]; nextActivityId: number } = {
      activity: [],
      nextActivityId: Number.MAX_SAFE_INTEGER,
    };
    assert.throws(() => allocateActivityId(state), ValidationError);
    assert.equal(state.nextActivityId, Number.MAX_SAFE_INTEGER);
    assert.deepEqual(state.activity, []);

    // Allocation still advances below the ceiling, skipping a used id.
    const usable = { activity: [event({ id: 4 })], nextActivityId: 4 };
    assert.throws(() => allocateActivityId(usable), ValidationError);
    assert.equal(usable.nextActivityId, 4);
    assert.equal(allocateActivityId({ activity: [event({ id: 4 })], nextActivityId: 5 }), 5);
    const next = { activity: [], nextActivityId: 1 };
    assert.equal(allocateActivityId(next), 1);
    assert.equal(next.nextActivityId, 2);
  });

  it("exposes the fixed action and target lists", () => {
    assert.deepEqual(ACTIVITY_ACTIONS, ["create", "edit", "archive", "restore"]);
    assert.deepEqual(ACTIVITY_TARGET_KINDS, [
      "client",
      "engagement",
      "project",
      "task",
      "item",
      "meeting",
    ]);
  });

  it("preserves a corrupt file and releases the lock", async () => {
    const dir = tempDir();
    // Not valid JSON at all.
    const content = "{ this is not json";
    writeFileSync(storePath(dir), content, "utf8");
    await assert.rejects(openStore(dir), PersistenceError);
    assert.equal(readFileSync(storePath(dir), "utf8"), content, "stored file left untouched");
    assert.equal(existsSync(lockPath(dir)), false, "lock released");
    // A valid document whose journal is corrupt.
    for (const activity of [
      [event({ targetId: "client-9" })],
      [event({ id: 2 }), event({ id: 2 })],
      [event({ action: "archive", targetKind: "meeting", targetId: "meeting-1" })],
      [event({ at: "yesterday" })],
    ]) {
      await assertRefused(dir, documentWithEveryFamily({ activity }));
    }
  });

  it("keeps the journal counter separate from the record counters", async () => {
    const dir = tempDir();
    writeFileSync(
      storePath(dir),
      JSON.stringify(documentWithEveryFamily({ activity: [event({ id: 9 })], nextActivityId: 10 })),
      "utf8",
    );
    const store = await openStore(dir);
    try {
      const task = await store.createTask({
        clientId: "client-1",
        engagementId: "engagement-1",
        title: "Next task",
      });
      // Record ids continue from the record counters and event ids are untouched.
      assert.equal(task.id, "task-2");
      assert.equal(store.snapshot().activity![0].id, 9);
    } finally {
      await store.close();
    }
    const saved = JSON.parse(readFileSync(storePath(dir), "utf8"));
    assert.equal(saved.nextIds.tasks, 3);
    assert.equal(saved.nextActivityId, 10);
    assert.deepEqual(saved.activity, [event({ id: 9 })]);
  });

  it("keeps a hand-built snapshot's missing journal as empty", async () => {
    // Existing hand-built snapshots omit `activity`. Typed as the production
    // Snapshot, the fixture only compiles because the interface makes the
    // journal optional; its absent journal is then read as empty.
    const withoutJournal: Snapshot = {
      clients: [],
      engagements: [],
      projects: [],
      tasks: [],
      items: [],
      meetings: [],
    };
    assert.equal(withoutJournal.activity, undefined);
    const store = await openStore(tempDir());
    try {
      assert.deepEqual(store.snapshot().activity, []);
    } finally {
      await store.close();
    }
  });
});
