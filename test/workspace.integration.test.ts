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

/** A section of a rendered page from its heading to its closing tag. */
function sectionOf(body: string, title: string): string {
  const start = body.indexOf(escapeHtml(title));
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

/** The count shown for a labelled tally row inside the given text. */
function countFor(text: string, label: string): number {
  const match = new RegExp(`<li>[^<]*(?:<a[^>]*>[^<]*</a>)?${label}: (\\d+)</li>`).exec(text);
  assert.ok(match !== null, `no count for ${label}`);
  return Number(match[1]);
}

// ---------------------------------------------------------------------------
// The workflow
// ---------------------------------------------------------------------------

describe("workspace integration: linked overview and restart", () => {
  it("runs a full profile-to-history workflow over loopback HTTP and survives a restart", async () => {
    const dir = tempDir();

    // -- Fresh application and store over the same temporary directory. -----
    let app = await open(dir);
    const base = app.url;
    const ids = {
      client: "",
      engagements: [] as string[],
      projects: [] as string[],
      tasks: [] as string[],
      items: [] as string[],
      meetings: [] as string[],
      otherClient: "",
      otherEngagement: "",
      otherProject: "",
      otherMeeting: "",
      otherTask: "",
      otherItem: "",
    };
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
      ids.tasks.push(await postTask(`/engagements/${alpha}/tasks/new`, {
        title: "Alpha engagement task", status: "open", priority: "high", owner: "Dana", dueDate: "2026-06-30", context: "no project",
      }));
      ids.tasks.push(await postTask(`/projects/${alphaProject}/tasks/new`, {
        title: "Alpha project task", status: "in_progress", priority: "normal", owner: "Lee", dueDate: "", context: "project work",
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
      // A closed decision in the alpha project, and one item per kind in beta.
      ids.items.push(await postItem(`/projects/${alphaProject}/items/new`, {
        kind: "decision", title: "Alpha closed decision", context: "decided", state: "open",
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

      // -- State changes: close a blocker, complete a task, edit a meeting. --
      const closeItem = parseForm((await send(base, { path: `/items/${ids.items[2]}/edit` })).body);
      assert.equal(closeItem.controls.get("kind"), "blocker");
      closeItem.controls.set("state", "closed");
      const closed = await send(base, { method: "POST", path: closeItem.action, form: Object.fromEntries(closeItem.controls) });
      assert.equal(redirectTarget(closed), `/items/${ids.items[2]}`);

      const completeTask = parseForm((await send(base, { path: `/tasks/${ids.tasks[0]}/edit` })).body);
      completeTask.controls.set("status", "done");
      const completed = await send(base, { method: "POST", path: completeTask.action, form: Object.fromEntries(completeTask.controls) });
      assert.equal(redirectTarget(completed), `/tasks/${ids.tasks[0]}`);

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

      // -- Rejected hostile requests leave the data unchanged. ---------------
      // The application holds the store's writer lock, so the snapshot is read
      // through the application's own route: the home page reports the exact
      // record counts the store holds.
      beforeRestart = JSON.stringify(recordCounts(await send(base, { path: "/" })));
      const hostile: Array<[string, Record<string, string>]> = [
        // A tampered cross-engagement project on a meeting create.
        [`/engagements/${alpha}/meetings/new`, { title: "Hijack", date: "2026-01-01", notes: "", projectId: betaProject }],
        // A tampered parent id: the URL parent wins, but an invalid date refuses.
        [`/engagements/${alpha}/meetings/new`, { engagementId: beta, clientId: ids.otherClient, title: "Bad date", date: "2023-02-29", notes: "" }],
        // A tampered project on a task create.
        [`/engagements/${alpha}/tasks/new`, { title: "Hijack task", status: "open", priority: "high", owner: "", dueDate: "", context: "", projectId: betaProject }],
        // A cross-engagement project on a meeting edit.
        [`/meetings/${alphaProjectMeeting}/edit`, { id: alphaProjectMeeting, title: "Moved", date: "2026-05-05", notes: "", projectId: betaProject }],
        // A blank title on a meeting create.
        [`/engagements/${alpha}/meetings/new`, { title: " ", date: "2026-05-05", notes: "" }],
      ];
      for (const [path, form] of hostile) {
        const reply = await send(base, { method: "POST", path, form });
        assert.equal(reply.status, 400, `${path} ${JSON.stringify(form)}`);
        assert.match(String(reply.headers["content-type"]), /^text\/html/);
        assert.match(reply.body, /role="alert"/);
        assert.equal(
          JSON.stringify(recordCounts(await send(base, { path: "/" }))),
          beforeRestart,
          `${path} must not mutate`,
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
      assert.equal(JSON.stringify(recordCounts(await send(base, { path: "/" }))), beforeRestart);

      // -- The client overview. ----------------------------------------------
      const overview = await send(base, { path: `/clients/${ids.client}` });
      assert.equal(overview.status, 200);
      // Profile, engagements/statuses/projects, each linked.
      assert.ok(overview.body.includes(escapeHtml("Acme <Ltd>")));
      assert.match(overview.body, new RegExp(`href="/engagements/${alpha}"`));
      assert.match(overview.body, new RegExp(`href="/engagements/${beta}"`));
      assert.match(overview.body, /<a href="\/engagements\/[^"]+">Alpha<\/a> \(active\)/);
      assert.match(overview.body, /<a href="\/engagements\/[^"]+">Beta<\/a> \(on_hold\)/);
      assert.match(overview.body, new RegExp(`href="/projects/${alphaProject}"`));
      assert.match(overview.body, new RegExp(`href="/projects/${betaProject}"`));

      // Current tasks: the open and in-progress tasks, not closed ones.
      const current = sectionOf(overview.body, "Current tasks");
      assert.match(current, new RegExp(`href="/tasks/${ids.tasks[1]}"`)); // in progress
      assert.ok(!current.includes(`href="/tasks/${ids.tasks[0]}"`)); // completed
      assert.ok(!current.includes(`href="/tasks/${ids.tasks[2]}"`)); // done
      assert.ok(!current.includes("Beta done task"));

      // Open blockers and questions; the closed blocker is gone from them.
      const blockers = sectionOf(overview.body, "Open blockers");
      assert.ok(!blockers.includes(`href="/items/${ids.items[2]}"`));
      const questions = sectionOf(overview.body, "Open questions");
      assert.match(questions, new RegExp(`href="/items/${ids.items[1]}"`));

      // Decisions include the closed project decision (still reachable).
      const decisions = sectionOf(overview.body, "Decisions");
      assert.match(decisions, new RegExp(`href="/items/${ids.items[0]}"`));
      assert.match(decisions, new RegExp(`href="/items/${ids.items[6]}"`));

      // Next steps: open follow-ups, commitments and waiting items, linked.
      const nextSteps = sectionOf(overview.body, "Next steps");
      assert.match(nextSteps, new RegExp(`href="/items/${ids.items[3]}"`)); // commitment
      assert.match(nextSteps, new RegExp(`href="/items/${ids.items[4]}"`)); // waiting
      assert.match(nextSteps, new RegExp(`href="/items/${ids.items[5]}"`)); // follow-up

      // Derived engagement counts. Alpha tasks: the engagement task (now done)
      // and the project task (in progress) = 1 done, 1 in progress, 0 open; the
      // closed and completed work still counts once each, never twice.
      const counts = sectionOf(overview.body, "Engagement counts");
      const alphaCounts = counts.slice(counts.indexOf(`href="/engagements/${alpha}"`), counts.indexOf(`href="/engagements/${beta}"`));
      assert.equal(countFor(alphaCounts, "open"), 0);
      assert.equal(countFor(alphaCounts, "in_progress"), 1);
      assert.equal(countFor(alphaCounts, "done"), 1);
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

      // The sibling client's records never leak into this overview.
      for (const marker of ["Other client", "Other engagement", "Other project", "Other task", "Other follow-up", "Other meeting"]) {
        assert.ok(!overview.body.includes(marker), marker);
      }
      assert.ok(!overview.body.includes(`href="/meetings/${ids.otherMeeting}"`));
      assert.ok(!overview.body.includes(`href="/items/${ids.otherItem}"`));

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
      assert.match(alphaRecord.body, new RegExp(`href="/items/${ids.items[2]}"`));
      const betaRecord = await send(base, { path: `/engagements/${beta}` });
      assert.match(betaRecord.body, new RegExp(`href="/tasks/${ids.tasks[2]}"`));
      // Every listed record links somewhere reachable.
      const closedBlocker = await send(base, { path: `/items/${ids.items[2]}` });
      assert.equal(closedBlocker.status, 200);
      assert.ok(closedBlocker.body.includes("closed"));
    } finally {
      await app.close();
    }

    // -- Restart: a fresh application and store over the same directory. ----
    app = await open(dir);
    try {
      // The data survived the restart unchanged: the home page counts match and
      // a fresh store opened over the directory reads back the same records.
      assert.equal(JSON.stringify(recordCounts(await send(app.url, { path: "/" }))), beforeRestart);

      const clientId = ids.client;
      const overview = await send(app.url, { path: `/clients/${clientId}` });
      assert.equal(overview.status, 200);
      // The edited meeting values survived and appear in both histories.
      assert.ok(overview.body.includes(escapeHtml("2026-01-20 — Alpha kickoff (edited)")));
      const engagementPage = await send(app.url, { path: `/engagements/${ids.engagements[0]}` });
      assert.ok(sectionOf(engagementPage.body, "Meeting history").includes(escapeHtml("2026-01-20 — Alpha kickoff (edited)")));
      const meetingDetail = await send(app.url, { path: `/meetings/${ids.meetings[0]}` });
      assert.equal(meetingDetail.status, 200);
      assert.ok(meetingDetail.body.includes(escapeHtml("Alpha kickoff (edited)")));
      assert.ok(meetingDetail.body.includes(escapeHtml("Edited & kept")));
      // The state changes survived too.
      assert.ok(meetingDetail.body.includes("2026-01-20"));
      const closedBlocker = await send(app.url, { path: `/items/${ids.items[2]}` });
      assert.ok(closedBlocker.body.includes("closed"));
      const completedTask = await send(app.url, { path: `/tasks/${ids.tasks[0]}` });
      assert.ok(completedTask.body.includes("done"));

      // Histories and counts after restart match those before.
      const counts = sectionOf(overview.body, "Engagement counts");
      const alphaCounts = counts.slice(counts.indexOf(`href="/engagements/${ids.engagements[0]}"`), counts.indexOf(`href="/engagements/${ids.engagements[1]}"`));
      assert.equal(countFor(alphaCounts, "done"), 1);
      assert.equal(countFor(alphaCounts, "in_progress"), 1);
      const clientHistory = sectionOf(overview.body, "Meeting history");
      assert.equal(clientHistory.split(`href="/meetings/${ids.meetings[1]}"`).length - 1, 1);

      // The sibling client is still isolated after restart.
      for (const marker of ["Other client", "Other meeting"]) {
        assert.ok(!overview.body.includes(marker), marker);
      }
      const otherOverview = await send(app.url, { path: `/clients/${ids.otherClient}` });
      assert.match(otherOverview.body, new RegExp(`href="/meetings/${ids.otherMeeting}"`));
      assert.ok(!otherOverview.body.includes("Alpha kickoff"));
    } finally {
      await app.close();
    }
  });
});
