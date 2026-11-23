/**
 * Board pages and movement: the protected board views and the exact
 * `POST /tasks/:id/move` endpoint, exercised through the registered HTTP
 * routes against a real on-disk store over loopback.
 *
 * The suite follows the scope links all → client → engagement → project → all,
 * submits the rendered movement controls, checks the four columns (with their
 * explicit empty states and text-plus-class labels), escaping, scope-preserving
 * redirects and a restart, and covers the refusals: a correctable invalid
 * status, an invalid scope or a conflicting identity/scope assertion without a
 * write, a stale archived-scope submission, missing records, guard refusals and
 * a generic save-failure 500 with no success redirect. A save failure is
 * injected through the store's own file-system adapter, never by mocking a
 * module or changing the environment.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { escapeHtml } from "../src/html.ts";
import { registerRoutes } from "../src/index.ts";
import {
  BOARD_STYLE,
  boardPath,
  kanbanRoutes,
  matchKanbanPath,
  renderBoard,
  routeForKanbanPattern,
} from "../src/kanban-pages.ts";
import { startServer } from "../src/server.ts";
import { openStore, type FileSystem, type Store } from "../src/store.ts";

// ---------------------------------------------------------------------------
// Fixtures and HTTP helpers
// ---------------------------------------------------------------------------

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kanban-pages-"));
  roots.push(dir);
  return dir;
}

interface Running {
  readonly origin: string;
  readonly store: Store;
  close(): Promise<void>;
}

/** Start a server over a real on-disk store, on an ephemeral port. */
async function running(directory = tempDir()): Promise<Running> {
  const store = await openStore(directory);
  const server = await startServer({ store, port: 0, routes: registerRoutes(store) });
  return {
    origin: server.origin,
    store,
    async close() {
      await server.close();
      await store.close();
    },
  };
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
  readonly host?: string;
  readonly contentType?: string;
  readonly form?: Record<string, string>;
}

