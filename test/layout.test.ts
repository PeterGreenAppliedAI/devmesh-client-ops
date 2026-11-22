import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { escapeHtml, PAGE_HEADERS, renderPage, renderFormError, FormError } from "../src/html.ts";
import {
  layoutContextFor,
  layoutContextForFormError,
  renderLayoutDocument,
  type LayoutContext,
} from "../src/layout.ts";
import { registerRoutes } from "../src/index.ts";
import { startServer } from "../src/server.ts";
import { openStore, type Store } from "../src/store.ts";

// ---------------------------------------------------------------------------
// Fixtures and HTTP helpers
// ---------------------------------------------------------------------------

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "layout-"));
  roots.push(dir);
  return dir;
}

interface Running {
  readonly origin: string;
  readonly store: Store;
  close(): Promise<void>;
}

/** Start a server over a real on-disk store, on an ephemeral port. */
async function running(): Promise<Running> {
  const store = await openStore(tempDir());
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
  readonly form?: Record<string, string>;
}

/** Send a request over loopback HTTP with the explicit canonical Host header. */
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

/** A rendered form as a browser would submit it. */
interface ParsedForm {
  readonly action: string;
  readonly controls: Record<string, string>;
}

function parseForm(document: string): ParsedForm {
  const controls: Record<string, string> = {};
  const form = /<form[^>]*>([\s\S]*?)<\/form>/.exec(document);
  assert.ok(form !== null, "page has a form");
  const action = /<form[^>]*\saction="([^"]*)"/.exec(form[0]);
  assert.ok(action !== null, "the form has an action");
  const inner = form[1];
  for (const match of inner.matchAll(/<textarea[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) {
    controls[unescapeHtml(match[1])] = unescapeHtml(match[2]);
  }
  for (const match of inner.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/g)) {
    controls[unescapeHtml(match[1])] = unescapeHtml(match[2]);
  }
  for (const match of inner.matchAll(/<select[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const options = [...match[2].matchAll(/<option value="([^"]*)"([^>]*)>([\s\S]*?)<\/option>/g)];
    const selected = options.find((option) => option[2].includes("selected")) ?? options[0];
    controls[unescapeHtml(match[1])] = selected === undefined ? "" : unescapeHtml(selected[1]);
  }
  return { action: unescapeHtml(action[1]), controls };
}

/** The single main landmark's content. */
function mainContentOf(body: string): string {
  const start = body.indexOf('<main id="main">');
  assert.ok(start >= 0, "page has a main landmark");
  assert.equal(body.indexOf('<main id="main">', start + 1), -1, "exactly one main landmark opens");
  const end = body.indexOf("</main>", start);
  assert.ok(end >= 0, "the main landmark is closed");
  assert.equal(body.indexOf("</main>", end + 1), -1, "exactly one main landmark closes");
  return body.slice(start, end);
}

/** The stylesheet embedded in the document. */
function styleOf(body: string): string {
  const style = /<style>([\s\S]*?)<\/style>/.exec(body);
  assert.ok(style !== null, "page has an inline stylesheet");
  return style[1];
}

/** A client, engagement, project, task, item and meeting for the HTTP checks. */
interface Records {
  readonly client: { id: string; name: string };
  readonly other: { id: string; name: string };
  readonly engagement: { id: string; name: string };
  readonly project: { id: string; name: string };
  readonly task: { id: string; title: string };
  readonly item: { id: string; title: string };
  readonly meeting: { id: string; title: string };
}

async function seed(store: Store): Promise<Records> {
  // Hostile characters in stored names must appear only escaped.
  const client = await store.createClient({ name: 'Acme <Ltd> & "partners"' });
  const other = await store.createClient({ name: "Other <client>" });
  const engagement = await store.createEngagement({
    clientId: client.id,
    name: "Discovery <phase>",
  });
  const project = await store.createProject({
    engagementId: engagement.id,
    name: "Prototype & pilot",
  });
  const task = await store.createTask({
    clientId: client.id,
    engagementId: engagement.id,
    projectId: project.id,
    title: "Draft <spec>",
    status: "open",
  });
  const item = await store.createItem({
    clientId: client.id,
    engagementId: engagement.id,
    title: 'Blocked "today"',
    kind: "blocker",
    state: "open",
  });
  const meeting = await store.createMeeting({
    clientId: client.id,
    engagementId: engagement.id,
    projectId: project.id,
    title: "Kickoff <call>",
    date: "2026-01-15",
  });
  return { client, other, engagement, project, task, item, meeting };
}

/** The breadcrumb links of the location header, in order. */
function ancestryOf(body: string): { href: string; label: string }[] {
  const header = /<header class="location">([\s\S]*?)<\/header>/.exec(body);
  if (header === null) return [];
  return [...header[1].matchAll(/<li><a href="([^"]*)">([^<]*)<\/a><\/li>/g)].map((match) => ({
    href: unescapeHtml(match[1]),
    label: unescapeHtml(match[2]),
  }));
}

