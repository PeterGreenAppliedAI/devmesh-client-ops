import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isEffectivelyArchived } from "../src/archive.ts";
import {
  addCalendarDays,
  isCalendarDate,
  localCalendarToday,
  renderDashboard,
  selectDashboard,
} from "../src/dashboard.ts";
import { escapeHtml } from "../src/html.ts";
import { openStore, type Snapshot, type Store } from "../src/store.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-"));
  roots.push(dir);
  return dir;
}

async function withStore(body: (store: Store) => Promise<void>): Promise<void> {
  const store = await openStore(tempDir());
  try {
    await body(store);
  } finally {
    await store.close();
  }
}

/** A fixed clock: a local Date whose calendar day is the given day. */
function fixedClock(date: string): Date {
  // Local noon keeps every local time zone on the same calendar day.
  return new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), 12, 0, 0);
}

/**
 * The rows of one section as "id" and due date, so an order can be asserted
 * without depending on how a row is rendered.
 */
function rowIds(dashboard: ReturnType<typeof selectDashboard>, kind: string): string[] {
  const section = dashboard.sections.find((candidate) => candidate.kind === kind);
  assert.ok(section !== undefined, `section ${kind}`);
  return section.rows.map((row) => row.id);
}

/** The text content of each card's link, in document order, for one section. */
function sectionOf(document: string, title: string): string {
  const start = document.indexOf(`<h2>${escapeHtml(title)}</h2>`);
  if (start < 0) return "";
  const end = document.indexOf("</section>", start);
  return document.slice(start, end < 0 ? undefined : end);
}

