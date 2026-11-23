import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  selectKanban,
  type BoardScope,
  type KanbanBoard,
} from "../src/kanban.ts";
import { TASK_STATUSES, type TaskStatus } from "../src/model.ts";
import {
  MissingRecordError,
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
  const dir = mkdtempSync(join(tmpdir(), "kanban-"));
  roots.push(dir);
  return dir;
}

function storePath(dir: string): string {
  return join(dir, "workspace.json");
}

/** A fixed clock: a canonical instant used by every journal assertion. */
const FIXED_AT = new Date("2026-02-03T04:05:06.007Z");

/** The task ids of one named group, in snapshot order. */
function groupIds(board: KanbanBoard, kind: string): string[] {
  const group = board.groups.find((candidate) => candidate.kind === kind);
  assert.ok(group !== undefined, `group ${kind}`);
  return group.tasks.map((task) => task.id);
}

/** The group kinds of a board, in order. */
function groupKinds(board: KanbanBoard): string[] {
  return board.groups.map((group) => group.kind);
}

/** A two-client, two-engagement hierarchy with one project under the first. */
async function hierarchy(store: Store) {
  const client = await store.createClient({ name: "Acme" });
  const otherClient = await store.createClient({ name: "Other" });
  const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
  const sibling = await store.createEngagement({ clientId: client.id, name: "Sibling" });
  const project = await store.createProject({ engagementId: engagement.id, name: "Project" });
  const secondProject = await store.createProject({ engagementId: engagement.id, name: "Second" });
  return { client, otherClient, engagement, sibling, project, secondProject };
}

