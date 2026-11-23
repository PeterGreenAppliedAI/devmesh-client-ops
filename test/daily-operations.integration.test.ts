/**
 * F2 daily operations milestone: one representative workspace exercised end to
 * end through the real rendered forms and links, over loopback HTTP, against a
 * temporary on-disk store.
 *
 * The fixture is synthetic only: two clients (one with a project-scoped and an
 * engagement-scoped engagement, one with a planned engagement and no project),
 * assigned and unassigned high-priority tasks, waiting/done tasks, work items
 * of the attention kinds and meetings on engagement and project scopes.
 *
 * The suite follows the dashboard's summary links to every record, walks every
 * board scope and back to all work, moves a high-priority actionable task to
 * waiting and then to done from the rendered movement controls, and observes
 * the dashboard date, membership and activity changes. It asserts that reads
 * and a submitted movement that the scope check refuses leave the records and
 * the journal untouched, then closes both the store and the server and reopens
 * them to confirm the records, the history and the dashboard survive.
 *
 * The home clock (which selects the reference day) is injected through
 * `appRoutes`, and the registered feature routes are kept beside it, so a test
 * sees a fixed day while every other page is the real one. The journal clock of
 * the store stamps events at fixed, increasing instants, so the history is
 * deterministic. No real client data, no inference or network service and no
 * production file is involved; the temporary directory is removed afterwards.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { appRoutes, startServer, type StartedServer } from "../src/server.ts";
import { registerRoutes } from "../src/index.ts";
import { escapeHtml } from "../src/html.ts";
import { localCalendarToday } from "../src/dashboard.ts";
import { openStore, type Snapshot, type Store } from "../src/store.ts";
import type { ActivityEvent } from "../src/activity.ts";

// ---------------------------------------------------------------------------
// Fixtures and HTTP helpers
// ---------------------------------------------------------------------------

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "daily-operations-"));
  roots.push(dir);
  return dir;
}

/**
 * The fixed reference day of the dashboard and the dates the fixture uses are
 * all local-calendar dates, exactly as the dashboard reads them, so the test
 * passes whatever the host time zone is.
 */
const NOW = new Date(2026, 10, 22, 12, 0, 0);

/** The dashboard's reference day for `NOW`: the server's local calendar day. */
const TODAY = localCalendarToday(NOW);

/** A calendar day `offset` days from TODAY, computed with local getters. */
function day(offset: number): string {
  const shifted = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + offset, 12, 0, 0);
  return localCalendarToday(shifted);
}

/** One fixed journal instant: a canonical UTC instant `seconds` from the base. */
function instant(seconds: number): Date {
  return new Date(Date.UTC(2026, 10, 22, 12, 0, 0) + seconds * 1000);
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

interface RequestOptions {
  readonly method?: string;
  readonly path?: string;
  readonly form?: Record<string, string>;
}

/** Send a request over loopback HTTP with the canonical Host header. */
function send(base: string, options: RequestOptions = {}): Promise<Reply> {
  const url = new URL(base);
  const method = options.method ?? "GET";
  const body = options.form === undefined ? "" : new URLSearchParams(options.form).toString();
  const headers: Record<string, string | number> = {
    host: url.host,
    "content-length": Buffer.byteLength(body),
  };
  if (method === "POST") {
    headers["content-type"] = "application/x-www-form-urlencoded";
    headers.origin = base;
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: Number(url.port),
        method,
        path: options.path ?? "/",
        headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * The internal target of a redirect, which a browser follows as a GET with the
 * same origin. Movement and create posts redirect this way (303).
 */
function follow(reply: Reply): string {
  assert.equal(reply.status, 303, reply.body);
  const location = String(reply.headers.location ?? "");
  assert.ok(location.startsWith("/") && !location.startsWith("//"), `internal location, got ${location}`);
  return location;
}

/** A rendered form as a browser would submit it. */
interface ParsedForm {
  readonly action: string;
  readonly controls: Map<string, string>;
}

/** The first form of a page, or the form whose action ends a given way. */
function parseForm(document: string, actionEndsWith?: string): ParsedForm {
  const forms = [...document.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)];
  const selected =
    actionEndsWith === undefined
      ? forms[0]
      : forms.find((form) => {
          const action = /<form[^>]*\saction="([^"]*)"/.exec(form[0])?.[1] ?? "";
          return unescapeHtml(action).endsWith(actionEndsWith);
        });
  assert.ok(selected !== undefined, `page has a form${actionEndsWith === undefined ? "" : ` for ${actionEndsWith}`}`);
  const form = selected;
  const action = /<form[^>]*\saction="([^"]*)"/.exec(form[0]);
  assert.ok(action !== null, "the form has an action");
  const controls = new Map<string, string>();
  const inner = form[1];
  for (const match of inner.matchAll(/<textarea[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) {
    controls.set(unescapeHtml(match[1]), unescapeHtml(match[2]));
  }
  for (const match of inner.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/g)) {
    controls.set(unescapeHtml(match[1]), unescapeHtml(match[2]));
  }
  for (const match of inner.matchAll(/<select[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const options = [...match[2].matchAll(/<option value="([^"]*)"([^>]*)>([\s\S]*?)<\/option>/g)];
    const selectedOption = options.find((option) => option[2].includes("selected")) ?? options[0];
    controls.set(unescapeHtml(match[1]), selectedOption === undefined ? "" : unescapeHtml(selectedOption[1]));
  }
  return { action: unescapeHtml(action[1]), controls };
}

/** The main content region, so the global client navigation is excluded. */
function mainContentOf(body: string): string {
  const start = body.indexOf('<main id="main">');
  assert.ok(start >= 0, "page has a main landmark");
  const end = body.indexOf("</main>", start);
  assert.ok(end >= 0, "the main landmark is closed");
  return body.slice(start, end);
}

/** A section of a page: its heading tag to its section's closing tag. */
function sectionOf(body: string, title: string): string {
  const start = body.indexOf(`<h2>${escapeHtml(title)}</h2>`);
  if (start < 0) return "";
  const end = body.indexOf("</section>", start);
  return body.slice(start, end < 0 ? undefined : end);
}

/** Every distinct internal link of a fragment, in document order. */
function linksOf(body: string): readonly string[] {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const match of body.matchAll(/href="([^"]+)"/g)) {
    const href = unescapeHtml(match[1]);
    if (!seen.has(href)) {
      seen.add(href);
      links.push(href);
    }
  }
  return links;
}

