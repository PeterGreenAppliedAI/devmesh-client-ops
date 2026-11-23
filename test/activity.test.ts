/**
 * The activity journal as a behaviour: every successful effective create, edit,
 * archive or restore appends exactly one event to the same write as its record
 * change, no-op mutations save without one, and the recent-activity view shows
 * the latest 20 visible events against the current records and ancestry.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  renameSync as renameSyncImpl,
  writeSync as writeSyncImpl,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  RECENT_ACTIVITY_LIMIT,
  selectRecentActivity,
  type ActivityEvent,
  type ActivityView,
} from "../src/activity.ts";
import {
  openStore,
  PersistenceError,
  selectRecentActivity as selectFromStore,
  type FileSystem,
  type Store,
  type StoreOptions,
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

const fixedAt = "2026-02-03T04:05:06.007Z";

/** A clock that returns a fixed instant, or the scripted instants in turn. */
function clock(at: string | string[] = fixedAt): () => Date {
  let index = 0;
  const values = Array.isArray(at) ? at : [at];
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return new Date(value);
  };
}

/** A clock whose every call fails. */
function failingClock(): () => Date {
  return () => {
    throw new Error("clock failure");
  };
}

/** A clock that returns something that is not a Date. */
function invalidClock(): () => Date {
  return () => "not a date" as unknown as Date;
}

/** A clock that returns a Date with no instant (`new Date(NaN)`). */
function invalidDateClock(): () => Date {
  return () => new Date(Number.NaN);
}

/** A date-like object whose instant conversion throws. */
function throwingDateClock(): () => Date {
  return () =>
    ({
      getUTCFullYear: () => 2026,
      getTime: () => Date.UTC(2026, 0, 1),
      toISOString: () => {
        throw new RangeError("Invalid time value");
      },
    }) as unknown as Date;
}

/** A real `Date` whose `toISOString` returns impossible canonical text. */
function impossibleIsoClock(): () => Date {
  return () => {
    const date = new Date(Date.UTC(2026, 0, 1));
    date.toISOString = () => "2026-13-01T00:00:00.000Z";
    return date;
  };
}

/** A real `Date` whose `toISOString` text disagrees with its instant. */
function mismatchedIsoClock(): () => Date {
  return () => {
    const date = new Date(Date.UTC(2026, 0, 1));
    date.toISOString = () => "2026-07-01T00:00:00.000Z";
    return date;
  };
}


function fsError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** The values of one record of each family, as a complete document carries them. */
const base = {
  client: {
    id: "client-1",
    name: "Acme",
    background: "",
    contacts: "",
    stakeholders: "",
    requirements: "",
    objectives: "",
  },
  engagement: {
    id: "engagement-1",
    clientId: "client-1",
    name: "Eng",
    objectives: "",
    status: "planned",
  },
  project: {
    id: "project-1",
    engagementId: "engagement-1",
    name: "Proj",
    objectives: "",
    status: "planned",
  },
  task: {
    id: "task-1",
    clientId: "client-1",
    engagementId: "engagement-1",
    title: "Task",
    status: "open",
    priority: "normal",
    owner: "",
    context: "",
  },
  item: {
    id: "item-1",
    clientId: "client-1",
    engagementId: "engagement-1",
    kind: "blocker",
    title: "Item",
    context: "",
    state: "open",
  },
  meeting: {
    id: "meeting-1",
    clientId: "client-1",
    engagementId: "engagement-1",
    title: "Meeting",
    date: "2026-01-05",
    notes: "",
  },
};

/** A view with one record of every family; overlays replace whole fields. */
function view(overrides: Record<string, unknown> = {}): ActivityView {
  return {
    clients: [{ ...base.client }],
    engagements: [{ ...base.engagement }],
    projects: [{ ...base.project }],
    tasks: [{ ...base.task }],
    items: [{ ...base.item }],
    meetings: [{ ...base.meeting }],
    activity: [],
    ...overrides,
  } as ActivityView;
}

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: 1,
    at: fixedAt,
    action: "create",
    targetKind: "client",
    targetId: "client-1",
    ...overrides,
  };
}

/** One readable string per selected event. */
function targets(events: readonly ActivityEvent[]): string[] {
  return events.map((e) => `${e.action}:${e.targetKind}:${e.targetId}`);
}

/** One readable string per stored event, in stored order. */
function recorded(store: Store): string[] {
  return targets(store.snapshot().activity ?? []);
}

/** A fresh workspace with one record of every family under one client. */
async function workspace(store: Store) {
  const client = await store.createClient({ name: "Acme" });
  const engagement = await store.createEngagement({ clientId: client.id, name: "Eng" });
  const project = await store.createProject({ engagementId: engagement.id, name: "Proj" });
  const links = { clientId: client.id, engagementId: engagement.id, projectId: project.id };
  const task = await store.createTask({ ...links, title: "Task" });
  const item = await store.createItem({ ...links, kind: "blocker", title: "Item" });
  const meeting = await store.createMeeting({ ...links, title: "Meeting", date: "2026-01-05" });
  return { client, engagement, project, task, item, meeting, links };
}