describe("kanban selection", () => {
  it("groups every visible task once in the fixed order with empty groups present", async () => {
    const store = await openStore(tempDir());
    try {
      const h = await hierarchy(store);
      const base = { clientId: h.client.id, engagementId: h.engagement.id };
      const open = await store.createTask({ ...base, title: "Open" });
      const inProgress = await store.createTask({ ...base, title: "In progress", status: "in_progress" });
      const waiting = await store.createTask({ ...base, title: "Waiting", status: "waiting" });
      const done = await store.createTask({ ...base, title: "Done", status: "done" });

      const board = selectKanban(store.snapshot(), { kind: "all" });
      assert.deepEqual(groupKinds(board), ["open", "in_progress", "waiting", "done"]);
      assert.deepEqual(groupIds(board, "open"), [open.id]);
      assert.deepEqual(groupIds(board, "in_progress"), [inProgress.id]);
      assert.deepEqual(groupIds(board, "waiting"), [waiting.id]);
      assert.deepEqual(groupIds(board, "done"), [done.id]);
      // The scope comes back validated and is the plain `all` form.
      assert.deepEqual(board.scope, { kind: "all" });

      // An unassigned (project-less) task and a project task both appear; each
      // visible task appears exactly once across the whole board.
      const projectTask = await store.createTask({ ...base, projectId: h.project.id, title: "Project" });
      const withProject = selectKanban(store.snapshot(), { kind: "all" });
      const allIds = withProject.groups.flatMap((group) => group.tasks.map((task) => task.id));
      assert.deepEqual(allIds.sort(), [open.id, inProgress.id, waiting.id, done.id, projectTask.id].sort());
      assert.equal(allIds.length, 5);
      assert.ok(groupIds(withProject, "open").includes(projectTask.id));

      // An empty workspace still has the four groups, each empty.
      const empty = selectKanban(emptySnapshot(), { kind: "all" });
      assert.deepEqual(groupKinds(empty), ["open", "in_progress", "waiting", "done"]);
      for (const kind of groupKinds(empty)) assert.deepEqual(groupIds(empty, kind), []);
    } finally {
      await store.close();
    }
  });

  it("preserves snapshot order within a group", async () => {
    const store = await openStore(tempDir());
    try {
      const h = await hierarchy(store);
      const base = { clientId: h.client.id, engagementId: h.engagement.id };
      const first = await store.createTask({ ...base, title: "First" });
      const second = await store.createTask({ ...base, title: "Second" });
      const third = await store.createTask({ ...base, title: "Third" });
      const board = selectKanban(store.snapshot(), { kind: "all" });
      assert.deepEqual(groupIds(board, "open"), [first.id, second.id, third.id]);
    } finally {
      await store.close();
    }
  });

  it("narrows to a client, engagement or project with sibling isolation", async () => {
    const store = await openStore(tempDir());
    try {
      const h = await hierarchy(store);
      const acmeEngagement = await store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Acme engagement",
      });
      const acmeProject = await store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: h.project.id,
        title: "Acme project",
      });
      const acmeSibling = await store.createTask({
        clientId: h.client.id,
        engagementId: h.sibling.id,
        title: "Acme sibling",
      });
      const other = await store.createTask({
        clientId: h.otherClient.id,
        engagementId: (await store.createEngagement({ clientId: h.otherClient.id, name: "Other E" })).id,
        title: "Other client",
      });

      const clientBoard = selectKanban(store.snapshot(), { kind: "client", id: h.client.id });
      assert.deepEqual(groupIds(clientBoard, "open"), [acmeEngagement.id, acmeProject.id, acmeSibling.id]);
      assert.ok(!groupIds(clientBoard, "open").includes(other.id));

      const engagementBoard = selectKanban(store.snapshot(), { kind: "engagement", id: h.engagement.id });
      assert.deepEqual(groupIds(engagementBoard, "open"), [acmeEngagement.id, acmeProject.id]);
      assert.ok(!groupIds(engagementBoard, "open").includes(acmeSibling.id));

      const projectBoard = selectKanban(store.snapshot(), { kind: "project", id: h.project.id });
      assert.deepEqual(groupIds(projectBoard, "open"), [acmeProject.id]);

      // Another project of the same engagement holds none of these tasks.
      const secondBoard = selectKanban(store.snapshot(), { kind: "project", id: h.secondProject.id });
      for (const kind of groupKinds(secondBoard)) assert.deepEqual(groupIds(secondBoard, kind), []);
    } finally {
      await store.close();
    }
  });

  it("keeps archived tasks off the boards, including those archived through an ancestor", async () => {
    const store = await openStore(tempDir());
    try {
      const h = await hierarchy(store);
      const base = { clientId: h.client.id, engagementId: h.engagement.id };
      const visible = await store.createTask({ ...base, title: "Visible" });
      const archivedTask = await store.createTask({ ...base, projectId: h.project.id, title: "Archived task" });
      const ancestorArchived = await store.createTask({
        clientId: h.client.id,
        engagementId: h.sibling.id,
        title: "Under archived engagement",
      });
      await store.setArchived("task", archivedTask.id, true);
      await store.setArchived("engagement", h.sibling.id, true);

      const board = selectKanban(store.snapshot(), { kind: "all" });
      const ids = board.groups.flatMap((group) => group.tasks.map((task) => task.id));
      assert.deepEqual(ids, [visible.id]);
      assert.ok(!ids.includes(archivedTask.id));
      assert.ok(!ids.includes(ancestorArchived.id));
    } finally {
      await store.close();
    }
  });

  it("refuses a bad scope and returns a detached, frozen result", async () => {
    const store = await openStore(tempDir());
    try {
      const h = await hierarchy(store);
      await store.createTask({ clientId: h.client.id, engagementId: h.engagement.id, title: "Task" });
      for (const scope of [
        undefined,
        null,
        {},
        { kind: "workspace" },
        { kind: "client" },
        { kind: "client", id: "" },
        { kind: "client", id: "   " },
        { kind: "engagement", id: 7 },
        { kind: "project", id: null },
      ] as unknown as BoardScope[]) {
        assert.throws(() => selectKanban(store.snapshot(), scope), ValidationError, JSON.stringify(scope));
      }

      const snapshot = store.snapshot();
      const board = selectKanban(snapshot, { kind: "all", extra: "ignored" } as unknown as BoardScope);
      assert.deepEqual(board.scope, { kind: "all" });
      assert.ok(Object.isFrozen(board));
      assert.ok(Object.isFrozen(board.groups));
      assert.ok(Object.isFrozen(board.groups[0].tasks[0]));
      // The result is frozen, so a caller cannot mutate it or the snapshot the
      // board was built from.
      assert.throws(
        () => { (board.groups[0].tasks[0] as { title: string }).title = "changed"; },
        TypeError,
      );
      assert.equal(snapshot.tasks[0].title, "Task");
      // Selecting the same snapshot again yields the same stored values.
      assert.equal(selectKanban(snapshot, { kind: "all" }).groups[0].tasks[0].title, "Task");
    } finally {
      await store.close();
    }
  });
});