/** The record ids linked under a heading inside one fragment. */
function idsLinked(body: string, prefix: string): readonly string[] {
  const pattern = new RegExp(`href="${prefix}/([^"/]+)"`, "g");
  return [...body.matchAll(pattern)].map((match) => unescapeHtml(match[1]));
}

/**
 * The board cards of one column, keyed by the task id each card links. A card's
 * slice runs from its list item to the closing tag, so its movement form can be
 * parsed on its own.
 */
function boardCards(board: string): ReadonlyMap<string, string> {
  const cards = new Map<string, string>();
  for (const match of board.matchAll(/<li class="card board-card">([\s\S]*?)<\/li>/g)) {
    const id = /<a href="\/tasks\/([^"/]+)"/.exec(match[1])?.[1];
    if (id !== undefined) cards.set(unescapeHtml(id), match[0]);
  }
  return cards;
}

/** The board column of one group, from its heading to its closing tag. */
function columnOf(board: string, title: string): string {
  return sectionOf(board, title);
}

/**
 * The whole observable state over HTTP: the dashboard document, every record
 * detail page and every hierarchy page. A changed title, status, field, link or
 * journal entry changes one of these documents, so comparing them compares the
 * records and the history, not only collection sizes.
 */
interface Observation {
  readonly pages: readonly { readonly path: string; readonly body: string }[];
}

async function observe(base: string, ids: FixtureIds): Promise<Observation> {
  const paths = [
    "/",
    "/clients",
    `/clients/${ids.alphaClient}`,
    `/clients/${ids.betaClient}`,
    ...ids.engagements.map((id) => `/engagements/${id}`),
    ...ids.projects.map((id) => `/projects/${id}`),
    ...ids.tasks.map((id) => `/tasks/${id}`),
    ...ids.items.map((id) => `/items/${id}`),
    ...ids.meetings.map((id) => `/meetings/${id}`),
    "/kanban",
    ...ids.engagements.map((id) => `/engagements/${id}/kanban`),
    ...ids.projects.map((id) => `/projects/${id}/kanban`),
    `/clients/${ids.alphaClient}/kanban`,
    `/clients/${ids.betaClient}/kanban`,
    "/archived",
  ];
  const pages: { path: string; body: string }[] = [];
  for (const path of paths) {
    const reply = await send(base, { path });
    assert.equal(reply.status, 200, `${path} is readable`);
    pages.push({ path, body: reply.body });
  }
  return { pages };
}

function snapshotOf(observation: Observation): string {
  return JSON.stringify(observation);
}

/** The journal of a snapshot; an opened schema-5 store always carries one. */
function journalOf(snapshot: Snapshot): readonly ActivityEvent[] {
  assert.ok(snapshot.activity !== undefined, "the store carries a journal");
  return snapshot.activity;
}

/** The ids of the temporary fixture, filled in by the workflow. */
interface FixtureIds {
  readonly alphaClient: string;
  readonly betaClient: string;
  readonly engagements: readonly string[];
  readonly projects: readonly string[];
  readonly tasks: readonly string[];
  readonly items: readonly string[];
  readonly meetings: readonly string[];
  readonly alphaEngagement: string;
  readonly alphaProject: string;
  readonly betaEngagement: string;
  readonly high: string;
  readonly highUnassigned: string;
  readonly done: string;
}

