import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { escapeHtml } from "../src/html.ts";
import { startApplication, type Application } from "../src/index.ts";
import { openStore } from "../src/store.ts";

// ---------------------------------------------------------------------------
// Fixtures and HTTP helpers
// ---------------------------------------------------------------------------

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "workspace-integration-"));
  roots.push(dir);
  return dir;
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

interface RequestOptions {
  readonly method?: string;
  readonly path?: string;
  readonly origin?: string;
  readonly form?: Record<string, string>;
}

/** Send a request over loopback HTTP, with an explicit canonical Host header. */
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
    headers.origin = options.origin ?? base;
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

/** The internal target of a successful form POST's redirect. */
function redirectTarget(reply: Reply): string {
  assert.equal(reply.status, 303, reply.body);
  const location = String(reply.headers.location ?? "");
  assert.ok(location.startsWith("/"), `redirect location must be internal, got ${location}`);
  return location;
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** A rendered form as a browser would submit it. */
interface ParsedForm {
  readonly action: string;
  readonly controls: Map<string, string>;
}

function parseForm(document: string): ParsedForm {
  const controls = new Map<string, string>();
  const form = /<form[^>]*>([\s\S]*?)<\/form>/.exec(document);
  assert.ok(form !== null, "page has a form");
  const action = /<form[^>]*\saction="([^"]*)"/.exec(form[0]);
  assert.ok(action !== null, "the form has an action");
  const inner = form[1];
  for (const match of inner.matchAll(/<textarea[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) {
    controls.set(unescapeHtml(match[1]), unescapeHtml(match[2]));
  }
  for (const match of inner.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/g)) {
    controls.set(unescapeHtml(match[1]), unescapeHtml(match[2]));
  }
  for (const match of inner.matchAll(/<select[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const options = [...match[2].matchAll(/<option value="([^"]*)"([^>]*)>([\s\S]*?)<\/option>/g)];
    const selected = options.find((option) => option[2].includes("selected")) ?? options[0];
    controls.set(unescapeHtml(match[1]), selected === undefined ? "" : unescapeHtml(selected[1]));
  }
  return { action: unescapeHtml(action[1]), controls };
}

/**
 * Open a fresh application over the directory, on an ephemeral port. The
 * application opens the store itself and closes it on shutdown, so the same
 * directory can be reopened by a later, independent application instance.
 */
async function open(directory: string): Promise<Application> {
  return startApplication({ dataDirectory: directory, port: 0 });
}

/**
 * The main content region of a rendered page: everything inside the single
 * `<main id="main">` landmark, so a record's scope can be checked without
 * the global shell's client navigation, which deliberately lists every active
 * client on every page.
 */
function mainContentOf(body: string): string {
  const start = body.indexOf('<main id="main">');
  assert.ok(start >= 0, "page has a main landmark");
  const end = body.indexOf("</main>", start);
  assert.ok(end >= 0, "the main landmark is closed");
  return body.slice(start, end);
}

/**
 * A section of a rendered page, from the heading tag that names it to the
 * section's closing tag. Anchoring on the heading tag keeps a section from
 * being confused with a link to the same title elsewhere on the page.
 */
function sectionOf(body: string, title: string): string {
  const start = body.indexOf(`<h2>${escapeHtml(title)}</h2>`);
  if (start < 0) return "";
  const end = body.indexOf("</section>", start);
  return body.slice(start, end < 0 ? undefined : end);
}

/**
 * The record counts the home page reports, parsed back into numbers. The home
 * page is a read-only view of the store, so it is a safe, lock-respecting way
 * for this test to observe the committed record counts.
 */
function recordCounts(reply: Reply): Record<string, number> {
  assert.equal(reply.status, 200);
  const match = /Records: ([^.]*)\./.exec(reply.body);
  assert.ok(match !== null, "home page reports record counts");
  const counts: Record<string, number> = {};
  for (const pair of match[1].split(", ")) {
    const [kind, value] = pair.split(" ");
    counts[kind] = Number(value);
  }
  return counts;
}

/**
 * The part of `body` from the first occurrence of `start` to the next occurrence
 * of `end`, so one group inside a section can be inspected without the groups
 * that follow it. When `end` does not occur the slice runs to the end.
 */
function partOf(body: string, start: string, end: string): string {
  const from = body.indexOf(start);
  assert.ok(from >= 0, `page contains ${start}`);
  const to = body.indexOf(end, from + start.length);
  return body.slice(from, to < 0 ? undefined : to);
}

/**
 * One next-step group of a client overview: from its heading to the heading of
 * the group that follows it (or to the end of the section).
 */
function nextStepGroup(body: string, title: string, next: string | null): string {
  return partOf(body, escapeHtml(title), next === null ? "</section>" : escapeHtml(next));
}

/** The current-task section of a client overview. */
function currentTasks(body: string): string {
  return sectionOf(body, "Current tasks (open or in progress)");
}

/** The count shown for a labelled tally row inside the given text. */
function countFor(text: string, label: string): number {
  const match = new RegExp(`<li>[^<]*(?:<a[^>]*>[^<]*</a>)?${label}: (\\d+)</li>`).exec(text);
  assert.ok(match !== null, `no count for ${label}`);
  return Number(match[1]);
}

/** One observed page: where it was read and the response it gave. */
interface ObservedPage {
  readonly path: string;
  readonly status: number;
  readonly body: string;
}

/**
 * The committed state as it is visible over HTTP: the home page's record
 * counts, the detail page of every known record, and every engagement, project
 * and client page (which carry the histories, the counts and the project
 * links). A hostile write that changed a title, a date, a notes field, a kind,
 * a state, a parent link or a project link changes one of these pages even when
 * the number of records stays the same, so comparing the pages compares record
 * values, not just collection sizes.
 */
async function observe(
  base: string,
  ids: {
    readonly client: string;
    readonly otherClient: string;
    readonly emptyClient: string;
    readonly engagements: readonly string[];
    readonly projects: readonly string[];
    readonly tasks: readonly string[];
    readonly items: readonly string[];
    readonly meetings: readonly string[];
    readonly otherEngagement: string;
    readonly otherProject: string;
    readonly otherMeeting: string;
    readonly otherTask: string;
    readonly otherItem: string;
  },
): Promise<{
  readonly counts: Record<string, number>;
  readonly pages: readonly ObservedPage[];
}> {
  const counts = recordCounts(await send(base, { path: "/" }));
  const paths = [
    ...ids.tasks.map((id) => `/tasks/${id}`),
    ...ids.items.map((id) => `/items/${id}`),
    ...ids.meetings.map((id) => `/meetings/${id}`),
    `/tasks/${ids.otherTask}`,
    `/items/${ids.otherItem}`,
    `/meetings/${ids.otherMeeting}`,
    `/clients/${ids.client}`,
    `/clients/${ids.otherClient}`,
    `/clients/${ids.emptyClient}`,
    ...ids.engagements.map((id) => `/engagements/${id}`),
    `/engagements/${ids.otherEngagement}`,
    ...ids.projects.map((id) => `/projects/${id}`),
    `/projects/${ids.otherProject}`,
  ];
  const pages: ObservedPage[] = [];
  for (const path of paths) {
    const reply = await send(base, { path });
    assert.equal(reply.status, 200, `${path} is a readable record or page`);
    pages.push({ path, status: reply.status, body: reply.body });
  }
  return { counts, pages };
}

// ---------------------------------------------------------------------------
// The workflow
// ---------------------------------------------------------------------------

describe("workspace integration: linked overview and restart", () => {
  it("runs a full profile-to-history workflow over loopback HTTP and survives a restart", async () => {
    const dir = tempDir();

    // -- Fresh application and store over the same temporary directory. -----
    let app = await open(dir);
    let base = app.url;
    const ids = {
      client: "",
      engagements: [] as string[],
      projects: [] as string[],
      tasks: [] as string[],
      items: [] as string[],
      meetings: [] as string[],
      probe: "",
      probeTitle: "",
      otherClient: "",
      emptyClient: "",
      otherEngagement: "",
      otherProject: "",
      otherMeeting: "",
      otherTask: "",
      otherItem: "",
    };
    let beforeHostile: string;
    let beforeRestart: string;

    try {
      // -- The full client profile, through the rendered form. ---------------
      const clientForm = parseForm((await send(base, { path: "/clients/new" })).body);
      clientForm.controls.set("name", "Acme <Ltd>");
      clientForm.controls.set("background", "Founded < 1990 & grew");
      clientForm.controls.set("contacts", 'Ada "Lovelace" <ada@example.test>');
      clientForm.controls.set("stakeholders", "Board & 'staff'");
      clientForm.controls.set("requirements", "Must <work> offline");
      clientForm.controls.set("objectives", "Ship <v1> & learn");
      const createdClient = await send(base, { method: "POST", path: clientForm.action, form: Object.fromEntries(clientForm.controls) });
      ids.client = redirectTarget(createdClient).split("/").pop() as string;

      // -- Two engagements under the client, each with a project. ------------
      for (const name of ["Alpha", "Beta"]) {
        const page = await send(base, { path: `/clients/${ids.client}/engagements/new` });
        const form = parseForm(page.body);
        assert.equal(form.controls.get("clientId"), ids.client);
        form.controls.set("name", name);
        form.controls.set("objectives", `${name} objectives`);
        form.controls.set("status", name === "Alpha" ? "active" : "on_hold");
        const reply = await send(base, { method: "POST", path: form.action, form: Object.fromEntries(form.controls) });
        ids.engagements.push(redirectTarget(reply).split("/").pop() as string);
      }
      for (const [index, name] of ["Alpha project", "Beta project"].entries()) {
        const engagement = ids.engagements[index];
        const page = await send(base, { path: `/engagements/${engagement}/projects/new` });
        const form = parseForm(page.body);
        assert.equal(form.controls.get("engagementId"), engagement);
        form.controls.set("name", name);
        form.controls.set("objectives", `${name} objectives`);
        form.controls.set("status", "active");
        const reply = await send(base, { method: "POST", path: form.action, form: Object.fromEntries(form.controls) });
        ids.projects.push(redirectTarget(reply).split("/").pop() as string);
      }
      const [alpha, beta] = ids.engagements;
      const [alphaProject, betaProject] = ids.projects;

      // -- Tasks with and without dates, all statuses, engagement and project.
      const postTask = async (
        path: string,
        values: Record<string, string>,
      ): Promise<string> => {
        const form = parseForm((await send(base, { path })).body);
        for (const [key, value] of Object.entries(values)) {
          assert.ok(form.controls.has(key), `task form has control ${key}`);
          form.controls.set(key, value);
        }
        const reply = await send(base, { method: "POST", path: form.action, form: Object.fromEntries(form.controls) });
        return redirectTarget(reply).split("/").pop() as string;
      };
      // Two tasks stay current (one open, one in progress). They are asserted
      // in the overview before the third is completed; after completion it must
      // leave the current-task list while staying reachable. The fourth task is
      // done from the start.
      ids.tasks.push(await postTask(`/engagements/${alpha}/tasks/new`, {
        title: "Alpha engagement task", status: "open", priority: "high", owner: "Dana", dueDate: "2026-06-30", context: "no project",
      }));
      ids.tasks.push(await postTask(`/projects/${alphaProject}/tasks/new`, {
        title: "Alpha project task", status: "in_progress", priority: "normal", owner: "Lee", dueDate: "", context: "project work",
      }));
      ids.tasks.push(await postTask(`/engagements/${alpha}/tasks/new`, {
        title: "Alpha finishing task", status: "open", priority: "low", owner: "", dueDate: "", context: "completing now",
      }));
      ids.tasks.push(await postTask(`/engagements/${beta}/tasks/new`, {
        title: "Beta done task", status: "done", priority: "low", owner: "", dueDate: "2025-12-31", context: "finished",
      }));

      // -- Every item kind and both states, then state changes. --------------
      const postItem = async (
        path: string,
        values: Record<string, string>,
      ): Promise<string> => {
        const form = parseForm((await send(base, { path })).body);
        for (const [key, value] of Object.entries(values)) {
          assert.ok(form.controls.has(key), `item form has control ${key}`);
          form.controls.set(key, value);
        }
        const reply = await send(base, { method: "POST", path: form.action, form: Object.fromEntries(form.controls) });
        return redirectTarget(reply).split("/").pop() as string;
      };
      const kinds = ["decision", "question", "blocker", "commitment", "waiting", "follow_up"];
      for (const kind of kinds) {
        ids.items.push(await postItem(`/engagements/${alpha}/items/new`, {
          kind, title: `Alpha ${kind}`, context: `${kind} context`, state: "open",
        }));
      }
      // A closed decision in the alpha project: a decision is not filtered by
      // state, so the overview must still list it (reachable and linked) though
      // it is closed. One item per kind follows in beta.
      ids.items.push(await postItem(`/projects/${alphaProject}/items/new`, {
        kind: "decision", title: "Alpha project decision", context: "decided", state: "closed",
      }));
      for (const kind of kinds) {
        ids.items.push(await postItem(`/engagements/${beta}/items/new`, {
          kind, title: `Beta ${kind}`, context: "", state: "open",
        }));
      }

      // -- Meetings: client-wide, engagement-only, project meetings, ties. ---
      const postMeeting = async (
        path: string,
        values: Record<string, string>,
      ): Promise<string> => {
        const form = parseForm((await send(base, { path })).body);
        for (const [key, value] of Object.entries(values)) {
          assert.ok(form.controls.has(key), `meeting form has control ${key}`);
          form.controls.set(key, value);
        }
        const reply = await send(base, { method: "POST", path: form.action, form: Object.fromEntries(form.controls) });
        return redirectTarget(reply).split("/").pop() as string;
      };
      const alphaEngagementMeeting = await postMeeting(`/engagements/${alpha}/meetings/new`, {
        title: "Alpha kickoff <draft>", date: "2026-01-15", notes: "Agenda & owners", projectId: "",
      });
      const alphaProjectMeeting = await postMeeting(`/projects/${alphaProject}/meetings/new`, {
        title: "Alpha project sync", date: "2026-03-02", notes: "Project progress", projectId: alphaProject,
      });
      const betaMeeting = await postMeeting(`/engagements/${beta}/meetings/new`, {
        title: "Beta planning", date: "2026-02-01", notes: "Plans <scope>", projectId: "",
      });
      // A tie on the same date: the history keeps a stable order (id descending).
      const alphaTieOld = await postMeeting(`/engagements/${alpha}/meetings/new`, {
        title: "Alpha tie older", date: "2026-02-01", notes: "", projectId: "",
      });
      const alphaTieNew = await postMeeting(`/engagements/${alpha}/meetings/new`, {
        title: "Alpha tie newer", date: "2026-02-01", notes: "", projectId: "",
      });
      ids.meetings.push(alphaEngagementMeeting, alphaProjectMeeting, betaMeeting, alphaTieOld, alphaTieNew);

      // -- State changes: close a blocker; edit a meeting. -------------------
      const closeItem = parseForm((await send(base, { path: `/items/${ids.items[2]}/edit` })).body);
      assert.equal(closeItem.controls.get("kind"), "blocker");
      assert.equal(closeItem.controls.get("state"), "open");
      closeItem.controls.set("state", "closed");
      const closed = await send(base, { method: "POST", path: closeItem.action, form: Object.fromEntries(closeItem.controls) });
      assert.equal(redirectTarget(closed), `/items/${ids.items[2]}`);
      // The closed blocker is excluded from the overview's open blockers; it
      // stays linked from the engagement's own work-item list.
      const closedBlockerPage = await send(base, { path: `/items/${ids.items[2]}` });
      assert.equal(closedBlockerPage.status, 200);
      assert.ok(closedBlockerPage.body.includes("closed"));

      const editMeeting = parseForm((await send(base, { path: `/meetings/${alphaEngagementMeeting}/edit` })).body);
      assert.equal(editMeeting.controls.get("date"), "2026-01-15");
      editMeeting.controls.set("title", "Alpha kickoff (edited)");
      editMeeting.controls.set("date", "2026-01-20");
      editMeeting.controls.set("notes", "Edited & kept");
      const edited = await send(base, { method: "POST", path: editMeeting.action, form: Object.fromEntries(editMeeting.controls) });
      assert.equal(redirectTarget(edited), `/meetings/${alphaEngagementMeeting}`);

      // -- Another client, for isolation. ------------------------------------
      const otherClientForm = parseForm((await send(base, { path: "/clients/new" })).body);
      otherClientForm.controls.set("name", "Other client");
      const otherClient = await send(base, { method: "POST", path: "/clients/new", form: Object.fromEntries(otherClientForm.controls) });
      ids.otherClient = redirectTarget(otherClient).split("/").pop() as string;
      const otherEngagementForm = parseForm((await send(base, { path: `/clients/${ids.otherClient}/engagements/new` })).body);
      otherEngagementForm.controls.set("name", "Other engagement");
      const otherEngagement = await send(base, { method: "POST", path: "/engagements/new", form: Object.fromEntries(otherEngagementForm.controls) });
      ids.otherEngagement = redirectTarget(otherEngagement).split("/").pop() as string;
      const otherProjectForm = parseForm((await send(base, { path: `/engagements/${ids.otherEngagement}/projects/new` })).body);
      otherProjectForm.controls.set("name", "Other project");
      const otherProject = await send(base, { method: "POST", path: "/projects/new", form: Object.fromEntries(otherProjectForm.controls) });
      ids.otherProject = redirectTarget(otherProject).split("/").pop() as string;
      ids.otherTask = (await postTask(`/engagements/${ids.otherEngagement}/tasks/new`, {
        title: "Other task", status: "open", priority: "high", owner: "", dueDate: "", context: "",
      }));
      ids.otherItem = (await postItem(`/engagements/${ids.otherEngagement}/items/new`, {
        kind: "follow_up", title: "Other follow-up", context: "", state: "open",
      }));
      ids.otherMeeting = await postMeeting(`/projects/${ids.otherProject}/meetings/new`, {
        title: "Other meeting", date: "2026-04-01", notes: "", projectId: ids.otherProject,
      });

      // -- A client with no engagements, for its empty states. ---------------
      const emptyClientForm = parseForm((await send(base, { path: "/clients/new" })).body);
      emptyClientForm.controls.set("name", "Empty client");
      const emptyClient = await send(base, { method: "POST", path: "/clients/new", form: Object.fromEntries(emptyClientForm.controls) });
      ids.emptyClient = redirectTarget(emptyClient).split("/").pop() as string;

      // -- Rejected hostile requests leave the data unchanged. ---------------
      // The complete committed state, captured over HTTP before any hostile
      // request: the home page counts, every record detail page (title, date,
      // notes, kind, state, parents and project link) and the three histories.
      // Collection sizes alone could not detect a changed field or parent link,
      // so the comparison is of record values and full page snapshots. The
      // captured state is used for the restart comparison as well.
      beforeRestart = JSON.stringify(await observe(base, ids));
      beforeHostile = beforeRestart;
      // Each hostile request is the same as a legitimate one except for the
      // field under attack, so the request itself is otherwise valid: a bug
      // that ignored the check would change a title, a notes field, a state or
      // a parent link, which the snapshot comparison detects.
      const hostile: Array<[string, Record<string, string>, number]> = [
        // A tampered cross-engagement project on a meeting create: the same
        // title as an existing record, so only the refused write differs.
        [`/engagements/${alpha}/meetings/new`, { title: "Alpha kickoff (edited)", date: "2026-01-20", notes: "Edited & kept", projectId: betaProject }, 400],
        // A tampered parent on a meeting create: refused, not rewritten.
        [`/engagements/${alpha}/meetings/new`, { engagementId: beta, clientId: ids.otherClient, title: "Alpha kickoff (edited)", date: "2026-01-20", notes: "Edited & kept" }, 400],
        // A tampered parent with an invalid date is refused either way.
        [`/engagements/${alpha}/meetings/new`, { engagementId: beta, title: "Bad date", date: "2023-02-29", notes: "" }, 400],
        // A tampered project on a task create.
        [`/engagements/${alpha}/tasks/new`, { title: "Alpha project task", status: "done", priority: "normal", owner: "Lee", dueDate: "", context: "project work", projectId: betaProject }, 400],
        // A cross-engagement project on a meeting edit: the record must not move.
        [`/meetings/${alphaProjectMeeting}/edit`, { id: alphaProjectMeeting, title: "Crossed project", date: "2026-05-05", notes: "should not save", projectId: betaProject }, 400],
        // A tampered parent on a meeting edit, with valid changed fields: the
        // record must not move and the other fields must not be saved.
        [`/meetings/${alphaProjectMeeting}/edit`, { id: alphaProjectMeeting, engagementId: beta, title: "Crossed engagement", date: "2026-05-05", notes: "should not save", projectId: alphaProject }, 400],
        // A blank title on a meeting create.
        [`/engagements/${alpha}/meetings/new`, { title: " ", date: "2026-05-05", notes: "" }, 400],
        // A hostile request that names another record's id on an edit.
        [`/meetings/${alphaEngagementMeeting}/edit`, { id: alphaProjectMeeting, title: "Crossed id", date: "2026-05-05", notes: "should not save" }, 400],
        // A tampered parent on a project-scoped meeting create.
        [`/projects/${alphaProject}/meetings/new`, { engagementId: beta, title: "Alpha kickoff (edited)", date: "2026-01-20", notes: "Edited & kept", projectId: alphaProject }, 400],
        // A hostile request that tries to move a closed decision back to open.
        [`/items/${ids.items[6]}/edit`, { kind: "decision", title: "Alpha project decision", context: "decided", state: "open", id: ids.items[0] }, 400],
      ];
      for (const [path, form, status] of hostile) {
        const reply = await send(base, { method: "POST", path, form });
        assert.equal(reply.status, status, `${path} ${JSON.stringify(form)}`);
        assert.match(String(reply.headers["content-type"]), /^text\/html/);
        assert.match(reply.body, /role="alert"/);
        assert.equal(
          JSON.stringify(await observe(base, ids)),
          beforeHostile,
          `${path} must not mutate any record or page`,
        );
      }
      // A cross-origin POST is refused before any handler runs.
      const foreign = await send(base, {
        method: "POST",
        path: `/engagements/${alpha}/meetings/new`,
        origin: "http://evil.example",
        form: { title: "Cross origin", date: "2026-01-01", notes: "" },
      });
      assert.equal(foreign.status, 403);
      assert.equal(JSON.stringify(await observe(base, ids)), beforeHostile);
      // A positive control: the same kind of request with only the tampered
      // field corrected is accepted, and the observation changes in its existing
      // paths (the new meeting's count, the history links and the scoped pages),
      // so a snapshot that never changed would fail this test rather than pass
      // silently. There is no delete route for a meeting, so the probe stays
      // stored for the rest of the workflow, including the restart below: the
      // path list before and after the control is identical (ids.probe is never
      // a path in it) and the probe's edited title is part of later snapshots.
      const legit = await send(base, {
        method: "POST",
        path: `/engagements/${alpha}/meetings/new`,
        form: { title: "Snapshot probe", date: "2026-07-01", notes: "" },
      });
      ids.probe = redirectTarget(legit).split("/").pop() as string;
      const probePage = await send(base, { path: `/meetings/${ids.probe}` });
      assert.equal(probePage.status, 200);
      assert.ok(probePage.body.includes("Snapshot probe"));
      const probed = JSON.stringify(await observe(base, ids));
      assert.notEqual(probed, beforeRestart);
      // Edit the probe so an accepted write of a changed title is observed.
      const probeEdit = parseForm((await send(base, { path: `/meetings/${ids.probe}/edit` })).body);
      probeEdit.controls.set("title", "Snapshot probe (edited)");
      ids.probeTitle = "Snapshot probe (edited)";
      const probeEdited = await send(base, { method: "POST", path: probeEdit.action, form: Object.fromEntries(probeEdit.controls) });
      assert.equal(redirectTarget(probeEdited), `/meetings/${ids.probe}`);
      const probedEdited = JSON.stringify(await observe(base, ids));
      assert.notEqual(probedEdited, probed);
      // Every subsequent hostile request is compared against the current state.
      // Accepted writes follow (a completed task), so the restart comparison
      // below uses the state observed just before the restart instead.
      beforeHostile = JSON.stringify(await observe(base, ids));

      // -- The client overview. ----------------------------------------------
      const overview = await send(base, { path: `/clients/${ids.client}` });
      assert.equal(overview.status, 200);

      // Profile: every non-name value submitted above is shown, escaped.
      const profile = sectionOf(overview.body, "Profile");
      // Every value the profile form supplied is on the stored record.
      for (const value of [
        "Acme <Ltd>",
        "Founded < 1990 & grew",
        'Ada "Lovelace" <ada@example.test>',
        "Board & 'staff'",
        "Must <work> offline",
        "Ship <v1> & learn",
      ]) {
        assert.ok(profile.includes(escapeHtml(value)), value);
        assert.ok(!profile.includes(value), `${value} is escaped`);
      }

      // Engagements with their statuses and projects, each linked.
      const engagementSection = sectionOf(overview.body, "Engagements");
      assert.match(engagementSection, new RegExp(`href="/engagements/${alpha}"`));
      assert.match(engagementSection, new RegExp(`href="/engagements/${beta}"`));
      assert.match(engagementSection, /<a href="\/engagements\/[^"]+">Alpha<\/a> \(active\)/);
      assert.match(engagementSection, /<a href="\/engagements\/[^"]+">Beta<\/a> \(on_hold\)/);
      const projectSection = sectionOf(overview.body, "Projects");
      assert.match(projectSection, new RegExp(`href="/projects/${alphaProject}"`));
      assert.match(projectSection, new RegExp(`href="/projects/${betaProject}"`));
      assert.match(projectSection, /<a href="\/projects\/[^"]+">Alpha project<\/a> \(active · Alpha\)/);
      assert.match(projectSection, /<a href="\/projects\/[^"]+">Beta project<\/a> \(active · Beta\)/);

      // Current tasks: exactly the open and in-progress tasks, with and without
      // dates, and never the completed ones.
      const current = currentTasks(overview.body);
      assert.deepEqual(
        [...current.matchAll(/href="\/tasks\/([^"]+)"/g)].map((match) => match[1]),
        [ids.tasks[0], ids.tasks[1], ids.tasks[2]],
      );
      assert.ok(!current.includes(`href="/tasks/${ids.tasks[3]}"`)); // done from the start
      assert.ok(!current.includes("Beta done task"));
      assert.match(current, /status open/);
      assert.match(current, /status in_progress/);
      assert.ok(current.includes(escapeHtml("Alpha engagement task")));
      assert.ok(current.includes(escapeHtml("Alpha project task")));

      // Open blockers and questions; the closed blocker is gone from them.
      const blockers = sectionOf(overview.body, "Open blockers");
      assert.ok(!blockers.includes(`href="/items/${ids.items[2]}"`));
      // Beta's open blocker belongs to the same client, so it is listed once
      // here as well; Alpha's closed blocker is gone.
      const betaBlocker = ids.items[9];
      assert.match(blockers, new RegExp(`href="/items/${betaBlocker}"`));
      assert.equal(blockers.split("<li>").length - 1, 1);
      const questions = sectionOf(overview.body, "Open questions");
      assert.match(questions, new RegExp(`href="/items/${ids.items[1]}"`));
      assert.ok(!questions.includes(`href="/items/${ids.items[7]}"`)); // beta question

      // Decisions list every decision of this client, open or closed, across
      // its engagements (Alpha's open one, the closed alpha-project one and
      // Beta's), and no other kind of item.
      const decisions = sectionOf(overview.body, "Decisions");
      assert.deepEqual(
        [...decisions.matchAll(/href="\/items\/([^"]+)"/g)].map((match) => match[1]),
        [ids.items[0], ids.items[6], ids.items[7]],
      );
      assert.match(decisions, /kind decision, closed/);
      assert.match(decisions, /kind decision, open/);
      // The closed decision is reachable and shows its closed state.
      const closedDecisionPage = await send(base, { path: `/items/${ids.items[6]}` });
      assert.equal(closedDecisionPage.status, 200);
      assert.match(closedDecisionPage.body, /<dd>closed<\/dd>/);

      // Next steps: three identifiable groups, each with its own heading and
      // list, containing only this client's open items of that kind.
      const nextSteps = sectionOf(overview.body, "Next steps");
      const followUps = nextStepGroup(nextSteps, "Open follow-ups", "Open commitments");
      const commitments = nextStepGroup(nextSteps, "Open commitments", "Open waiting items");
      const waiting = nextStepGroup(nextSteps, "Open waiting items", null);
      assert.match(followUps, new RegExp(`href="/items/${ids.items[5]}"`));
      assert.ok(!followUps.includes(`href="/items/${ids.items[3]}"`));
      assert.match(commitments, new RegExp(`href="/items/${ids.items[3]}"`));
      assert.ok(!commitments.includes(`href="/items/${ids.items[4]}"`));
      assert.match(waiting, new RegExp(`href="/items/${ids.items[4]}"`));
      // Each next-step item is listed exactly once across the three groups.
      for (const index of [3, 4, 5]) {
        assert.equal(nextSteps.split(`href="/items/${ids.items[index]}"`).length - 1, 1, `item ${index}`);
      }
      // Closed items never appear in the next steps.
      assert.ok(!nextSteps.includes(`href="/items/${ids.items[2]}"`));
      assert.ok(!nextSteps.includes(`href="/items/${ids.items[6]}"`));
      // The overview offers no client-level creation shortcut: creation is
      // scoped under a chosen engagement or project, and the sections have no
      // "New task" or "New item" link.
      assert.ok(!overview.body.includes("New task"));
      assert.ok(!overview.body.includes("New item"));
      assert.ok(!overview.body.includes("/engagements//"));

      // Derived engagement counts. Alpha tasks: two open engagement tasks and
      // the in-progress project task. Beta: its single done task. Engagement
      // project tasks are counted once, in their engagement's scope.
      const counts = sectionOf(overview.body, "Engagement counts");
      const alphaCounts = counts.slice(counts.indexOf(`href="/engagements/${alpha}"`), counts.indexOf(`href="/engagements/${beta}"`));
      // Alpha's three tasks split into two engagement-only tasks (both open)
      // and one project task (in progress), each counted once.
      assert.equal(countFor(alphaCounts, "open"), 2);
      assert.equal(countFor(alphaCounts, "in_progress"), 1);
      assert.equal(countFor(alphaCounts, "done"), 0);
      const alphaStored = [ids.tasks[0], ids.tasks[1], ids.tasks[2]];
      assert.equal(alphaStored.length, 3);
      assert.equal(
        countFor(alphaCounts, "open") + countFor(alphaCounts, "in_progress") + countFor(alphaCounts, "done"),
        3,
      );
      const betaCounts = counts.slice(counts.indexOf(`href="/engagements/${beta}"`));
      assert.equal(countFor(betaCounts, "open"), 0);
      assert.equal(countFor(betaCounts, "in_progress"), 0);
      assert.equal(countFor(betaCounts, "done"), 1);

      // The client-wide meeting history: every meeting of this client once,
      // ordered by date descending with a stable tie order.
      const clientHistory = sectionOf(overview.body, "Meeting history");
      for (const meeting of [alphaEngagementMeeting, alphaProjectMeeting, betaMeeting, alphaTieOld, alphaTieNew]) {
        assert.match(clientHistory, new RegExp(`href="/meetings/${meeting}"`));
        const occurrences = clientHistory.split(`href="/meetings/${meeting}"`).length - 1;
        assert.equal(occurrences, 1);
      }
      assert.ok(clientHistory.includes(escapeHtml("2026-01-20 — Alpha kickoff (edited)")));
      // Dates: 2026-03-02 (alpha project), 2026-02-01 (two ties), 2026-01-20
      // (the edited alpha engagement meeting). Ties order by id descending.
      const clientOrder = [alphaProjectMeeting, alphaTieNew, alphaTieOld, alphaEngagementMeeting]
        .map((meeting) => clientHistory.indexOf(`href="/meetings/${meeting}"`));
      for (let index = 1; index < clientOrder.length; index += 1) {
        assert.ok(clientOrder[index - 1] < clientOrder[index], "newest first");
      }

      // The sibling client's records never leak into this overview's main
      // content. The global shell deliberately lists every active client in its
      // navigation, so the whole document carries the sibling client's name;
      // the isolation assertion is scoped to the main landmark.
      const overviewMain = mainContentOf(overview.body);
      for (const marker of ["Other client", "Other engagement", "Other project", "Other task", "Other follow-up", "Other meeting"]) {
        assert.ok(!overviewMain.includes(marker), marker);
      }
      assert.ok(!overviewMain.includes(`href="/meetings/${ids.otherMeeting}"`));
      assert.ok(!overviewMain.includes(`href="/items/${ids.otherItem}"`));
      // The global client navigation does carry the sibling client, escaped and
      // linked, exactly as the owner's decision requires.
      assert.ok(overview.body.includes(escapeHtml("Other client")));
      assert.match(
        overview.body,
        new RegExp(`<nav class="primary-nav" aria-label="Primary"><ul>[\\s\\S]*href="/clients/${ids.otherClient}"`),
      );

      // -- The engagement history: direct and project meetings once each. ----
      const alphaPage = await send(base, { path: `/engagements/${alpha}` });
      assert.equal(alphaPage.status, 200);
      const alphaHistory = sectionOf(alphaPage.body, "Meeting history");
      for (const meeting of [alphaEngagementMeeting, alphaProjectMeeting, alphaTieOld, alphaTieNew]) {
        const occurrences = alphaHistory.split(`href="/meetings/${meeting}"`).length - 1;
        assert.equal(occurrences, 1, meeting);
      }
      // The sibling engagement's meeting is not in this engagement's history.
      assert.ok(!alphaHistory.includes(`href="/meetings/${betaMeeting}"`));
      assert.ok(!alphaHistory.includes(`href="/meetings/${ids.otherMeeting}"`));

      // -- The project history: only its meetings. ---------------------------
      const alphaProjectPage = await send(base, { path: `/projects/${alphaProject}` });
      const alphaProjectHistory = sectionOf(alphaProjectPage.body, "Meeting history");
      assert.match(alphaProjectHistory, new RegExp(`href="/meetings/${alphaProjectMeeting}"`));
      for (const meeting of [alphaEngagementMeeting, betaMeeting, alphaTieOld, alphaTieNew]) {
        assert.ok(!alphaProjectHistory.includes(`href="/meetings/${meeting}"`), meeting);
      }

      // -- The sibling engagement and project views stay scoped. -------------
      const betaPage = await send(base, { path: `/engagements/${beta}` });
      const betaHistory = sectionOf(betaPage.body, "Meeting history");
      assert.match(betaHistory, new RegExp(`href="/meetings/${betaMeeting}"`));
      for (const meeting of [alphaEngagementMeeting, alphaProjectMeeting, alphaTieOld, alphaTieNew]) {
        assert.ok(!betaHistory.includes(`href="/meetings/${meeting}"`), meeting);
      }
      assert.ok(!betaPage.body.includes("Alpha kickoff"));
      const betaProjectPage = await send(base, { path: `/projects/${betaProject}` });
      assert.match(sectionOf(betaProjectPage.body, "Meeting history"), /No meetings recorded yet\./);

      // Closed and completed work stays reachable through its record lists.
      const alphaRecord = await send(base, { path: `/engagements/${alpha}` });
      assert.match(alphaRecord.body, new RegExp(`href="/tasks/${ids.tasks[0]}"`));
      assert.match(alphaRecord.body, new RegExp(`href="/tasks/${ids.tasks[2]}"`));
      assert.match(alphaRecord.body, new RegExp(`href="/tasks/${ids.tasks[1]}"`));
      assert.match(alphaRecord.body, new RegExp(`href="/items/${ids.items[2]}"`));
      assert.match(alphaRecord.body, new RegExp(`href="/items/${ids.items[6]}"`));
      // Alpha's finished and engagement-only work appears in the engagement-only
      // group, its project task and project decision in the project's section.
      assert.ok(!alphaRecord.body.includes(`href="/tasks/${ids.tasks[3]}"`), "beta task is not Alpha's");
      const betaRecord = await send(base, { path: `/engagements/${beta}` });
      assert.match(betaRecord.body, new RegExp(`href="/tasks/${ids.tasks[3]}"`));
      // Every listed record links somewhere reachable.
      const closedBlocker = await send(base, { path: `/items/${ids.items[2]}` });
      assert.equal(closedBlocker.status, 200);
      assert.match(closedBlocker.body, /<dd>closed<\/dd>/);
      const closedDecisionAfterBlockers = await send(base, { path: `/items/${ids.items[6]}` });
      assert.equal(closedDecisionAfterBlockers.status, 200);
      assert.match(closedDecisionAfterBlockers.body, /<dd>closed<\/dd>/);

      // -- A task completed after the overviews were read. -------------------
      // Completing a task is a state change the overview's current-task list
      // must reflect; the completed task stays reachable through its record
      // list and its detail page.
      const completeTask = parseForm((await send(base, { path: `/tasks/${ids.tasks[2]}/edit` })).body);
      assert.equal(completeTask.controls.get("status"), "open");
      completeTask.controls.set("status", "done");
      const completed = await send(base, { method: "POST", path: completeTask.action, form: Object.fromEntries(completeTask.controls) });
      assert.equal(redirectTarget(completed), `/tasks/${ids.tasks[2]}`);
      const overviewAfter = await send(base, { path: `/clients/${ids.client}` });
      assert.equal(overviewAfter.status, 200);
      const currentAfter = currentTasks(overviewAfter.body);
      assert.deepEqual(
        [...currentAfter.matchAll(/href="\/tasks\/([^"]+)"/g)].map((match) => match[1]),
        [ids.tasks[0], ids.tasks[1]],
      );
      const completedTaskPage = await send(base, { path: `/tasks/${ids.tasks[2]}` });
      assert.equal(completedTaskPage.status, 200);
      assert.ok(completedTaskPage.body.includes("done"));
      const alphaAfter = await send(base, { path: `/engagements/${alpha}` });
      assert.match(alphaAfter.body, new RegExp(`href="/tasks/${ids.tasks[2]}"`));

      // A client with no engagements shows meaningful empty states and offers
      // no creation shortcuts that would guess a parent.
      const emptyOverview = await send(base, { path: `/clients/${ids.emptyClient}` });
      assert.equal(emptyOverview.status, 200);
      assert.match(emptyOverview.body, /No engagements yet\./);
      assert.match(emptyOverview.body, /No projects yet\./);
      assert.match(currentTasks(emptyOverview.body), /No current tasks\./);
      assert.match(sectionOf(emptyOverview.body, "Next steps"), /No open follow-ups\./);
      assert.match(sectionOf(emptyOverview.body, "Next steps"), /No open commitments\./);
      assert.match(sectionOf(emptyOverview.body, "Next steps"), /No open waiting items\./);
      assert.match(sectionOf(emptyOverview.body, "Meeting history"), /No meetings recorded yet\./);
      assert.ok(!emptyOverview.body.includes("/engagements//"));
      // That client is not part of the first client's overview main content.
      assert.ok(!mainContentOf(overview.body).includes("Empty client"));

      // The state as it stands before the restart, after the accepted writes.
      beforeRestart = JSON.stringify(await observe(base, ids));
    } finally {
      await app.close();
    }

    // -- Restart: a fresh application and store over the same directory. ----
    app = await open(dir);
    try {
      // The data survived the restart unchanged: a fresh store opened over the
      // directory reads back the same record counts, record pages and linked
      // views as before the restart.
      assert.equal(JSON.stringify(await observe(app.url, ids)), beforeRestart);

      const clientId = ids.client;
      const overview = await send(app.url, { path: `/clients/${clientId}` });
      assert.equal(overview.status, 200);
      // The edited meeting values survived and appear in the client-wide and
      // the engagement histories.
      assert.ok(overview.body.includes(escapeHtml("2026-01-20 — Alpha kickoff (edited)")));
      // The engagement page keeps the edited meeting in its history, and the
      // completed task in its own task list, the closed blocker and the closed
      // project decision in its work-item lists: closed and completed work
      // stays reachable after the restart.
      const engagementPage = await send(app.url, { path: `/engagements/${ids.engagements[0]}` });
      assert.ok(sectionOf(engagementPage.body, "Meeting history").includes(escapeHtml("2026-01-20 — Alpha kickoff (edited)")));
      assert.match(engagementPage.body, new RegExp(`href="/tasks/${ids.tasks[2]}"`));
      assert.match(engagementPage.body, new RegExp(`href="/items/${ids.items[2]}"`));
      assert.match(engagementPage.body, new RegExp(`href="/items/${ids.items[6]}"`));
      assert.ok(sectionOf(engagementPage.body, "Meeting history").includes(escapeHtml(ids.probeTitle)));
      const probeDetail = await send(app.url, { path: `/meetings/${ids.probe}` });
      assert.equal(probeDetail.status, 200);
      assert.ok(probeDetail.body.includes(escapeHtml(ids.probeTitle)));
      const meetingDetail = await send(app.url, { path: `/meetings/${ids.meetings[0]}` });
      assert.equal(meetingDetail.status, 200);
      assert.ok(meetingDetail.body.includes(escapeHtml("Alpha kickoff (edited)")));
      assert.ok(meetingDetail.body.includes(escapeHtml("Edited & kept")));
      assert.ok(meetingDetail.body.includes("2026-01-20"));

      // The state changes (a closed decision, a closed blocker, a completed
      // task) survived.
      const closedDecisionPage = await send(app.url, { path: `/items/${ids.items[6]}` });
      assert.match(closedDecisionPage.body, /closed/);
      const closedBlocker = await send(app.url, { path: `/items/${ids.items[2]}` });
      assert.ok(closedBlocker.body.includes("closed"));
      const completedTask = await send(app.url, { path: `/tasks/${ids.tasks[2]}` });
      assert.ok(completedTask.body.includes("done"));

      // Counts after the restart: Alpha has 1 open, 1 in progress and 1 done
      // task, counted once each in their engagement's scope (the project task
      // is not also counted separately). The engagement-only lists carry the
      // completed task as well.
      const counts = sectionOf(overview.body, "Engagement counts");
      const alphaCounts = counts.slice(counts.indexOf(`href="/engagements/${ids.engagements[0]}"`), counts.indexOf(`href="/engagements/${ids.engagements[1]}"`));
      assert.equal(countFor(alphaCounts, "open"), 1);
      assert.equal(countFor(alphaCounts, "in_progress"), 1);
      assert.equal(countFor(alphaCounts, "done"), 1);
      assert.equal(
        countFor(alphaCounts, "open") + countFor(alphaCounts, "in_progress") + countFor(alphaCounts, "done"),
        3,
      );
      // Current tasks after the restart exclude the completed task.
      assert.deepEqual(
        [...currentTasks(overview.body).matchAll(/href="\/tasks\/([^"]+)"/g)].map((match) => match[1]),
        [ids.tasks[0], ids.tasks[1]],
      );
      const clientHistory = sectionOf(overview.body, "Meeting history");
      assert.equal(clientHistory.split(`href="/meetings/${ids.meetings[1]}"`).length - 1, 1);
      // The probe meeting created and edited by the positive control survived
      // the restart, with its edited title, in the client-wide history and on
      // its own detail page.
      assert.equal(clientHistory.split(`href="/meetings/${ids.probe}"`).length - 1, 1);
      assert.ok(clientHistory.includes(escapeHtml(ids.probeTitle)));
      // Next steps groups survive too.
      const nextSteps = sectionOf(overview.body, "Next steps");
      assert.match(nextStepGroup(nextSteps, "Open follow-ups", "Open commitments"), new RegExp(`href="/items/${ids.items[5]}"`));

      // The closed decision, a decision listed regardless of its state, is
      // still linked from the restarted overview, together with the open ones.
      const restartedDecisions = sectionOf(overview.body, "Decisions");
      assert.deepEqual(
        [...restartedDecisions.matchAll(/href="\/items\/([^"]+)"/g)].map((match) => match[1]),
        [ids.items[0], ids.items[6], ids.items[7]],
      );
      assert.match(restartedDecisions, /kind decision, closed/);
      // The completed and closed work is still reachable in the record lists.
      const restartedAlpha = await send(app.url, { path: `/engagements/${ids.engagements[0]}` });
      assert.match(restartedAlpha.body, new RegExp(`href="/tasks/${ids.tasks[2]}"`));
      assert.match(restartedAlpha.body, new RegExp(`href="/items/${ids.items[2]}"`));
      assert.match(restartedAlpha.body, new RegExp(`href="/items/${ids.items[6]}"`));

      // The sibling client is still isolated in the main content after restart,
      // while the global navigation still links to it.
      const restartedOverviewMain = mainContentOf(overview.body);
      for (const marker of ["Other client", "Other meeting"]) {
        assert.ok(!restartedOverviewMain.includes(marker), marker);
      }
      assert.ok(overview.body.includes(escapeHtml("Other client")));
      const otherOverview = await send(app.url, { path: `/clients/${ids.otherClient}` });
      assert.match(otherOverview.body, new RegExp(`href="/meetings/${ids.otherMeeting}"`));
      assert.ok(!otherOverview.body.includes("Alpha kickoff"));
      assert.ok(!otherOverview.body.includes(`href="/items/${ids.items[0]}"`));
    } finally {
      await app.close();
    }
  });
});
