/**
 * F2 daily operations milestone: one representative workspace exercised end to
 * end through the real rendered forms and links, over loopback HTTP, against a
 * temporary on-disk store.
 *
 * The fixture is synthetic only: two clients (one with an active engagement
 * that carries a project and a finished engagement, one with a planned
 * engagement and no project), assigned and unassigned high-priority tasks, an
 * actionable normal-priority task, waiting/done tasks, work items of the
 * attention kinds and meetings on engagement and project scopes.
 *
 * The suite follows the dashboard's summary links to every record and requests
 * the destination of every create's 303 redirect, walks every board scope by
 * the hrefs the all-work board renders and back to all work, puts an
 * engagement on hold from its rendered edit form, and moves a high-priority
 * actionable task to waiting and then to done by selecting the options the
 * rendered movement controls offer. It observes the dashboard date, membership,
 * priority, engagement and activity changes. It asserts that reads, a no-op
 * movement and refused movements leave the stored records and the journal
 * untouched, then closes both the store and the server and reopens them to
 * confirm the records, the history and the dashboard survive.
 *
 * The authoritative stored snapshot is captured before the very first page read
 * (no page is requested before it), and it is compared after the read batches,
 * the board reads and the refused movement; the journal is compared separately.
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
  /** The Host header, when it differs from the base origin. */
  readonly host?: string;
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
  // A destination request may name a different host (a followed Location).
  if (options.host !== undefined) headers.host = options.host;
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
function redirectTarget(reply: Reply): string {
  assert.equal(reply.status, 303, reply.body);
  const location = String(reply.headers.location ?? "");
  assert.ok(location.startsWith("/") && !location.startsWith("//"), `internal location, got ${location}`);
  return location;
}

/**
 * Follow a redirect like a browser: request the returned Location and assert
 * that its destination is a rendered page (200 HTML). Returns the target.
 */
async function follow(base: string, reply: Reply | Promise<Reply>): Promise<string> {
  const location = redirectTarget(await reply);
  const url = new URL(location, base);
  const destination = await send(base, { path: url.pathname + url.search, host: url.host });
  assert.equal(destination.status, 200, `the redirect destination ${location} is rendered`);
  assert.match(String(destination.headers["content-type"]), /^text\/html; charset=utf-8/);
  return location;
}