/** Send a request to the running server over loopback HTTP. */
function send(base: string, options: RequestOptions = {}): Promise<Reply> {
  const url = new URL(base);
  const method = options.method ?? "GET";
  const body = options.form === undefined ? "" : new URLSearchParams(options.form).toString();
  // The canonical Host authority is set explicitly, so the same request is
  // sent on every platform.
  const headers: Record<string, string | number> = {
    host: options.host ?? url.host,
    "content-length": Buffer.byteLength(body),
  };
  if (method === "POST") {
    headers["content-type"] = options.contentType ?? "application/x-www-form-urlencoded";
    headers.origin = options.origin ?? base;
  } else if (options.origin !== undefined) {
    headers.origin = options.origin;
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

/** Follow one redirect from the reply, returning the target's path. */
function redirectTarget(reply: Reply): string {
  assert.equal(reply.status, 303);
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

/** The markup of one board column, from its heading to the column's end. */
function columnOf(body: string, heading: string): string {
  const start = body.indexOf(`<h2>${escapeHtml(heading)}</h2>`);
  if (start < 0) return "";
  const end = body.indexOf("</section>", start);
  return body.slice(start, end < 0 ? undefined : end);
}

/** The task ids linked from inside one board column body. */
function columnTaskIds(column: string): string[] {
  return [...column.matchAll(/href="\/tasks\/([^"/]+)"(?![^>]*\/edit)/g)].map((match) => match[1]);
}

/**
 * A full hierarchy: a client with an engagement and a project, plus another
 * client whose engagement and project stay empty, so sibling isolation is
 * observable.
 */
async function hierarchy(store: Store) {
  const client = await store.createClient({ name: "Acme <client>" });
  const otherClient = await store.createClient({ name: "Other" });
  const engagement = await store.createEngagement({ clientId: client.id, name: "Delivery" });
  const sibling = await store.createEngagement({ clientId: client.id, name: "Sibling" });
  const project = await store.createProject({ engagementId: engagement.id, name: "Project <one>" });
  const secondProject = await store.createProject({ engagementId: engagement.id, name: "Second" });
  return { client, otherClient, engagement, sibling, project, secondProject };
}

// ---------------------------------------------------------------------------
// Path matching and pure helpers
// ---------------------------------------------------------------------------

describe("board paths", () => {
  it("matches the fixed board patterns and refuses everything else", () => {
    assert.deepEqual(matchKanbanPath("/kanban"), { pattern: "/kanban", id: "" });
    assert.deepEqual(matchKanbanPath("/clients/client-1/kanban"), { pattern: "/clients/:id/kanban", id: "client-1" });
    assert.deepEqual(matchKanbanPath("/engagements/e-1/kanban"), { pattern: "/engagements/:id/kanban", id: "e-1" });
    assert.deepEqual(matchKanbanPath("/projects/p-1/kanban"), { pattern: "/projects/:id/kanban", id: "p-1" });
    assert.deepEqual(matchKanbanPath("/tasks/t-1/move"), { pattern: "/tasks/:id/move", id: "t-1" });
    // The query string is not part of the match.
    assert.deepEqual(matchKanbanPath("/kanban?x=1"), { pattern: "/kanban", id: "" });
    for (const path of [
      "/kanban/",
      "/clients/new/kanban",
      "/clients//kanban",
      "/clients/kanban",
      "/tasks/new/move",
      "/tasks/t-1/edit",
      "/tasks/t-1/move/extra",
      "/items/t-1/move",
      "/meetings/t-1/move",
      "/projects/p-1/board",
    ]) {
      assert.equal(matchKanbanPath(path), null, path);
    }
  });

  it("builds the server path of each validated scope", () => {
    assert.equal(boardPath({ kind: "all" }), "/kanban");
    assert.equal(boardPath({ kind: "client", id: "client 1/a" }), "/clients/client%201%2Fa/kanban");
    assert.equal(boardPath({ kind: "engagement", id: "e-1" }), "/engagements/e-1/kanban");
    assert.equal(boardPath({ kind: "project", id: "p-1" }), "/projects/p-1/kanban");
  });

  it("reflows the columns and keeps the action buttons visible at every width", () => {
    // The four-column grid collapses to two and then one column on narrow
    // screens, and every move button stays full width, never hidden.
    assert.match(BOARD_STYLE, /\.board\{[^}]*grid-template-columns:repeat\(4,/);
    assert.match(BOARD_STYLE, /@media \(max-width:1000px\)\{\.board\{grid-template-columns:repeat\(2,/);
    assert.match(BOARD_STYLE, /@media \(max-width:560px\)\{\.board\{grid-template-columns:minmax\(0,1fr\)\}\}/);
    assert.match(BOARD_STYLE, /\.move-form button\{[^}]*width:100%/);
    assert.doesNotMatch(BOARD_STYLE, /display:none/);
  });

  it("renders the four columns, labels and explicit empties for an empty workspace", () => {
    const page = renderBoard(
      { clients: [], engagements: [], projects: [], tasks: [], items: [], meetings: [] },
      { kind: "all" },
    );
    // Each column shows its text label plus its class, so status is readable
    // without relying on colour alone.
    for (const [heading, className, empty] of [
      ["Actionable: open", "column-open", "No actionable tasks."],
      ["Actionable: in progress", "column-in_progress", "No actionable tasks."],
      ["Waiting: waiting", "column-waiting", "No waiting tasks."],
      ["Completed: done", "column-done", "No completed tasks."],
    ] as const) {
      assert.ok(page.html.includes(`<h2>${heading}</h2>`), heading);
      assert.ok(page.html.includes(`class="board-column ${className}"`), className);
      const column = columnOf(page.html, heading);
      assert.match(column, new RegExp(escapeHtml(empty)));
    }
    // The scope navigation is present even with no records.
    assert.match(page.html, /aria-label="Board scopes"/);
    assert.match(page.html, /<a href="\/kanban" aria-current="page">All work<\/a>/);
  });
});

// ---------------------------------------------------------------------------
// HTTP: navigating and moving
// ---------------------------------------------------------------------------

describe("board pages over HTTP", () => {
  it("shows linked cards with their fields and every scope link", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const base = { clientId: h.client.id, engagementId: h.engagement.id };
      const open = await server.store.createTask({
        ...base,
        title: "Open <task>",
        priority: "high",
        owner: "Ada",
        dueDate: "2026-06-30",
      });
      const waiting = await server.store.createTask({ ...base, title: "Waiting task", status: "waiting", owner: "" });
      const done = await server.store.createTask({
        ...base,
        projectId: h.project.id,
        title: "Done task",
        status: "done",
      });
      const inProgress = await server.store.createTask({ ...base, title: "Progress", status: "in_progress" });

      const reply = await send(server.origin, { path: "/kanban" });
      assert.equal(reply.status, 200);
      assert.match(String(reply.headers["content-type"]), /^text\/html; charset=utf-8/);
      assert.equal(reply.headers["cache-control"], "no-store");
      assert.match(String(reply.headers["content-security-policy"]), /default-src 'none'/);
      // The board's responsive stylesheet is inline (the CSP forbids external
      // assets) and reflows the columns without hiding any action.
      assert.ok(reply.body.includes(BOARD_STYLE));
      assert.match(reply.body, /@media \(max-width:560px\)\{\.board\{grid-template-columns:minmax\(0,1fr\)\}\}/);
      assert.ok(!reply.body.includes("<script"));

      // Each task is in exactly one column, linked from its title.
      assert.deepEqual(columnTaskIds(columnOf(reply.body, "Actionable: open")), [open.id]);
      assert.deepEqual(columnTaskIds(columnOf(reply.body, "Actionable: in progress")), [inProgress.id]);
      assert.deepEqual(columnTaskIds(columnOf(reply.body, "Waiting: waiting")), [waiting.id]);
      assert.deepEqual(columnTaskIds(columnOf(reply.body, "Completed: done")), [done.id]);

      // The open card shows title, status, priority, owner, due date and the
      // actual client, engagement and no project, all escaped.
      const openColumn = columnOf(reply.body, "Actionable: open");
      assert.ok(openColumn.includes(escapeHtml("Open <task>")));
      assert.ok(!openColumn.includes("<task>"));
      assert.match(openColumn, /<span class="badge">open<\/span>/);
      assert.match(openColumn, /<span class="badge">high<\/span>/);
      assert.match(openColumn, /<dt>Owner<\/dt><dd>Ada<\/dd>/);
      assert.match(openColumn, /<dt>Due date<\/dt><dd>2026-06-30<\/dd>/);
      assert.match(openColumn, new RegExp(`<dt>Client</dt><dd><a href="/clients/${h.client.id}">Acme &lt;client&gt;</a></dd>`));
      assert.match(openColumn, new RegExp(`<dt>Engagement</dt><dd><a href="/engagements/${h.engagement.id}">Delivery</a></dd>`));
      assert.match(openColumn, /<dt>Project<\/dt><dd><em>\(no project\)<\/em><\/dd>/);
      // The waiting task shows an explicit blank owner.
      assert.match(columnOf(reply.body, "Waiting: waiting"), /<dt>Owner<\/dt><dd><em>\(none\)<\/em><\/dd>/);
      // The project task names its actual project.
      assert.match(columnOf(reply.body, "Completed: done"), new RegExp(`href="/projects/${h.project.id}">Project &lt;one&gt;</a>`));

      // The move forms post to each task's own endpoint with the validated scope
      // and current identity as assertions.
      const moveForm = /<form class="move-form" method="post" action="\/tasks\/[^"]+\/move">([\s\S]*?)<button/.exec(openColumn);
      assert.ok(moveForm !== null);
      const form = parseForm(openColumn);
      assert.equal(form.action, `/tasks/${open.id}/move`);
      assert.equal(form.controls.get("status"), "open");
      assert.equal(form.controls.get("scopeKind"), "all");
      assert.equal(form.controls.get("scopeId"), "");
      assert.equal(form.controls.get("id"), open.id);
      assert.equal(form.controls.get("clientId"), h.client.id);
      assert.equal(form.controls.get("engagementId"), h.engagement.id);
      assert.equal(form.controls.get("projectId"), "");
      // The button is a native submit control with a text label.
      assert.match(openColumn, /<button type="submit">Move to Actionable \(open\)<\/button>/);

      // The scope navigation offers all → client → engagement → project.
      assert.match(reply.body, /<a href="\/clients\/[^"]+\/kanban">Acme &lt;client&gt;<\/a>/);
      assert.match(reply.body, /<a href="\/engagements\/[^"]+\/kanban">Delivery<\/a>/);
      assert.match(reply.body, new RegExp(`<a href="/projects/${h.project.id}/kanban">Project &lt;one&gt; \\(Delivery\\)</a>`));
      assert.match(reply.body, /<a href="\/clients\/[^"]+\/kanban">Other<\/a>/);
    } finally {
      await server.close();
    }
  });

  it("follows the scope links all → client → engagement → project → all", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const base = { clientId: h.client.id, engagementId: h.engagement.id };
      const engagementOnly = await server.store.createTask({ ...base, title: "Engagement-only task" });
      const projectTask = await server.store.createTask({ ...base, projectId: h.project.id, title: "Project task" });
      const siblingTask = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.sibling.id,
        title: "Sibling task",
      });

      // From the whole board a test follows a rendered scope link, never a
      // guessed path: read the client link's href and request it.
      const all = await send(server.origin, { path: "/kanban" });
      const clientHref = new RegExp(`href="(/clients/${h.client.id}/kanban)"`).exec(all.body)?.[1];
      assert.ok(clientHref !== undefined);
      const clientBoard = await send(server.origin, { path: clientHref });
      assert.equal(clientBoard.status, 200);
      assert.ok(clientBoard.body.includes("<h1>Acme &lt;client&gt; board</h1>"));
      // A client board includes all its engagements' work.
      assert.deepEqual(
        columnTaskIds(clientBoard.body).sort(),
        [engagementOnly.id, projectTask.id, siblingTask.id].sort(),
      );

      const engagementHref = new RegExp(`href="(/engagements/${h.engagement.id}/kanban)"`).exec(clientBoard.body)?.[1];
      assert.ok(engagementHref !== undefined);
      const engagementBoard = await send(server.origin, { path: engagementHref });
      assert.equal(engagementBoard.status, 200);
      assert.ok(engagementBoard.body.includes("<h1>Delivery board</h1>"));
      // An engagement board includes engagement-only and project work, but no
      // sibling engagement's work.
      assert.deepEqual(
        columnTaskIds(engagementBoard.body).sort(),
        [engagementOnly.id, projectTask.id].sort(),
      );
      assert.ok(!engagementBoard.body.includes("Sibling task"));

      const projectHref = new RegExp(`href="(/projects/${h.project.id}/kanban)"`).exec(engagementBoard.body)?.[1];
      assert.ok(projectHref !== undefined);
      const projectBoard = await send(server.origin, { path: projectHref });
      assert.equal(projectBoard.status, 200);
      assert.ok(projectBoard.body.includes("<h1>Project &lt;one&gt; board</h1>"));
      // A project board includes only the project's own tasks.
      assert.deepEqual(columnTaskIds(projectBoard.body), [projectTask.id]);
      assert.ok(!projectBoard.body.includes("Engagement-only task"));

      // Every board's scope navigation links back to the whole board.
      const backHref = new RegExp(`href="(/kanban)"`).exec(projectBoard.body)?.[1];
      assert.equal(backHref, "/kanban");
      const back = await send(server.origin, { path: backHref as string });
      assert.equal(back.status, 200);
      assert.deepEqual(
        columnTaskIds(back.body).sort(),
        [engagementOnly.id, projectTask.id, siblingTask.id].sort(),
      );
    } finally {
      await server.close();
    }
  });

  it("moves a card through the rendered controls and redirects to the validated scope", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const task = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Move me",
        status: "open",
      });
      const board = await send(server.origin, { path: "/kanban" });
      const form = parseForm(columnOf(board.body, "Actionable: open"));
      form.controls.set("status", "in_progress");
      // A stray field is ignored: it is never an edit.
      const reply = await send(server.origin, {
        method: "POST",
        path: form.action,
        form: { ...Object.fromEntries(form.controls), title: "Edited title", owner: "Mallory" },
      });
      assert.equal(reply.status, 303);
      assert.equal(redirectTarget(reply), "/kanban");
      const stored = server.store.snapshot().tasks.find((candidate) => candidate.id === task.id)!;
      assert.equal(stored.status, "in_progress");
      // The other fields were not edited.
      assert.equal(stored.title, "Move me");
      assert.equal(stored.owner, "");
      // The in-progress column now holds the task.
      const after = await send(server.origin, { path: "/kanban" });
      assert.deepEqual(columnTaskIds(columnOf(after.body, "Actionable: in progress")), [task.id]);
      assert.deepEqual(columnTaskIds(columnOf(after.body, "Actionable: open")), []);
    } finally {
      await server.close();
    }
  });

  it("preserves the narrowed scope in the redirect and the board", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const task = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: h.project.id,
        title: "Project task",
      });
      const board = await send(server.origin, { path: `/projects/${h.project.id}/kanban` });
      const form = parseForm(columnOf(board.body, "Actionable: open"));
      assert.equal(form.controls.get("scopeKind"), "project");
      assert.equal(form.controls.get("scopeId"), h.project.id);
      form.controls.set("status", "done");
      const reply = await send(server.origin, {
        method: "POST",
        path: form.action,
        form: Object.fromEntries(form.controls),
      });
      assert.equal(reply.status, 303);
      assert.equal(redirectTarget(reply), `/projects/${h.project.id}/kanban`);
      const after = await send(server.origin, { path: redirectTarget(reply) });
      assert.deepEqual(columnTaskIds(columnOf(after.body, "Completed: done")), [task.id]);
    } finally {
      await server.close();
    }
  });

  it("refuses a submitted return URL and redirects only to the server-built scope", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const task = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "No return URL",
      });
      const reply = await send(server.origin, {
        method: "POST",
        path: `/tasks/${task.id}/move`,
        form: {
          status: "done",
          scopeKind: "client",
          scopeId: h.client.id,
          id: task.id,
          returnUrl: "https://evil.example/",
          next: "//evil.example",
        },
      });
      assert.equal(reply.status, 303);
      assert.equal(redirectTarget(reply), `/clients/${h.client.id}/kanban`);
    } finally {
      await server.close();
    }
  });

  it("keeps the board working across a restart", async () => {
    const dir = tempDir();
    const first = await running(dir);
    let taskId: string;
    try {
      const h = await hierarchy(first.store);
      taskId = (await first.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Survives",
        status: "waiting",
      })).id;
      const board = await send(first.origin, { path: "/kanban" });
      assert.deepEqual(columnTaskIds(columnOf(board.body, "Waiting: waiting")), [taskId]);
    } finally {
      await first.close();
    }
    const second = await running(dir);
    try {
      const board = await send(second.origin, { path: "/kanban" });
      assert.equal(board.status, 200);
      assert.deepEqual(columnTaskIds(columnOf(board.body, "Waiting: waiting")), [taskId]);
    } finally {
      await second.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("board movement refusals", () => {
  it("returns a correctable invalid-status FormError retaining status and scope", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const task = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Status test",
        status: "open",
      });
      const before = JSON.stringify(server.store.snapshot());
      const reply = await send(server.origin, {
        method: "POST",
        path: `/tasks/${task.id}/move`,
        form: {
          status: "paused",
          scopeKind: "engagement",
          scopeId: h.engagement.id,
          id: task.id,
          clientId: h.client.id,
          engagementId: h.engagement.id,
          projectId: "",
        },
      });
      assert.equal(reply.status, 400);
      assert.equal(reply.headers["cache-control"], "no-store");
      assert.match(reply.body, /role="alert"/);
      assert.match(reply.body, /task\.status must be one of open, in_progress, waiting, done/);
      // The submitted status and the validated scope are kept on the form.
      assert.match(reply.body, /<option value="paused" selected>paused \(not a valid choice\)<\/option>/);
      const form = parseForm(reply.body);
      assert.equal(form.action, `/tasks/${task.id}/move`);
      assert.equal(form.controls.get("status"), "paused");
      assert.equal(form.controls.get("scopeKind"), "engagement");
      assert.equal(form.controls.get("scopeId"), h.engagement.id);
      // The status select is the one marked control.
      assert.equal((reply.body.match(/aria-invalid="true"/g) ?? []).length, 1);
      assert.match(reply.body, /<select[^>]*\sid="field-status"[^>]*\saria-invalid="true"/);
      // Nothing was written.
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // A corrected resubmission of the kept form saves and redirects to the
      // retained scope.
      form.controls.set("status", "waiting");
      const corrected = await send(server.origin, {
        method: "POST",
        path: form.action,
        form: Object.fromEntries(form.controls),
      });
      assert.equal(corrected.status, 303);
      assert.equal(redirectTarget(corrected), `/engagements/${h.engagement.id}/kanban`);
      assert.equal(server.store.snapshot().tasks.find((c) => c.id === task.id)!.status, "waiting");
    } finally {
      await server.close();
    }
  });

  it("refuses an invalid scope with 400 and no write", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const task = await server.store.createTask({ clientId: h.client.id, engagementId: h.engagement.id, title: "T" });
      const before = JSON.stringify(server.store.snapshot());
      for (const form of [
        { status: "done", scopeKind: "team", scopeId: "" },
        { status: "done", scopeKind: "all", scopeId: h.client.id },
        { status: "done", scopeKind: "client", scopeId: "" },
        { status: "done", scopeKind: "client", scopeId: "client-999" },
        { status: "done", scopeKind: "engagement", scopeId: "engagement-999" },
        { status: "done", scopeKind: "project", scopeId: "project-999" },
        { status: "done", scopeKind: "", scopeId: "" },
      ]) {
        const reply = await send(server.origin, {
          method: "POST",
          path: `/tasks/${task.id}/move`,
          form: { ...form, id: task.id },
        });
        assert.equal(reply.status, 400, JSON.stringify(form));
        // A plain-text refusal, not a success redirect.
        assert.equal(reply.headers.location, undefined, JSON.stringify(form));
      }
      assert.equal(JSON.stringify(server.store.snapshot()), before);
    } finally {
      await server.close();
    }
  });

  it("refuses conflicting identity or scope assertions with 400 and no write", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const task = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: h.project.id,
        title: "Assert",
      });
      const before = JSON.stringify(server.store.snapshot());
      const cases: Record<string, string>[] = [
        { id: "task-999" },
        { clientId: h.otherClient.id },
        { engagementId: h.sibling.id },
        { projectId: h.secondProject.id },
        { projectId: "" },
      ];
      for (const extra of cases) {
        const reply = await send(server.origin, {
          method: "POST",
          path: `/tasks/${task.id}/move`,
          form: { status: "done", scopeKind: "all", scopeId: "", ...extra },
        });
        assert.equal(reply.status, 400, JSON.stringify(extra));
        assert.equal(reply.headers.location, undefined, JSON.stringify(extra));
      }
      // The task is outside a sibling project's scope: refused.
      const outside = await send(server.origin, {
        method: "POST",
        path: `/tasks/${task.id}/move`,
        form: { status: "done", scopeKind: "project", scopeId: h.secondProject.id },
      });
      assert.equal(outside.status, 400);
      assert.equal(JSON.stringify(server.store.snapshot()), before);
    } finally {
      await server.close();
    }
  });

  it("refuses a malformed or unknown URL id as 404", async () => {
    const server = await running();
    try {
      await hierarchy(server.store);
      const before = JSON.stringify(server.store.snapshot());
      for (const path of [
        "/clients/client-999/kanban",
        "/engagements/engagement-999/kanban",
        "/projects/project-999/kanban",
        "/clients/%E0%A4%A/kanban",
        "/engagements/%ZZ/kanban",
      ]) {
        const reply = await send(server.origin, { path });
        assert.equal(reply.status, 404, path);
      }
      for (const path of ["/tasks/task-999/move", "/tasks/%E0%A4%A/move"]) {
        const reply = await send(server.origin, {
          method: "POST",
          path,
          form: { status: "done", scopeKind: "all", scopeId: "" },
        });
        assert.equal(reply.status, 404, path);
      }
      assert.equal(JSON.stringify(server.store.snapshot()), before);
    } finally {
      await server.close();
    }
  });

  it("keeps guard refusals before any handler runs", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const task = await server.store.createTask({ clientId: h.client.id, engagementId: h.engagement.id, title: "Guarded" });
      const before = JSON.stringify(server.store.snapshot());
      // Wrong methods: board pages are GET-only, movement is POST-only.
      assert.equal((await send(server.origin, { method: "POST", path: "/kanban", form: {} })).status, 405);
      assert.equal((await send(server.origin, { method: "POST", path: `/clients/${h.client.id}/kanban`, form: {} })).status, 405);
      assert.equal((await send(server.origin, { path: `/tasks/${task.id}/move` })).status, 405);
      // A foreign Origin is refused (403) before any handler runs.
      const foreign = await send(server.origin, {
        method: "POST",
        path: `/tasks/${task.id}/move`,
        origin: "https://evil.example",
        form: { status: "done", scopeKind: "all", scopeId: "" },
      });
      assert.equal(foreign.status, 403);
      // A foreign Host is refused.
      assert.equal((await send(server.origin, { path: "/kanban", host: "evil.example" })).status, 403);
      // An unsupported content type is refused.
      const wrongType = await send(server.origin, {
        method: "POST",
        path: `/tasks/${task.id}/move`,
        contentType: "application/json",
        form: { status: "done", scopeKind: "all", scopeId: "" },
      });
      assert.equal(wrongType.status, 415);
      // An oversized body is refused.
      const huge = await send(server.origin, {
        method: "POST",
        path: `/tasks/${task.id}/move`,
        form: { status: "done", scopeKind: "all", scopeId: "", padding: "x".repeat(20 * 1024) },
      });
      assert.equal(huge.status, 413);
      assert.equal(JSON.stringify(server.store.snapshot()), before);
    } finally {
      await server.close();
    }
  });

  it("returns a generic 500 on save failure with no success redirect", async () => {
    const dir = tempDir();
    const setup = await openStore(dir);
    let taskId: string;
    try {
      const h = await hierarchy(setup);
      taskId = (await setup.createTask({ clientId: h.client.id, engagementId: h.engagement.id, title: "Fragile" })).id;
    } finally {
      await setup.close();
    }
    const failingRename: Partial<FileSystem> = {
      renameSync: () => {
        const error = new Error("rename refused") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      },
    };
    const store = await openStore(dir, { fs: failingRename });
    const server = await startServer({ store, port: 0, routes: registerRoutes(store) });
    try {
      const reply = await send(server.origin, {
        method: "POST",
        path: `/tasks/${taskId}/move`,
        form: { status: "done", scopeKind: "all", scopeId: "" },
      });
      assert.equal(reply.status, 500);
      assert.equal(reply.headers.location, undefined, "no success redirect");
      assert.ok(!reply.body.includes("rename refused"), "the 500 is generic");
      // The committed memory still shows the task open: the failed save never
      // published the new status.
      assert.equal(store.snapshot().tasks.find((task) => task.id === taskId)!.status, "open");
    } finally {
      await server.close();
      await store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Archives and stale submissions
// ---------------------------------------------------------------------------

describe("board archives", () => {
  it("keeps an archived scope's board usable with a notice and an empty board", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const task = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: h.project.id,
        title: "Hidden",
      });
      await server.store.setArchived("project", h.project.id, true);
      const reply = await send(server.origin, { path: `/projects/${h.project.id}/kanban` });
      assert.equal(reply.status, 200);
      assert.ok(reply.body.includes("This record is archived"), "archive notice shown");
      assert.ok(reply.body.includes("stays editable"));
      // The board is empty: the archived task is hidden with its scope.
      assert.deepEqual(columnTaskIds(reply.body), []);
      // The archived project is left out of the scope navigation, but the
      // project's own board URL stays reachable.
      assert.doesNotMatch(reply.body, new RegExp(`href="/projects/${h.project.id}/kanban"`));
      assert.equal(task.status, "open");
    } finally {
      await server.close();
    }
  });

  it("moves an archived task from a stale submission while the redirected board hides it", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const task = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Archived task",
        status: "open",
      });
      // The stale form was rendered before the archive; its assertions are the
      // record's own identity, so they still match the archived record.
      const staleForm = {
        status: "done",
        scopeKind: "all",
        scopeId: "",
        id: task.id,
        clientId: h.client.id,
        engagementId: h.engagement.id,
        projectId: "",
      };
      await server.store.setArchived("task", task.id, true);
      const reply = await send(server.origin, { method: "POST", path: `/tasks/${task.id}/move`, form: staleForm });
      assert.equal(reply.status, 303);
      assert.equal(redirectTarget(reply), "/kanban");
      const stored = server.store.snapshot().tasks.find((candidate) => candidate.id === task.id)!;
      assert.equal(stored.status, "done");
      assert.equal(stored.archived, true, "the move keeps the flag");
      // The redirected board still hides the archived task.
      const board = await send(server.origin, { path: "/kanban" });
      assert.deepEqual(columnTaskIds(columnOf(board.body, "Completed: done")), []);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Navigation links