type Family = "client" | "engagement" | "project" | "task" | "item" | "meeting";
const FAMILIES: readonly Family[] = [
  "client",
  "engagement",
  "project",
  "task",
  "item",
  "meeting",
];
const ARCHIVE_FAMILIES: readonly Family[] = ["client", "engagement", "project", "task", "item"];

function recordOf(w: Awaited<ReturnType<typeof workspace>>, family: Family): { id: string } {
  return w[family];
}

/** Update one record of a family with a changed value: an effective edit. */
function edit(
  store: Store,
  family: Family,
  id: string,
): Promise<unknown> {
  switch (family) {
    case "client":
      return store.updateClient(id, { name: "Edited client" });
    case "engagement":
      return store.updateEngagement(id, { name: "Edited engagement" });
    case "project":
      return store.updateProject(id, { name: "Edited project" });
    case "task":
      return store.updateTask(id, { title: "Edited task" });
    case "item":
      return store.updateItem(id, { title: "Edited item" });
    case "meeting":
      return store.updateMeeting(id, { title: "Edited meeting" });
  }
}

/** Update one record with the values it already holds: a no-op edit. */
function sameEdit(store: Store, family: Family, id: string): Promise<unknown> {
  switch (family) {
    case "client":
      return store.updateClient(id, { name: "Acme" });
    case "engagement":
      return store.updateEngagement(id, { name: "Eng" });
    case "project":
      return store.updateProject(id, { name: "Proj" });
    case "task":
      return store.updateTask(id, { title: "Task" });
    case "item":
      return store.updateItem(id, { title: "Item" });
    case "meeting":
      return store.updateMeeting(id, { title: "Meeting" });
  }
}

function archive(store: Store, family: Family, id: string, archived: boolean): Promise<void> {
  return store.setArchived(family as never, id, archived);
}

/** A directory's own files, so temporary save files can be spotted. */
function tempFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