/** A rendered form as a browser would submit it. */
interface ParsedForm {
  readonly action: string;
  readonly controls: Map<string, string>;
  /** The option values each rendered select offered, keyed by control name. */
  readonly options: ReadonlyMap<string, readonly string[]>;
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
  const offered = new Map<string, readonly string[]>();
  const inner = form[1];
  for (const match of inner.matchAll(/<textarea[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) {
    controls.set(unescapeHtml(match[1]), unescapeHtml(match[2]));
  }
  for (const match of inner.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/g)) {
    controls.set(unescapeHtml(match[1]), unescapeHtml(match[2]));
  }
  for (const match of inner.matchAll(/<select[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const options = [...match[2].matchAll(/<option value="([^"]*)"([^>]*)>([\s\S]*?)<\/option>/g)];
    const values = options.map((option) => unescapeHtml(option[1]));
    offered.set(unescapeHtml(match[1]), values);
    const selectedOption = options.find((option) => option[2].includes("selected")) ?? options[0];
    controls.set(unescapeHtml(match[1]), selectedOption === undefined ? "" : unescapeHtml(selectedOption[1]));
  }
  return { action: unescapeHtml(action[1]), controls, options: offered };
}

/**
 * Choose a rendered select's offered option, exactly as selecting it in the
 * browser. A value the page did not offer fails the milestone.
 */
function chooseOption(form: ParsedForm, name: string, value: string): void {
  const offered = form.options.get(name);
  assert.ok(offered !== undefined, `the form has the select ${name}`);
  assert.ok(offered.includes(value), `the ${name} select offers ${value}; offered ${offered.join(", ")}`);
  form.controls.set(name, value);
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

/**
 * Every page of the workspace: the dashboard, the client list, the board
 * scopes, the archive discovery page, the health page and every fixture record's
 * own pages.
 * `linkedPaths` are the internal record links extracted from rendered pages, so
 * a page reachable from a rendered link (and not only from a constructed path)
 * is requested too.
 */
function workspacePaths(ids: FixtureIds, linkedPaths: readonly string[] = []): readonly string[] {
  const base = [
    "/",
    "/clients",
    "/archived",
    "/health",
    "/kanban",
    ...ids.engagements.map((id) => `/engagements/${id}/kanban`),
    ...ids.projects.map((id) => `/projects/${id}/kanban`),
    `/clients/${ids.alphaClient}/kanban`,
    `/clients/${ids.betaClient}/kanban`,
  ];
  const records = [
    `/clients/${ids.alphaClient}`,
    `/clients/${ids.betaClient}`,
    ...ids.engagements.flatMap((id) => [`/engagements/${id}`]),
    ...ids.projects.flatMap((id) => [`/projects/${id}`]),
    ...ids.tasks.map((id) => `/tasks/${id}`),
    ...ids.items.map((id) => `/items/${id}`),
    ...ids.meetings.map((id) => `/meetings/${id}`),
  ];
  return [...new Set([...base, ...records, ...linkedPaths])];
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

async function observe(
  base: string,
  ids: FixtureIds,
  linkedPaths: readonly string[] = [],
): Promise<Observation> {
  const pages: { path: string; body: string }[] = [];
  const known = new Set<string>();
  const visit = async (path: string): Promise<void> => {
    if (known.has(path)) return;
    known.add(path);
    const reply = await send(base, { path });
    assert.equal(reply.status, 200, `${path} is readable`);
    pages.push({ path, body: reply.body });
  };
  for (const path of workspacePaths(ids, linkedPaths)) await visit(path);
  // Every internal record link a read page renders is read as well, so a page
  // the workspace offers cannot change unnoticed.
  const recordLink = /^\/(clients|engagements|projects|tasks|items|meetings)\/[^/]+$/;
  for (const page of [...pages]) {
    for (const href of linksOf(mainContentOf(page.body))) {
      if (recordLink.test(href)) await visit(href);
    }
  }
  return { pages };
}

function snapshotOf(observation: Observation): string {
  return JSON.stringify(observation);
}

/**
 * The authoritative stored state as JSON: every record and the whole journal,
 * read straight from the store rather than through a rendered page. It is
 * captured before and after reads, so a read that altered a single field once
 * cannot establish the baseline it is compared with.
 */
async function readStore(store: Store): Promise<unknown> {
  const snapshot = store.snapshot();
  return structuredClone({
    clients: snapshot.clients,
    engagements: snapshot.engagements,
    projects: snapshot.projects,
    tasks: snapshot.tasks,
    items: snapshot.items,
    meetings: snapshot.meetings,
    activity: snapshot.activity,
  });
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
  /** The engagement moved to on hold during the milestone (filled in later). */
  readonly onHoldEngagement: string;
  /** The completed engagement, which is never unfinished. */
  readonly completedEngagement: string;
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
    if (form.options.has(key)) chooseOption(form, key, value);
    else form.controls.set(key, value);
  }
  const reply = await submit(base, form);
  // The create redirects (303) to the new record's page; request it.
  return follow(base, reply);
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
      onHoldEngagement: "",
      completedEngagement: "",
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
      // Two finished engagements of the first client that never count as
      // unfinished: an on-hold one (unfinished by status) is kept below, while
      // a completed one must stay out of the engagement overview.
      created.completedEngagement = idOf(await create(base, `/clients/${created.alphaClient}/engagements/new`, {
        name: "Archived audit",
        objectives: "Already delivered",
        status: "completed",
      }));
      created.engagements.push(created.completedEngagement);

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
      // An actionable non-high task with a date inside the due-soon range: it
      // is dated like the high tasks but must never reach the priority section.
      const normalSoon = idOf(await create(base, `/projects/${created.alphaProject}/tasks/new`, {
        title: "Book the room",
        status: "open",
        priority: "normal",
        owner: "",
        dueDate: day(1),
        context: "Actionable, normal priority",
        projectId: created.alphaProject,
      }));
      created.tasks.push(created.high, created.highUnassigned, waiting, created.done, betaHigh, normalSoon);

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
        onHoldEngagement: created.onHoldEngagement,
        completedEngagement: created.completedEngagement,
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
      assert.equal(journalOf(app.store.snapshot()).length, created.tasks.length + created.items.length + created.meetings.length + 6);

      // -- The dashboard at the fixed reference day. -------------------------
      // The authoritative stored state before the very first page is read: the
      // full stored snapshot, records and journal, taken straight from the
      // store. No page has been requested by the suite before this point, so a
      // read that changed a record once cannot establish the baseline.
      const beforeFirstRead = await readStore(app.store);
      const journalBeforeReads = JSON.stringify(journalOf(app.store.snapshot()));
      // The home clock selects the reference day; the store's journal clock
      // stamps the events. Neither read changes a stored value.
      const readStoreBefore = await readStore(app.store);
      assert.equal(JSON.stringify(readStoreBefore), JSON.stringify(beforeFirstRead), "reading the store changes nothing");
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
      // Due soon: today..today+7, holding the dated waiting task, the other
      // client's high task and the normal-priority task, ordered by due date,
      // with the range text.
      const dueSoon = sectionOf(home.body, "Tasks due soon");
      assert.deepEqual(idsLinked(dueSoon, "/tasks"), [ids.tasks[5], ids.tasks[2], ids.tasks[4]]);
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
      assert.ok(!high.includes(`href="/tasks/${ids.tasks[5]}"`), "a normal-priority task is never high-priority");
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
      // The newest row is the last create, stamped by the journal clock.
      const latest = /<span class="detail">([^<]+)<\/span>/.exec(activity)?.[1];
      assert.equal(latest, escapeHtml(instant(journalOf(app.store.snapshot()).length).toISOString()));
      // Every dated due-soon task, high or not, is listed; the priority section
      // holds exactly the high ones, so a non-high task is never there.
      assert.deepEqual(
        [...idsLinked(dueSoon, "/tasks")].sort(),
        [ids.tasks[2], ids.tasks[4], ids.tasks[5]].sort(),
      );
      // The completed engagement is never an unfinished engagement, though its
      // create is recent activity like any other.
      assert.ok(!engagementsSection.includes(`href="/engagements/${created.completedEngagement}"`));
      const newestCreate = activity.slice(activity.indexOf('<li class="card">'), activity.indexOf("</li>"));

      // -- Reads change nothing: read every scope, then compare the store. --
      // Every page of the workspace, including those linked from the pages
      // read, is requested; the observation is the baseline the later reads and
      // the refused movement are compared with.
      const readLinks = linksOf(mainContentOf(home.body)).filter((href) => /^\/(clients|engagements|projects|tasks|items|meetings)\/[^/]+$/.test(href));
      const observedAfterReads = await observe(base, ids, readLinks);
      beforeRefusal = snapshotOf(observedAfterReads);
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
      // Reads recorded nothing: no event was added and no record changed. The
      // stored snapshot taken before the very first page read is the baseline,
      // so a read that changed a record once cannot establish it.
      assert.equal(snapshotOf(await observe(base, ids, readLinks)), beforeRefusal);
      assert.deepEqual(await readStore(app.store), beforeFirstRead, "reads leave the store untouched");
      assert.equal(JSON.stringify(journalOf(app.store.snapshot())), journalBeforeReads, "reads add no journal event");

      // -- Every board scope, and back to all work. --------------------------
      const expectedTasks: Readonly<Record<string, readonly string[]>> = {
        "/kanban": [...ids.tasks],
        [`/clients/${ids.alphaClient}/kanban`]: [ids.high, ids.highUnassigned, ids.tasks[2], ids.done, ids.tasks[5]],
        [`/engagements/${ids.alphaEngagement}/kanban`]: [ids.high, ids.highUnassigned, ids.tasks[2], ids.done, ids.tasks[5]],
        [`/projects/${ids.alphaProject}/kanban`]: [ids.high, ids.done, ids.tasks[5]],
        [`/clients/${ids.betaClient}/kanban`]: [ids.tasks[4]],
        [`/engagements/${ids.betaEngagement}/kanban`]: [ids.tasks[4]],
        [`/engagements/${ids.completedEngagement}/kanban`]: [],
      };
      const scopeOfPath = (path: string): { kind: string; id: string } => {
        if (path === "/kanban") return { kind: "all", id: "" };
        const [, family, id] = path.split("/");
        return { kind: family.slice(0, -1), id };
      };
      /** Read one board page and check it is the scope's own board. */
      const readBoard = async (path: string): Promise<string> => {
        const board = await send(base, { path });
        assert.equal(board.status, 200, path);
        assert.ok(board.body.includes('aria-current="page"'), `${path} marks itself current`);
        // The scope navigation offers every scope plus all work, and the page
        // links back to all work and home.
        const scopeNav = mainContentOf(board.body);
        for (const href of Object.keys(expectedTasks)) {
          assert.ok(scopeNav.includes(`href="${href}"`), `${path} links ${href}`);
        }
        assert.ok(scopeNav.includes('href="/"'), "the board links home");
        return board.body;
      };
      // The navigation is driven by the hrefs the all-work board renders, not
      // by constructed paths: each extracted scope link opens its own board.
      const allWorkBoard = await readBoard("/kanban");
      const scopeLinks = linksOf(mainContentOf(allWorkBoard)).filter((href) => href.endsWith("/kanban"));
      assert.ok(scopeLinks.includes("/kanban"), "all work offers a link to itself");
      for (const path of Object.keys(expectedTasks)) {
        assert.ok(scopeLinks.includes(path), `the all-work board navigates to ${path}`);
      }
      assert.deepEqual(
        [...scopeLinks].sort(),
        Object.keys(expectedTasks).sort(),
        "the boards offer exactly the fixture's scopes plus all work",
      );
      for (const path of scopeLinks) {
        const board = await readBoard(path);
        // Every visible task of the scope is in exactly one column.
        const cards = new Map<string, string>();
        const groupStatus: Record<string, string> = {
          "Actionable: open": "open",
          "Actionable: in progress": "in_progress",
          "Waiting: waiting": "waiting",
          "Completed: done": "done",
        };
        for (const title of Object.keys(groupStatus)) {
          const column = columnOf(board, title);
          assert.ok(column !== "", `${path} has the ${title} column`);
          for (const [id, card] of boardCards(column)) {
            assert.ok(!cards.has(id), `${id} appears once`);
            cards.set(id, card);
            // The card's movement form starts on its column's own status.
            assert.equal(parseForm(card, `/tasks/${id}/move`).controls.get("status"), groupStatus[title]);
          }
        }
        assert.deepEqual([...cards.keys()].sort(), [...expectedTasks[path]].sort(), `${path} shows its own tasks`);
        // The project-scope board never shows engagement-only work.
        if (path === `/projects/${ids.alphaProject}/kanban`) {
          assert.ok(!cards.has(ids.highUnassigned), "a project board excludes project-less work");
        }
        // A card's movement form names the board's own scope and the record's
        // identity links, so a submission is checked against the exact record.
        const scope = scopeOfPath(path);
        for (const [id, card] of cards) {
          const form = parseForm(card, `/tasks/${id}/move`);
          assert.equal(form.controls.get("id"), id);
          assert.equal(form.controls.get("scopeKind"), scope.kind);
          assert.equal(form.controls.get("scopeId"), scope.id);
          const expectedClient = id === ids.tasks[4] ? ids.betaClient : ids.alphaClient;
          assert.equal(form.controls.get("clientId"), expectedClient);
          assert.equal(
            form.controls.get("projectId"),
            id === ids.high || id === ids.done || id === ids.tasks[5] ? ids.alphaProject : "",
          );
        }
      }
      // Back to all work from a narrowed board, through the href it renders.
      const projectBoard = await readBoard(`/projects/${ids.alphaProject}/kanban`);
      const backHref = linksOf(mainContentOf(projectBoard)).find((href) => href === "/kanban");
      assert.ok(backHref !== undefined, "the project board links back to all work");
      const backBoard = await readBoard(backHref);
      assert.ok(backBoard.includes('<a href="/kanban" aria-current="page">All work</a>'));
      // The board navigation is a read too: the state is unchanged.
      assert.equal(snapshotOf(await observe(base, ids, readLinks)), beforeRefusal);
      assert.deepEqual(await readStore(app.store), beforeFirstRead, "board reads leave the store untouched");

      // -- Putting an engagement on hold keeps it unfinished. ----------------
      // The engagement's own record page links its edit form; the rendered
      // status select offers on hold, and saving it keeps the engagement in the
      // unfinished overview.
      const engagementPage = await send(base, { path: `/engagements/${ids.alphaEngagement}` });
      assert.equal(engagementPage.status, 200);
      const editHref = linksOf(mainContentOf(engagementPage.body)).find((href) =>
        href === `/engagements/${ids.alphaEngagement}/edit`,
      );
      assert.ok(editHref !== undefined, "the engagement page links its edit form");
      const editPage = await send(base, { path: editHref });
      assert.equal(editPage.status, 200);
      const holdForm = parseForm(editPage.body);
      assert.equal(holdForm.action, editHref);
      assert.equal(holdForm.controls.get("status"), "active");
      assert.ok((holdForm.options.get("status") ?? []).includes("on_hold"), "the form offers on hold");
      chooseOption(holdForm, "status", "on_hold");
      assert.equal(await follow(base, await submit(base, holdForm)), `/engagements/${ids.alphaEngagement}`);
      const onHoldState = app.store.snapshot();
      assert.equal(
        onHoldState.engagements.find((engagement) => engagement.id === ids.alphaEngagement)!.status,
        "on_hold",
      );
      // The dashboard overview still lists it, and its current status badge says
      // on hold; the completed engagement stays out.
      const onHoldHome = await send(base, { path: "/" });
      const onHoldSection = sectionOf(onHoldHome.body, "Engagements in progress");
      assert.deepEqual(idsLinked(onHoldSection, "/engagements"), [ids.betaEngagement, ids.alphaEngagement]);
      assert.ok(onHoldSection.includes('<span class="badge">on_hold</span>'));
      assert.ok(!onHoldSection.includes(`href="/engagements/${ids.completedEngagement}"`));
      const onHoldEvent = journalOf(onHoldState)[journalOf(onHoldState).length - 1];
      assert.deepEqual(
        { action: onHoldEvent.action, targetKind: onHoldEvent.targetKind, targetId: onHoldEvent.targetId },
        { action: "edit", targetKind: "engagement", targetId: ids.alphaEngagement },
      );

      // -- A high-priority actionable task to waiting, then to done. --------
      const beforeMove = app.store.snapshot();
      const allBoard = await send(base, { path: "/kanban" });
      const card = boardCards(columnOf(allBoard.body, "Actionable: open")).get(ids.high);
      assert.ok(card !== undefined, "the high task is actionable on all work");
      const moveForm = parseForm(card, `/tasks/${ids.high}/move`);
      // The rendered select offers every status the milestone uses, on the
      // task's own status.
      assert.equal(moveForm.controls.get("status"), "open");
      assert.deepEqual([...(moveForm.options.get("status") ?? [])].sort(), ["done", "in_progress", "open", "waiting"]);
      // Submit the form as rendered (moving to its own status): no event.
      const noop = await submit(base, moveForm);
      assert.equal(await follow(base, noop), "/kanban");
      // A movement to the status the task already holds is a no-op: neither the
      // journal nor the records change.
      assert.equal(JSON.stringify(app.store.snapshot()), JSON.stringify(beforeMove), "a no-op movement changes nothing");
      // Move the task to waiting by choosing the option the card offers it.
      chooseOption(moveForm, "status", "waiting");
      const moved = await submit(base, moveForm);
      const destination = await follow(base, moved);
      assert.equal(destination, "/kanban");
      const afterWaiting = app.store.snapshot();
      const afterWaitingStore = await readStore(app.store);
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
      const newest = activityAfter.slice(activityAfter.indexOf('<li class="card">'), activityAfter.indexOf("</li>"));
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
      const refusedState = snapshotOf(await observe(base, ids, readLinks));
      const staleForm = parseForm(card, `/tasks/${ids.high}/move`);
      staleForm.controls.set("status", "open");
      // The task is inside the project scope, so submit it from a scope it is
      // outside: the other client's engagement.
      staleForm.controls.set("scopeKind", "engagement");
      staleForm.controls.set("scopeId", ids.betaEngagement);
      const refused = await submit(base, staleForm);
      assert.equal(refused.status, 400);
      assert.match(String(refused.headers["content-type"]), /^text\/plain/);
      assert.equal(snapshotOf(await observe(base, ids, readLinks)), refusedState, "a refused movement changes nothing");
      assert.deepEqual(await readStore(app.store), afterWaitingStore, "a refused movement leaves the store untouched");
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
      assert.equal(doneForm.controls.get("status"), "waiting", "the waiting card starts on waiting");
      chooseOption(doneForm, "status", "done");
      assert.equal(await follow(base, await submit(base, doneForm)), "/kanban");
      const afterDone = app.store.snapshot();
      assert.equal(journalOf(afterDone).length, journalOf(afterWaiting).length + 1);
      const doneEvent = journalOf(afterDone)[journalOf(afterDone).length - 1];
      assert.deepEqual(
        { action: doneEvent.action, targetKind: doneEvent.targetKind, targetId: doneEvent.targetId },
        { action: "edit", targetKind: "task", targetId: ids.high },
      );
      assert.equal(afterDone.tasks.find((task) => task.id === ids.high)!.status, "done");
      // The dashboard no longer lists a dated done task anywhere, and the
      // completed high task has left the high-priority section too.
      const afterDoneHome = await send(base, { path: "/" });
      assert.ok(!sectionOf(afterDoneHome.body, "Waiting tasks").includes(`href="/tasks/${ids.high}"`));
      assert.ok(!sectionOf(afterDoneHome.body, "Overdue tasks").includes(`href="/tasks/${ids.high}"`));
      assert.ok(!sectionOf(afterDoneHome.body, "Tasks due soon").includes(`href="/tasks/${ids.high}"`));
      assert.ok(!sectionOf(afterDoneHome.body, "High-priority tasks").includes(`href="/tasks/${ids.high}"`), "a done task is not high-priority actionable");
      assert.deepEqual(
        [...idsLinked(sectionOf(afterDoneHome.body, "High-priority tasks"), "/tasks")].sort(),
        [ids.highUnassigned, ids.tasks[4]].sort(),
        "the high-priority section keeps only the open high tasks",
      );
      // Its current record page shows the done status and stays reachable.
      const donePage = await send(base, { path: `/tasks/${ids.high}` });
      assert.equal(donePage.status, 200);
      assert.match(donePage.body, /<dd><span class="badge">done<\/span><\/dd>/);

      // -- Restart: close both, reopen the same temporary directory. --------
      beforeRestart = snapshotOf(await observe(base, ids, readLinks));
      const activityBeforeRestart = JSON.stringify(journalOf(app.store.snapshot()));
      await app.close();
      app = await running(dir, () => NOW, journal);
      base = app.origin;
      try {
        // The records and their history read back exactly as before, through
        // the same pages, links and boards.
        assert.equal(snapshotOf(await observe(base, ids, readLinks)), beforeRestart);
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
        const storeAfterRestart = await readStore(app.store);
        const stable = snapshotOf(await observe(base, ids, readLinks));
        assert.equal(stable, beforeRestart);
        // The reads after the restart leave the reopened store untouched too:
        // both the store snapshot and the journal are unchanged by them.
        assert.deepEqual(await readStore(app.store), storeAfterRestart, "post-restart reads leave the store untouched");
        assert.equal(JSON.stringify(journalOf(app.store.snapshot())), JSON.stringify(journalOf(restarted)));

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