function emptySnapshot(): Snapshot {
  return {
    clients: [],
    engagements: [],
    projects: [],
    tasks: [],
    items: [],
    meetings: [],
  };
}

describe("kanban task movement", () => {
  it("creates a waiting task, keeps the default open, and survives restart", async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    try {
      const h = await hierarchy(store);
      const base = { clientId: h.client.id, engagementId: h.engagement.id };
      const defaulted = await store.createTask({ ...base, title: "Default" });
      assert.equal(defaulted.status, "open");
      const waiting = await store.createTask({ ...base, title: "Waiting", status: "waiting" });
      assert.equal(waiting.status, "waiting");
    } finally {
      await store.close();
    }
    const saved = JSON.parse(readFileSync(storePath(dir), "utf8"));
    assert.equal(saved.schemaVersion, 6);
    const reopened = await openStore(dir);
    try {
      const tasks = reopened.snapshot().tasks;
      assert.equal(tasks.find((task) => task.title === "Default")?.status, "open");
      assert.equal(tasks.find((task) => task.title === "Waiting")?.status, "waiting");
    } finally {
      await reopened.close();
    }
  });

  it("rejects an invalid status value", async () => {
    const store = await openStore(tempDir());
    try {
      const h = await hierarchy(store);
      await assert.rejects(
        store.createTask({ clientId: h.client.id, engagementId: h.engagement.id, title: "T", status: "paused" as never }),
        ValidationError,
      );
      await assert.rejects(
        store.createTask({ clientId: h.client.id, engagementId: h.engagement.id, title: "T", status: null as never }),
        ValidationError,
      );
      assert.equal(store.snapshot().tasks.length, 0);
    } finally {
      await store.close();
    }
  });

  it("moves between every pair of statuses, replacing the status and recording one edit", async () => {
    const dir = tempDir();
    const store = await openStore(dir, { now: () => FIXED_AT });
    try {
      const h = await hierarchy(store);
      const task = await store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: h.project.id,
        title: "Move me",
        status: "open",
        priority: "high",
        owner: "Owner",
        dueDate: "2027-01-02",
        context: "Context",
      });
      const scope: BoardScope = { kind: "all" };
      for (const from of TASK_STATUSES) {
        for (const to of TASK_STATUSES) {
          if (from === to) continue;
          // Reset the task to `from` first; the movement's own event then
          // carries the transition under test. The current record, not the
          // stale creation result, tells us where the task actually stands.
          const current = store.snapshot().tasks.find((entry) => entry.id === task.id)!;
          if (current.status !== from) await store.moveTask(task.id, from as TaskStatus, scope);
          const established = store.snapshot().tasks.find((entry) => entry.id === task.id)!;
          assert.equal(established.status, from, `${from} -> ${to} begins at ${from}`);
          const journalAt = store.snapshot().activity!.length;
          const moved = await store.moveTask(task.id, to, scope);
          assert.equal(moved.status, to, `${from} -> ${to}`);
          // Only the status changed: every other field is preserved exactly.
          const { id, clientId, engagementId, projectId, title, priority, owner, dueDate, context } = moved;
          assert.deepEqual(
            { id, clientId, engagementId, projectId, title, priority, owner, dueDate, context },
            {
              id: task.id,
              clientId: h.client.id,
              engagementId: h.engagement.id,
              projectId: h.project.id,
              title: "Move me",
              priority: "high",
              owner: "Owner",
              dueDate: "2027-01-02",
              context: "Context",
            },
          );
          const journal = store.snapshot().activity!;
          assert.equal(journal.length, journalAt + 1, `${from} -> ${to} records one event`);
          const event = journal.at(-1)!;
          assert.equal(event.action, "edit");
          assert.equal(event.targetKind, "task");
          assert.equal(event.targetId, task.id);
          assert.equal(event.at, "2026-02-03T04:05:06.007Z");
        }
      }
      // Reopening a done task through the board is allowed: no prior status is
      // remembered beyond the stored value.
      await store.moveTask(task.id, "done", scope);
      const reopened = await store.moveTask(task.id, "waiting", scope);
      assert.equal(reopened.status, "waiting");
    } finally {
      await store.close();
    }
  });

  it("refuses a movement to the status the task already holds without recording an event", async () => {
    const dir = tempDir();
    const store = await openStore(dir, { now: () => FIXED_AT });
    try {
      const h = await hierarchy(store);
      const task = await store.createTask({ clientId: h.client.id, engagementId: h.engagement.id, title: "Same" });
      for (const status of TASK_STATUSES) {
        if (status !== "open") await store.moveTask(task.id, status, { kind: "all" });
        const current = store.snapshot().tasks.find((entry) => entry.id === task.id)!;
        assert.equal(current.status, status, `task stands at ${status}`);
        const journalBefore = store.snapshot().activity!.length;
        const moved = await store.moveTask(task.id, status, { kind: "all" });
        assert.equal(moved.status, status, `${status} -> ${status}`);
        assert.equal(store.snapshot().activity!.length, journalBefore, `${status} -> ${status} records no event`);
      }
    } finally {
      await store.close();
    }
  });

  it("checks the scope, status and assertions inside the mutation queue", async () => {
    const store = await openStore(tempDir());
    try {
      const h = await hierarchy(store);
      const task = await store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: h.project.id,
        title: "Scoped",
      });
      // Bad scope values are refused.
      for (const scope of [
        undefined,
        null,
        { kind: "workspace" },
        { kind: "client" },
        { kind: "project", id: "" },
      ] as unknown as BoardScope[]) {
        await assert.rejects(store.moveTask(task.id, "in_progress", scope), ValidationError, JSON.stringify(scope));
      }
      // A bad status value is refused.
      await assert.rejects(store.moveTask(task.id, "paused" as never, { kind: "all" }), ValidationError);

      // A task outside the selected scope is refused.
      for (const scope of [
        { kind: "client", id: h.otherClient.id },
        { kind: "engagement", id: h.sibling.id },
        { kind: "project", id: h.secondProject.id },
      ] as BoardScope[]) {
        await assert.rejects(
          store.moveTask(task.id, "in_progress", scope),
          (error: unknown) => error instanceof ValidationError && /outside the board scope/.test(error.message),
          JSON.stringify(scope),
        );
      }

      // Conflicting identity assertions are refused.
      for (const expected of [
        { id: "task-999" },
        { clientId: h.otherClient.id },
        { engagementId: h.sibling.id },
        { projectId: h.secondProject.id },
        { projectId: "" },
      ]) {
        await assert.rejects(
          store.moveTask(task.id, "in_progress", { kind: "all" }, expected),
          (error: unknown) => error instanceof ValidationError && /not the expected/.test(error.message),
          JSON.stringify(expected),
        );
      }
      // Non-string assertions are refused too.
      await assert.rejects(
        store.moveTask(task.id, "in_progress", { kind: "all" }, { clientId: 7 as never }),
        ValidationError,
      );

      // Matching assertions, including an absent project compared as "", are
      // accepted.
      const moved = await store.moveTask(
        task.id,
        "in_progress",
        { kind: "project", id: h.project.id },
        { id: task.id, clientId: h.client.id, engagementId: h.engagement.id, projectId: h.project.id },
      );
      assert.equal(moved.status, "in_progress");
      const projectless = await store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "No project",
      });
      const movedProjectless = await store.moveTask(
        projectless.id,
        "waiting",
        { kind: "engagement", id: h.engagement.id },
        { projectId: "" },
      );
      assert.equal(movedProjectless.status, "waiting");
      assert.equal("projectId" in movedProjectless, false);

    } finally {
      await store.close();
    }
  });

  it("reports a missing record as MissingRecordError after argument validation", async () => {
    const store = await openStore(tempDir());
    try {
      await hierarchy(store);
      await assert.rejects(
        store.moveTask("task-999", "done", { kind: "all" }),
        MissingRecordError,
      );
      // A bad scope is refused before the missing lookup: the argument check
      // runs first.
      await assert.rejects(
        store.moveTask("task-999", "done", { kind: "bogus" } as never),
        ValidationError,
      );
      assert.equal(store.snapshot().tasks.length, 0);
      assert.equal(store.snapshot().engagements.length, 2);
    } finally {
      await store.close();
    }
  });

  it("validates a queued movement against the record as a prior write left it", async () => {
    const store = await openStore(tempDir());
    try {
      const h = await hierarchy(store);
      const task = await store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Queued",
      });
      // Queue a reassignment edit and a movement that asserts the old project
      // link. Both enter the queue in order; the movement sees the edit's
      // result and its assertion fails against the new state.
      const edit = store.updateTask(task.id, { projectId: h.project.id });
      const move = store.moveTask(task.id, "in_progress", { kind: "all" }, { projectId: "" });
      await edit;
      await assert.rejects(
        move,
        (error: unknown) => error instanceof ValidationError && /projectId/.test(error.message),
      );
      const stored = store.snapshot().tasks[0];
      assert.equal(stored.projectId, h.project.id);
      // The refused movement changed nothing.
      assert.equal(stored.status, "open");

      // A movement queued behind a successful edit that matches its assertion
      // applies to the current record.
      const edit2 = store.updateTask(task.id, { projectId: h.secondProject.id });
      const move2 = store.moveTask(task.id, "waiting", { kind: "project", id: h.secondProject.id }, { projectId: h.secondProject.id });
      await edit2;
      const moved = await move2;
      assert.equal(moved.status, "waiting");
      assert.equal(moved.projectId, h.secondProject.id);
    } finally {
      await store.close();
    }
  });

  it("moves an archived task directly while keeping it off the board", async () => {
    const store = await openStore(tempDir());
    try {
      const h = await hierarchy(store);
      const task = await store.createTask({ clientId: h.client.id, engagementId: h.engagement.id, title: "Archived" });
      await store.setArchived("task", task.id, true);
      const moved = await store.moveTask(task.id, "done", { kind: "all" });
      assert.equal(moved.status, "done");
      assert.equal(moved.archived, true);
      const board = selectKanban(store.snapshot(), { kind: "all" });
      const ids = board.groups.flatMap((group) => group.tasks.map((t) => t.id));
      assert.ok(!ids.includes(task.id));
    } finally {
      await store.close();
    }
  });

  it("preserves the committed state when the save fails", async () => {
    const dir = tempDir();
    const setup = await openStore(dir);
    try {
      const h = await hierarchy(setup);
      await setup.createTask({ clientId: h.client.id, engagementId: h.engagement.id, title: "Kept" });
    } finally {
      await setup.close();
    }
    const saved = readFileSync(storePath(dir), "utf8");
    // Fail the store file's rename: the temporary file is written and flushed
    // but the committed file is never replaced, so nothing is published.
    const failing = { renameSync: () => { const error: NodeJS.ErrnoException = new Error("simulated EIO"); error.code = "EIO"; throw error; } };
    const store = await openStore(dir, { fs: failing, now: () => FIXED_AT });
    try {
      await assert.rejects(
        store.moveTask("task-1", "waiting", { kind: "all" }),
        PersistenceError,
      );
      assert.equal(store.snapshot().tasks[0].status, "open");
      const journal = store.snapshot().activity!;
      assert.equal(journal.length, 7);
      assert.ok(!journal.some((event) => event.targetKind === "task" && event.action === "edit"));
    } finally {
      await store.close();
    }
    assert.equal(readFileSync(storePath(dir), "utf8"), saved);
  });

  it("reads legacy schemas 3 and 4 with their original statuses and preserves them", async () => {
    for (const version of [3, 4]) {
      const dir = tempDir();
      const document = {
        schemaVersion: version,
        clients: [
          { id: "client-1", name: "Acme", background: "", contacts: "", stakeholders: "", requirements: "", objectives: "" },
        ],
        engagements: [
          { id: "engagement-1", clientId: "client-1", name: "E", objectives: "", status: "planned" },
        ],
        projects: [],
        tasks: [
          { id: "task-1", clientId: "client-1", engagementId: "engagement-1", title: "Open", status: "open", priority: "normal", owner: "", context: "" },
          { id: "task-2", clientId: "client-1", engagementId: "engagement-1", title: "Progress", status: "in_progress", priority: "normal", owner: "", context: "" },
          { id: "task-3", clientId: "client-1", engagementId: "engagement-1", title: "Done", status: "done", priority: "normal", owner: "", context: "" },
        ],
        items: [],
        meetings: [],
        nextIds: { clients: 2, engagements: 2, tasks: 4 },
      };
      writeFileSync(storePath(dir), JSON.stringify(document), "utf8");
      const store = await openStore(dir);
      try {
        const snapshot = store.snapshot();
        assert.deepEqual(snapshot.tasks.map((task) => task.status), ["open", "in_progress", "done"]);
        assert.equal("archived" in snapshot.tasks[0], false);
        const board = selectKanban(snapshot, { kind: "all" });
        assert.deepEqual(groupIds(board, "open"), ["task-1"]);
        assert.deepEqual(groupIds(board, "in_progress"), ["task-2"]);
        assert.deepEqual(groupIds(board, "waiting"), []);
        assert.deepEqual(groupIds(board, "done"), ["task-3"]);
      } finally {
        await store.close();
      }
      // Opening never rewrites the legacy file.
      assert.equal(JSON.parse(readFileSync(storePath(dir), "utf8")).schemaVersion, version);
    }
  });

  it("keeps the legacy status rules: waiting in a legacy document is refused intact", async () => {
    const dir = tempDir();
    const document = {
      schemaVersion: 4,
      clients: [
        { id: "client-1", name: "Acme", background: "", contacts: "", stakeholders: "", requirements: "", objectives: "" },
      ],
      engagements: [
        { id: "engagement-1", clientId: "client-1", name: "E", objectives: "", status: "planned" },
      ],
      projects: [],
      tasks: [
        { id: "task-1", clientId: "client-1", engagementId: "engagement-1", title: "T", status: "waiting", priority: "normal", owner: "", context: "" },
      ],
      items: [],
      meetings: [],
      nextIds: { clients: 2, engagements: 2, tasks: 2 },
    };
    const content = JSON.stringify(document);
    writeFileSync(storePath(dir), content, "utf8");
    await assert.rejects(openStore(dir), PersistenceError);
    assert.equal(readFileSync(storePath(dir), "utf8"), content);
  });
});