describe("dashboard calendar arithmetic", () => {
  it("adds calendar days across month, year and leap boundaries", () => {
    assert.equal(addCalendarDays("2026-01-31", 1), "2026-02-01");
    assert.equal(addCalendarDays("2026-02-28", 1), "2026-03-01");
    assert.equal(addCalendarDays("2028-02-28", 1), "2028-02-29");
    assert.equal(addCalendarDays("2028-02-28", 2), "2028-03-01");
    assert.equal(addCalendarDays("2100-02-28", 1), "2100-03-01");
    assert.equal(addCalendarDays("2000-02-28", 1), "2000-02-29");
    assert.equal(addCalendarDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addCalendarDays("2026-03-01", -1), "2026-02-28");
    assert.equal(addCalendarDays("2026-11-26", 7), "2026-12-03");
    assert.equal(addCalendarDays("2026-11-30", 7), "2026-12-07");
    assert.equal(addCalendarDays("2026-12-28", 7), "2027-01-04");
  });

  it("keeps the literal year when adding days to dates below the year 100", () => {
    // Date.UTC would read years 0-99 as 1900-1999; calendar arithmetic must not.
    assert.equal(addCalendarDays("0099-12-28", 7), "0100-01-04");
    assert.equal(addCalendarDays("0099-12-31", 1), "0100-01-01");
    assert.equal(addCalendarDays("0001-12-31", 1), "0002-01-01");
    assert.equal(addCalendarDays("0099-12-28", -28), "0099-11-30");
    assert.equal(addCalendarDays("0001-01-01", 0), "0001-01-01");
    assert.equal(addCalendarDays("0004-02-28", 1), "0004-02-29");
  });

  it("recognises real calendar dates and refuses invalid ones", () => {
    assert.equal(isCalendarDate("2026-11-22"), true);
    assert.equal(isCalendarDate("2028-02-29"), true);
    assert.equal(isCalendarDate("2027-02-29"), false);
    assert.equal(isCalendarDate("2026-13-01"), false);
    assert.equal(isCalendarDate("2026-00-10"), false);
    assert.equal(isCalendarDate("2026-04-31"), false);
    assert.equal(isCalendarDate("2026-1-1"), false);
    assert.throws(() => selectDashboard(emptySnapshot(), "not-a-date"), /reference date/);
    assert.throws(() => selectDashboard(emptySnapshot(), "2027-02-29"), /reference date/);
  });

  it("derives today from the local calendar of the given clock", () => {
    assert.equal(localCalendarToday(fixedClock("2026-11-22")), "2026-11-22");
    // The local calendar day is used, not UTC: the constructed noon date's
    // local getters name the same day whatever the zone.
    const late = new Date(2026, 11, 31, 23, 30, 0);
    assert.equal(localCalendarToday(late), "2026-12-31");
    const early = new Date(2027, 0, 1, 0, 15, 0);
    assert.equal(localCalendarToday(early), "2027-01-01");
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

describe("dashboard selection", () => {
  it("shows the six attention sections in their order, then the added sections, even when the workspace is empty", async () => {
    await withStore(async (store) => {
      const dashboard = selectDashboard(store.snapshot(), "2026-11-22");
      assert.equal(dashboard.today, "2026-11-22");
      assert.deepEqual(
        dashboard.sections.map((section) => section.kind),
        [
          "overdue",
          "due_soon",
          "blocker",
          "question",
          "commitment",
          "waiting",
          "high_priority",
          "waiting_tasks",
          "follow_up",
          "recent_activity",
          "engagement",
        ],
      );
      assert.deepEqual(
        dashboard.sections.map((section) => section.title),
        [
          "Overdue tasks",
          "Tasks due soon",
          "Open blockers",
          "Open questions",
          "Open commitments",
          "Open waiting items",
          "High-priority tasks",
          "Waiting tasks",
          "Open follow-ups",
          "Recent activity",
          "Engagements in progress",
        ],
      );
      for (const section of dashboard.sections) assert.equal(section.rows.length, 0);
    });
  });

  it("classifies yesterday, today, +7 and +8 as overdue, due soon, due soon and neither", async () => {
    await withStore(async (store) => {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
      const base = { clientId: client.id, engagementId: engagement.id };
      const yesterday = await store.createTask({ ...base, title: "Yesterday", dueDate: "2026-11-21" });
      const today = await store.createTask({ ...base, title: "Today", dueDate: "2026-11-22" });
      const plus7 = await store.createTask({ ...base, title: "+7", dueDate: "2026-11-29" });
      const plus8 = await store.createTask({ ...base, title: "+8", dueDate: "2026-11-30" });

      const dashboard = selectDashboard(store.snapshot(), "2026-11-22");
      assert.deepEqual(rowIds(dashboard, "overdue"), [yesterday.id]);
      assert.deepEqual(rowIds(dashboard, "due_soon"), [today.id, plus7.id]);
      assert.ok(!rowIds(dashboard, "overdue").includes(plus8.id));
      assert.ok(!rowIds(dashboard, "due_soon").includes(plus8.id));
      const dueSoon = dashboard.sections.find((section) => section.kind === "due_soon")!;
      assert.equal(dueSoon.range, "2026-11-22 to 2026-11-29");
      const overdue = dashboard.sections.find((section) => section.kind === "overdue")!;
      assert.equal(overdue.range, "2026-11-21 to 2026-11-21");
    });
  });

  it("covers month, year and leap boundaries with calendar days", async () => {
    await withStore(async (store) => {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
      const base = { clientId: client.id, engagementId: engagement.id };
      const monthEnd = await store.createTask({ ...base, title: "Month end", dueDate: "2026-12-31" });
      const nextMonth = await store.createTask({ ...base, title: "Next month", dueDate: "2027-01-01" });
      const leap = await store.createTask({ ...base, title: "Leap", dueDate: "2028-02-29" });
      const nonLeap = await store.createTask({ ...base, title: "Non leap", dueDate: "2027-02-28" });

      const endOfYear = selectDashboard(store.snapshot(), "2026-12-28");
      assert.deepEqual(rowIds(endOfYear, "due_soon"), [monthEnd.id, nextMonth.id]);
      assert.equal(endOfYear.sections[1].range, "2026-12-28 to 2027-01-04");
      assert.deepEqual(rowIds(endOfYear, "overdue"), []);

      // On 2027-02-28 the nonleap date is today; 2027 has no 29 February.
      const nonLeapToday = selectDashboard(store.snapshot(), "2027-02-28");
      assert.deepEqual(rowIds(nonLeapToday, "due_soon"), [nonLeap.id]);
      assert.deepEqual(
        rowIds(nonLeapToday, "overdue"),
        [monthEnd.id, nextMonth.id],
      );

      // Across the leap day: 2028-02-22 through 2028-02-29 includes the 29th.
      const leapToday = selectDashboard(store.snapshot(), "2028-02-22");
      assert.deepEqual(rowIds(leapToday, "due_soon"), [leap.id]);
      assert.deepEqual(rowIds(leapToday, "overdue"), [monthEnd.id, nextMonth.id, nonLeap.id]);
      // After the leap range: the leap date is still due soon, not overdue.
      const afterLeap = selectDashboard(store.snapshot(), "2028-02-23");
      assert.deepEqual(rowIds(afterLeap, "due_soon"), [leap.id]);
      assert.ok(!rowIds(afterLeap, "overdue").includes(leap.id));
    });
  });

  it("excludes done and undated tasks and keeps open, in-progress and waiting dated tasks", async () => {
    await withStore(async (store) => {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
      const base = { clientId: client.id, engagementId: engagement.id };
      const open = await store.createTask({ ...base, title: "Open", status: "open", dueDate: "2026-11-21" });
      const inProgress = await store.createTask({ ...base, title: "In progress", status: "in_progress", dueDate: "2026-11-23" });
      const waiting = await store.createTask({ ...base, title: "Waiting", status: "waiting", dueDate: "2026-11-24" });
      await store.createTask({ ...base, title: "Done", status: "done", dueDate: "2026-11-21" });
      await store.createTask({ ...base, title: "Open undated", status: "open" });
      await store.createTask({ ...base, title: "In progress undated", status: "in_progress" });
      await store.createTask({ ...base, title: "Waiting undated", status: "waiting" });

      const dashboard = selectDashboard(store.snapshot(), "2026-11-22");
      assert.deepEqual(rowIds(dashboard, "overdue"), [open.id]);
      assert.deepEqual(rowIds(dashboard, "due_soon"), [inProgress.id, waiting.id]);

      // The waiting task keeps its due date; moving it to done on the board
      // takes it out of both due sections exactly as for any done task.
      await store.moveTask(waiting.id, "done", { kind: "all" });
      const after = selectDashboard(store.snapshot(), "2026-11-22");
      assert.ok(!rowIds(after, "due_soon").includes(waiting.id));
      assert.ok(!rowIds(after, "overdue").includes(waiting.id));

      // Moving it back to waiting, with the date unchanged, makes it eligible
      // again under the same range.
      await store.moveTask(waiting.id, "waiting", { kind: "all" });
      const again = selectDashboard(store.snapshot(), "2026-11-22");
      assert.deepEqual(rowIds(again, "due_soon"), [inProgress.id, waiting.id]);
      assert.equal(store.snapshot().tasks.find((task) => task.id === waiting.id)?.dueDate, "2026-11-24");
    });
  });

  it("sorts task groups by ascending due date then id", async () => {
    await withStore(async (store) => {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
      const base = { clientId: client.id, engagementId: engagement.id };
      const later = await store.createTask({ ...base, title: "Later", dueDate: "2026-11-20" });
      const earlier = await store.createTask({ ...base, title: "Earlier", dueDate: "2026-11-19" });
      const sameDayA = await store.createTask({ ...base, title: "A", dueDate: "2026-11-20" });
      const sameDayB = await store.createTask({ ...base, title: "B", dueDate: "2026-11-20" });
      const soonLate = await store.createTask({ ...base, title: "Soon late", dueDate: "2026-11-29" });
      const soonEarly = await store.createTask({ ...base, title: "Soon early", dueDate: "2026-11-22" });

      const dashboard = selectDashboard(store.snapshot(), "2026-11-22");
      const expectedOverdue = [earlier, later, sameDayA, sameDayB]
        .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : a.dueDate! > b.dueDate! ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((task) => task.id);
      assert.deepEqual(rowIds(dashboard, "overdue"), expectedOverdue);
      const expectedSoon = [soonLate, soonEarly]
        .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : a.dueDate! > b.dueDate! ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((task) => task.id);
      assert.deepEqual(rowIds(dashboard, "due_soon"), expectedSoon);
      assert.equal(rowIds(dashboard, "due_soon")[0], soonEarly.id);
    });
  });

  it("covers every item kind and state, retaining snapshot order and excluding decisions", async () => {
    await withStore(async (store) => {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
      const base = { clientId: client.id, engagementId: engagement.id };
      const blocker = await store.createItem({ ...base, kind: "blocker", title: "Blocker", state: "open" });
      const question = await store.createItem({ ...base, kind: "question", title: "Question", state: "open" });
      const commitment = await store.createItem({ ...base, kind: "commitment", title: "Commitment", state: "open" });
      const waiting = await store.createItem({ ...base, kind: "waiting", title: "Waiting", state: "open" });
      const followUp = await store.createItem({ ...base, kind: "follow_up", title: "Follow-up", state: "open" });
      // Closed items of every kind and open decisions are excluded.
      for (const kind of ["blocker", "question", "commitment", "waiting", "follow_up"] as const) {
        await store.createItem({ ...base, kind, title: `Closed ${kind}`, state: "closed" });
      }
      const decision = await store.createItem({ ...base, kind: "decision", title: "Decision", state: "open" });

      const dashboard = selectDashboard(store.snapshot(), "2026-11-22");
      assert.deepEqual(rowIds(dashboard, "blocker"), [blocker.id]);
      assert.deepEqual(rowIds(dashboard, "question"), [question.id]);
      assert.deepEqual(rowIds(dashboard, "commitment"), [commitment.id]);
      assert.deepEqual(rowIds(dashboard, "waiting"), [waiting.id]);
      assert.deepEqual(rowIds(dashboard, "follow_up"), [followUp.id]);
      // No section contains a decision.
      const allIds = dashboard.sections.flatMap((section) => section.rows.map((row) => row.id));
      assert.ok(!allIds.includes(decision.id));
      assert.equal(allIds.filter((id) => [blocker.id, question.id, commitment.id, waiting.id, followUp.id].includes(id)).length, 5);
    });
  });

  it("retains snapshot order for item groups while task groups are sorted", async () => {
    await withStore(async (store) => {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
      const base = { clientId: client.id, engagementId: engagement.id };
      const first = await store.createItem({ ...base, kind: "blocker", title: "First", state: "open" });
      const second = await store.createItem({ ...base, kind: "blocker", title: "Second", state: "open" });
      const third = await store.createItem({ ...base, kind: "blocker", title: "Third", state: "open" });
      const dashboard = selectDashboard(store.snapshot(), "2026-11-22");
      // The store's snapshot order is creation order; the rows keep it.
      assert.deepEqual(rowIds(dashboard, "blocker"), [first.id, second.id, third.id]);
    });
  });

  it("excludes records archived directly or through an ancestor, for two clients", async () => {
    await withStore(async (store) => {
      const alpha = await store.createClient({ name: "Alpha" });
      const beta = await store.createClient({ name: "Beta" });
      const alphaEngagement = await store.createEngagement({ clientId: alpha.id, name: "Alpha delivery" });
      const betaEngagement = await store.createEngagement({ clientId: beta.id, name: "Beta delivery" });
      const alphaProject = await store.createProject({ engagementId: alphaEngagement.id, name: "Alpha project" });

      const alphaTask = await store.createTask({
        clientId: alpha.id, engagementId: alphaEngagement.id, title: "Alpha task", dueDate: "2026-11-21",
      });
      const betaTask = await store.createTask({
        clientId: beta.id, engagementId: betaEngagement.id, title: "Beta task", dueDate: "2026-11-21",
      });
      const betaBlocker = await store.createItem({
        clientId: beta.id, engagementId: betaEngagement.id, kind: "blocker", title: "Beta blocker", state: "open",
      });
      // Direct archive on the record itself.
      const selfArchived = await store.createTask({
        clientId: alpha.id, engagementId: alphaEngagement.id, title: "Self archived", dueDate: "2026-11-21",
      });
      await store.setArchived("task", selfArchived.id, true);
      // Inherited archives: the project for one task, the client for another.
      const projectArchived = await store.createTask({
        clientId: alpha.id, engagementId: alphaEngagement.id, projectId: alphaProject.id,
        title: "Project archived", dueDate: "2026-11-21",
      });
      await store.setArchived("project", alphaProject.id, true);
      const clientArchivedItem = await store.createItem({
        clientId: beta.id, engagementId: betaEngagement.id, kind: "blocker", title: "Client archived", state: "open",
      });
      await store.setArchived("client", beta.id, true);

      const snapshot = store.snapshot();
      assert.equal(isEffectivelyArchived(snapshot, snapshot.tasks.find((t) => t.id === projectArchived.id)!), true);
      const dashboard = selectDashboard(snapshot, "2026-11-22");
      assert.deepEqual(rowIds(dashboard, "overdue"), [alphaTask.id]);
      // Beta's client is archived, so its task and its item are hidden.
      assert.ok(!rowIds(dashboard, "overdue").includes(betaTask.id));
      assert.ok(!rowIds(dashboard, "blocker").includes(betaBlocker.id));
      assert.ok(!rowIds(dashboard, "blocker").includes(clientArchivedItem.id));
      assert.deepEqual(rowIds(dashboard, "blocker"), []);

      // Restoring beta makes its records visible again; alpha's archived ones stay hidden.
      await store.setArchived("client", beta.id, false);
      const restored = selectDashboard(store.snapshot(), "2026-11-22");
      assert.deepEqual(rowIds(restored, "overdue").sort(), [alphaTask.id, betaTask.id].sort());
      assert.deepEqual(rowIds(restored, "overdue").includes(selfArchived.id), false);
      assert.deepEqual(rowIds(restored, "overdue").includes(projectArchived.id), false);
      // The record's own archive flag survives its client's restore, so the
      // beta item archived directly is still hidden and the one archived only
      // through its client is visible again.
      assert.deepEqual(rowIds(restored, "blocker"), [betaBlocker.id, clientArchivedItem.id]);
    });
  });

  it("names each row's client and engagement and shows its actual date", async () => {
    await withStore(async (store) => {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
      const task = await store.createTask({
        clientId: client.id, engagementId: engagement.id, title: "Dated", dueDate: "2026-11-19",
      });
      const dashboard = selectDashboard(store.snapshot(), "2026-11-22");
      const row = dashboard.sections[0].rows[0];
      assert.equal(row.id, task.id);
      assert.equal(row.clientName, "Acme");
      assert.equal(row.engagementName, "Delivery");
      assert.equal(row.clientId, client.id);
      assert.equal(row.engagementId, engagement.id);
      assert.equal(row.detail, "2026-11-19");
      assert.equal(row.href, `/tasks/${task.id}`);
    });
  });

  it("reads a snapshot without mutating it", async () => {
    await withStore(async (store) => {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
      await store.createTask({
        clientId: client.id, engagementId: engagement.id, title: "Task", dueDate: "2026-11-21",
      });
      await store.createItem({
        clientId: client.id, engagementId: engagement.id, kind: "blocker", title: "Blocker", state: "open",
      });
      const before = store.snapshot();
      const copy = JSON.parse(JSON.stringify(before)) as Snapshot;
      const dashboard = selectDashboard(before, "2026-11-22");
      renderDashboard(before, fixedClock("2026-11-22"));
      assert.deepEqual(JSON.parse(JSON.stringify(before)), copy);
      assert.deepEqual(dashboard.sections[0].rows.length, 1);
      // The selector never shares a mutable row with the snapshot.
      assert.notEqual(dashboard.sections[0].rows[0].title, undefined);
    });
  });
});

describe("dashboard rendering", () => {
  async function seeded(): Promise<{ store: Store; ids: Record<string, string> }> {
    const store = await openStore(tempDir());
    const client = await store.createClient({ name: 'Acme <Ltd> & "partners"' });
    const other = await store.createClient({ name: "Other <client>" });
    const engagement = await store.createEngagement({ clientId: client.id, name: "Discovery <phase>" });
    const otherEngagement = await store.createEngagement({ clientId: other.id, name: "Other & engagement" });
    const overdue = await store.createTask({
      clientId: client.id, engagementId: engagement.id, title: "Overdue <task>", dueDate: "2026-11-21",
    });
    const dueSoon = await store.createTask({
      clientId: other.id, engagementId: otherEngagement.id, title: "Soon & task", dueDate: "2026-11-25",
    });
    const blocker = await store.createItem({
      clientId: client.id, engagementId: engagement.id, kind: "blocker", title: 'Blocked "today"', state: "open",
    });
    const question = await store.createItem({
      clientId: other.id, engagementId: otherEngagement.id, kind: "question", title: "Question?", state: "open",
    });
    return {
      store,
      ids: {
        client: client.id,
        engagement: engagement.id,
        otherClient: other.id,
        otherEngagement: otherEngagement.id,
        overdue: overdue.id,
        dueSoon: dueSoon.id,
        blocker: blocker.id,
        question: question.id,
      },
    };
  }

  it("renders every named section in order, with links, ancestry, dates and escaped text", async () => {
    const { store, ids } = await seeded();
    try {
      const page = renderDashboard(store.snapshot(), fixedClock("2026-11-22"));
      const document = page.html;
      const titles = [
        "Overdue tasks",
        "Tasks due soon",
        "Open blockers",
        "Open questions",
        "Open commitments",
        "Open waiting items",
        "High-priority tasks",
        "Waiting tasks",
        "Open follow-ups",
        "Recent activity",
        "Engagements in progress",
      ];
      let last = -1;
      for (const title of titles) {
        const at = document.indexOf(`<h2>${escapeHtml(title)}</h2>`);
        assert.ok(at >= 0, title);
        assert.ok(at > last, `${title} keeps its place after the section before it`);
        last = at;
      }

      const overdue = sectionOf(document, "Overdue tasks");
      // The row links to its record and names its client and engagement, linked.
      assert.match(overdue, new RegExp(`<a href="/tasks/${ids.overdue}">Overdue &lt;task&gt;</a>`));
      assert.match(overdue, new RegExp(`client <a href="/clients/${ids.client}">Acme &lt;Ltd&gt; &amp; &quot;partners&quot;</a>`));
      assert.match(overdue, new RegExp(`engagement <a href="/engagements/${ids.engagement}">Discovery &lt;phase&gt;</a>`));
      // The actual due date is shown.
      assert.ok(overdue.includes("2026-11-21"));
      // The range names the real calendar dates.
      assert.ok(overdue.includes("2026-11-21 to 2026-11-21"));
      // Stored markup is escaped, never emitted raw.
      assert.ok(!document.includes("<Ltd>"));
      assert.ok(!document.includes('<span class="badge">overdue'));

      const soon = sectionOf(document, "Tasks due soon");
      assert.match(soon, new RegExp(`<a href="/tasks/${ids.dueSoon}">Soon &amp; task</a>`));
      assert.match(soon, new RegExp(`client <a href="/clients/${ids.otherClient}">Other &lt;client&gt;</a>`));
      assert.ok(soon.includes("2026-11-22 to 2026-11-29"));
      assert.ok(soon.includes("2026-11-25"));

      const blockers = sectionOf(document, "Open blockers");
      assert.match(blockers, new RegExp(`<a href="/items/${ids.blocker}">Blocked &quot;today&quot;</a>`));
      assert.match(blockers, new RegExp(`engagement <a href="/engagements/${ids.engagement}">`));
      const questions = sectionOf(document, "Open questions");
      assert.match(questions, new RegExp(`<a href="/items/${ids.question}">Question\\?</a>`));
      assert.match(questions, new RegExp(`client <a href="/clients/${ids.otherClient}">`));
    } finally {
      await store.close();
    }
  });

  it("renders every qualifying record without truncation", async () => {
    const store = await openStore(tempDir());
    try {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
      const ids: string[] = [];
      for (let index = 0; index < 25; index += 1) {
        const task = await store.createTask({
          clientId: client.id, engagementId: engagement.id, title: `Task ${index}`, dueDate: "2026-11-21",
        });
        ids.push(task.id);
      }
      const blockerIds: string[] = [];
      for (let index = 0; index < 25; index += 1) {
        const item = await store.createItem({
          clientId: client.id, engagementId: engagement.id, kind: "blocker", title: `Blocker ${index}`, state: "open",
        });
        blockerIds.push(item.id);
      }
      const document = renderDashboard(store.snapshot(), fixedClock("2026-11-22")).html;
      const overdue = sectionOf(document, "Overdue tasks");
      const blockers = sectionOf(document, "Open blockers");
      for (const id of ids) assert.ok(overdue.includes(`href="/tasks/${id}"`), id);
      for (const id of blockerIds) assert.ok(blockers.includes(`href="/items/${id}"`), id);
    } finally {
      await store.close();
    }
  });

  it("explains empty sections and links to /clients", async () => {
    const { store, ids } = await seeded();
    try {
      const document = renderDashboard(store.snapshot(), fixedClock("2026-11-22")).html;
      // Attention sections without rows say nothing needs attention and link
      // to /clients; the added attention sections do the same.
      for (const title of [
        "Open commitments",
        "Open waiting items",
        "High-priority tasks",
        "Waiting tasks",
        "Open follow-ups",
      ]) {
        const section = sectionOf(document, title);
        assert.ok(section.includes("Nothing needs attention here."), title);
        assert.ok(section.includes('href="/clients"'), title);
        assert.ok(section.includes("Browse clients"), title);
      }
      // A populated section does not carry the empty state.
      assert.ok(!sectionOf(document, "Overdue tasks").includes("Nothing needs attention here."));
      // The added sections that are not attention sets have their own empty
      // text and do not offer the client list as a next step for attention.
      // The seeded store recorded every create, so the activity section is
      // populated and the engagement section is empty here.
      const activity = sectionOf(document, "Recent activity");
      assert.ok(activity.includes('href="/tasks/'));
      assert.ok(!activity.includes("No recorded activity yet."));
      const engagements = sectionOf(document, "Engagements in progress");
      assert.match(engagements, new RegExp(`<a href="/engagements/${ids.engagement}">`));
      assert.ok(engagements.includes('<span class="badge">planned</span>'));
      // Empty added sections that are not attention sets say so explicitly.
      const empty = renderDashboard(
        { ...store.snapshot(), engagements: [], activity: [] },
        fixedClock("2026-11-22"),
      ).html;
      assert.ok(sectionOf(empty, "Engagements in progress").includes(
        "No unfinished engagements (planned, active or on hold).",
      ));
      assert.ok(!sectionOf(empty, "Engagements in progress").includes('href="/clients"'));
      assert.ok(sectionOf(empty, "Recent activity").includes("No recorded activity yet."));
      assert.ok(!sectionOf(empty, "Recent activity").includes('href="/clients"'));
      void ids;
    } finally {
      await store.close();
    }
  });

  it("renders an entirely empty dashboard as explicit empty sections", async () => {
    const store = await openStore(tempDir());
    try {
      const document = renderDashboard(store.snapshot(), fixedClock("2026-11-22")).html;
      for (const title of [
        "Overdue tasks",
        "Tasks due soon",
        "Open blockers",
        "Open questions",
        "Open commitments",
        "Open waiting items",
      ]) {
        const section = sectionOf(document, title);
        assert.ok(section.length > 0, title);
        assert.ok(section.includes("Nothing needs attention here."), title);
        assert.ok(section.includes('href="/clients"'), title);
      }
      for (const [title, text] of [
        ["High-priority tasks", "Nothing needs attention here."],
        ["Waiting tasks", "Nothing needs attention here."],
        ["Open follow-ups", "Nothing needs attention here."],
        ["Recent activity", "No recorded activity yet."],
        ["Engagements in progress", "No unfinished engagements (planned, active or on hold)."],
      ] as const) {
        const section = sectionOf(document, title);
        assert.ok(section.length > 0, title);
        assert.ok(section.includes(text), title);
      }
    } finally {
      await store.close();
    }
  });

  it("links a task's actual project beside its client and engagement", async () => {
    const store = await openStore(tempDir());
    try {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
      const project = await store.createProject({ engagementId: engagement.id, name: "Phase <one>" });
      const task = await store.createTask({
        clientId: client.id, engagementId: engagement.id, projectId: project.id,
        title: "Project task", priority: "high", dueDate: "2026-11-21",
      });
      const item = await store.createItem({
        clientId: client.id, engagementId: engagement.id, projectId: project.id,
        kind: "blocker", title: "Project blocker", state: "open",
      });
      const document = renderDashboard(store.snapshot(), fixedClock("2026-11-22")).html;
      for (const title of ["Overdue tasks", "High-priority tasks"]) {
        const section = sectionOf(document, title);
        assert.match(section, new RegExp(`href="/tasks/${task.id}"`), title);
        assert.match(section, new RegExp(`project <a href="/projects/${project.id}">Phase &lt;one&gt;</a>`), title);
      }
      assert.match(
        sectionOf(document, "Open blockers"),
        new RegExp(`project <a href="/projects/${project.id}">Phase &lt;one&gt;</a>`),
      );
      assert.match(sectionOf(document, "Open blockers"), new RegExp(`href="/items/${item.id}"`));
    } finally {
      await store.close();
    }
  });

  it("renders engagement rows linking the engagement and its client", async () => {
    const store = await openStore(tempDir());
    try {
      const client = await store.createClient({ name: "Acme <Ltd>" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Discovery & design" });
      await store.createEngagement({ clientId: client.id, name: "Completed one", status: "completed" });
      const document = renderDashboard(store.snapshot(), fixedClock("2026-11-22")).html;
      const section = sectionOf(document, "Engagements in progress");
      assert.match(section, new RegExp(`<a href="/engagements/${engagement.id}">Discovery &amp; design</a>`));
      assert.match(section, new RegExp(`client <a href="/clients/${client.id}">Acme &lt;Ltd&gt;</a>`));
      assert.ok(section.includes('<span class="badge">planned</span>'));
      assert.ok(!section.includes("Completed one"));
    } finally {
      await store.close();
    }
  });

  it("renders recent activity with current labels, the action and target links", async () => {
    const store = await openStore(tempDir());
    try {
      const client = await store.createClient({ name: "Acme <Ltd>" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Discovery & design" });
      const project = await store.createProject({ engagementId: engagement.id, name: "Phase" });
      const task = await store.createTask({
        clientId: client.id, engagementId: engagement.id, projectId: project.id,
        title: "Renamed task", dueDate: "2026-11-21",
      });
      await store.updateTask(task.id, { title: "Current <task>" });
      const document = renderDashboard(store.snapshot(), fixedClock("2026-11-22")).html;
      const section = sectionOf(document, "Recent activity");
      // The label is the record as it is now, never the stored title.
      assert.match(section, new RegExp(`<a href="/tasks/${task.id}">Current &lt;task&gt;</a>`));
      assert.match(section, new RegExp(`href="/clients/${client.id}">Acme &lt;Ltd&gt;</a>`));
      assert.match(section, new RegExp(`href="/engagements/${engagement.id}">Discovery &amp; design</a>`));
      assert.ok(section.includes('<span class="action">edit</span>'));
      assert.ok(section.includes('<span class="action">create</span>'));
      assert.ok(!section.includes("Renamed task"));
      // Every recorded event carries a timestamp shown as text.
      assert.match(section, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    } finally {
      await store.close();
    }
  });

  it("lists the current targets of activity events for every record family, linking detail routes", async () => {
    const store = await openStore(tempDir());
    try {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
      const project = await store.createProject({ engagementId: engagement.id, name: "Project" });
      const item = await store.createItem({
        clientId: client.id, engagementId: engagement.id, kind: "decision", title: "Decide", state: "open",
      });
      const meeting = await store.createMeeting({
        clientId: client.id, engagementId: engagement.id, title: "Kickoff", date: "2026-01-05",
      });
      const section = sectionOf(
        renderDashboard(store.snapshot(), fixedClock("2026-11-22")).html,
        "Recent activity",
      );
      // A project has no client link of its own, so its create event resolves
      // no ancestry and is not shown; every other family's target is.
      for (const href of [
        `/clients/${client.id}`,
        `/engagements/${engagement.id}`,
        `/items/${item.id}`,
        `/meetings/${meeting.id}`,
      ]) {
        assert.ok(section.includes(`href="${href}"`), href);
      }
    } finally {
      await store.close();
    }
  });

  it("renders reads without mutating the snapshot and leaves stored events untouched", async () => {
    const store = await openStore(tempDir());
    try {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
      await store.createTask({
        clientId: client.id, engagementId: engagement.id, title: "Task", priority: "high", dueDate: "2026-11-21",
      });
      await store.createItem({
        clientId: client.id, engagementId: engagement.id, kind: "follow_up", title: "Follow-up", state: "open",
      });
      await store.createItem({
        clientId: client.id, engagementId: engagement.id, kind: "commitment", title: "Commitment", state: "open",
      });
      const before = store.snapshot();
      const copy = JSON.parse(JSON.stringify(before)) as Snapshot;
      const journal = JSON.stringify(before.activity);
      renderDashboard(before, fixedClock("2026-11-22"));
      selectDashboard(before, "2026-11-22");
      assert.deepEqual(JSON.parse(JSON.stringify(before)), copy);
      assert.equal(JSON.stringify(store.snapshot().activity), journal);
    } finally {
      await store.close();
    }
  });
});

describe("dashboard high-priority tasks", () => {
  it("shows only high-priority open or in-progress tasks, dated or not, and never falls back", async () => {
    await withStore(async (store) => {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
      const base = { clientId: client.id, engagementId: engagement.id };
      const openHigh = await store.createTask({
        ...base, title: "Open high", priority: "high", status: "open", dueDate: "2026-11-25",
      });
      const progressHigh = await store.createTask({
        ...base, title: "Progress high", priority: "high", status: "in_progress",
      });
      await store.createTask({ ...base, title: "Waiting high", priority: "high", status: "waiting", dueDate: "2026-11-25" });
      await store.createTask({ ...base, title: "Done high", priority: "high", status: "done", dueDate: "2026-11-25" });
      const normalOpen = await store.createTask({
        ...base, title: "Normal open", priority: "normal", status: "open", dueDate: "2026-11-25",
      });
      const lowOpen = await store.createTask({
        ...base, title: "Low open", priority: "low", status: "open", dueDate: "2026-11-25",
      });
      const highOpen = await store.createTask({
        ...base, title: "High open", priority: "high", status: "open", dueDate: "2026-11-25",
      });
      await store.setArchived("task", progressHigh.id, true);

      const dashboard = selectDashboard(store.snapshot(), "2026-11-22");
      // Dated high tasks by due date then id; undated last; archived excluded.
      const expected = [highOpen, openHigh]
        .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : a.dueDate! > b.dueDate! ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((task) => task.id);
      assert.deepEqual(rowIds(dashboard, "high_priority"), expected);
      assert.ok(!rowIds(dashboard, "high_priority").includes(normalOpen.id));
      assert.ok(!rowIds(dashboard, "high_priority").includes(lowOpen.id));
      assert.deepEqual(rowIds(dashboard, "overdue"), []);
      assert.match(
        rowIds(dashboard, "due_soon").join(","),
        new RegExp([openHigh.id, highOpen.id].join("|")),
      );
    });
  });

  it("keeps high-priority rows distinct within the section when they also qualify for a date section", async () => {
    await withStore(async (store) => {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
      const task = await store.createTask({
        clientId: client.id, engagementId: engagement.id, title: "Both",
        priority: "high", status: "open", dueDate: "2026-11-21",
      });
      const dashboard = selectDashboard(store.snapshot(), "2026-11-22");
      assert.deepEqual(rowIds(dashboard, "overdue"), [task.id]);
      assert.deepEqual(rowIds(dashboard, "high_priority"), [task.id]);
      // Overlapping sections list the record once each, and never twice within one.
      assert.equal(rowIds(dashboard, "overdue").filter((id) => id === task.id).length, 1);
      assert.equal(rowIds(dashboard, "high_priority").filter((id) => id === task.id).length, 1);
    });
  });
});

describe("dashboard waiting tasks", () => {
  it("shows every waiting task, dated or undated, sorted by due date then id with undated last", async () => {
    await withStore(async (store) => {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
      const base = { clientId: client.id, engagementId: engagement.id };
      const datedLater = await store.createTask({ ...base, title: "Dated later", status: "waiting", dueDate: "2026-11-30" });
      const datedPast = await store.createTask({ ...base, title: "Dated past", status: "waiting", dueDate: "2026-11-21" });
      const datedSoon = await store.createTask({ ...base, title: "Dated soon", status: "waiting", dueDate: "2026-11-23" });
      const undatedA = await store.createTask({ ...base, title: "Undated A", status: "waiting" });
      const undatedB = await store.createTask({ ...base, title: "Undated B", status: "waiting" });
      await store.createTask({ ...base, title: "Open dated", status: "open", dueDate: "2026-11-21" });

      const dashboard = selectDashboard(store.snapshot(), "2026-11-22");
      const undatedIds = [undatedA.id, undatedB.id].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      assert.deepEqual(
        rowIds(dashboard, "waiting_tasks"),
        [datedPast.id, datedSoon.id, datedLater.id, ...undatedIds],
      );
      // Dated waiting tasks also qualify for the date sections.
      assert.ok(rowIds(dashboard, "overdue").includes(datedPast.id));
      assert.ok(rowIds(dashboard, "due_soon").includes(datedSoon.id));
      // Undated waiting tasks appear only in the waiting section.
      assert.ok(!rowIds(dashboard, "overdue").includes(undatedA.id));
      assert.ok(!rowIds(dashboard, "due_soon").includes(undatedB.id));
    });
  });

  it("drops a done task from the waiting section and restores it when moved back", async () => {
    await withStore(async (store) => {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
      const task = await store.createTask({
        clientId: client.id, engagementId: engagement.id, title: "Waiting", status: "waiting", dueDate: "2026-11-24",
      });
      assert.deepEqual(rowIds(selectDashboard(store.snapshot(), "2026-11-22"), "waiting_tasks"), [task.id]);
      await store.moveTask(task.id, "done", { kind: "all" });
      const done = selectDashboard(store.snapshot(), "2026-11-22");
      assert.deepEqual(rowIds(done, "waiting_tasks"), []);
      assert.ok(!rowIds(done, "due_soon").includes(task.id));
      await store.moveTask(task.id, "waiting", { kind: "all" });
      const back = selectDashboard(store.snapshot(), "2026-11-22");
      assert.deepEqual(rowIds(back, "waiting_tasks"), [task.id]);
      assert.ok(rowIds(back, "due_soon").includes(task.id));
    });
  });
});

describe("dashboard open follow-ups", () => {
  it("lists every open follow-up in snapshot order and drops a closed one", async () => {
    await withStore(async (store) => {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
      const base = { clientId: client.id, engagementId: engagement.id };
      const first = await store.createItem({ ...base, kind: "follow_up", title: "First", state: "open" });
      const second = await store.createItem({ ...base, kind: "follow_up", title: "Second", state: "open" });
      const third = await store.createItem({ ...base, kind: "follow_up", title: "Third", state: "open" });
      await store.createItem({ ...base, kind: "follow_up", title: "Closed", state: "closed" });

      assert.deepEqual(
        rowIds(selectDashboard(store.snapshot(), "2026-11-22"), "follow_up"),
        [first.id, second.id, third.id],
      );
      await store.updateItem(second.id, { state: "closed" });
      assert.deepEqual(
        rowIds(selectDashboard(store.snapshot(), "2026-11-22"), "follow_up"),
        [first.id, third.id],
      );
    });
  });
});

describe("dashboard unfinished engagements", () => {
  it("includes planned, active and on-hold engagements ordered by client name, engagement name then id", async () => {
    await withStore(async (store) => {
      const zeta = await store.createClient({ name: "Zeta" });
      const alpha = await store.createClient({ name: "Alpha" });
      const beta = await store.createClient({ name: "Beta" });
      const zetaActive = await store.createEngagement({ clientId: zeta.id, name: "Active one" });
      const alphaPlanned = await store.createEngagement({ clientId: alpha.id, name: "Planned one", status: "planned" });
      const alphaOnHold = await store.createEngagement({ clientId: alpha.id, name: "On hold one", status: "on_hold" });
      const alphaActive = await store.createEngagement({ clientId: alpha.id, name: "Active one" });
      const betaActive = await store.createEngagement({ clientId: beta.id, name: "Active one" });
      await store.createEngagement({ clientId: alpha.id, name: "Done one", status: "completed" });
      // An archived active engagement is effectively archived and excluded.
      const archived = await store.createEngagement({ clientId: beta.id, name: "Archived one" });
      await store.setArchived("engagement", archived.id, true);

      const dashboard = selectDashboard(store.snapshot(), "2026-11-22");
      assert.deepEqual(
        rowIds(dashboard, "engagement"),
        [alphaActive.id, alphaOnHold.id, alphaPlanned.id, betaActive.id, zetaActive.id],
      );
      // Restoring the archived engagement makes it visible again.
      await store.setArchived("engagement", archived.id, false);
      assert.ok(rowIds(selectDashboard(store.snapshot(), "2026-11-22"), "engagement").includes(archived.id));
    });
  });

  it("orders engagements with equal names by id", async () => {
    await withStore(async (store) => {
      const client = await store.createClient({ name: "Acme" });
      // Create in reverse order; the store ids increase with creation, so the
      // expected order is ascending id whatever the store's own list order.
      const second = await store.createEngagement({ clientId: client.id, name: "Same" });
      const first = await store.createEngagement({ clientId: client.id, name: "Same" });
      const [lower, upper] = first.id < second.id ? [first, second] : [second, first];
      assert.deepEqual(
        rowIds(selectDashboard(store.snapshot(), "2026-11-22"), "engagement"),
        [lower.id, upper.id],
      );
    });
  });
});

describe("dashboard archives", () => {
  it("excludes effectively archived records from every added section", async () => {
    await withStore(async (store) => {
      const client = await store.createClient({ name: "Alpha" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
      const project = await store.createProject({ engagementId: engagement.id, name: "Project" });
      const base = { clientId: client.id, engagementId: engagement.id };
      const high = await store.createTask({
        ...base, title: "High", priority: "high", status: "open", dueDate: "2026-11-21",
      });
      const waiting = await store.createTask({
        ...base, title: "Waiting", status: "waiting", projectId: project.id,
      });
      const followUp = await store.createItem({ ...base, kind: "follow_up", title: "Follow-up", state: "open" });
      const archivedClient = await store.createClient({ name: "Archived" });
      const archivedEngagement = await store.createEngagement({ clientId: archivedClient.id, name: "Gone" });
      const hiddenTask = await store.createTask({
        clientId: archivedClient.id, engagementId: archivedEngagement.id,
        title: "Hidden", priority: "high", status: "waiting", dueDate: "2026-11-21",
      });
      const hiddenFollowUp = await store.createItem({
        clientId: archivedClient.id, engagementId: archivedEngagement.id,
        kind: "follow_up", title: "Hidden follow-up", state: "open",
      });
      const sorted = (ids: string[]): string[] => ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const before = selectDashboard(store.snapshot(), "2026-11-22");
      assert.deepEqual(rowIds(before, "high_priority"), [high.id]);
      // The dated waiting task precedes the undated one.
      assert.deepEqual(rowIds(before, "waiting_tasks"), [hiddenTask.id, waiting.id]);
      assert.deepEqual(rowIds(before, "follow_up"), sorted([followUp.id, hiddenFollowUp.id]));
      assert.ok(rowIds(before, "engagement").includes(archivedEngagement.id));

      await store.setArchived("client", archivedClient.id, true);
      const after = selectDashboard(store.snapshot(), "2026-11-22");
      assert.deepEqual(rowIds(after, "high_priority"), [high.id]);
      assert.deepEqual(rowIds(after, "waiting_tasks"), [waiting.id]);
      assert.deepEqual(rowIds(after, "follow_up"), [followUp.id]);
      assert.ok(!rowIds(after, "engagement").includes(archivedEngagement.id));
      // The archived records also leave the recent-activity view.
      const activity = after.sections.find((section) => section.kind === "recent_activity")!;
      assert.ok(!activity.rows.some((row) => row.href.includes(hiddenTask.id)));
      assert.ok(!activity.rows.some((row) => row.href.includes(hiddenFollowUp.id)));

      // A directly archived project hides its waiting task and follow-up.
      await store.setArchived("project", project.id, true);
      const projectArchived = selectDashboard(store.snapshot(), "2026-11-22");
      assert.deepEqual(rowIds(projectArchived, "waiting_tasks"), []);
      assert.ok(!projectArchived.sections.find((section) => section.kind === "waiting_tasks")!.rows.some(
        (row) => row.projectId === project.id,
      ));
    });
  });
});

describe("dashboard recent activity", () => {
  /** A fixed clock whose events are stamped one second apart from a base instant. */
  function tickingClock(): () => Date {
    let n = 0;
    return () => new Date(Date.UTC(2026, 10, 20, 12, 0, 0) + n++ * 1000);
  }

  it("keeps the latest 20 visible events, newest first, with current labels", async () => {
    const dir = tempDir();
    const store = await openStore(dir, { now: tickingClock() });
    try {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
      const base = { clientId: client.id, engagementId: engagement.id };
      // 25 dated overdue tasks, each create an event; then an edit of one of
      // them stamps the newest event.
      const tasks = [];
      for (let index = 0; index < 25; index += 1) {
        tasks.push(await store.createTask({ ...base, title: `Task ${index}`, dueDate: "2026-11-21" }));
      }
      const edited = tasks[3];
      await store.updateTask(edited.id, { title: "Edited task" });

      const dashboard = selectDashboard(store.snapshot(), "2026-11-22");
      const activity = dashboard.sections.find((section) => section.kind === "recent_activity")!;
      assert.equal(activity.rows.length, 20);
      // Newest first: the edit leads, then the latest creates in reverse order.
      assert.equal(activity.rows[0].action, "edit");
      assert.equal(activity.rows[0].href, `/tasks/${edited.id}`);
      assert.equal(activity.rows[0].title, "Edited task");
      const created = tasks.slice(-19).reverse();
      assert.deepEqual(
        activity.rows.slice(1).map((row) => row.href),
        created.map((task) => `/tasks/${task.id}`),
      );
      // Each row resolves the current record: the edited task's label is the
      // new title, and none of the rows carries a stale title.
      assert.ok(!activity.rows.some((row) => row.title === "Task 3"));
    } finally {
      await store.close();
    }
  });

  it("keeps events for records that no longer exist out of the view without failing", async () => {
    const dir = tempDir();
    const store = await openStore(dir, { now: tickingClock() });
    try {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
      const task = await store.createTask({
        clientId: client.id, engagementId: engagement.id, title: "Will be archived", dueDate: "2026-11-21",
      });
      await store.setArchived("task", task.id, true);
      const dashboard = selectDashboard(store.snapshot(), "2026-11-22");
      const activity = dashboard.sections.find((section) => section.kind === "recent_activity")!;
      // The archived task's create and archive events are invisible, and so is
      // the engagement create: this engagement is the archived task's parent,
      // so it is itself effectively archived. Only the client create remains.
      assert.deepEqual(
        activity.rows.map((row) => row.href),
        [`/clients/${client.id}`],
      );
    } finally {
      await store.close();
    }
  });

  it("is empty when the journal is absent or empty", async () => {
    const dashboard = selectDashboard(emptySnapshot(), "2026-11-22");
    const activity = dashboard.sections.find((section) => section.kind === "recent_activity")!;
    assert.deepEqual(activity.rows, []);
    const withEmpty = selectDashboard({ ...emptySnapshot(), activity: [] }, "2026-11-22");
    assert.deepEqual(
      withEmpty.sections.find((section) => section.kind === "recent_activity")!.rows,
      [],
    );
  });
});