/** The navigation links of the first primary nav, with current markers. */
function navLinks(body: string): { href: string; label: string; current: boolean }[] {
  const nav = /<nav class="primary-nav" aria-label="Primary">([\s\S]*?)<\/nav>/.exec(body);
  assert.ok(nav !== null, "page has the primary navigation");
  return [...nav[1].matchAll(/<li><a href="([^"]*)"([^>]*)>([^<]*)<\/a><\/li>/g)].map((match) => ({
    href: unescapeHtml(match[1]),
    label: unescapeHtml(match[3]),
    current: match[2].includes('aria-current="page"'),
  }));
}

// ---------------------------------------------------------------------------
// Pure layout context
// ---------------------------------------------------------------------------

describe("layout context", () => {
  it("builds ancestry from known records and keeps global pages ancestor-free", async () => {
    const store = await openStore(tempDir());
    try {
      const records = await seed(store);
      const snapshot = store.snapshot();

      const clientContext = layoutContextFor(`/clients/${records.client.id}`, snapshot);
      assert.deepEqual(clientContext.ancestry.map((link) => link.href), [
        `/clients/${records.client.id}`,
      ]);
      assert.equal(clientContext.activeClientId, records.client.id);

      const projectContext = layoutContextFor(`/projects/${records.project.id}`, snapshot);
      assert.deepEqual(projectContext.ancestry.map((link) => link.href), [
        `/clients/${records.client.id}`,
        `/engagements/${records.engagement.id}`,
        `/projects/${records.project.id}`,
      ]);

      // A work record shows the full known ancestor chain, not itself.
      const taskContext = layoutContextFor(`/tasks/${records.task.id}`, snapshot);
      assert.deepEqual(taskContext.ancestry.map((link) => link.href), [
        `/clients/${records.client.id}`,
        `/engagements/${records.engagement.id}`,
        `/projects/${records.project.id}`,
      ]);
      // An engagement-only item has no project in its chain.
      const itemContext = layoutContextFor(`/items/${records.item.id}`, snapshot);
      assert.deepEqual(itemContext.ancestry.map((link) => link.href), [
        `/clients/${records.client.id}`,
        `/engagements/${records.engagement.id}`,
      ]);
      const meetingContext = layoutContextFor(`/meetings/${records.meeting.id}`, snapshot);
      assert.deepEqual(meetingContext.ancestry.map((link) => link.href), [
        `/clients/${records.client.id}`,
        `/engagements/${records.engagement.id}`,
        `/projects/${records.project.id}`,
      ]);

      // Global pages carry no invented ancestors.
      for (const path of ["/", "/health", "/clients", "/clients/new", "/engagements/new", "/projects/new"]) {
        const context = layoutContextFor(path, snapshot);
        assert.deepEqual(context.ancestry, [], path);
        assert.equal(context.activeClientId, undefined, path);
      }
      // Every active client is in the navigation; the other client too.
      assert.deepEqual(
        clientContext.clients.map((entry) => entry.id).sort(),
        [records.client.id, records.other.id].sort(),
      );
    } finally {
      await store.close();
    }
  });

  it("excludes effectively archived clients from navigation", async () => {
    const store = await openStore(tempDir());
    try {
      const records = await seed(store);
      await store.setArchived("client", records.other.id, true);
      const context = layoutContextFor("/clients", store.snapshot());
      assert.deepEqual(
        context.clients.map((entry) => entry.id),
        [records.client.id],
      );
    } finally {
      await store.close();
    }
  });

  it("uses a collection-create refusal's validated parent for its ancestry", async () => {
    const store = await openStore(tempDir());
    try {
      const records = await seed(store);
      const snapshot = store.snapshot();
      const clientFailure = new FormError(
        "name must be nonblank",
        {},
        [],
        [{ name: "clientId", label: "Client", hidden: true, value: records.client.id }],
        "/engagements/new",
      );
      const clientContext = layoutContextForFormError(clientFailure.fields, "/engagements/new", snapshot);
      assert.deepEqual(clientContext.ancestry.map((link) => link.href), [
        `/clients/${records.client.id}`,
      ]);
      assert.equal(clientContext.activeClientId, records.client.id);

      const projectFailure = new FormError(
        "name must be nonblank",
        {},
        [],
        [{ name: "engagementId", label: "Engagement", hidden: true, value: records.engagement.id }],
        "/projects/new",
      );
      const projectContext = layoutContextForFormError(projectFailure.fields, "/projects/new", snapshot);
      assert.deepEqual(projectContext.ancestry.map((link) => link.href), [
        `/clients/${records.client.id}`,
        `/engagements/${records.engagement.id}`,
      ]);

      // A create form with no parent control invents nothing.
      const noParent = layoutContextForFormError([], "/clients/new", snapshot);
      assert.deepEqual(noParent.ancestry, []);
    } finally {
      await store.close();
    }
  });

  it("keeps renderPage usable without context and escapes every rendered value", () => {
    const bare = renderPage("Plain", "<p>body</p>");
    assert.match(bare.html, /<title>Plain<\/title>/);
    assert.match(bare.html, /<h1>Plain<\/h1>/);
    assert.match(bare.html, /<p>body<\/p>/);
    assert.equal(bare.layout, undefined);
    // Without explicit headers a page carries the standard page headers.
    assert.deepEqual(bare.headers, PAGE_HEADERS);

    const context: LayoutContext = {
      clients: [{ id: "c1", name: "<evil> & \"x\"" }],
      activeClientId: "c1",
      ancestry: [{ id: "c1", name: "<evil> & \"x\"", href: "/clients/c1" }],
    };
    const document = renderPage("Title <x>", "<p>body</p>", context);
    assert.equal(document.layout, context);
    assert.match(document.html, /<main id="main">/);
    assert.ok(!document.html.includes("<evil>"));
    assert.ok(document.html.includes(escapeHtml('<evil> & "x"')));
    assert.ok(document.html.includes(escapeHtml("Title <x>")));

    const failure = new FormError("bad", { name: "x" }, [], [], "/");
    const failurePage = renderFormError(failure, "Check the form", context);
    assert.match(failurePage.html, /<main id="main">/);
    assert.match(failurePage.html, /Skip to main content/);
    assert.equal(failurePage.layout, context);
  });

  it("keeps the standard page headers on a page it wraps", () => {
    const context: LayoutContext = {
      clients: [],
      ancestry: [],
    };
    const wrapped = renderPage("Title", "<p>body</p>", context);
    assert.deepEqual(wrapped.headers, PAGE_HEADERS);
    assert.equal(wrapped.layout, context);
  });

  it("renders the shell directly with one main landmark and keyboard-operable controls", () => {
    const html = renderLayoutDocument(
      { clients: [{ id: "c1", name: "Acme" }], activeClientId: "c1", ancestry: [] },
      "Home",
      "<p>body</p>",
    );
    assert.equal(html.split('<main id="main">').length - 1, 1);
    assert.match(html, /<a class="skip-link" href="#main">Skip to main content<\/a>/);
    assert.match(html, /<details class="phone-menu"><summary>Menu<\/summary>/);
    assert.match(html, /<aside class="sidebar">/);
    assert.match(html, /aria-label="Primary"/);
  });
});