describe("each effective create, edit, archive and restore records one event", () => {
  it("records exactly one create event per family, in that create's own save", async () => {
    const cases: { family: Family; make: (store: Store) => Promise<{ id: string }> }[] = [
      { family: "client", make: (s) => s.createClient({ name: "Acme" }) },
      {
        family: "engagement",
        make: async (s) => {
          const c = await s.createClient({ name: "Acme" });
          return s.createEngagement({ clientId: c.id, name: "Eng" });
        },
      },
      {
        family: "project",
        make: async (s) => {
          const c = await s.createClient({ name: "Acme" });
          const e = await s.createEngagement({ clientId: c.id, name: "Eng" });
          return s.createProject({ engagementId: e.id, name: "Proj" });
        },
      },
      {
        family: "task",
        make: async (s) => {
          const c = await s.createClient({ name: "Acme" });
          const e = await s.createEngagement({ clientId: c.id, name: "Eng" });
          return s.createTask({ clientId: c.id, engagementId: e.id, title: "Task" });
        },
      },
      {
        family: "item",
        make: async (s) => {
          const c = await s.createClient({ name: "Acme" });
          const e = await s.createEngagement({ clientId: c.id, name: "Eng" });
          return s.createItem({ clientId: c.id, engagementId: e.id, kind: "blocker", title: "Item" });
        },
      },
      {
        family: "meeting",
        make: async (s) => {
          const c = await s.createClient({ name: "Acme" });
          const e = await s.createEngagement({ clientId: c.id, name: "Eng" });
          return s.createMeeting({
            clientId: c.id,
            engagementId: e.id,
            title: "Meeting",
            date: "2026-01-05",
          });
        },
      },
    ];
    for (const { family, make } of cases) {
      const dir = tempDir();
      const store = await openStore(dir, { now: clock() });
      let record: { id: string };
      let journal: readonly ActivityEvent[];
      try {
        record = await make(store);
        journal = store.snapshot().activity!;
        const mine = journal.filter((e) => e.targetKind === family && e.targetId === record.id);
        assert.deepEqual(
          mine,
          [event({ id: journal.length, action: "create", targetKind: family, targetId: record.id })],
          `${family} create records its own event`,
        );
        assert.equal(existsSync(storePath(dir)), true, `${family} create wrote the document`);
        assert.deepEqual(tempFiles(dir), [], `${family} create left no temporary file`);
      } finally {
        await store.close();
      }
      // The event is in the same document as the record, and survives restart.
      const saved = JSON.parse(readFileSync(storePath(dir), "utf8"));
      assert.deepEqual(
        saved.activity.at(-1),
        event({
          id: saved.activity.length,
          action: "create",
          targetKind: family,
          targetId: record!.id,
        }),
        `${family} create event persisted`,
      );
      assert.equal(saved.nextActivityId, saved.activity.length + 1, `${family} counter advanced`);
      assert.equal(saved[famPlural(family)].some((r: { id: string }) => r.id === record!.id), true);
      const reopened = await openStore(dir);
      try {
        assert.deepEqual(reopened.snapshot().activity, saved.activity);
      } finally {
        await reopened.close();
      }
    }
  });

  it("records exactly one edit event per family for an effective edit", async () => {
    for (const family of FAMILIES) {
      const store = await openStore(tempDir(), { now: clock() });
      try {
        const w = await workspace(store);
        const id = recordOf(w, family).id;
        const before = recorded(store).length;
        const updated = (await edit(store, family, id)) as { id: string };
        const journal = store.snapshot().activity!;
        assert.equal(journal.length, before + 1, `${family} edit records one event`);
        assert.deepEqual(
          journal.at(-1),
          event({ id: journal.length, action: "edit", targetKind: family, targetId: updated.id }),
          `${family} edit event`,
        );
      } finally {
        await store.close();
      }
    }
  });

  it("records one archive then one restore per archivable family", async () => {
    for (const family of ARCHIVE_FAMILIES) {
      const store = await openStore(tempDir(), { now: clock() });
      try {
        const w = await workspace(store);
        const id = recordOf(w, family).id;
        const before = recorded(store).length;
        await archive(store, family, id, true);
        await archive(store, family, id, false);
        const journal = store.snapshot().activity!;
        assert.deepEqual(
          targets(journal.slice(before)),
          [`archive:${family}:${id}`, `restore:${family}:${id}`],
          `${family} archive then restore`,
        );
        assert.deepEqual(
          journal.slice(before).map((e) => e.id),
          [before + 1, before + 2],
          `${family} ids follow the stored journal`,
        );
      } finally {
        await store.close();
      }
    }
  });

  it("records no event for no-op edits and for repeats of the flag already held", async () => {
    const dir = tempDir();
    const store = await openStore(dir, { now: clock() });
    try {
      const w = await workspace(store);
      for (const family of FAMILIES) {
        const id = recordOf(w, family).id;
        const before = recorded(store).length;
        const result = (await sameEdit(store, family, id)) as { id: string };
        assert.deepEqual(result, recordOf(w, family), `${family} no-op keeps the record`);
        assert.equal(recorded(store).length, before, `${family} no-op records nothing`);
        // The no-op still follows normal save/failure behaviour: it persists.
        assert.equal(
          JSON.parse(readFileSync(storePath(dir), "utf8")).activity.length,
          before,
          `${family} no-op persisted`,
        );
      }
      for (const family of ARCHIVE_FAMILIES) {
        const id = recordOf(w, family).id;
        await archive(store, family, id, true);
        const archived = recorded(store).length;
        await archive(store, family, id, true);
        assert.equal(recorded(store).length, archived, `${family} repeat archive is a no-op`);
        await archive(store, family, id, false);
        const restored = recorded(store).length;
        await archive(store, family, id, false);
        assert.equal(recorded(store).length, restored, `${family} repeat restore is a no-op`);
        assert.equal(JSON.parse(readFileSync(storePath(dir), "utf8")).activity.length, restored);
      }
    } finally {
      await store.close();
    }
  });

  it("treats an absent flag and an explicit false as the same active state", async () => {
    const store = await openStore(tempDir(), { now: clock() });
    try {
      const w = await workspace(store);
      const before = recorded(store).length;
      assert.equal("archived" in w.client, false, "a new client carries no flag");
      // Restoring a record that is active only because its flag is absent
      // changes nothing effectively and records no event.
      await archive(store, "client", w.client.id, false);
      assert.equal(recorded(store).length, before, "restore of an unflagged record");
      await archive(store, "client", w.client.id, true);
      await archive(store, "client", w.client.id, false);
      // The restored record is active with the flag removed, not set to false,
      // and the journal holds one archive and one restore.
      assert.equal("archived" in store.snapshot().clients[0], false);
      assert.deepEqual(
        targets(store.snapshot().activity!.slice(before)),
        [`archive:client:${w.client.id}`, `restore:client:${w.client.id}`],
      );
    } finally {
      await store.close();
    }
  });

  it("treats a stored false flag like an absent one for edits and restores", async () => {
    // Seed a workspace, then store the archivable records with an explicit
    // `archived: false` instead of no flag. The document validator accepts both
    // spellings as the same active state.
    const dir = tempDir();
    const seed = await openStore(dir, { now: clock() });
    let w: Awaited<ReturnType<typeof workspace>>;
    let seedEvents: string[];
    let seedIds: number[];
    let journalLength: number;
    let counter: number;
    try {
      w = await workspace(seed);
      // Capture the expected journal independently of the store API, straight
      // from the seed's own snapshot fields, before the file is edited.
      const seeded = seed.snapshot().activity!;
      seedEvents = seeded.map((e) => `${e.action}:${e.targetKind}:${e.targetId}`);
      seedIds = seeded.map((e) => e.id);
      journalLength = seeded.length;
      counter = JSON.parse(readFileSync(storePath(dir), "utf8")).nextActivityId;
    } finally {
      await seed.close();
    }
    const document = JSON.parse(readFileSync(storePath(dir), "utf8"));
    for (const family of ARCHIVE_FAMILIES) {
      const record = document[famPlural(family)].find(
        (entry: { id: string }) => entry.id === recordOf(w, family).id,
      );
      record.archived = false;
    }
    writeFileSync(storePath(dir), JSON.stringify(document));

    const store = await openStore(dir, { now: clock() });
    try {
      const reopened = store.snapshot();
      for (const family of ARCHIVE_FAMILIES) {
        const record = (reopened[famPlural(family) as keyof typeof reopened] as readonly { id: string; archived?: boolean }[]).find(
          (entry) => entry.id === recordOf(w, family).id,
        );
        assert.equal(record?.archived, false, `${family} loaded with an explicit false`);
      }
      const loaded = store.snapshot().activity!;
      assert.deepEqual(
        loaded.map((e) => `${e.action}:${e.targetKind}:${e.targetId}`),
        seedEvents,
        "journal loads as stored",
      );
      assert.deepEqual(loaded.map((e) => e.id), seedIds, "event ids load as stored");
      const before = recorded(store).length;
      for (const family of ARCHIVE_FAMILIES) {
        const id = recordOf(w, family).id;
        // A no-op edit of a false-flagged record records nothing.
        await sameEdit(store, family, id);
        assert.equal(recorded(store).length, before, `${family} edit of a false-flagged record`);
        // Restoring a false-flagged record is the same no-op as restoring an
        // unflagged one: no event, and the counter does not advance.
        await archive(store, family, id, false);
        assert.equal(recorded(store).length, before, `${family} restore of a false-flagged record`);
      }
      // Each no-op still persisted the record it was given.
      const saved = JSON.parse(readFileSync(storePath(dir), "utf8"));
      assert.equal(saved.activity.length, journalLength, "no event reached disk");
      assert.equal(saved.nextActivityId, counter, "and the event counter did not advance");
    } finally {
      await store.close();
    }
  });

  it("records nothing for reads, startup, failed validation or unknown ids", async () => {
    const dir = tempDir();
    const store = await openStore(dir, { now: clock() });
    let before: string[];
    try {
      await workspace(store);
      before = [...recorded(store)];
      const snapshot = store.snapshot();
      assert.deepEqual(snapshot.activity, store.snapshot().activity);
      store.listTasks({ clientId: snapshot.clients[0].id });
      store.listItems({ clientId: snapshot.clients[0].id });
      store.listMeetings({ clientId: snapshot.clients[0].id });
      await assert.rejects(store.createClient({ name: "" }), Error);
      await assert.rejects(store.updateClient(snapshot.clients[0].id, { name: "" }), Error);
      await assert.rejects(store.updateTask(snapshot.tasks[0].id, { status: "bogus" as never }), Error);
      await assert.rejects(store.setArchived("client", "client-99", true), Error);
      await assert.rejects(store.setArchived("meeting" as never, snapshot.meetings[0].id, true), Error);
      assert.deepEqual(recorded(store), before, "none of these recorded an event");
    } finally {
      await store.close();
    }
    const reopened = await openStore(dir);
    try {
      assert.deepEqual(recorded(reopened), before, "startup records nothing");
    } finally {
      await reopened.close();
    }
  });
});