/**
 * One running application: its loopback origin, its store and a shutdown that
 * closes the server and then the store, releasing every resource.
 */
interface Running {
  readonly origin: string;
  readonly store: Store;
  close(): Promise<void>;
}

/** Open the store and start the loopback server with the injected home clock. */
async function running(
  directory: string,
  clock: () => Date,
  journal: () => Date,
): Promise<Running> {
  const store = await openStore(directory, { now: journal });
  let server: StartedServer;
  try {
    // The registered feature routes are kept; only the home clock is replaced.
    server = await startServer({ store, port: 0, routes: { ...registerRoutes(store), ...appRoutes(store, { now: clock }) } });
  } catch (error) {
    await store.close();
    throw error;
  }
  return {
    origin: server.origin,
    store,
    async close() {
      await server.close();
      await store.close();
    },
  };
}

/** POST a rendered form exactly as the browser submits it. */
async function submit(base: string, form: ParsedForm): Promise<Reply> {
  return send(base, { method: "POST", path: form.action, form: Object.fromEntries(form.controls) });
}

/** Create one record through its rendered form and follow the redirect. */
async function create(
  base: string,
  path: string,
  values: Record<string, string>,
): Promise<string> {
  const form = parseForm((await send(base, { path })).body);
  for (const [key, value] of Object.entries(values)) {
    assert.ok(form.controls.has(key), `${path} form has control ${key}`);
    form.controls.set(key, value);
  }
  const reply = await submit(base, form);
  return follow(reply);
}

function idOf(location: string): string {
  return location.split("/").pop() as string;
}

// ---------------------------------------------------------------------------
// The daily-operations milestone
// ---------------------------------------------------------------------------