// ---------------------------------------------------------------------------
// HTTP layout
// ---------------------------------------------------------------------------

describe("layout: every application page is wrapped in the shared shell", () => {
  it("wraps home and health as global pages with navigation and no ancestors", async () => {
    const server = await running();
    try {
      const records = await seed(server.store);
      for (const path of ["/", "/health"]) {
        const reply = await send(server.origin, { path });
        assert.equal(reply.status, 200, path);
        assert.match(String(reply.headers["content-type"]), /^text\/html; charset=utf-8/);
        mainContentOf(reply.body);
        assert.deepEqual(ancestryOf(reply.body), [], `${path} has no invented ancestors`);
        // The location header is still present, naming the current page alone.
        assert.match(
          reply.body,
          /<header class="location"><nav class="breadcrumb" aria-label="Location"><ol><li><span aria-current="page">[^<]+<\/span><\/li><\/ol><\/nav><\/header>/,
          `${path} has a location header`,
        );
        const links = navLinks(reply.body);
        assert.ok(links.some((link) => link.href === "/" && link.label === "Home"));
        assert.ok(links.some((link) => link.href === "/clients" && link.label === "Clients"));
        assert.ok(links.some((link) => link.href === "/clients/new" && link.label === "New client"));
        assert.ok(links.some((link) => link.href === `/clients/${records.client.id}`));
        assert.ok(links.some((link) => link.href === `/clients/${records.other.id}`));
        assert.ok(!links.some((link) => link.current), `${path} has no active client`);
      }
    } finally {
      await server.close();
    }
  });

  it("keeps the standard page headers when wrapping a page in the shell", async () => {
    const server = await running();
    try {
      const reply = await send(server.origin, { path: "/" });
      assert.equal(reply.status, 200);
      // The page was wrapped in the shell and still carries the page headers.
      mainContentOf(reply.body);
      assert.match(String(reply.headers["content-type"]), /^text\/html; charset=utf-8/);
      assert.equal(reply.headers["cache-control"], "no-store");
      assert.match(
        String(reply.headers["content-security-policy"]),
        /default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'/,
      );
    } finally {
      await server.close();
    }
  });

  it("shows correct ancestry, title and escaped names on hierarchy, work and meeting pages", async () => {
    const server = await running();
    try {
      const r = await seed(server.store);
      const cases: Array<{ path: string; chain: string[]; title: string }> = [
        {
          path: `/clients/${r.client.id}`,
          chain: [`/clients/${r.client.id}`],
          title: r.client.name,
        },
        {
          path: `/clients/${r.client.id}/edit`,
          chain: [`/clients/${r.client.id}`],
          title: "Edit client",
        },
        {
          path: `/engagements/${r.engagement.id}`,
          chain: [`/clients/${r.client.id}`, `/engagements/${r.engagement.id}`],
          title: r.engagement.name,
        },
        {
          path: `/engagements/${r.engagement.id}/edit`,
          chain: [`/clients/${r.client.id}`, `/engagements/${r.engagement.id}`],
          title: "Edit engagement",
        },
        {
          path: `/projects/${r.project.id}`,
          chain: [`/clients/${r.client.id}`, `/engagements/${r.engagement.id}`, `/projects/${r.project.id}`],
          title: r.project.name,
        },
        {
          path: `/projects/${r.project.id}/edit`,
          chain: [`/clients/${r.client.id}`, `/engagements/${r.engagement.id}`, `/projects/${r.project.id}`],
          title: "Edit project",
        },
        {
          path: `/tasks/${r.task.id}`,
          chain: [`/clients/${r.client.id}`, `/engagements/${r.engagement.id}`, `/projects/${r.project.id}`],
          title: r.task.title,
        },
        {
          path: `/tasks/${r.task.id}/edit`,
          chain: [`/clients/${r.client.id}`, `/engagements/${r.engagement.id}`, `/projects/${r.project.id}`],
          title: "Edit task",
        },
        {
          path: `/items/${r.item.id}`,
          chain: [`/clients/${r.client.id}`, `/engagements/${r.engagement.id}`],
          title: r.item.title,
        },
        {
          path: `/items/${r.item.id}/edit`,
          chain: [`/clients/${r.client.id}`, `/engagements/${r.engagement.id}`],
          title: "Edit work item",
        },
        {
          path: `/meetings/${r.meeting.id}`,
          chain: [`/clients/${r.client.id}`, `/engagements/${r.engagement.id}`, `/projects/${r.project.id}`],
          title: r.meeting.title,
        },
        {
          path: `/meetings/${r.meeting.id}/edit`,
          chain: [`/clients/${r.client.id}`, `/engagements/${r.engagement.id}`, `/projects/${r.project.id}`],
          title: "Edit meeting",
        },
      ];
      for (const entry of cases) {
        const reply = await send(server.origin, { path: entry.path });
        assert.equal(reply.status, 200, entry.path);
        const main = mainContentOf(reply.body);
        // The page title is the single h1 inside the main landmark, escaped.
        assert.match(main, new RegExp(`<h1>${escapeHtml(entry.title)}</h1>`), entry.path);
        // The ancestry is exactly the known chain, escaped.
        assert.deepEqual(
          ancestryOf(reply.body).map((link) => link.href),
          entry.chain,
          `${entry.path} ancestry`,
        );
        // The current client is marked in the navigation.
        const links = navLinks(reply.body);
        const current = links.filter((link) => link.current);
        assert.equal(current.length, 1, `${entry.path} marks one active client`);
        assert.equal(current[0].href, `/clients/${r.client.id}`);
      }
      // Stored hostile names are escaped everywhere they are shown.
      const clientPage = await send(server.origin, { path: `/clients/${r.client.id}` });
      assert.ok(!clientPage.body.includes("<Ltd>"));
      assert.ok(clientPage.body.includes(escapeHtml(r.client.name)));
      assert.ok(!clientPage.body.includes("Other <client>"));
      assert.ok(clientPage.body.includes(escapeHtml(r.other.name)));
    } finally {
      await server.close();
    }
  });

  it("shows the parent ancestry on create forms under a client, engagement or project", async () => {
    const server = await running();
    try {
      const r = await seed(server.store);
      const cases: Array<{ path: string; chain: string[] }> = [
        {
          path: `/clients/${r.client.id}/engagements/new`,
          chain: [`/clients/${r.client.id}`],
        },
        {
          path: `/engagements/${r.engagement.id}/projects/new`,
          chain: [`/clients/${r.client.id}`, `/engagements/${r.engagement.id}`],
        },
        {
          path: `/engagements/${r.engagement.id}/tasks/new`,
          chain: [`/clients/${r.client.id}`, `/engagements/${r.engagement.id}`],
        },
        {
          path: `/projects/${r.project.id}/items/new`,
          chain: [`/clients/${r.client.id}`, `/engagements/${r.engagement.id}`, `/projects/${r.project.id}`],
        },
        {
          path: `/engagements/${r.engagement.id}/meetings/new`,
          chain: [`/clients/${r.client.id}`, `/engagements/${r.engagement.id}`],
        },
        {
          path: `/projects/${r.project.id}/meetings/new`,
          chain: [`/clients/${r.client.id}`, `/engagements/${r.engagement.id}`, `/projects/${r.project.id}`],
        },
      ];
      for (const entry of cases) {
        const reply = await send(server.origin, { path: entry.path });
        assert.equal(reply.status, 200, entry.path);
        mainContentOf(reply.body);
        assert.deepEqual(ancestryOf(reply.body).map((link) => link.href), entry.chain, entry.path);
      }
      const newClient = await send(server.origin, { path: "/clients/new" });
      assert.equal(newClient.status, 200);
      assert.deepEqual(ancestryOf(newClient.body), []);
      // The global New client page still has a location header, no ancestors.
      assert.match(
        newClient.body,
        /<header class="location"><nav class="breadcrumb" aria-label="Location"><ol><li><span aria-current="page">New client<\/span><\/li><\/ol><\/nav><\/header>/,
      );
    } finally {
      await server.close();
    }
  });

  it("keeps authoritative ancestry and escapes values on correction pages", async () => {
    const server = await running();
    try {
      const r = await seed(server.store);

      // Refuse a client edit: the correction page keeps the URL record's context.
      const editPage = await send(server.origin, { path: `/clients/${r.client.id}/edit` });
      const editForm = parseForm(editPage.body);
      editForm.controls.name = "   ";
      const editRefused = await send(server.origin, {
        method: "POST",
        path: `/clients/${r.client.id}/edit`,
        form: editForm.controls,
      });
      assert.equal(editRefused.status, 400);
      assert.match(String(editRefused.headers["content-type"]), /^text\/html/);
      const editMain = mainContentOf(editRefused.body);
      assert.match(editMain, /role="alert"/);
      assert.deepEqual(
        ancestryOf(editRefused.body).map((link) => link.href),
        [`/clients/${r.client.id}`],
      );
      const editNav = navLinks(editRefused.body);
      assert.equal(editNav.filter((link) => link.current).length, 1);
      assert.equal(editNav.find((link) => link.current)?.href, `/clients/${r.client.id}`);

      // Refuse an engagement create: the hidden validated parent supplies it.
      const engagementRefused = await send(server.origin, {
        method: "POST",
        path: "/engagements/new",
        form: { clientId: r.client.id, name: "  ", objectives: "", status: "active" },
      });
      assert.equal(engagementRefused.status, 400);
      assert.match(engagementRefused.body, /role="alert"/);
      mainContentOf(engagementRefused.body);
      assert.deepEqual(
        ancestryOf(engagementRefused.body).map((link) => link.href),
        [`/clients/${r.client.id}`],
      );
      assert.ok(engagementRefused.body.includes(escapeHtml(r.client.name)));

      // Refuse a project create: the validated engagement parent supplies the
      // client and engagement ancestry, and the hidden parent stays in the form.
      const projectRefused = await send(server.origin, {
        method: "POST",
        path: "/projects/new",
        form: { engagementId: r.engagement.id, name: "", objectives: "", status: "planned" },
      });
      assert.equal(projectRefused.status, 400);
      assert.deepEqual(
        ancestryOf(projectRefused.body).map((link) => link.href),
        [`/clients/${r.client.id}`, `/engagements/${r.engagement.id}`],
      );
      assert.match(
        projectRefused.body,
        new RegExp(`type="hidden" name="engagementId" value="${r.engagement.id}"`),
      );

      // Refuse a task edit: the task's own authoritative chain is kept.
      const taskPage = await send(server.origin, { path: `/tasks/${r.task.id}/edit` });
      const taskForm = parseForm(taskPage.body);
      taskForm.controls.title = "";
      const taskRefused = await send(server.origin, {
        method: "POST",
        path: `/tasks/${r.task.id}/edit`,
        form: taskForm.controls,
      });
      assert.equal(taskRefused.status, 400);
      assert.deepEqual(
        ancestryOf(taskRefused.body).map((link) => link.href),
        [`/clients/${r.client.id}`, `/engagements/${r.engagement.id}`, `/projects/${r.project.id}`],
      );

      // A refused client create is a global page: no invented ancestors.
      const clientRefused = await send(server.origin, {
        method: "POST",
        path: "/clients/new",
        form: { name: "" },
      });
      assert.equal(clientRefused.status, 400);
      assert.deepEqual(ancestryOf(clientRefused.body), []);
      // A refused client create is still a global page with a location header.
      assert.match(
        clientRefused.body,
        /<header class="location"><nav class="breadcrumb" aria-label="Location"><ol><li><span aria-current="page">[^<]+<\/span><\/li><\/ol><\/nav><\/header>/,
      );
      mainContentOf(clientRefused.body);
    } finally {
      await server.close();
    }
  });

  it("scopes record isolation to main content while the global client navigation is explicit", async () => {
    const server = await running();
    try {
      const r = await seed(server.store);
      // A sibling's engagement-only task must never appear in the main content,
      // but the shell deliberately links every active client, including the
      // sibling client, outside the main landmark.
      const reply = await send(server.origin, { path: `/engagements/${r.engagement.id}` });
      assert.equal(reply.status, 200);
      const main = mainContentOf(reply.body);
      assert.ok(!main.includes("Other <client>"));
      assert.ok(!main.includes(escapeHtml(r.other.name)));
      const links = navLinks(reply.body);
      assert.ok(links.some((link) => link.href === `/clients/${r.other.id}`));
      assert.ok(reply.body.includes(escapeHtml(r.other.name)));
    } finally {
      await server.close();
    }
  });

  it("keeps protocol rejections and missing records as plain text without navigation", async () => {
    const server = await running();
    try {
      const r = await seed(server.store);
      const missing = await send(server.origin, { path: `/clients/no-such-client` });
      assert.equal(missing.status, 404);
      assert.match(String(missing.headers["content-type"]), /^text\/plain/);
      assert.ok(!missing.body.includes("Primary"));
      assert.ok(!missing.body.includes(`/clients/${r.client.id}`));
      const unknown = await send(server.origin, { path: "/nowhere" });
      assert.equal(unknown.status, 404);
      assert.match(String(unknown.headers["content-type"]), /^text\/plain/);
      assert.ok(!unknown.body.includes("Skip to main content"));
    } finally {
      await server.close();
    }
  });

  it("returns the generic 500 when the layout snapshot cannot be read", async () => {
    const store = await openStore(tempDir());
    const failingStore: Store = {
      ...store,
      snapshot: () => {
        throw new Error("Failed to read workspace.json");
      },
    };
    const server = await startServer({ store: failingStore, port: 0, routes: registerRoutes(store) });
    try {
      const reply = await send(server.origin, { path: "/clients" });
      assert.equal(reply.status, 500);
      assert.match(String(reply.headers["content-type"]), /^text\/plain/);
      assert.match(reply.body, /An unexpected error occurred\./);
      assert.ok(!reply.body.includes("workspace.json"));
      assert.ok(!reply.body.includes("Skip to main content"));
    } finally {
      await server.close();
      await store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Presentation: semantic controls, responsive CSS, focus and contrast
// ---------------------------------------------------------------------------

/** Parse a `#rrggbb` colour into its channels. */
function rgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  assert.equal(value.length, 6, `expected a six-digit hex colour, got ${hex}`);
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** WCAG relative luminance of an sRGB colour. */
function luminance(hex: string): number {
  const channels = rgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG contrast ratio between two colours. */
function contrast(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

/** The declaration block of the first rule with this exact selector. */
function rule(style: string, selector: string): string {
  const start = style.indexOf(`${selector}{`);
  assert.ok(start >= 0, `stylesheet has a ${selector} rule`);
  const end = style.indexOf("}", start);
  assert.ok(end >= 0);
  return style.slice(start + selector.length + 1, end);
}

/** The value of a declaration in a rule. */
function declaration(block: string, property: string): string {
  const match = new RegExp(`(?:^|;)${property}:([^;]*)`).exec(block);
  assert.ok(match !== null, `rule has a ${property} declaration`);
  return match[1];
}

describe("layout: presentation", () => {
  it("uses semantic, keyboard-operable navigation controls and a skip link", async () => {
    const server = await running();
    try {
      const reply = await send(server.origin, { path: "/" });
      assert.match(reply.body, /<a class="skip-link" href="#main">Skip to main content<\/a>/);
      // A native details/summary is keyboard operable without scripts.
      assert.match(reply.body, /<details class="phone-menu"><summary>Menu<\/summary>/);
      assert.match(reply.body, /<aside class="sidebar">/);
      assert.equal((reply.body.match(/aria-label="Primary"/g) ?? []).length, 2);
      // The content security policy still forbids scripts and external assets.
      assert.match(
        String(reply.headers["content-security-policy"]),
        /default-src 'none'; style-src 'unsafe-inline'/,
      );
      assert.ok(!reply.body.includes("<script"));
      assert.ok(!reply.body.includes("<link"));
    } finally {
      await server.close();
    }
  });

  it("has a persistent laptop sidebar and a phone layout that reflows at 360px and 1280px", async () => {
    const server = await running();
    try {
      const style = styleOf((await send(server.origin, { path: "/" })).body);
      // Phone first: one column, hidden sidebar, full-width controls.
      assert.match(rule(style, ".sidebar"), /display:none/);
      assert.match(rule(style, "input,textarea,select"), /width:100%/);
      assert.match(rule(style, "form"), /max-width:32rem/);
      // Laptop: a persistent sidebar beside the content.
      const laptop = style.slice(style.indexOf("@media (min-width:901px)"));
      assert.ok(laptop.includes(".sidebar{display:block"), "sidebar is persistent on laptops");
      assert.ok(laptop.includes("grid-template-columns:16rem minmax(0,1fr)"));
      // A narrow phone still reflows without clipping actions.
      assert.ok(style.includes("@media (max-width:400px)"));
      // Long unbroken stored names wrap instead of overflowing the sidebar or
      // the viewport into the content and its actions.
      assert.match(rule(style, ".primary-nav a"), /overflow-wrap:anywhere/);
      assert.match(rule(style, ".breadcrumb li"), /overflow-wrap:anywhere/);
      assert.match(rule(style, "main"), /overflow-wrap:anywhere/);
      assert.match(rule(style, ".content"), /min-width:0/);
      assert.match(rule(style, "input,textarea,select"), /max-width:100%/);
      // No fixed overlay covers the main content or an action.
      assert.ok(!/position:fixed/.test(style));
    } finally {
      await server.close();
    }
  });

  it("shows a visible focus outline and text contrast of at least 4.5:1", async () => {
    const server = await running();
    try {
      const style = styleOf((await send(server.origin, { path: "/" })).body);
      assert.match(style, /:focus-visible\{outline:3px solid #0b4f9c;outline-offset:2px\}/);

      const body = rule(style, "body");
      const background = declaration(body, "background");
      assert.ok(contrast(declaration(body, "color"), background) >= 4.5, "body text contrast");

      const link = rule(style, "a");
      assert.ok(contrast(declaration(link, "color"), background) >= 4.5, "link contrast");
      const visited = rule(style, "a:visited");
      assert.ok(contrast(declaration(visited, "color"), background) >= 4.5, "visited link contrast");

      const current = rule(style, ".primary-nav a[aria-current=page]");
      assert.ok(
        contrast(declaration(current, "color"), declaration(current, "background")) >= 4.5,
        "active client contrast",
      );
      // The visited override keeps the current client readable on its background.
      const currentVisited = rule(
        style,
        ".primary-nav a[aria-current=page]:link,.primary-nav a[aria-current=page]:visited",
      );
      assert.ok(
        contrast(declaration(currentVisited, "color"), declaration(current, "background")) >= 4.5,
        "visited active client contrast",
      );

      // The skip link keeps white text on its blue background once visited.
      const skipLinks = rule(style, ".skip-link:link,.skip-link:visited");
      assert.ok(
        contrast(declaration(skipLinks, "color"), declaration(skipLinks, "background")) >= 4.5,
        "skip link contrast",
      );

      const button = rule(style, "button");
      assert.ok(
        contrast(declaration(button, "color"), declaration(button, "background")) >= 4.5,
        "button label contrast",
      );

      const alert = rule(style, "[role=alert]");
      assert.ok(contrast(declaration(alert, "color"), background) >= 4.5, "alert contrast");

      // System fonts only: no external font asset.
      assert.match(declaration(body, "font-family"), /system-ui/);
      assert.ok(!style.includes("@font-face"));
    } finally {
      await server.close();
    }
  });
});
