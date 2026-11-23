import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  MissingRecordError,
  openStore,
  PersistenceError,
  ValidationError,
  type Store,
  type WorkFilter,
} from "../src/store.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "work-"));
  roots.push(dir);
  return dir;
}

function storePath(dir: string): string {
  return join(dir, "workspace.json");
}

function lockPath(dir: string): string {
  return join(dir, "workspace.lock");
}

/** Create a client with two engagements, each with one project. */
async function hierarchy(store: Store) {
  const client = await store.createClient({ name: "Acme" });
  const otherClient = await store.createClient({ name: "Other" });
  const engagement = await store.createEngagement({ clientId: client.id, name: "Eng" });
  const sibling = await store.createEngagement({ clientId: client.id, name: "Sibling" });
  const otherEngagement = await store.createEngagement({
    clientId: otherClient.id,
    name: "OtherEng",
  });
  const project = await store.createProject({ engagementId: engagement.id, name: "P" });
  const siblingProject = await store.createProject({
    engagementId: sibling.id,
    name: "SiblingP",
  });
  return {
    client,
    otherClient,
    engagement,
    sibling,
    otherEngagement,
    project,
    siblingProject,
  };
}

describe("tasks", () => {
  it("creates tasks with defaults and edits every editable field", async () => {
    const store = await openStore(tempDir());
    try {
      const h = await hierarchy(store);
      const task = await store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Send report",
      });
      assert.match(task.id, /^task-\d+$/);
      assert.equal(task.clientId, h.client.id);
      assert.equal(task.engagementId, h.engagement.id);
      assert.equal(task.projectId, undefined);
      assert.equal(task.title, "Send report");
      assert.equal(task.status, "open");
      assert.equal(task.priority, "normal");
      assert.equal(task.owner, "");
      assert.equal(task.context, "");
      assert.equal(task.dueDate, undefined);
      assert.equal("dueDate" in task, false);

      const edited = await store.updateTask(task.id, {
        title: "Send final report",
        status: "in_progress",
        priority: "high",
        owner: "Dana",
        dueDate: "2027-02-28",
        context: "Awaiting approval",
      });
      assert.deepEqual(edited, {
        id: task.id,
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Send final report",
        status: "in_progress",
        priority: "high",
        owner: "Dana",
        dueDate: "2027-02-28",
        context: "Awaiting approval",
      });

      // Omitted fields keep their values on a partial edit.
      const done = await store.updateTask(task.id, { status: "done" });
      assert.equal(done.status, "done");
      assert.equal(done.owner, "Dana");
      assert.equal(done.dueDate, "2027-02-28");

      // Descriptive text may be empty.
      const cleared = await store.updateTask(task.id, { owner: "", context: "" });
      assert.equal(cleared.owner, "");
      assert.equal(cleared.context, "");
    } finally {
      await store.close();
    }
  });

  it("treats a blank due date as absent and rejects invalid calendar dates", async () => {
    const store = await openStore(tempDir());
    try {
      const h = await hierarchy(store);
      const base = { clientId: h.client.id, engagementId: h.engagement.id, title: "T" };
      const blank = await store.createTask({ ...base, dueDate: "" });
      assert.equal(blank.dueDate, undefined);
      assert.equal("dueDate" in blank, false);

      const dated = await store.createTask({ ...base, dueDate: "2028-02-29" });
      assert.equal(dated.dueDate, "2028-02-29");
      // Clearing a due date makes it absent again, with no default date.
      const cleared = await store.updateTask(dated.id, { dueDate: "  " });
      assert.equal(cleared.dueDate, undefined);
      assert.equal("dueDate" in cleared, false);

      const invalid = [
        "2023-02-29",
        "2026-13-01",
        "2026-00-10",
        "2026-04-31",
        "2026-1-05",
        "2026/01/05",
        "20260105",
        "2026-01-05T00:00:00Z",
        "not a date",
        20260105 as never,
        null as never,
      ];
      for (const dueDate of invalid) {
        await assert.rejects(store.createTask({ ...base, dueDate }), ValidationError);
        await assert.rejects(store.updateTask(dated.id, { dueDate }), ValidationError);
      }
      // Century leap-year rules are applied.
      await assert.rejects(
        store.createTask({ ...base, dueDate: "1900-02-29" }),
        ValidationError,
      );
      assert.equal((await store.createTask({ ...base, dueDate: "2000-02-29" })).dueDate, "2000-02-29");

      // No rejected create or edit changed the committed state.
      const tasks = store.snapshot().tasks;
      assert.equal(tasks.length, 3);
      assert.deepEqual(
        tasks.map((t) => t.dueDate),
        [undefined, undefined, "2000-02-29"],
      );
    } finally {
      await store.close();
    }
  });

  it("rejects invalid task fields", async () => {
    const store = await openStore(tempDir());
    try {
      const h = await hierarchy(store);
      const base = { clientId: h.client.id, engagementId: h.engagement.id };
      await assert.rejects(store.createTask({ ...base, title: "" }), ValidationError);
      await assert.rejects(store.createTask({ ...base, title: "   " }), ValidationError);
      await assert.rejects(store.createTask({ ...base, title: 42 as never }), ValidationError);
      await assert.rejects(
        store.createTask({ ...base, title: "T", status: "closed" as never }),
        ValidationError,
      );
      await assert.rejects(
        store.createTask({ ...base, title: "T", priority: "urgent" as never }),
        ValidationError,
      );
      await assert.rejects(
        store.createTask({ ...base, title: "T", owner: null as never }),
        ValidationError,
      );
      await assert.rejects(
        store.createTask({ ...base, title: "T", context: [] as never }),
        ValidationError,
      );
      const task = await store.createTask({ ...base, title: "T", owner: "Dana" });
      await assert.rejects(
        store.updateTask(task.id, { status: "unknown" as never }),
        ValidationError,
      );
      await assert.rejects(store.updateTask(task.id, { title: " " }), ValidationError);
      await assert.rejects(
        store.updateTask(task.id, { owner: null as never }),
        ValidationError,
      );
      assert.equal(store.snapshot().tasks.length, 1);
      assert.deepEqual(store.snapshot().tasks[0], task);
    } finally {
      await store.close();
    }
  });

  it("supports engagement-level and project-level tasks", async () => {
    const store = await openStore(tempDir());
    try {
      const h = await hierarchy(store);
      const engagementTask = await store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Engagement level",
      });
      const projectTask = await store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: h.project.id,
        title: "Project level",
      });
      assert.equal(engagementTask.projectId, undefined);
      assert.equal(projectTask.projectId, h.project.id);

      assert.deepEqual(
        store.listTasks({ clientId: h.client.id }).map((t) => t.title),
        ["Engagement level", "Project level"],
      );
      assert.deepEqual(
        store.listTasks({ clientId: h.client.id, engagementId: h.engagement.id }).map(
          (t) => t.title,
        ),
        ["Engagement level", "Project level"],
      );
      assert.deepEqual(
        store.listTasks({
          clientId: h.client.id,
          engagementId: h.engagement.id,
          projectId: h.project.id,
        }).map((t) => t.title),
        ["Project level"],
      );
      assert.deepEqual(store.listTasks({ clientId: h.otherClient.id }), []);
    } finally {
      await store.close();
    }
  });
});