// ---------------------------------------------------------------------------

describe("board navigation", () => {
  it("adds the global Kanban link to every application page", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      for (const path of ["/", "/clients", `/clients/${h.client.id}`, `/engagements/${h.engagement.id}`]) {
        const reply = await send(server.origin, { path });
        assert.equal(reply.status, 200, path);
        assert.match(reply.body, /<li><a href="\/kanban">Kanban<\/a><\/li>/, `${path} links to Kanban`);
      }
    } finally {
      await server.close();
    }
  });

  it("links the hierarchy pages to their boards", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const client = await send(server.origin, { path: `/clients/${h.client.id}` });
      assert.match(client.body, new RegExp(`href="/clients/${h.client.id}/kanban">Client board</a>`));
      const engagement = await send(server.origin, { path: `/engagements/${h.engagement.id}` });
      assert.match(engagement.body, new RegExp(`href="/engagements/${h.engagement.id}/kanban">Engagement board</a>`));
      const project = await send(server.origin, { path: `/projects/${h.project.id}` });
      assert.match(project.body, new RegExp(`href="/projects/${h.project.id}/kanban">Project board</a>`));
    } finally {
      await server.close();
    }
  });

  it("includes a waiting task in the client's current-task section and in counts", async () => {
    const server = await running();
    try {
      const h = await hierarchy(server.store);
      const waiting = await server.store.createTask({
        clientId: h.client.id,
        engagementId: h.engagement.id,
        title: "Waiting work",
        status: "waiting",
      });
      const overview = await send(server.origin, { path: `/clients/${h.client.id}` });
      assert.equal(overview.status, 200);
      const heading = "Current tasks (open, in progress or waiting)";
      const start = overview.body.indexOf(`<h2>${escapeHtml(heading)}</h2>`);
      assert.ok(start >= 0, "the section heading is present");
      const section = overview.body.slice(start, overview.body.indexOf("</section>", start));
      assert.match(section, new RegExp(`href="/tasks/${waiting.id}"`));
      // The engagement counts include the waiting task exactly once.
      assert.match(overview.body, /<li>waiting: 1<\/li>/);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Route table wiring (no store writes)
// ---------------------------------------------------------------------------

describe("board route table", () => {
  it("exposes a GET board and a POST move route and routes them by method", async () => {
    const store = await openStore(tempDir());
    try {
      const table = kanbanRoutes(store);
      for (const pattern of ["/kanban", "/clients/:id/kanban", "/engagements/:id/kanban", "/projects/:id/kanban"] as const) {
        assert.equal(routeForKanbanPattern(table, pattern, "GET")?.method, "GET", pattern);
        assert.equal(routeForKanbanPattern(table, pattern, "POST"), undefined, pattern);
      }
      // The move route is POST-only.
      assert.equal(routeForKanbanPattern(table, "/tasks/:id/move", "GET"), undefined);
      assert.equal(routeForKanbanPattern(table, "/tasks/:id/move", "POST")?.method, "POST");
    } finally {
      await store.close();
    }
  });
});