/** The plural collection key of a family. */
function famPlural(family: Family): string {
  return family === "item" ? "items" : `${family}s`;
}

describe("the journal's clock and counter", () => {
  it("defaults to the server clock and stamps canonical UTC instants in commit order", async () => {
    const store = await openStore(tempDir());
    try {
      const before = Date.now();
      const w = await workspace(store);
      const after = Date.now();
      for (const e of store.snapshot().activity!) {
        assert.match(e.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        const at = Date.parse(e.at);
        assert.ok(at >= before - 1000 && at <= after + 1000, "stamped near commit time");
      }
      assert.equal(store.snapshot().activity!.length, 6);
      assert.deepEqual(
        store.snapshot().activity!.map((e) => e.id),
        [1, 2, 3, 4, 5, 6],
        "ids allocated in order",
      );
    } finally {
      await store.close();
    }
  });

  it("stamps each event with the clock read inside the serialized commit", async () => {
    const store = await openStore(tempDir(), {
      now: clock([
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:01.000Z",
        "2026-01-01T00:00:02.000Z",
      ]),
    });
    try {
      await store.createClient({ name: "One" });
      await store.createClient({ name: "Two" });
      await store.createClient({ name: "Three" });
      assert.deepEqual(
        store.snapshot().activity!.map((e) => [e.id, e.at]),
        [
          [1, "2026-01-01T00:00:00.000Z"],
          [2, "2026-01-01T00:00:01.000Z"],
          [3, "2026-01-01T00:00:02.000Z"],
        ],
      );
    } finally {
      await store.close();
    }
  });

  it("reads the clock only for a mutation that records an event", async () => {
    const calls: number[] = [];
    const counting = await openStore(tempDir(), {
      now: () => {
        calls.push(1);
        return new Date(fixedAt);
      },
    });
    try {
      const c = await counting.createClient({ name: "Acme" });
      assert.equal(calls.length, 1);
      const before = recorded(counting).length;
      // A no-op records no event, so it never reads the clock.
      await counting.updateClient(c.id, { name: "Acme" });
      assert.equal(calls.length, 1, "the no-op did not read the clock");
      assert.equal(recorded(counting).length, before, "and records nothing");
      await counting.updateClient(c.id, { name: "Renamed" });
      assert.equal(calls.length, 2, "the effective edit read the clock");
      assert.equal(recorded(counting).length, before + 1);
    } finally {
      await counting.close();
    }
  });

  it("saves a no-op mutation normally even when the clock fails", async () => {
    const dir = tempDir();
    const seed = await openStore(dir, { now: clock() });
    let clientId: string;
    try {
      clientId = (await seed.createClient({ name: "Acme" })).id;
    } finally {
      await seed.close();
    }
    const store = await openStore(dir, { now: failingClock() });
    try {
      const before = store.snapshot();
      // The no-op needs no timestamp, so it persists exactly as before.
      const result = await store.updateClient(clientId, { name: "Acme" });
      assert.equal(result.name, "Acme");
      await store.setArchived("client", clientId, false);
      assert.deepEqual(recorded(store), targets(before.activity!));
      const saved = JSON.parse(readFileSync(storePath(dir), "utf8"));
      assert.deepEqual(saved.activity, before.activity, "and on disk");
    } finally {
      await store.close();
    }
  });

  it("rejects a throwing or invalid clock with PersistenceError and publishes nothing", async () => {
    for (const makeClock of [
      failingClock,
      invalidClock,
      invalidDateClock,
      throwingDateClock,
      impossibleIsoClock,
      mismatchedIsoClock,
    ]) {
      const dir = tempDir();
      const seed = await openStore(dir, { now: clock() });
      let clientId: string;
      try {
        const w = await workspace(seed);
        clientId = w.client.id;
      } finally {
        await seed.close();
      }
      const committed = readFileSync(storePath(dir), "utf8");
      const store = await openStore(dir, { now: makeClock() });
      try {
        const before = store.snapshot();
        await assert.rejects(store.updateClient(clientId, { name: "Renamed" }), PersistenceError);
        await assert.rejects(store.setArchived("client", clientId, true), PersistenceError);
        await assert.rejects(store.createClient({ name: "New" }), PersistenceError);
        // The rejected mutations are never published, in memory or on disk.
        assert.deepEqual(store.snapshot(), before);
        assert.equal(readFileSync(storePath(dir), "utf8"), committed);
        assert.deepEqual(tempFiles(dir), []);
      } finally {
        await store.close();
      }
    }
  });

  it("rejects an exhausted event counter with PersistenceError and publishes nothing", async () => {
    const dir = tempDir();
    const seed = await openStore(dir, { now: clock() });
    try {
      await workspace(seed);
    } finally {
      await seed.close();
    }
    const document = JSON.parse(readFileSync(storePath(dir), "utf8"));
    document.nextActivityId = Number.MAX_SAFE_INTEGER;
    writeFileSync(storePath(dir), JSON.stringify(document), "utf8");
    const committed = readFileSync(storePath(dir), "utf8");
    const store = await openStore(dir, { now: clock() });
    try {
      const before = store.snapshot();
      const id = before.clients[0].id;
      await assert.rejects(store.updateClient(id, { name: "Renamed" }), PersistenceError);
      await assert.rejects(store.setArchived("client", id, true), PersistenceError);
      await assert.rejects(store.createClient({ name: "New" }), PersistenceError);
      assert.deepEqual(store.snapshot(), before);
      assert.equal(readFileSync(storePath(dir), "utf8"), committed);
    } finally {
      await store.close();
    }
  });
});

describe("concurrent ordering", () => {
  it("orders events by the order commits complete, even when issued together", async () => {
    const dir = tempDir();
    const store = await openStore(dir, {
      now: clock(["2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]),
    });
    let clientId: string;
    try {
      const w = await workspace(store);
      clientId = w.client.id;
      const before = recorded(store).length;
      // Two edits issued without awaiting either: the store serializes them.
      const [first, second] = await Promise.all([
        store.updateClient(clientId, { name: "First" }),
        store.updateClient(clientId, { name: "Second" }),
      ]);
      assert.equal(first.name, "First");
      assert.equal(second.name, "Second");
      const journal = store.snapshot().activity!;
      const added = journal.slice(before);
      assert.equal(added.length, 2);
      // The commit order is the issue order, so the ids follow it.
      assert.deepEqual(
        added.map((e) => e.id),
        [before + 1, before + 2],
        "ids allocated in commit order",
      );
      // Equal timestamps fall back to the numeric id, latest first.
      const recent = selectRecentActivity(store.snapshot());
      assert.deepEqual(
        recent.slice(0, 2).map((e) => e.id),
        [before + 2, before + 1],
        "same-timestamp events order by id descending",
      );
    } finally {
      await store.close();
    }
    const reopened = await openStore(dir);
    try {
      assert.deepEqual(reopened.snapshot().activity, store.snapshot().activity);
      assert.equal(reopened.snapshot().clients[0].name, "Second");
    } finally {
      await reopened.close();
    }
  });
});

describe("recent activity selection", () => {
  it("sorts by timestamp descending then event id descending and takes 20", () => {
    const activity = Array.from({ length: 25 }, (_, index) =>
      event({
        id: index + 1,
        at: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      }),
    );
    const recent = selectRecentActivity(view({ activity }));
    assert.equal(recent.length, RECENT_ACTIVITY_LIMIT);
    assert.equal(RECENT_ACTIVITY_LIMIT, 20);
    assert.deepEqual(
      recent.map((e) => e.id),
      Array.from({ length: 20 }, (_, index) => 25 - index),
      "latest 20, newest first",
    );
    assert.ok(Object.isFrozen(recent));
    assert.ok(Object.isFrozen(recent[0]));
    // The result is detached from the snapshot.
    assert.notEqual(recent, view({ activity }).activity);
  });

  it("breaks equal timestamps by numeric id, not by stored order", () => {
    const activity = [
      event({ id: 3 }),
      event({ id: 10 }),
      event({ id: 2 }),
    ];
    assert.deepEqual(
      selectRecentActivity(view({ activity })).map((e) => e.id),
      [10, 3, 2],
    );
    assert.deepEqual(
      selectRecentActivity(view({ activity: [event({ id: 9 }), event({ id: 10 })] })).map((e) => e.id),
      [10, 9],
    );
  });

  it("has no date cutoff and treats absent or empty activity as empty", () => {
    const old = event({ at: "1990-01-01T00:00:00.000Z", id: 1 });
    assert.equal(selectRecentActivity(view({ activity: [old] })).length, 1);
    assert.deepEqual(selectRecentActivity(view({ activity: [] })), []);
    const { activity: _ignored, ...withoutActivity } = view();
    assert.deepEqual(selectRecentActivity(withoutActivity as ActivityView), []);
    assert.deepEqual(selectFromStore(withoutActivity as ActivityView), []);
  });

  it("excludes events whose current target no longer exists or is archived", () => {
    const activity = [
      event({ id: 1, targetKind: "client", targetId: "client-1" }),
      event({ id: 2, targetKind: "client", targetId: "client-9" }),
      event({ id: 3, targetKind: "task", targetId: "task-1" }),
    ];
    assert.deepEqual(
      targets(selectRecentActivity(view({ activity }))),
      ["create:task:task-1", "create:client:client-1"],
      "a missing target is excluded",
    );
    const archivedTask = view({ activity, tasks: [{ ...base.task, archived: true }] });
    assert.deepEqual(
      targets(selectRecentActivity(archivedTask)),
      ["create:client:client-1"],
      "an effectively archived target is excluded",
    );
    const archived = view({
      activity: [
        event({ id: 1, targetKind: "client", targetId: "client-1" }),
        event({
          id: 2,
          action: "archive",
          targetKind: "task",
          targetId: "task-1",
        }),
        event({ id: 3, targetKind: "item", targetId: "item-1" }),
      ],
      tasks: [{ ...base.task, archived: true }],
    });
    // The archived task's own archive event is hidden with it too.
    assert.deepEqual(
      targets(selectRecentActivity(archived)),
      ["create:item:item-1", "create:client:client-1"],
      "an effectively archived target is excluded",
    );
  });

  it("resolves current ancestry rather than historical copies", () => {
    // A meeting is visible only while its current ancestors are active.
    const activity = [
      event({ id: 1, action: "create", targetKind: "meeting", targetId: "meeting-1" }),
      event({ id: 2, action: "edit", targetKind: "task", targetId: "task-1" }),
    ];
    const archivedClient = view({
      activity,
      clients: [{ ...base.client, archived: true }],
    });
    assert.deepEqual(selectRecentActivity(archivedClient), [], "archived client hides all");
    // A task and a meeting that link the archived project are hidden with it.
    const linked = view({
      activity,
      projects: [{ ...base.project, archived: true }],
      tasks: [{ ...base.task, projectId: base.project.id }],
      meetings: [{ ...base.meeting, projectId: base.project.id }],
    });
    assert.deepEqual(
      targets(selectRecentActivity(linked)),
      [],
      "archived project hides the work below it",
    );
    const archivedProjectWithClientEvent = view({
      activity: [event({ id: 1, targetKind: "client", targetId: "client-1" })],
      projects: [{ ...base.project, archived: true }],
    });
    assert.deepEqual(targets(selectRecentActivity(archivedProjectWithClientEvent)), ["create:client:client-1"]);
    // Restoring the ancestor makes descendants visible again, with current links.
    const restored = view({
      activity,
      projects: [{ ...base.project, archived: false }],
      tasks: [{ ...base.task, projectId: base.project.id }],
      meetings: [{ ...base.meeting, projectId: base.project.id }],
    });
    assert.deepEqual(
      targets(selectRecentActivity(restored)),
      ["edit:task:task-1", "create:meeting:meeting-1"],
      "false and absent archival flags are equivalent",
    );
  });

  it("shows events before and after ancestor restoration through a store", async () => {
    const store = await openStore(tempDir(), { now: clock() });
    try {
      const w = await workspace(store);
      const id = w.meeting.id;
      await store.updateMeeting(id, { title: "Retitled meeting" });
      assert.ok(
        targets(selectFromStore(store.snapshot())).includes(`edit:meeting:${id}`),
        "visible while its ancestors are active",
      );
      await store.setArchived("engagement", w.engagement.id, true);
      assert.equal(
        targets(selectFromStore(store.snapshot())).includes(`edit:meeting:${id}`),
        false,
        "hidden while an ancestor is archived",
      );
      // The meeting's own event stays in the journal while hidden.
      assert.ok(targets(store.snapshot().activity!).includes(`edit:meeting:${id}`));
      await store.setArchived("engagement", w.engagement.id, false);
      assert.ok(
        targets(selectFromStore(store.snapshot())).includes(`edit:meeting:${id}`),
        "visible again once the ancestor is restored",
      );
    } finally {
      await store.close();
    }
  });

  it("keeps only the latest 20 visible events when later ones are invisible", () => {
    const activity = Array.from({ length: 30 }, (_, index) => {
      const newest = index >= 25;
      return event({
        id: index + 1,
        at: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
        targetKind: "task",
        targetId: newest ? "task-9" : "task-1",
      });
    });
    // The newest five target a record that does not exist, so they are dropped
    // before the limit applies: the visible latest 20 are ids 25 down to 6.
    assert.deepEqual(
      selectRecentActivity(view({ activity })).map((e) => e.id),
      Array.from({ length: 20 }, (_, index) => 25 - index),
    );
  });
});

describe("record and event atomicity under persistence failures", () => {
  /** A failure state the tests toggle between saves. */
  interface FailureState {
    failWrites: boolean;
    failRenames: boolean;
  }

  function failingFs(state: FailureState): Partial<FileSystem> {
    return {
      writeSync: (fd: number, data: Uint8Array) => {
        if (state.failWrites) throw fsError("EIO");
        return writeSyncImpl(fd, data);
      },
      renameSync: (oldPath: string, newPath: string) => {
        if (state.failRenames) throw fsError("EIO");
        renameSyncImpl(oldPath, newPath);
      },
    };
  }

  /** Seed a persisted workspace and return its directory and record ids. */
  async function seeded(): Promise<{ dir: string; w: Awaited<ReturnType<typeof workspace>> }> {
    const dir = tempDir();
    const setup = await openStore(dir, { now: clock() });
    try {
      const w = await workspace(setup);
      return { dir, w };
    } finally {
      await setup.close();
    }
  }

  it("keeps records, journal and counter when the rename fails", async () => {
    const { dir, w } = await seeded();
    const committed = readFileSync(storePath(dir), "utf8");
    const state: FailureState = { failWrites: false, failRenames: true };
    const store = await openStore(dir, { fs: failingFs(state), now: clock() });
    try {
      const before = store.snapshot();
      await assert.rejects(store.updateClient(w.client.id, { name: "Renamed" }), PersistenceError);
      await assert.rejects(store.createClient({ name: "New" }), PersistenceError);
      await assert.rejects(store.setArchived("client", w.client.id, true), PersistenceError);
      // Neither the record nor its event is published or written, and the
      // temporary file is cleaned up rather than left behind.
      assert.deepEqual(store.snapshot(), before);
      assert.equal(readFileSync(storePath(dir), "utf8"), committed);
      assert.deepEqual(tempFiles(dir), []);
      // The event counter did not advance with the rejected attempts: the next
      // successful mutation allocates the id the journal expected.
      state.failRenames = false;
      const created = await store.createClient({ name: "New" });
      const journal = store.snapshot().activity!;
      assert.deepEqual(
        targets(journal.slice(before.activity!.length)),
        [`create:client:${created.id}`],
      );
      assert.equal(
        journal[journal.length - 1].id,
        before.activity![before.activity!.length - 1].id + 1,
        "the next event takes the next id",
      );
      const saved = JSON.parse(readFileSync(storePath(dir), "utf8"));
      assert.deepEqual(saved.clients.map((c: { id: string }) => c.id).slice(-1), [created.id]);
      assert.equal(saved.activity[saved.activity.length - 1].id, journal[journal.length - 1].id);
    } finally {
      await store.close();
    }
  });

  it("keeps prior data and records no event when the write fails before rename", async () => {
    const { dir, w } = await seeded();
    const committed = readFileSync(storePath(dir), "utf8");
    const state: FailureState = { failWrites: false, failRenames: false };
    const store = await openStore(dir, { fs: failingFs(state), now: clock() });
    try {
      state.failWrites = true;
      const before = store.snapshot();
      await assert.rejects(store.updateClient(w.client.id, { name: "Renamed" }), PersistenceError);
      await assert.rejects(store.createClient({ name: "New" }), PersistenceError);
      await assert.rejects(store.setArchived("client", w.client.id, true), PersistenceError);
      // Neither the record nor its event is published or written.
      assert.deepEqual(store.snapshot(), before);
      assert.equal(readFileSync(storePath(dir), "utf8"), committed);
      assert.deepEqual(tempFiles(dir), []);
    } finally {
      await store.close();
    }
  });

  it("records both the record and its event together, or neither", async () => {
    // A directory flush fails after the rename: the new bytes were written but
    // not acknowledged, so the previous state is written back and the whole
    // mutation, record and event alike, is rejected. Only the replacement's
    // flush fails once; the restore's flush then succeeds.
    const { dir, w } = await seeded();
    const committed = readFileSync(storePath(dir), "utf8");
    let flushes = 0;
    const fs: Partial<FileSystem> = {
      fsyncDirectorySync: () => {
        flushes += 1;
        if (flushes === 1) throw fsError("EIO");
      },
    };
    const store = await openStore(dir, { fs, now: clock(), platform: "linux" });
    let before;
    try {
      before = store.snapshot();
      await assert.rejects(store.updateClient(w.client.id, { name: "Renamed" }), PersistenceError);
      assert.equal(flushes, 2, "the restore flushed too");
      assert.deepEqual(store.snapshot(), before, "record and journal unchanged in memory");
      assert.equal(readFileSync(storePath(dir), "utf8"), committed, "record and journal restored on disk");
      // Later writes build on the committed state, not the failed draft.
      await store.updateClient(w.client.id, { name: "Renamed" });
      assert.equal(store.snapshot().clients[0].name, "Renamed");
      assert.deepEqual(
        targets(store.snapshot().activity!.slice(before.activity!.length)),
        [`edit:client:${w.client.id}`],
        "exactly one event for the later, successful edit",
      );
    } finally {
      await store.close();
    }
  });

  it("blocks later writes and publishes nothing when recovery fails", async () => {
    const { dir, w } = await seeded();
    // The replacement's flush fails, and so does the restore's: the store cannot
    // recover.
    let flushes = 0;
    const fs: Partial<FileSystem> = {
      fsyncDirectorySync: () => {
        flushes += 1;
        throw fsError("EIO");
      },
    };
    const store = await openStore(dir, { fs, now: clock(), platform: "linux" });
    let before;
    try {
      before = store.snapshot();
      await assert.rejects(store.updateClient(w.client.id, { name: "Renamed" }), PersistenceError);
      assert.equal(flushes, 2, "the restore was attempted and failed");
      // The failed mutation is never published, and no later write is accepted.
      assert.deepEqual(store.snapshot(), before);
      await assert.rejects(store.updateClient(w.client.id, { name: "Again" }), PersistenceError);
      await assert.rejects(store.setArchived("client", w.client.id, true), PersistenceError);
      assert.deepEqual(store.snapshot(), before);
    } finally {
      await store.close();
    }
    // Reopening reads whatever the disk holds: the failed save was never
    // published, and its journal gained no event.
    const reopened = await openStore(dir);
    try {
      assert.equal(reopened.snapshot().clients[0].name, "Acme");
      assert.deepEqual(reopened.snapshot().activity, before.activity);
    } finally {
      await reopened.close();
    }
  });
});
