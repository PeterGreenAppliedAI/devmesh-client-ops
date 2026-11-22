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
  it("shows six sections in order even when the workspace is empty", async () => {
    await withStore(async (store) => {
      const dashboard = selectDashboard(store.snapshot(), "2026-11-22");
      assert.equal(dashboard.today, "2026-11-22");
      assert.deepEqual(
        dashboard.sections.map((section) => section.kind),
        ["overdue", "due_soon", "blocker", "question", "commitment", "waiting"],
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

  it("excludes done and undated tasks and keeps open and in-progress dated tasks", async () => {
    await withStore(async (store) => {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
      const base = { clientId: client.id, engagementId: engagement.id };
      const open = await store.createTask({ ...base, title: "Open", status: "open", dueDate: "2026-11-21" });
      const inProgress = await store.createTask({ ...base, title: "In progress", status: "in_progress", dueDate: "2026-11-23" });
      await store.createTask({ ...base, title: "Done", status: "done", dueDate: "2026-11-21" });
      await store.createTask({ ...base, title: "Open undated", status: "open" });
      await store.createTask({ ...base, title: "In progress undated", status: "in_progress" });

      const dashboard = selectDashboard(store.snapshot(), "2026-11-22");
      assert.deepEqual(rowIds(dashboard, "overdue"), [open.id]);
      assert.deepEqual(rowIds(dashboard, "due_soon"), [inProgress.id]);
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

  it("covers every item kind and state, retaining snapshot order and excluding decisions and follow-ups", async () => {
    await withStore(async (store) => {
      const client = await store.createClient({ name: "Acme" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
      const base = { clientId: client.id, engagementId: engagement.id };
      const blocker = await store.createItem({ ...base, kind: "blocker", title: "Blocker", state: "open" });
      const question = await store.createItem({ ...base, kind: "question", title: "Question", state: "open" });
      const commitment = await store.createItem({ ...base, kind: "commitment", title: "Commitment", state: "open" });
      const waiting = await store.createItem({ ...base, kind: "waiting", title: "Waiting", state: "open" });
      // Closed items of every kind and open decisions/follow-ups are excluded.
      for (const kind of ["blocker", "question", "commitment", "waiting"] as const) {
        await store.createItem({ ...base, kind, title: `Closed ${kind}`, state: "closed" });
      }
      const decision = await store.createItem({ ...base, kind: "decision", title: "Decision", state: "open" });
      const followUp = await store.createItem({ ...base, kind: "follow_up", title: "Follow-up", state: "open" });

      const dashboard = selectDashboard(store.snapshot(), "2026-11-22");
      assert.deepEqual(rowIds(dashboard, "blocker"), [blocker.id]);
      assert.deepEqual(rowIds(dashboard, "question"), [question.id]);
      assert.deepEqual(rowIds(dashboard, "commitment"), [commitment.id]);
      assert.deepEqual(rowIds(dashboard, "waiting"), [waiting.id]);
      // No section contains a decision or a follow-up.
      const allIds = dashboard.sections.flatMap((section) => section.rows.map((row) => row.id));
      assert.ok(!allIds.includes(decision.id));
      assert.ok(!allIds.includes(followUp.id));
      assert.deepEqual(allIds.sort(), [blocker.id, question.id, commitment.id, waiting.id].sort());
      assert.equal(allIds.length, 4);
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

  it("renders all six named sections with links, ancestry, dates and escaped text", async () => {
    const { store, ids } = await seeded();
    try {
      const page = renderDashboard(store.snapshot(), fixedClock("2026-11-22"));
      const document = page.html;
      for (const title of [
        "Overdue tasks",
        "Tasks due soon",
        "Open blockers",
        "Open questions",
        "Open commitments",
        "Open waiting items",
      ]) {
        assert.match(document, new RegExp(`<h2>${escapeHtml(title)}</h2>`));
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
      // Sections without rows say nothing needs attention and link to /clients.
      for (const title of ["Open commitments", "Open waiting items"]) {
        const section = sectionOf(document, title);
        assert.ok(section.includes("Nothing needs attention here."), title);
        assert.ok(section.includes('href="/clients"'), title);
        assert.ok(section.includes("Browse clients"), title);
      }
      // A populated section does not carry the empty state.
      assert.ok(!sectionOf(document, "Overdue tasks").includes("Nothing needs attention here."));
      void ids;
    } finally {
      await store.close();
    }
  });

  it("renders an entirely empty dashboard as six empty sections that link to /clients", async () => {
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
    } finally {
      await store.close();
    }
  });
});