describe("work items", () => {
  it("supports every kind and state", async () => {
    const store = await openStore(tempDir());
    try {
      const h = await hierarchy(store);
      const kinds = [
        "decision",
        "question",
        "blocker",
        "commitment",
        "waiting",
        "follow_up",
      ] as const;
      for (const kind of kinds) {
        const item = await store.createItem({
          clientId: h.client.id,
          engagementId: h.engagement.id,
          kind,
          title: `${kind} item`,
        });
        assert.equal(item.kind, kind);
        assert.equal(item.state, "open");
        assert.equal(item.context, "");
        assert.equal(item.projectId, undefined);

        const closed = await store.updateItem(item.id, {
          state: "closed",
          context: "Resolved",
        });
        assert.equal(closed.state, "closed");
        assert.equal(closed.context, "Resolved");
        assert.equal(closed.kind, kind);
        const reopened = await store.updateItem(item.id, { state: "open" });
        assert.equal(reopened.state, "open");

        const projectItem = await store.createItem({
          clientId: h.client.id,
          engagementId: h.engagement.id,
          projectId: h.project.id,
          kind,
          title: `project ${kind}`,
          context: "In project",
          state: "closed",
        });
        assert.equal(projectItem.projectId, h.project.id);
        assert.equal(projectItem.state, "closed");
      }
      assert.equal(store.snapshot().items.length, kinds.length * 2);
      assert.deepEqual(
        store.listItems({ clientId: h.client.id, projectId: h.project.id })
          .map((item) => item.kind)
          .sort(),
        [...kinds].sort(),
      );

      await assert.rejects(
        store.createItem({
          clientId: h.client.id,
          engagementId: h.engagement.id,
          kind: "note" as never,
          title: "Bad",
        }),
        ValidationError,
      );
      await assert.rejects(
        store.createItem({
          clientId: h.client.id,
          engagementId: h.engagement.id,
          kind: "decision",
          title: " ",
        }),
        ValidationError,
      );
      await assert.rejects(
        store.updateItem(store.snapshot().items[0].id, { state: "done" as never }),
        ValidationError,
      );
    } finally {
      await store.close();
    }
  });
});