describe("F2 daily operations integration", () => {
  it("runs a representative workspace through the dashboard, boards, a movement and a restart", async () => {
    const dir = tempDir();

    // The journal clock reads fixed, strictly increasing instants, one per
    // event, so the recorded history is deterministic.
    let stamps = 0;
    // A no-op mutation never reads the clock, so the recorded instants are
    // exactly one per recorded event and can be predicted from the journal
    // length.
    const journal = (): Date => {
      stamps += 1;
      return instant(stamps);
    };

    let app = await running(dir, () => NOW, journal);
    let base = app.origin;

    const created = {
      alphaClient: "",
      betaClient: "",
      alphaEngagement: "",
      alphaProject: "",
      betaEngagement: "",
      high: "",
      highUnassigned: "",
      done: "",
      tasks: [] as string[],
      items: [] as string[],
      meetings: [] as string[],
      engagements: [] as string[],
      projects: [] as string[],
    };
    let beforeRefusal: string;
    let beforeRestart: string;

    try {
      // -- Clients. ----------------------------------------------------------
      created.alphaClient = idOf(await create(base, "/clients/new", {
        name: "Northwind <synthetic>",
        background: "Synthetic fixture client",
        contacts: "",
        stakeholders: "",
        requirements: "",
        objectives: "",
      }));
      created.betaClient = idOf(await create(base, "/clients/new", {
        name: "Contoso & partners",
        background: "Second synthetic client",
        contacts: "",
        stakeholders: "",
        requirements: "",
        objectives: "",
      }));

      // -- Engagements: active (with a project) and planned (no project). ----
      created.alphaEngagement = idOf(await create(base, `/clients/${created.alphaClient}/engagements/new`, {
        name: "Quarterly audit",
        objectives: "Deliver the audit",
        status: "active",
      }));
      created.betaEngagement = idOf(await create(base, `/clients/${created.betaClient}/engagements/new`, {
        name: "Discovery",
        objectives: "Discover the need",
        status: "planned",
      }));
      created.alphaProject = idOf(await create(base, `/engagements/${created.alphaEngagement}/projects/new`, {
        name: "Field work",
        objectives: "Field work package",
        status: "active",
      }));
      created.engagements.push(created.alphaEngagement, created.betaEngagement);
      created.projects.push(created.alphaProject);

      // -- Tasks: assigned/unassigned, actionable/waiting/done, dated/undated.
      // The high-priority actionable task the milestone moves.
      created.high = idOf(await create(base, `/projects/${created.alphaProject}/tasks/new`, {
        title: "Prepare audit <plan>",
        status: "open",
        priority: "high",
        owner: "Dana",
        dueDate: day(-1),
        context: "Assigned, high priority, overdue",
        projectId: created.alphaProject,
      }));
      // A high-priority in-progress task with no project and no owner.
      created.highUnassigned = idOf(await create(base, `/engagements/${created.alphaEngagement}/tasks/new`, {
        title: "Gather evidence",
        status: "in_progress",
        priority: "high",
        owner: "",
        dueDate: "",
        context: "Unassigned, high priority",
        projectId: "",
      }));
      // A waiting task, dated inside the due-soon range.
      const waiting = idOf(await create(base, `/engagements/${created.alphaEngagement}/tasks/new`, {
        title: "Await client reply",
        status: "waiting",
        priority: "high",
        owner: "Lee",
        dueDate: day(3),
        context: "Waiting on the client",
        projectId: "",
      }));
      // A done task with a date, which never appears in the date sections.
      created.done = idOf(await create(base, `/projects/${created.alphaProject}/tasks/new`, {
        title: "Kickoff done",
        status: "done",
        priority: "low",
        owner: "Lee",
        dueDate: day(-2),
        context: "Finished",
        projectId: created.alphaProject,
      }));
      // A high-priority task of the other client, dated soon.
      const betaHigh = idOf(await create(base, `/engagements/${created.betaEngagement}/tasks/new`, {
        title: "Draft scope",
        status: "open",
        priority: "high",
        owner: "",
        dueDate: day(5),
        context: "Other client",
        projectId: "",
      }));
      created.tasks.push(created.high, created.highUnassigned, waiting, created.done, betaHigh);

      // -- Work items of the attention kinds and a decision (never shown). ---
      const itemKinds: Array<[string, string, string]> = [
        ["blocker", "Missing statements", "engagement"],
        ["question", "Which scope?", "engagement"],
        ["commitment", "Weekly summary", "project"],
        ["waiting", "Signed contract", "project"],
        ["follow_up", "Call the auditor", "engagement"],
        ["decision", "Use the template", "engagement"],
      ];
      for (const [kind, title, where] of itemKinds) {
        const path = where === "project"
          ? `/projects/${created.alphaProject}/items/new`
          : `/engagements/${created.alphaEngagement}/items/new`;
        const projectId = where === "project" ? created.alphaProject : "";
        created.items.push(idOf(await create(base, path, { kind, title, context: `${kind} context`, state: "open", projectId })));
      }
      // A closed blocker of the other client, which no section shows.
      const closed = idOf(await create(base, `/engagements/${created.betaEngagement}/items/new`, {
        kind: "blocker", title: "Closed blocker", context: "", state: "closed", projectId: "",
      }));
      created.items.push(closed);

      // -- Meetings on engagement and project scopes. ------------------------
      created.meetings.push(idOf(await create(base, `/engagements/${created.alphaEngagement}/meetings/new`, {
        title: "Audit kickoff",
        date: day(-10),
        notes: "Kickoff notes",
        projectId: "",
      })));
      created.meetings.push(idOf(await create(base, `/projects/${created.alphaProject}/meetings/new`, {
        title: "Field review",
        date: day(-4),
        notes: "Field notes",
        projectId: created.alphaProject,
      })));
      created.meetings.push(idOf(await create(base, `/engagements/${created.betaEngagement}/meetings/new`, {
        title: "Discovery interview",
        date: day(-3),
        notes: "",
        projectId: "",
      })));

      const ids: FixtureIds = {
        alphaClient: created.alphaClient,
        betaClient: created.betaClient,
        engagements: created.engagements,
        projects: created.projects,
        tasks: created.tasks,
        items: created.items,
        meetings: created.meetings,
        alphaEngagement: created.alphaEngagement,
        alphaProject: created.alphaProject,
        betaEngagement: created.betaEngagement,
        high: created.high,
        highUnassigned: created.highUnassigned,
        done: created.done,
      };

      // The journal recorded one create per record, and nothing else yet.
      assert.equal(journalOf(app.store.snapshot()).length, created.tasks.length + created.items.length + created.meetings.length + 5);

      // -- The dashboard at the fixed reference day. -------------------------
      const home = await send(base, { path: "/" });
      assert.equal(home.status, 200);
      assert.match(String(home.headers["content-type"]), /^text\/html; charset=utf-8/);
      assert.ok(home.body.includes(escapeHtml(`Attention across the workspace as of ${TODAY}.`)), "the fixed day is shown");
      // The dashboard is a read-only page: it offers no form.
      assert.ok(!mainContentOf(home.body).includes("<form"));
      // All eleven sections are present, in order.
      const headings = [
        "Overdue tasks", "Tasks due soon", "Open blockers", "Open questions",
        "Open commitments", "Open waiting items", "High-priority tasks",
        "Waiting tasks", "Open follow-ups", "Recent activity", "Engagements in progress",
      ];
      let lastAt = -1;
      for (const title of headings) {
        const at = home.body.indexOf(`<h2>${escapeHtml(title)}</h2>`);
        assert.ok(at >= 0, title);
        assert.ok(at > lastAt, `${title} keeps its place`);
        lastAt = at;
      }
      // Overdue: the high task due yesterday is there, the done and undated
      // tasks are not, and the range runs from the earliest due date through
      // yesterday.
      const overdue = sectionOf(home.body, "Overdue tasks");
      assert.deepEqual(idsLinked(overdue, "/tasks"), [ids.high]);
      assert.ok(overdue.includes(escapeHtml(`${day(-1)} to ${day(-1)}`)));
      // Due soon: today..today+7, holding the waiting task and the other
      // client's dated high task, with the range text.
      const dueSoon = sectionOf(home.body, "Tasks due soon");
      assert.deepEqual([...idsLinked(dueSoon, "/tasks")].sort(), [ids.tasks[2], ids.tasks[4]].sort());
      assert.ok(dueSoon.includes(escapeHtml(`${TODAY} to ${day(7)}`)));
      assert.ok(!dueSoon.includes(`href="/tasks/${ids.done}"`), "a done task is never due");
      // Open blockers: the engagement-scoped blocker only (not the closed one).
      assert.deepEqual(idsLinked(sectionOf(home.body, "Open blockers"), "/items"), [ids.items[0]]);
      assert.deepEqual(idsLinked(sectionOf(home.body, "Open questions"), "/items"), [ids.items[1]]);
      assert.deepEqual(idsLinked(sectionOf(home.body, "Open commitments"), "/items"), [ids.items[2]]);
      assert.deepEqual(idsLinked(sectionOf(home.body, "Open waiting items"), "/items"), [ids.items[3]]);
      assert.deepEqual(idsLinked(sectionOf(home.body, "Open follow-ups"), "/items"), [ids.items[4]]);
      // A decision never appears in an attention section; its create event is
      // still listed in recent activity, which links its current record.
      const attention = [
        "Overdue tasks", "Tasks due soon", "Open blockers", "Open questions",
        "Open commitments", "Open waiting items", "High-priority tasks",
        "Waiting tasks", "Open follow-ups", "Engagements in progress",
      ].map((title) => sectionOf(home.body, title)).join("");
      assert.ok(!attention.includes(`href="/items/${ids.items[5]}"`));
      assert.ok(sectionOf(home.body, "Recent activity").includes(`href="/items/${ids.items[5]}"`));
      // High-priority actionable tasks: the open and in-progress high tasks,
      // ordered by due date then id, and never the done or waiting high tasks.
      const high = sectionOf(home.body, "High-priority tasks");
      assert.deepEqual([...idsLinked(high, "/tasks")].sort(), [ids.high, ids.highUnassigned, ids.tasks[4]].sort());
      assert.ok(!high.includes(`href="/tasks/${ids.tasks[2]}"`), "a waiting task is not actionable");
      assert.ok(!high.includes(`href="/tasks/${ids.done}"`), "a done task is not actionable");
      assert.ok(high.includes('<span class="badge">high</span>'));
      // Waiting tasks: the engagement-scoped waiting task.
      assert.deepEqual(idsLinked(sectionOf(home.body, "Waiting tasks"), "/tasks"), [ids.tasks[2]]);
      // Unfinished engagements: active and planned, ordered by client name,
      // engagement name then id: Contoso before Northwind.
      const engagementsSection = sectionOf(home.body, "Engagements in progress");
      assert.deepEqual(idsLinked(engagementsSection, "/engagements"), [ids.betaEngagement, ids.alphaEngagement]);
      assert.ok(engagementsSection.includes(`href="/clients/${ids.betaClient}"`));
      // Recent activity lists current records, newest first: the last creates.
      const activity = sectionOf(home.body, "Recent activity");
      assert.ok(activity.includes('<span class="action">create</span>'));
      const latest = /<span class="detail">([^<]+)<\/span>/.exec(activity)?.[1];
      assert.equal(latest, escapeHtml(instant(journalOf(app.store.snapshot()).length).toISOString()));

      // -- Reads change nothing: snapshot the state, then read every scope. --
      beforeRefusal = snapshotOf(await observe(base, ids));
      // Follow the dashboard's summary links to the existing records. Each
      // record row links its own detail page, its client, engagement and, when
      // it has one, its project; the engagement rows link the engagement and
      // its client.
      for (const title of ["Overdue tasks", "Tasks due soon", "High-priority tasks", "Waiting tasks"]) {
        const section = sectionOf(home.body, title);
        for (const taskId of idsLinked(section, "/tasks")) {
          assert.ok(ids.tasks.includes(taskId), `${taskId} is a fixture task`);
          const at = section.indexOf(`href="/tasks/${taskId}"`);
          const row = section.slice(at, section.indexOf("</li>", at));
          assert.match(row, /client <a href="\/clients\/[^"]+">/, "the row links its client");
          assert.match(row, /engagement <a href="\/engagements\/[^"]+">/, "the row links its engagement");
          const detail = await send(base, { path: `/tasks/${taskId}` });
          assert.equal(detail.status, 200);
        }
      }
      // A project-scoped task's row links its actual project as well.
      const overdueRow = overdue.slice(overdue.indexOf(`href="/tasks/${ids.high}"`));
      assert.match(overdueRow, new RegExp(`project <a href="/projects/${ids.alphaProject}">`));
      // Every item section row links a reachable item page.
      for (const title of ["Open blockers", "Open questions", "Open commitments", "Open waiting items", "Open follow-ups"]) {
        for (const itemId of idsLinked(sectionOf(home.body, title), "/items")) {
          const detail = await send(base, { path: `/items/${itemId}` });
          assert.equal(detail.status, 200);
        }
      }
      // The engagement rows link reachable engagements, and their clients.
      for (const engagementId of idsLinked(engagementsSection, "/engagements")) {
        const detail = await send(base, { path: `/engagements/${engagementId}` });
        assert.equal(detail.status, 200);
        assert.ok(mainContentOf(detail.body).includes(`href="/clients/`));
      }
      // Recent-activity rows link the current target, its client and, unless
      // the target is a client, its engagement: each record page is reachable.
      const activityTarget = /^\/(tasks|items|meetings|projects|engagements|clients)\/[^/]+$/;
      let targetLinks = 0;
      for (const href of linksOf(activity)) {
        if (!activityTarget.test(href)) continue;
        const page = await send(base, { path: href });
        assert.equal(page.status, 200, `${href} is reachable from the activity section`);
        targetLinks += 1;
      }
      assert.ok(targetLinks > 0, "the activity section links record pages");
      // Reads recorded nothing: no event was added and no record changed.
      assert.equal(snapshotOf(await observe(base, ids)), beforeRefusal);

      // -- Every board scope, and back to all work. --------------------------
      const scopes: Array<{ path: string; tasks: readonly string[] }> = [
        { path: "/kanban", tasks: [...ids.tasks] },
        { path: `/clients/${ids.alphaClient}/kanban`, tasks: [ids.high, ids.highUnassigned, ids.tasks[2], ids.done] },
        { path: `/engagements/${ids.alphaEngagement}/kanban`, tasks: [ids.high, ids.highUnassigned, ids.tasks[2], ids.done] },
        { path: `/projects/${ids.alphaProject}/kanban`, tasks: [ids.high, ids.done] },
        { path: `/clients/${ids.betaClient}/kanban`, tasks: [ids.tasks[4]] },
        { path: `/engagements/${ids.betaEngagement}/kanban`, tasks: [ids.tasks[4]] },
      ];
      for (const scope of scopes) {
        const board = await send(base, { path: scope.path });
        assert.equal(board.status, 200, scope.path);
        assert.ok(board.body.includes('aria-current="page"'), `${scope.path} marks itself current`);
        // The scope navigation offers every scope plus all work, and the page
        // links back to all work and home.
        const scopeNav = mainContentOf(board.body);
        for (const href of ["/kanban", `/clients/${ids.alphaClient}/kanban`, `/clients/${ids.betaClient}/kanban`, `/engagements/${ids.alphaEngagement}/kanban`, `/engagements/${ids.betaEngagement}/kanban`, `/projects/${ids.alphaProject}/kanban`]) {
          assert.ok(scopeNav.includes(`href="${href}"`), `${scope.path} links ${href}`);
        }
        assert.ok(scopeNav.includes('href="/"'), "the board links home");
        // Every visible task of the scope is in exactly one column.
        const cards = new Map<string, string>();
        const groupStatus: Record<string, string> = {
          "Actionable: open": "open",
          "Actionable: in progress": "in_progress",
          "Waiting: waiting": "waiting",
          "Completed: done": "done",
        };
        for (const title of Object.keys(groupStatus)) {
          const column = columnOf(board.body, title);
          assert.ok(column !== "", `${scope.path} has the ${title} column`);
          for (const [id, card] of boardCards(column)) {
            assert.ok(!cards.has(id), `${id} appears once`);
            cards.set(id, card);
            // The card's movement form starts on its column's own status.
            assert.equal(parseForm(card, `/tasks/${id}/move`).controls.get("status"), groupStatus[title]);
          }
        }
        assert.deepEqual([...cards.keys()].sort(), [...scope.tasks].sort(), `${scope.path} shows its own tasks`);
        // The project-scope board never shows engagement-only work.
        if (scope.path === `/projects/${ids.alphaProject}/kanban`) {
          assert.ok(!cards.has(ids.highUnassigned), "a project board excludes project-less work");
        }
        // A card's movement form names the board's own scope and the record's
        // identity links, so a submission is checked against the exact record.
        const scopeOf = ((): { kind: string; id: string } => {
          if (scope.path === "/kanban") return { kind: "all", id: "" };
          const [, family, id] = scope.path.split("/");
          return { kind: family.slice(0, -1), id };
        })();
        for (const [id, card] of cards) {
          const form = parseForm(card, `/tasks/${id}/move`);
          assert.equal(form.controls.get("id"), id);
          assert.equal(form.controls.get("scopeKind"), scopeOf.kind);
          assert.equal(form.controls.get("scopeId"), scopeOf.id);
          const expectedClient = id === ids.tasks[4] ? ids.betaClient : ids.alphaClient;
          assert.equal(form.controls.get("clientId"), expectedClient);
          assert.equal(
            form.controls.get("projectId"),
            id === ids.high || id === ids.done ? ids.alphaProject : "",
          );
        }
      }
      // Back to all work from the project scope, as the board's link does.
      const backBoard = await send(base, { path: "/kanban" });
      assert.equal(backBoard.status, 200);
      assert.ok(backBoard.body.includes('<a href="/kanban" aria-current="page">All work</a>'));
      // The board navigation is a read too: the state is unchanged.
      assert.equal(snapshotOf(await observe(base, ids)), beforeRefusal);

      // -- A high-priority actionable task to waiting, then to done. --------
      const beforeMove = app.store.snapshot();
      const allBoard = await send(base, { path: "/kanban" });
      const card = boardCards(columnOf(allBoard.body, "Actionable: open")).get(ids.high);
      assert.ok(card !== undefined, "the high task is actionable on all work");
      const moveForm = parseForm(card, `/tasks/${ids.high}/move`);
      // Submit the form as rendered (moving to its own status): no event.
      const noop = await submit(base, moveForm);
      assert.equal(follow(noop), "/kanban");
      // A movement to the status the task already holds is a no-op: neither the
      // journal nor the records change.
      assert.equal(JSON.stringify(app.store.snapshot()), JSON.stringify(beforeMove), "a no-op movement changes nothing");
      // Move the task to waiting from the rendered select.
      moveForm.controls.set("status", "waiting");
      const moved = await submit(base, moveForm);
      const destination = follow(moved);
      assert.equal(destination, "/kanban");
      const afterWaiting = app.store.snapshot();
      // Exactly one movement event was recorded, stamped by the journal clock.
      assert.equal(journalOf(afterWaiting).length, journalOf(beforeMove).length + 1);
      const event = journalOf(afterWaiting)[journalOf(afterWaiting).length - 1];
      assert.equal(event.action, "edit");
      assert.equal(event.targetKind, "task");
      assert.equal(event.targetId, ids.high);
      assert.equal(event.at, instant(journalOf(afterWaiting).length).toISOString());
      // Only the status changed: every other task field is untouched.
      const movedTask = afterWaiting.tasks.find((task) => task.id === ids.high)!;
      const previous = beforeMove.tasks.find((task) => task.id === ids.high)!;
      assert.deepEqual({ ...movedTask, status: previous.status }, previous);

      // The dashboard reflects the movement: the task left the high-priority
      // (actionable) section and joined the waiting task section, while a
      // waiting task with a past date still qualifies for the date sections.
      const afterWaitingHome = await send(base, { path: "/" });
      assert.ok(!sectionOf(afterWaitingHome.body, "High-priority tasks").includes(`href="/tasks/${ids.high}"`));
      assert.ok(sectionOf(afterWaitingHome.body, "Overdue tasks").includes(`href="/tasks/${ids.high}"`));
      assert.ok(sectionOf(afterWaitingHome.body, "Overdue tasks").includes(escapeHtml(`${day(-1)} to ${day(-1)}`)));
      const waitingSection = sectionOf(afterWaitingHome.body, "Waiting tasks");
      assert.deepEqual(idsLinked(waitingSection, "/tasks"), [ids.high, ids.tasks[2]]);
      // Recent activity now shows the movement as its newest action, linking
      // the task's current record.
      const activityAfter = sectionOf(afterWaitingHome.body, "Recent activity");
      const newest = activityAfter.slice(activityAfter.indexOf("<li"), activityAfter.indexOf("</li>"));
      assert.ok(newest.includes('<span class="action">edit</span>'));
      assert.ok(newest.includes(`href="/tasks/${ids.high}"`));
      assert.ok(newest.includes(escapeHtml(instant(journalOf(afterWaiting).length).toISOString())));
      // The board shows it in the waiting column.
      const waitingBoard = await send(base, { path: "/kanban" });
      assert.ok(boardCards(columnOf(waitingBoard.body, "Waiting: waiting")).has(ids.high));
      assert.ok(!boardCards(columnOf(waitingBoard.body, "Actionable: open")).has(ids.high));

      // A movement that the scope check refuses leaves the records and the
      // journal untouched. The stale card's form asserts the task's identity,
      // so submitting it with a scope it is not in is refused with a 400.
      const refusedState = snapshotOf(await observe(base, ids));
      const staleForm = parseForm(card, `/tasks/${ids.high}/move`);
      staleForm.controls.set("status", "open");
      // The task is inside the project scope, so submit it from a scope it is
      // outside: the other client's engagement.
      staleForm.controls.set("scopeKind", "engagement");
      staleForm.controls.set("scopeId", ids.betaEngagement);
      const refused = await submit(base, staleForm);
      assert.equal(refused.status, 400);
      assert.match(String(refused.headers["content-type"]), /^text\/plain/);
      assert.equal(snapshotOf(await observe(base, ids)), refusedState, "a refused movement changes nothing");
      // A conflicting identity assertion is refused without a write.
      const forged = parseForm(card, `/tasks/${ids.high}/move`);
      forged.controls.set("status", "done");
      forged.controls.set("id", ids.tasks[2]);
      const forgedReply = await submit(base, forged);
      assert.equal(forgedReply.status, 400);
      assert.deepEqual(app.store.snapshot(), afterWaiting, "a conflicting assertion changes nothing");
      // An invalid status is a correctable form error and records nothing.
      const corrected = parseForm(card, `/tasks/${ids.high}/move`);
      corrected.controls.set("status", "paused");
      const invalid = await submit(base, corrected);
      assert.equal(invalid.status, 400);
      assert.match(String(invalid.headers["content-type"]), /^text\/html/);
      assert.match(invalid.body, /role="alert"/);
      assert.deepEqual(app.store.snapshot(), afterWaiting, "an invalid status changes nothing");

      // -- Then to done, from the freshly rendered waiting card. -------------
      const doneForm = parseForm(
        boardCards(columnOf(waitingBoard.body, "Waiting: waiting")).get(ids.high)!,
        `/tasks/${ids.high}/move`,
      );
      doneForm.controls.set("status", "done");
      assert.equal(follow(await submit(base, doneForm)), "/kanban");
      const afterDone = app.store.snapshot();
      assert.equal(journalOf(afterDone).length, journalOf(afterWaiting).length + 1);
      const doneEvent = journalOf(afterDone)[journalOf(afterDone).length - 1];
      assert.deepEqual(
        { action: doneEvent.action, targetKind: doneEvent.targetKind, targetId: doneEvent.targetId },
        { action: "edit", targetKind: "task", targetId: ids.high },
      );
      assert.equal(afterDone.tasks.find((task) => task.id === ids.high)!.status, "done");
      // The dashboard no longer lists a dated done task anywhere.
      const afterDoneHome = await send(base, { path: "/" });
      assert.ok(!sectionOf(afterDoneHome.body, "Waiting tasks").includes(`href="/tasks/${ids.high}"`));
      assert.ok(!sectionOf(afterDoneHome.body, "Overdue tasks").includes(`href="/tasks/${ids.high}"`));
      assert.ok(!sectionOf(afterDoneHome.body, "Tasks due soon").includes(`href="/tasks/${ids.high}"`));
      // Its current record page shows the done status and stays reachable.
      const donePage = await send(base, { path: `/tasks/${ids.high}` });
      assert.equal(donePage.status, 200);
      assert.match(donePage.body, /<dd><span class="badge">done<\/span><\/dd>/);

      // -- Restart: close both, reopen the same temporary directory. --------
      beforeRestart = snapshotOf(await observe(base, ids));
      const activityBeforeRestart = JSON.stringify(journalOf(app.store.snapshot()));
      await app.close();
      app = await running(dir, () => NOW, journal);
      base = app.origin;
      try {
        // The records and their history read back exactly as before, through
        // the same pages, links and boards.
        assert.equal(snapshotOf(await observe(base, ids)), beforeRestart);
        const restarted = app.store.snapshot();
        assert.equal(JSON.stringify(journalOf(restarted)), activityBeforeRestart);
        // The moved task is done and its two movement events are in history.
        assert.equal(restarted.tasks.find((task) => task.id === ids.high)!.status, "done");
        const movements = journalOf(restarted).filter(
          (candidate) => candidate.targetId === ids.high && candidate.action === "edit",
        );
        assert.equal(movements.length, 2);
        // Each movement event carries the instant its journal position holds.
        for (const movement of movements) {
          const position = journalOf(restarted).findIndex((candidate) => candidate.id === movement.id);
          assert.equal(movement.at, instant(position + 1).toISOString());
        }
        // The restarted dashboard is the same read-only page at the same day.
        const restartedHome = await send(base, { path: "/" });
        assert.equal(restartedHome.status, 200);
        assert.ok(restartedHome.body.includes(escapeHtml(TODAY)));
        assert.ok(!sectionOf(restartedHome.body, "Waiting tasks").includes(`href="/tasks/${ids.high}"`));
        assert.ok(sectionOf(restartedHome.body, "Recent activity").includes(`href="/tasks/${ids.high}"`));
        // The temporary workspace holds its store document.
        assert.ok(existsSyncCompat(dir, "workspace.json"));
        // The journal clock was read once per recorded event, and never more.
        assert.equal(stamps, journalOf(restarted).length);
        // A read after the restart still records nothing.
        const stable = snapshotOf(await observe(base, ids));
        assert.equal(stable, beforeRestart);
      } finally {
        await app.close();
      }
    } finally {
      // Close whatever is still open; a closed store releases its lock file.
      await app.close();
      assert.ok(!existsSyncCompat(dir, "workspace.lock"), "no lock is left behind");
    }
  });
});
/** True when `name` exists inside the temporary workspace directory. */
function existsSyncCompat(dir: string, name: string): boolean {
  try {
    statSync(join(dir, name));
    return true;
  } catch {
    return false;
  }
}