describe("meetings", () => {
  it("creates and edits meetings with required, real dates", async () => {
    const store = await openStore(tempDir());
    try {
      const h = await hierarchy(store);
      // Past and future dates are both allowed.
      const past = await store.createMeeting({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Kickoff",
        date: "2020-01-15",
      });
      assert.match(past.id, /^meeting-\d+$/);
      assert.equal(past.notes, "");
      assert.equal(past.projectId, undefined);
      const future = await store.createMeeting({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: h.project.id,
        title: "Review",
        date: "2035-12-31",
        notes: "Agenda TBD",
      });
      assert.equal(future.date, "2035-12-31");
      assert.equal(future.notes, "Agenda TBD");
      assert.equal(future.projectId, h.project.id);

      const edited = await store.updateMeeting(past.id, {
        title: "Kickoff (rescheduled)",
        date: "2020-02-29",
        notes: "Moved",
      });
      assert.equal(edited.title, "Kickoff (rescheduled)");
      assert.equal(edited.date, "2020-02-29");
      assert.equal(edited.notes, "Moved");
      assert.equal(edited.clientId, h.client.id);

      // Notes may be cleared, but the date can never be blank or absent.
      assert.equal((await store.updateMeeting(past.id, { notes: "" })).notes, "");
      await assert.rejects(store.updateMeeting(past.id, { date: "" }), ValidationError);
      await assert.rejects(store.updateMeeting(past.id, { date: "  " }), ValidationError);
      // An omitted date keeps the current one.
      assert.equal(
        (await store.updateMeeting(past.id, { notes: "Kept" })).date,
        "2020-02-29",
      );
      await assert.rejects(
        store.createMeeting({
          clientId: h.client.id,
          engagementId: h.engagement.id,
          title: "No date",
        } as never),
        ValidationError,
      );
      await assert.rejects(store.createMeeting({ clientId: h.client.id, engagementId: h.engagement.id, title: "Bad", date: "2023-02-29" }), ValidationError);
      await assert.rejects(store.createMeeting({ clientId: h.client.id, engagementId: h.engagement.id, title: " ", date: "2026-01-01" }), ValidationError);

      assert.deepEqual(
        store.listMeetings({ clientId: h.client.id, engagementId: h.engagement.id })
          .map((m) => m.title)
          .sort(),
        ["Kickoff (rescheduled)", "Review"],
      );
      assert.deepEqual(
        store.listMeetings({ clientId: h.client.id, projectId: h.project.id }).map((m) => m.title),
        ["Review"],
      );
    } finally {
      await store.close();
    }
  });
});

describe("parent links", () => {
  it("rejects cross-client and cross-engagement links without mutating", async () => {
    const store = await openStore(tempDir());
    try {
      const h = await hierarchy(store);
      const before = store.snapshot();

      // Engagement belongs to another client.
      await assert.rejects(
        store.createTask({
          clientId: h.client.id,
          engagementId: h.otherEngagement.id,
          title: "Cross client",
        }),
        ValidationError,
      );
      // Project belongs to a sibling engagement.
      await assert.rejects(
        store.createTask({
          clientId: h.client.id,
          engagementId: h.engagement.id,
          projectId: h.siblingProject.id,
          title: "Cross engagement",
        }),
        ValidationError,
      );
      await assert.rejects(
        store.createItem({
          clientId: h.client.id,
          engagementId: h.engagement.id,
          projectId: h.siblingProject.id,
          kind: "decision",
          title: "Cross engagement",
        }),
        ValidationError,
      );
      await assert.rejects(
        store.createMeeting({
          clientId: h.otherClient.id,
          engagementId: h.engagement.id,
          title: "Cross client",
          date: "2026-05-01",
        }),
        ValidationError,
      );
      // Missing records are reported as missing, not as valid links.
      await assert.rejects(
        store.createTask({ clientId: "client-999", engagementId: h.engagement.id, title: "X" }),
        MissingRecordError,
      );
      await assert.rejects(
        store.createMeeting({
          clientId: h.client.id,
          engagementId: h.engagement.id,
          projectId: "project-999",
          title: "X",
          date: "2026-05-01",
        }),
        MissingRecordError,
      );
      // Invalid link values are validation errors.
      await assert.rejects(
        store.createTask({ clientId: "", engagementId: h.engagement.id, title: "X" }),
        ValidationError,
      );
      await assert.rejects(
        store.createTask({
          clientId: h.client.id,
          engagementId: h.engagement.id,
          projectId: 42 as never,
          title: "X",
        }),
        ValidationError,
      );

      assert.deepEqual(store.snapshot(), before);

      // Edits cannot move a record to another engagement either.
      const task = await store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Stay",
      });
      const beforeEdit = store.snapshot();
      await assert.rejects(
        store.updateTask(task.id, { projectId: h.siblingProject.id }),
        ValidationError,
      );
      assert.deepEqual(store.snapshot(), beforeEdit);
      // Supplied client and engagement links on an edit are ignored, so a
      // record can never be moved to another client or engagement.
      const keptParents = await store.updateTask(task.id, {
        clientId: h.otherClient.id,
        engagementId: h.otherEngagement.id,
        title: "Renamed",
      });
      assert.equal(keptParents.clientId, h.client.id);
      assert.equal(keptParents.engagementId, h.engagement.id);
      assert.equal(keptParents.title, "Renamed");
      assert.equal(
        store.listTasks({ clientId: h.client.id, engagementId: h.engagement.id }).length,
        1,
      );
      assert.deepEqual(store.listTasks({ clientId: h.otherClient.id }), []);
    } finally {
      await store.close();
    }
  });

  it("keeps client and engagement links immutable and allows project reassignment", async () => {
    const store = await openStore(tempDir());
    try {
      const h = await hierarchy(store);
      const secondProject = await store.createProject({
        engagementId: h.engagement.id,
        name: "Second",
      });
      const task = await store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Movable",
      });

      // Set a project inside the same engagement.
      const assigned = await store.updateTask(task.id, { projectId: h.project.id });
      assert.equal(assigned.projectId, h.project.id);
      // Change it to another project in the same engagement.
      const changed = await store.updateTask(task.id, { projectId: secondProject.id });
      assert.equal(changed.projectId, secondProject.id);
      // Clear it.
      const cleared = await store.updateTask(task.id, { clearProject: true, title: "Still movable" });
      assert.equal(cleared.projectId, undefined);
      assert.equal(cleared.title, "Still movable");
      // Clearing again is harmless; setting and clearing together is refused.
      assert.equal((await store.updateTask(task.id, { clearProject: true })).projectId, undefined);
      assert.equal("projectId" in store.snapshot().tasks[0], false);
      await assert.rejects(
        store.updateTask(task.id, { projectId: h.project.id, clearProject: true }),
        ValidationError,
      );
      await assert.rejects(
        store.updateTask(task.id, { clearProject: "yes" as never }),
        ValidationError,
      );
      // A supplied null project link is invalid, not a way to clear it.
      await assert.rejects(
        store.updateTask(task.id, { projectId: null as never }),
        ValidationError,
      );
      assert.equal("projectId" in store.snapshot().tasks[0], false);

      // The client and engagement links are immutable even when supplied.
      const linked = await store.updateTask(task.id, { projectId: h.project.id });
      const edited = await store.updateTask(task.id, {
        engagementId: "engagement-bogus",
        clientId: h.otherClient.id,
        title: "Renamed",
      } as never);
      assert.equal(edited.engagementId, linked.engagementId);
      assert.equal(edited.clientId, h.client.id);
      assert.equal(edited.projectId, h.project.id);
      assert.equal(edited.title, "Renamed");

      const item = await store.createItem({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        kind: "question",
        title: "Q",
      });
      assert.equal(
        (await store.updateItem(item.id, { projectId: h.project.id })).projectId,
        h.project.id,
      );
      assert.equal(
        (await store.updateItem(item.id, { projectId: secondProject.id })).projectId,
        secondProject.id,
      );
      assert.equal(
        (await store.updateItem(item.id, { clearProject: true })).projectId,
        undefined,
      );

      const meeting = await store.createMeeting({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "M",
        date: "2026-03-03",
      });
      assert.equal(
        (await store.updateMeeting(meeting.id, { projectId: h.project.id })).projectId,
        h.project.id,
      );
      assert.equal(
        (await store.updateMeeting(meeting.id, { clearProject: true })).projectId,
        undefined,
      );
    } finally {
      await store.close();
    }
  });

  it("isolates siblings in selectors and edits", async () => {
    const store = await openStore(tempDir());
    try {
      const h = await hierarchy(store);
      await store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: h.project.id,
        title: "first",
      });
      await store.createTask({
        clientId: h.client.id,
        engagementId: h.sibling.id,
        projectId: h.siblingProject.id,
        title: "second",
      });
      await store.createTask({
        clientId: h.otherClient.id,
        engagementId: h.otherEngagement.id,
        title: "third",
      });
      assert.deepEqual(
        store.listTasks({ clientId: h.client.id, engagementId: h.engagement.id }).map(
          (t) => t.title,
        ),
        ["first"],
      );
      assert.deepEqual(
        store.listTasks({ clientId: h.client.id, engagementId: h.sibling.id }).map(
          (t) => t.title,
        ),
        ["second"],
      );
      assert.deepEqual(
        store.listTasks({
          clientId: h.client.id,
          engagementId: h.sibling.id,
          projectId: h.project.id,
        }),
        [],
      );
      assert.deepEqual(
        store.listTasks({ clientId: h.otherClient.id }).map((t) => t.title),
        ["third"],
      );

      // Selectors return detached, frozen copies.
      const listed = store.listTasks({ clientId: h.client.id });
      assert.throws(() => {
        (listed as unknown as { title: string }[]).push({ title: "x" });
      });
      assert.throws(() => {
        (listed[0] as { title: string }).title = "mutated";
      });
      assert.equal(store.snapshot().tasks[0].title, "first");

      assert.throws(() => store.listTasks({ clientId: "  " }), ValidationError);
      assert.throws(() => store.listTasks({ clientId: h.client.id, engagementId: "" }), ValidationError);

      // Every selector is client-scoped: an omitted filter is refused.
      for (const list of [
        store.listTasks.bind(store),
        store.listItems.bind(store),
        store.listMeetings.bind(store),
      ]) {
        assert.throws(() => list(undefined as unknown as WorkFilter), ValidationError);
      }
    } finally {
      await store.close();
    }
  });
});

describe("work persistence", () => {
  it("persists tasks, items and meetings across restart", async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    let ids: { task: string; item: string; meeting: string };
    try {
      const h = await hierarchy(store);
      const task = await store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: h.project.id,
        title: "Persist me",
        status: "in_progress",
        priority: "high",
        owner: "Dana",
        dueDate: "2027-06-30",
        context: "Some context",
      });
      const item = await store.createItem({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        kind: "blocker",
        title: "Blocked",
        context: "Waiting on vendor",
        state: "closed",
      });
      const meeting = await store.createMeeting({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Sync",
        date: "2025-11-04",
        notes: "Notes here",
      });
      ids = { task: task.id, item: item.id, meeting: meeting.id };
      await store.updateMeeting(ids.meeting, { notes: "Edited notes" });
    } finally {
      await store.close();
    }

    const reopened = await openStore(dir);
    try {
      const snapshot = reopened.snapshot();
      assert.deepEqual(snapshot.tasks, [
        {
          id: ids.task,
          clientId: snapshot.clients[0].id,
          engagementId: snapshot.engagements[0].id,
          projectId: snapshot.projects[0].id,
          title: "Persist me",
          status: "in_progress",
          priority: "high",
          owner: "Dana",
          dueDate: "2027-06-30",
          context: "Some context",
        },
      ]);
      assert.deepEqual(snapshot.items, [
        {
          id: ids.item,
          clientId: snapshot.clients[0].id,
          engagementId: snapshot.engagements[0].id,
          kind: "blocker",
          title: "Blocked",
          context: "Waiting on vendor",
          state: "closed",
        },
      ]);
      assert.deepEqual(snapshot.meetings, [
        {
          id: ids.meeting,
          clientId: snapshot.clients[0].id,
          engagementId: snapshot.engagements[0].id,
          title: "Sync",
          date: "2025-11-04",
          notes: "Edited notes",
        },
      ]);
      // New ids continue from the persisted counters.
      const next = await reopened.createTask({
        clientId: snapshot.clients[0].id,
        engagementId: snapshot.engagements[0].id,
        title: "After restart",
      });
      assert.equal(next.id, "task-2");
    } finally {
      await reopened.close();
    }
  });

  it("loads hierarchy-only version 1 snapshots with empty work collections", async () => {
    const dir = tempDir();
    const content = JSON.stringify({
      schemaVersion: 1,
      clients: [
        { id: "client-1", name: "Acme", background: "", contacts: "", stakeholders: "", requirements: "", objectives: "" },
      ],
      engagements: [
        { id: "engagement-1", clientId: "client-1", name: "E", objectives: "", status: "active" },
      ],
      projects: [
        { id: "project-1", engagementId: "engagement-1", name: "P", objectives: "", status: "planned" },
      ],
      nextIds: { clients: 2, engagements: 2, projects: 2 },
    });
    writeFileSync(storePath(dir), content, "utf8");
    const store = await openStore(dir);
    try {
      const snapshot = store.snapshot();
      assert.deepEqual(snapshot.tasks, []);
      assert.deepEqual(snapshot.items, []);
      assert.deepEqual(snapshot.meetings, []);
      assert.equal(snapshot.clients.length, 1);
      assert.equal(snapshot.engagements.length, 1);
      // The legacy hierarchy is still editable and new work records can be added.
      const task = await store.createTask({
        clientId: "client-1",
        engagementId: "engagement-1",
        projectId: "project-1",
        title: "First task",
      });
      assert.equal(task.id, "task-1");
      assert.equal((await store.updateClient("client-1", { name: "Renamed" })).name, "Renamed");
    } finally {
      await store.close();
    }
    // The migrated document is written at the current schema version. No event
    // is invented for the records that already exist: the journal holds only
    // the events of this session's own effective mutations, the new task and
    // the client's rename.
    const saved = JSON.parse(readFileSync(storePath(dir), "utf8"));
    assert.equal(saved.schemaVersion, 5);
    assert.equal(saved.tasks.length, 1);
    assert.deepEqual(
      saved.activity.map((e: { action: string; targetKind: string; targetId: string }) =>
        `${e.action}:${e.targetKind}:${e.targetId}`,
      ),
      ["create:task:task-1", "edit:client:client-1"],
      "only this session's changes are recorded",
    );
    assert.equal(saved.nextActivityId, 3);

    const reopened = await openStore(dir);
    try {
      assert.equal(reopened.snapshot().tasks[0].title, "First task");
      assert.deepEqual(reopened.snapshot().activity, saved.activity);
    } finally {
      await reopened.close();
    }
  });

  it("refuses stored work records with invalid links, fields or dates", async () => {
    const dir = tempDir();
    const hierarchyDoc = {
      clients: [
        { id: "client-1", name: "A", background: "", contacts: "", stakeholders: "", requirements: "", objectives: "" },
        { id: "client-2", name: "B", background: "", contacts: "", stakeholders: "", requirements: "", objectives: "" },
      ],
      engagements: [
        { id: "engagement-1", clientId: "client-1", name: "E", objectives: "", status: "planned" },
        { id: "engagement-2", clientId: "client-2", name: "E2", objectives: "", status: "planned" },
      ],
      projects: [
        { id: "project-1", engagementId: "engagement-1", name: "P", objectives: "", status: "planned" },
      ],
    };
    const validTask = {
      id: "task-1",
      clientId: "client-1",
      engagementId: "engagement-1",
      projectId: "project-1",
      title: "T",
      status: "open",
      priority: "normal",
      owner: "",
      dueDate: "2026-01-02",
      context: "",
    };
    const cases: unknown[] = [
      // Engagement from another client.
      { ...hierarchyDoc, schemaVersion: 3, tasks: [{ ...validTask, engagementId: "engagement-2" }], items: [], meetings: [], nextIds: { clients: 3, engagements: 3, projects: 2, tasks: 2 } },
      // Project from another engagement.
      { ...hierarchyDoc, schemaVersion: 3, tasks: [], items: [], meetings: [{ id: "meeting-1", clientId: "client-2", engagementId: "engagement-2", projectId: "project-1", title: "M", date: "2026-01-01", notes: "" }], nextIds: { clients: 3, engagements: 3, projects: 2, meetings: 2 } },
      // Impossible date.
      { ...hierarchyDoc, schemaVersion: 3, tasks: [{ ...validTask, dueDate: "2023-02-29" }], items: [], meetings: [], nextIds: { clients: 3, engagements: 3, projects: 2, tasks: 2 } },
      // Invalid item kind.
      { ...hierarchyDoc, schemaVersion: 3, tasks: [], items: [{ id: "item-1", clientId: "client-1", engagementId: "engagement-1", kind: "idea", title: "I", context: "", state: "open" }], meetings: [], nextIds: { clients: 3, engagements: 3, projects: 2, items: 2 } },
      // Work collection present but not an array.
      { ...hierarchyDoc, schemaVersion: 3, tasks: {}, items: [], meetings: [], nextIds: { clients: 3, engagements: 3, projects: 2 } },
      // Work ids must follow the generated pattern.
      { ...hierarchyDoc, schemaVersion: 3, tasks: [{ ...validTask, id: "bogus" }], items: [], meetings: [], nextIds: { clients: 3, engagements: 3, projects: 2, tasks: 2 } },
      // A counter is required once records exist.
      { ...hierarchyDoc, schemaVersion: 3, tasks: [validTask], items: [], meetings: [], nextIds: { clients: 3, engagements: 3, projects: 2 } },
    ];
    for (const value of cases) {
      const content = JSON.stringify(value);
      writeFileSync(storePath(dir), content, "utf8");
      await assert.rejects(openStore(dir), PersistenceError);
      assert.equal(readFileSync(storePath(dir), "utf8"), content);
      assert.equal(existsSync(lockPath(dir)), false);
    }

    // An invalid legacy version 1 document is still refused.
    const invalidLegacy = [
      // A version 1 document with a work counter is inconsistent.
      { ...hierarchyDoc, schemaVersion: 1, nextIds: { clients: 3, engagements: 3, projects: 2, tasks: 1 } },
      // A version 1 document with a work collection is inconsistent.
      { ...hierarchyDoc, schemaVersion: 1, tasks: [], items: [], meetings: [], nextIds: { clients: 3, engagements: 3, projects: 2 } },
      // Version 2 was never written and stays unsupported.
      { ...hierarchyDoc, schemaVersion: 2, tasks: [], items: [], meetings: [], nextIds: { clients: 3, engagements: 3, projects: 2 } },
    ];
    for (const value of invalidLegacy) {
      const content = JSON.stringify(value);
      writeFileSync(storePath(dir), content, "utf8");
      await assert.rejects(openStore(dir), PersistenceError);
      assert.equal(readFileSync(storePath(dir), "utf8"), content);
      assert.equal(existsSync(lockPath(dir)), false);
    }

    writeFileSync(
      storePath(dir),
      JSON.stringify({ ...hierarchyDoc, schemaVersion: 1, nextIds: { clients: 3, engagements: 3, projects: 2 } }),
      "utf8",
    );
    const legacy = await openStore(dir);
    try {
      assert.deepEqual(legacy.snapshot().tasks, []);
    } finally {
      await legacy.close();
    }
  });
});
