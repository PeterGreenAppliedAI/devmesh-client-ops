/**
 * Archival pages and actions: the exact archive/unarchive POST endpoints, the
 * archive notice on record pages, the hiding of effective archives from normal
 * lists, counts and histories, and the `/archived` discovery page.
 *
 * The HTTP tests run against a real on-disk store over loopback; a save failure
 * is injected through the store's own file-system adapter, never by mocking a
 * module or changing the environment.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  archiveConflict,
  archivedGroups,
  archivedPage,
  archiveRoutes,
  matchArchivePath,
} from "../src/archive-pages.ts";
import { escapeHtml } from "../src/html.ts";
import { registerRoutes } from "../src/index.ts";
import { startServer } from "../src/server.ts";
import {
  openStore,
  PersistenceError,
  type FileSystem,
  type Store,
} from "../src/store.ts";

// ---------------------------------------------------------------------------
// Fixtures and HTTP helpers
// ---------------------------------------------------------------------------

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "archive-pages-"));
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
  readonly form?: Record<string, string>;
}

/** Send a request to the running server over loopback HTTP. */
function send(base: string, options: RequestOptions = {}): Promise<Reply> {
  const url = new URL(base);
  const method = options.method ?? "GET";
  const body = options.form === undefined ? "" : new URLSearchParams(options.form).toString();
  // The canonical Host authority is set explicitly from the URL, so the same
  // request is sent on every platform; Node's own default Host header differs
  // between platforms and would otherwise fail the server's Host check.
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

/** Follow one redirect from the reply, returning the target's path. */
function redirectTarget(reply: Reply): string {
  assert.equal(reply.status, 303);
  const location = String(reply.headers.location ?? "");
  assert.ok(location.startsWith("/"), `redirect location must be internal, got ${location}`);
  return location;
}

function containsEscaped(body: string, text: string): boolean {
  return body.includes(escapeHtml(text));
}

/** A workspace with two clients, an engagement, its project, task, item and meeting. */
interface Seeds {
  readonly client: { id: string; name: string };
  readonly otherClient: { id: string; name: string };
  readonly engagement: { id: string; name: string };
  readonly siblingEngagement: { id: string; name: string };
  readonly project: { id: string; name: string };
  readonly task: { id: string; title: string };
  readonly item: { id: string; title: string };
  readonly meeting: { id: string; title: string };
}

async function seed(store: Store): Promise<Seeds> {
  const client = await store.createClient({ name: "Acme <Ltd>" });
  const otherClient = await store.createClient({ name: "Other <client>" });
  const engagement = await store.createEngagement({ clientId: client.id, name: "Discovery & design" });
  const siblingEngagement = await store.createEngagement({ clientId: client.id, name: "Sibling <eng>" });
  const project = await store.createProject({ engagementId: engagement.id, name: "Prototype \"pilot\"" });
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
    projectId: project.id,
    kind: "blocker",
    title: 'Blocked "today"',
    state: "open",
  });
  const meeting = await store.createMeeting({
    clientId: client.id,
    engagementId: engagement.id,
    projectId: project.id,
    title: "Kickoff <call>",
    date: "2026-01-15",
  });
  return { client, otherClient, engagement, siblingEngagement, project, task, item, meeting };
}

/** The `archived` flag on a record in the current snapshot, or undefined. */
function flagOf(store: Store, family: "clients" | "engagements" | "projects" | "tasks" | "items", id: string): boolean | undefined {
  const snap = store.snapshot();
  const records =
    family === "clients"
      ? snap.clients
      : family === "engagements"
        ? snap.engagements
        : family === "projects"
          ? snap.projects
          : family === "tasks"
            ? snap.tasks
            : snap.items;
  const record = records.find((candidate) => candidate.id === id) as { archived?: boolean } | undefined;
  return record?.archived;
}

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

describe("archive endpoints: matching", () => {
  it("matches only the exact archive and unarchive endpoints of the five families", () => {
    for (const family of ["clients", "engagements", "projects", "tasks", "items"]) {
      assert.deepEqual(matchArchivePath(`/${family}/r-1/archive`), {
        pattern: `/${family}/:id/archive`,
        family,
        action: "archive",
        id: "r-1",
      });
      assert.deepEqual(matchArchivePath(`/${family}/r-1/unarchive`), {
        pattern: `/${family}/:id/unarchive`,
        family,
        action: "unarchive",
        id: "r-1",
      });
    }
    for (const path of [
      "/meetings/meeting-1/archive",
      "/clients/archive",
      "/clients/c1/archive/extra",
      "/clients/c1/delete",
      "/clients//archive",
      "/clients/new/archive",
      "/archived",
      "/",
    ]) {
      assert.equal(matchArchivePath(path), null, path);
    }
  });
});

// ---------------------------------------------------------------------------
// Conflict checks (pure)
// ---------------------------------------------------------------------------

describe("archive endpoints: conflicts", () => {
  it("accepts omitted fields and matching identity and parent fields", () => {
    const expected = { id: "task-1", clientId: "client-1", engagementId: "engagement-1", projectId: "" };
    assert.equal(archiveConflict({}, expected, "task"), null);
    assert.equal(
      archiveConflict(
        { id: "task-1", clientId: "client-1", engagementId: "engagement-1", projectId: "" },
        expected,
        "task",
      ),
      null,
    );
  });

  it("refuses every conflicting identity or parent field", () => {
    const expected = { id: "task-1", clientId: "client-1", engagementId: "engagement-1", projectId: "project-1" };
    const conflicts: Record<string, string>[] = [
      { id: "task-2" },
      { clientId: "client-2" },
      { engagementId: "engagement-2" },
      { projectId: "project-2" },
      { projectId: "" },
      { id: "task-1", clientId: "client-2" },
    ];
    for (const form of conflicts) {
      const conflict = archiveConflict(form, expected, "task");
      assert.ok(conflict !== null, JSON.stringify(form));
      assert.equal(conflict.name, "ValidationError");
    }
    // An absent optional project compares as empty: an empty project field is
    // not a conflict for a record with no project.
    assert.equal(
      archiveConflict({ projectId: "" }, { id: "task-2", clientId: "client-1", engagementId: "engagement-1", projectId: "" }, "task"),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// HTTP archive and unarchive actions
// ---------------------------------------------------------------------------

describe("archive endpoints over HTTP", () => {
  it("archives and restores all five families, redirecting to the same detail", async () => {
    const server = await running();
    try {
      const s = await seed(server.store);
      const cases: Array<{ family: string; id: string; detail: string }> = [
        { family: "clients", id: s.client.id, detail: `/clients/${s.client.id}` },
        { family: "engagements", id: s.engagement.id, detail: `/engagements/${s.engagement.id}` },
        { family: "projects", id: s.project.id, detail: `/projects/${s.project.id}` },
        { family: "tasks", id: s.task.id, detail: `/tasks/${s.task.id}` },
        { family: "items", id: s.item.id, detail: `/items/${s.item.id}` },
      ];
      for (const c of cases) {
        const archived = await send(server.origin, { method: "POST", path: `/${c.family}/${c.id}/archive` });
        assert.equal(archived.status, 303, c.family);
        assert.equal(redirectTarget(archived), c.detail, `${c.family} archive redirects to its detail`);
        assert.equal(flagOf(server.store, c.family as never, c.id), true, `${c.family} archived`);

        const restored = await send(server.origin, { method: "POST", path: `/${c.family}/${c.id}/unarchive` });
        assert.equal(restored.status, 303, c.family);
        assert.equal(redirectTarget(restored), c.detail, `${c.family} unarchive redirects to its detail`);
        assert.equal(flagOf(server.store, c.family as never, c.id), undefined, `${c.family} restored`);
      }
    } finally {
      await server.close();
    }
  });

  it("keeps repeated archive/unarchive requests idempotent", async () => {
    const server = await running();
    try {
      const s = await seed(server.store);
      for (let round = 0; round < 3; round += 1) {
        for (const action of ["archive", "archive", "unarchive", "unarchive"]) {
          const reply = await send(server.origin, { method: "POST", path: `/tasks/${s.task.id}/${action}` });
          assert.equal(reply.status, 303, `${action} ${round}`);
          assert.equal(redirectTarget(reply), `/tasks/${s.task.id}`);
          assert.equal(flagOf(server.store, "tasks", s.task.id), action === "archive" ? true : undefined);
        }
      }
      // Only the selected flag is stored; the record's other fields are kept.
      const task = server.store.snapshot().tasks.find((candidate) => candidate.id === s.task.id)!;
      assert.equal(task.title, s.task.title);
      assert.equal(task.projectId, s.project.id);
    } finally {
      await server.close();
    }
  });

  it("keeps flags across a restart", async () => {
    const dir = tempDir();
    const first = await running(dir);
    let ids: { task: string; item: string };
    try {
      const s = await seed(first.store);
      ids = { task: s.task.id, item: s.item.id };
      await send(first.origin, { method: "POST", path: `/tasks/${s.task.id}/archive` });
      await send(first.origin, { method: "POST", path: `/items/${s.item.id}/archive` });
    } finally {
      await first.close();
    }
    const second = await running(dir);
    try {
      assert.equal(flagOf(second.store, "tasks", ids.task), true);
      assert.equal(flagOf(second.store, "items", ids.item), true);
      // The discovery page lists both after the restart.
      const archived = await send(second.origin, { path: "/archived" });
      assert.equal(archived.status, 200);
      assert.match(archived.body, new RegExp(`href="/tasks/${ids.task}"`));
      assert.match(archived.body, new RegExp(`href="/items/${ids.item}"`));
    } finally {
      await second.close();
    }
  });

  it("refuses GET on an archive endpoint with 405 and never mutates", async () => {
    const server = await running();
    try {
      const s = await seed(server.store);
      for (const action of ["archive", "unarchive"]) {
        const reply = await send(server.origin, { path: `/clients/${s.client.id}/${action}` });
        assert.equal(reply.status, 405, action);
        assert.equal(reply.headers.allow, "GET, POST");
        assert.match(String(reply.headers["content-type"]), /^text\/plain/);
      }
      assert.equal(flagOf(server.store, "clients", s.client.id), undefined, "GET never archives");
    } finally {
      await server.close();
    }
  });

  it("refuses a foreign Origin on a POST and never mutates", async () => {
    const server = await running();
    try {
      const s = await seed(server.store);
      const reply = await send(server.origin, {
        method: "POST",
        path: `/clients/${s.client.id}/archive`,
        origin: "http://evil.example",
      });
      assert.equal(reply.status, 403);
      assert.equal(flagOf(server.store, "clients", s.client.id), undefined);
    } finally {
      await server.close();
    }
  });

  it("treats GET on /archived as read-only and refuses POST with 405", async () => {
    const server = await running();
    try {
      const read = await send(server.origin, { path: "/archived" });
      assert.equal(read.status, 200);
      const write = await send(server.origin, { method: "POST", path: "/archived", form: {} });
      assert.equal(write.status, 405);
    } finally {
      await server.close();
    }
  });

  it("refuses conflicting identity and parent fields with 400 and no mutation", async () => {
    const server = await running();
    try {
      const s = await seed(server.store);
      const target = `/tasks/${s.task.id}/archive`;
      const cases: Record<string, string>[] = [
        { id: "task-999" },
        { clientId: s.otherClient.id },
        { engagementId: s.siblingEngagement.id },
        { projectId: "" },
        { clientId: s.client.id, engagementId: s.siblingEngagement.id },
      ];
      for (const form of cases) {
        const reply = await send(server.origin, { method: "POST", path: target, form });
        assert.equal(reply.status, 400, JSON.stringify(form));
        assert.match(String(reply.headers["content-type"]), /^text\/plain/, "plain-text validation error");
        assert.equal(flagOf(server.store, "tasks", s.task.id), undefined, `${JSON.stringify(form)} did not archive`);
      }
      // Matching identity and parent fields are accepted, as are omitted ones.
      const accepted = await send(server.origin, {
        method: "POST",
        path: target,
        form: {
          id: s.task.id,
          clientId: s.client.id,
          engagementId: s.engagement.id,
          projectId: s.project.id,
          unrelated: "ignored",
        },
      });
      assert.equal(accepted.status, 303);
      assert.equal(flagOf(server.store, "tasks", s.task.id), true);
      const omitted = await send(server.origin, { method: "POST", path: `/items/${s.item.id}/archive` });
      assert.equal(omitted.status, 303);
      assert.equal(flagOf(server.store, "items", s.item.id), true);
    } finally {
      await server.close();
    }
  });

  it("refuses a conflicting project field on a project and a record with no project", async () => {
    const server = await running();
    try {
      const s = await seed(server.store);
      const projectConflict = await send(server.origin, {
        method: "POST",
        path: `/projects/${s.project.id}/archive`,
        form: { projectId: "project-999" },
      });
      assert.equal(projectConflict.status, 400);
      assert.equal(flagOf(server.store, "projects", s.project.id), undefined);
      // A record with no project accepts an empty project field (absent compares
      // as empty) but refuses a different one.
      const otherEngagementTask = await server.store.createTask({
        clientId: s.client.id,
        engagementId: s.engagement.id,
        title: "No project",
      });
      const empty = await send(server.origin, {
        method: "POST",
        path: `/tasks/${otherEngagementTask.id}/archive`,
        form: { projectId: "" },
      });
      assert.equal(empty.status, 303);
      assert.equal(flagOf(server.store, "tasks", otherEngagementTask.id), true);
      const mismatch = await send(server.origin, {
        method: "POST",
        path: `/tasks/${otherEngagementTask.id}/unarchive`,
        form: { projectId: s.project.id },
      });
      assert.equal(mismatch.status, 400);
      assert.equal(flagOf(server.store, "tasks", otherEngagementTask.id), true, "unarchive refused");
    } finally {
      await server.close();
    }
  });

  it("returns 404 for missing or malformed targets without mutation", async () => {
    const server = await running();
    try {
      await seed(server.store);
      for (const path of [
        "/tasks/task-999/archive",
        "/clients/client-999/unarchive",
        "/projects/%E0%A4%A/archive",
        "/items/%ZZ/unarchive",
      ]) {
        const reply = await send(server.origin, { method: "POST", path });
        assert.equal(reply.status, 404, path);
        assert.match(String(reply.headers["content-type"]), /^text\/plain/);
      }
      assert.deepEqual(
        server.store.snapshot().tasks.map((task) => task.archived),
        [undefined],
        "no task was archived",
      );
    } finally {
      await server.close();
    }
  });

  it("returns a generic 500 on save failure and keeps committed memory", async () => {
    const dir = tempDir();
    // Seed on a real store, then reopen with an injected rename failure so a
    // save's atomic replace is refused. Nothing about the environment changes.
    const setup = await openStore(dir);
    let taskId: string;
    try {
      const s = await seed(setup);
      taskId = s.task.id;
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
      const reply = await send(server.origin, { method: "POST", path: `/tasks/${taskId}/archive` });
      assert.equal(reply.status, 500);
      assert.ok(!reply.body.includes("rename refused"), "the 500 is generic");
      // The committed memory still shows the task active: the failed save never
      // published a new flag.
      assert.equal(flagOf(store, "tasks", taskId), undefined);
    } finally {
      await server.close();
      await store.close();
    }
  });

  it("rejects a save failure through the store's own error type", async () => {
    // A direct check that a failed archival is reported, not swallowed.
    const dir = tempDir();
    const setup = await openStore(dir);
    let taskId: string;
    try {
      taskId = (await seed(setup)).task.id;
    } finally {
      await setup.close();
    }
    const store = await openStore(dir, {
      fs: {
        renameSync: () => {
          const error = new Error("rename refused") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        },
      },
    });
    try {
      await assert.rejects(store.setArchived("task", taskId, true), PersistenceError);
    } finally {
      await store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Discovery page
// ---------------------------------------------------------------------------

describe("archived discovery page", () => {
  it("lists every archived record grouped by family with ancestry, reason and detail links", async () => {
    const server = await running();
    try {
      const s = await seed(server.store);
      await server.store.setArchived("client", s.client.id, true);
      await server.store.setArchived("engagement", s.siblingEngagement.id, true);
      await server.store.setArchived("task", s.task.id, true);

      const reply = await send(server.origin, { path: "/archived" });
      assert.equal(reply.status, 200);
      assert.match(String(reply.headers["content-type"]), /^text\/html; charset=utf-8/);

      // The client is explicitly archived and sits under the Clients heading.
      assert.match(reply.body, /<section><h2>Clients<\/h2>/);
      assert.ok(containsEscaped(reply.body, s.client.name));
      assert.match(reply.body, new RegExp(`href="/clients/${s.client.id}"`));
      assert.match(reply.body, /archived itself/);

      // The sibling engagement is explicitly archived under Engagements.
      assert.ok(containsEscaped(reply.body, s.siblingEngagement.name));
      assert.match(reply.body, new RegExp(`href="/engagements/${s.siblingEngagement.id}"`));

      // The task is explicitly archived under Tasks with its own detail link.
      assert.match(reply.body, /<section><h2>Tasks<\/h2>/);
      assert.ok(containsEscaped(reply.body, s.task.title));
      assert.match(reply.body, new RegExp(`href="/tasks/${s.task.id}"`));

      // The groups helper agrees with the page: every archived record is once.
      const groups = archivedGroups(server.store.snapshot());
      const listed = groups.flatMap((group) => group.entries.map((entry) => entry.entry.href));
      assert.ok(listed.includes(`/clients/${s.client.id}`));
      assert.ok(listed.includes(`/engagements/${s.siblingEngagement.id}`));
      assert.ok(listed.includes(`/tasks/${s.task.id}`));
    } finally {
      await server.close();
    }
  });

  it("groups inherited-only records, including hidden meetings, under their archived ancestor", async () => {
    const server = await running();
    try {
      const s = await seed(server.store);
      await server.store.setArchived("client", s.client.id, true);

      // The project, task, item and meeting are hidden only by the client:
      // none of them carries a flag, so each is inherited-only.
      assert.equal(flagOf(server.store, "projects", s.project.id), undefined);
      assert.equal(flagOf(server.store, "tasks", s.task.id), undefined);
      assert.equal(flagOf(server.store, "items", s.item.id), undefined);
      const meeting = server.store.snapshot().meetings.find((candidate) => candidate.id === s.meeting.id)!;
      assert.equal("archived" in meeting, false, "meetings have no flag");

      const reply = await send(server.origin, { path: "/archived" });
      assert.equal(reply.status, 200);
      // The client is the only own-flag record; the rest sit under Clients and
      // link to the archived client for restoration.
      const groups = archivedGroups(server.store.snapshot());
      assert.deepEqual(groups.map((group) => group.title), ["Clients"]);
      const inherited = groups[0].entries.filter((entry) => entry.inheritedOnly);
      assert.deepEqual(
        inherited.map((entry) => entry.family).sort(),
        ["engagements", "engagements", "items", "meetings", "projects", "tasks"],
        "the engagement, project, task, item and meeting are inherited-only",
      );
      for (const entry of inherited) {
        assert.equal(entry.entry.href, `/clients/${s.client.id}`, "inherited entry links to the ancestor");
        assert.ok(entry.reason.startsWith("client:"), entry.reason);
      }
      // The hidden meeting is discoverable on the page and links to the client.
      assert.ok(containsEscaped(reply.body, s.meeting.title), "hidden meeting is discoverable");
      assert.match(reply.body, new RegExp(`href="/clients/${s.client.id}"`));
      assert.ok(!reply.body.includes(`href="/meetings/${s.meeting.id}"`), "inherited meeting links to its ancestor");
    } finally {
      await server.close();
    }
  });

  it("names the nearest archived ancestor in an inherited record's reason", async () => {
    const server = await running();
    try {
      const s = await seed(server.store);
      await server.store.setArchived("engagement", s.engagement.id, true);
      const groups = archivedGroups(server.store.snapshot());
      const engagements = groups.find((group) => group.family === "engagements")!;
      const project = engagements.entries.find((entry) => entry.family === "projects")!;
      assert.equal(project.inheritedOnly, true);
      assert.equal(project.reason, `engagement:${s.engagement.id}`);
      assert.equal(project.entry.href, `/engagements/${s.engagement.id}`);
    } finally {
      await server.close();
    }
  });

  it("shows an explanatory empty state with a Clients link when nothing is archived", async () => {
    const server = await running();
    try {
      await seed(server.store);
      const reply = await send(server.origin, { path: "/archived" });
      assert.equal(reply.status, 200);
      assert.match(reply.body, /No archived records yet/);
      assert.match(reply.body, /href="\/clients"/);
    } finally {
      await server.close();
    }
  });

  it("is linked from the navigation on every page", async () => {
    const server = await running();
    try {
      await seed(server.store);
      for (const path of ["/", "/clients", "/archived"]) {
        const reply = await send(server.origin, { path });
        assert.equal(reply.status, 200, path);
        assert.match(reply.body, /<li><a href="\/archived">Archived<\/a><\/li>/, `${path} links Archived`);
      }
    } finally {
      await server.close();
    }
  });

  it("escapes stored names and reasons", async () => {
    const store = await openStore(tempDir());
    try {
      const s = await seed(store);
      await store.setArchived("client", s.client.id, true);
      const page = archivedPage(store);
      assert.ok(!page.html.includes("<Ltd>"), "stored markup is escaped");
      assert.ok(containsEscaped(page.html, s.client.name));
      assert.ok(containsEscaped(page.html, s.engagement.name));
    } finally {
      await store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Hiding from normal lists, counts and histories, with independent flags
// ---------------------------------------------------------------------------

describe("visible views agree on hidden records", () => {
  it("hides effectively archived work from lists, counts and histories without cascading flags", async () => {
    const server = await running();
    try {
      const s = await seed(server.store);
      // Two sibling tasks in the project, one archived by its own flag.
      const siblingTask = await server.store.createTask({
        clientId: s.client.id,
        engagementId: s.engagement.id,
        projectId: s.project.id,
        title: "Keep me",
        status: "open",
      });
      await server.store.setArchived("task", s.task.id, true);

      const projectPage = await send(server.origin, { path: `/projects/${s.project.id}` });
      assert.equal(projectPage.status, 200);
      assert.ok(!projectPage.body.includes(`href="/tasks/${s.task.id}"`), "archived task hidden");
      assert.ok(projectPage.body.includes(`href="/tasks/${siblingTask.id}"`), "active task shown");
      // The project page's counts agree with its list: only the active task.
      assert.match(projectPage.body, /<li>open: 1<\/li>/);
      // The item and meeting stay visible: archival of the task did not cascade.
      assert.ok(projectPage.body.includes(`href="/items/${s.item.id}"`));
      assert.ok(projectPage.body.includes(`href="/meetings/${s.meeting.id}"`));

      // The same holds through the helper selectors.
      const { projectWork } = await import("../src/work-pages.ts");
      const work = projectWork(server.store, s.client.id, s.engagement.id, s.project.id);
      assert.deepEqual(work.tasks.map((task) => task.title), ["Keep me"]);
      assert.deepEqual(work.items.map((item) => item.title), [s.item.title]);
    } finally {
      await server.close();
    }
  });

  it("hides inherited work when an ancestor is archived and restores it independently", async () => {
    const server = await running();
    try {
      const s = await seed(server.store);
      // Archive the project: its task, item and meeting are hidden through it,
      // but none of their own flags changes.
      await server.store.setArchived("project", s.project.id, true);
      const projectPage = await send(server.origin, { path: `/projects/${s.project.id}` });
      assert.equal(projectPage.status, 200);
      assert.ok(!projectPage.body.includes(`href="/tasks/${s.task.id}"`));
      assert.ok(!projectPage.body.includes(`href="/items/${s.item.id}"`));
      assert.ok(!projectPage.body.includes(`href="/meetings/${s.meeting.id}"`));
      assert.match(projectPage.body, /<li>open: 0<\/li>/);
      assert.equal(flagOf(server.store, "tasks", s.task.id), undefined, "the task keeps no flag");
      assert.equal(flagOf(server.store, "items", s.item.id), undefined, "the item keeps no flag");
      assert.equal(flagOf(server.store, "engagements", s.engagement.id), undefined);

      // Restoring the project reveals its children again; their flags are still
      // independent, so a child with its own flag stays hidden.
      await server.store.setArchived("task", s.task.id, true);
      await server.store.setArchived("project", s.project.id, false);
      const restored = await send(server.origin, { path: `/projects/${s.project.id}` });
      assert.ok(!restored.body.includes(`href="/tasks/${s.task.id}"`), "own-flag task still hidden");
      assert.ok(restored.body.includes(`href="/items/${s.item.id}"`), "item revealed");
      assert.ok(restored.body.includes(`href="/meetings/${s.meeting.id}"`), "meeting revealed");
    } finally {
      await server.close();
    }
  });

  it("hides archived clients from the Clients list and the navigation", async () => {
    const server = await running();
    try {
      const s = await seed(server.store);
      await server.store.setArchived("client", s.client.id, true);
      const list = await send(server.origin, { path: "/clients" });
      assert.equal(list.status, 200);
      assert.ok(!list.body.includes(`href="/clients/${s.client.id}"`), "archived client hidden from the list");
      assert.ok(list.body.includes(`href="/clients/${s.otherClient.id}"`), "active client shown");
      // The navigation never marks an archived client's detail page as current.
      const detail = await send(server.origin, { path: `/clients/${s.client.id}` });
      assert.equal(detail.status, 200, "the archived client's detail page is still usable");
      assert.ok(!detail.body.includes('aria-current="page">Acme'), "archived client is not a current nav entry");
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Detail, edit and create pages stay usable with a notice
// ---------------------------------------------------------------------------

describe("record pages stay usable when archived", () => {
  it("keeps archived detail and edit pages usable with a notice and a restore control", async () => {
    const server = await running();
    try {
      const s = await seed(server.store);
      await server.store.setArchived("task", s.task.id, true);

      const detail = await send(server.origin, { path: `/tasks/${s.task.id}` });
      assert.equal(detail.status, 200);
      assert.ok(detail.body.includes("This record is archived"), "detail shows the notice");
      assert.ok(containsEscaped(detail.body, s.task.title));
      assert.match(detail.body, new RegExp(`action="/tasks/${s.task.id}/unarchive"`), "restore control offered");

      const edit = await send(server.origin, { path: `/tasks/${s.task.id}/edit` });
      assert.equal(edit.status, 200);
      assert.ok(edit.body.includes("This record is archived"), "edit shows the notice");

      // A partial edit of the archived task still saves and re-shows the notice.
      const save = await send(server.origin, {
        method: "POST",
        path: `/tasks/${s.task.id}/edit`,
        form: { title: "Edited while archived" },
      });
      assert.equal(save.status, 303);
      assert.equal(redirectTarget(save), `/tasks/${s.task.id}`);
      const task = server.store.snapshot().tasks.find((candidate) => candidate.id === s.task.id)!;
      assert.equal(task.title, "Edited while archived");
      assert.equal(task.archived, true, "the partial edit keeps the flag");
    } finally {
      await server.close();
    }
  });

  it("shows the archive control on an active record's detail page", async () => {
    const server = await running();
    try {
      const s = await seed(server.store);
      const detail = await send(server.origin, { path: `/clients/${s.client.id}` });
      assert.equal(detail.status, 200);
      assert.ok(!detail.body.includes("This record is archived"), "active record has no notice");
      assert.match(detail.body, new RegExp(`action="/clients/${s.client.id}/archive"`), "archive control offered");
    } finally {
      await server.close();
    }
  });

  it("shows an inherited record's notice with a link to the archived ancestor", async () => {
    const server = await running();
    try {
      const s = await seed(server.store);
      await server.store.setArchived("project", s.project.id, true);
      for (const path of [`/tasks/${s.task.id}`, `/items/${s.item.id}`, `/meetings/${s.meeting.id}`, `/tasks/${s.task.id}/edit`]) {
        const reply = await send(server.origin, { path });
        assert.equal(reply.status, 200, path);
        assert.ok(reply.body.includes("This record is archived"), `${path} shows the notice`);
        assert.match(reply.body, new RegExp(`href="/projects/${s.project.id}"`), `${path} links the archived ancestor`);
      }
    } finally {
      await server.close();
    }
  });

  it("shows notices on archived parents' create and edit forms and still creates", async () => {
    const server = await running();
    try {
      const s = await seed(server.store);
      await server.store.setArchived("engagement", s.engagement.id, true);

      const edit = await send(server.origin, { path: `/engagements/${s.engagement.id}/edit` });
      assert.equal(edit.status, 200);
      assert.ok(edit.body.includes("This record is archived"));
      assert.match(edit.body, new RegExp(`action="/engagements/${s.engagement.id}/unarchive"`));

      // Creating a task under the archived engagement still works; the task then
      // inherits the engagement's hiding.
      const create = await send(server.origin, { path: `/engagements/${s.engagement.id}/tasks/new` });
      assert.equal(create.status, 200);
      assert.ok(create.body.includes("This record is archived"), "create form shows the parent's notice");
      const save = await send(server.origin, {
        method: "POST",
        path: `/engagements/${s.engagement.id}/tasks/new`,
        form: { engagementId: s.engagement.id, title: "New inheriting task" },
      });
      assert.equal(save.status, 303);
      const created = server.store.snapshot().tasks.find((task) => task.title === "New inheriting task")!;
      assert.equal(created.archived, undefined, "the new task has no flag of its own");

      // Creating an engagement under an archived client is likewise allowed.
      const newEngagement = await send(server.origin, { path: `/clients/${s.client.id}/engagements/new` });
      assert.equal(newEngagement.status, 200, "a client's create form stays usable");
      assert.equal(flagOf(server.store, "clients", s.client.id), undefined);
    } finally {
      await server.close();
    }
  });

  it("keeps original URLs usable regardless of the record's current stored links", async () => {
    const server = await running();
    try {
      const s = await seed(server.store);
      await server.store.setArchived("client", s.client.id, true);
      for (const path of [
        `/clients/${s.client.id}`,
        `/clients/${s.client.id}/edit`,
        `/clients/${s.client.id}/engagements/new`,
        `/engagements/${s.engagement.id}`,
        `/engagements/${s.engagement.id}/edit`,
        `/engagements/${s.engagement.id}/projects/new`,
        `/projects/${s.project.id}`,
        `/projects/${s.project.id}/edit`,
        `/tasks/${s.task.id}`,
        `/tasks/${s.task.id}/edit`,
        `/items/${s.item.id}`,
        `/items/${s.item.id}/edit`,
        `/meetings/${s.meeting.id}`,
        `/meetings/${s.meeting.id}/edit`,
      ]) {
        const reply = await send(server.origin, { path });
        assert.equal(reply.status, 200, path);
      }
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Archived project choices stay available in forms
// ---------------------------------------------------------------------------

describe("forms keep archived project choices", () => {
  it("offers every valid in-engagement project, labelling archived ones", async () => {
    const server = await running();
    try {
      const s = await seed(server.store);
      await server.store.setArchived("project", s.project.id, true);

      // The engagement's new-task form offers the archived project, labelled.
      const create = await send(server.origin, { path: `/engagements/${s.engagement.id}/tasks/new` });
      assert.equal(create.status, 200);
      const options = [...create.body.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)];
      const archivedChoice = options.find((option) => option[1] === s.project.id);
      assert.ok(archivedChoice !== undefined, "the archived project stays an available choice");
      assert.match(archivedChoice[3], /\(archived\)/, "the archived choice is labelled");
      assert.ok(!archivedChoice[2].includes("disabled"), "the archived choice is not disabled");

      // Choosing it on a create still works, and the new record inherits hiding.
      const save = await send(server.origin, {
        method: "POST",
        path: `/engagements/${s.engagement.id}/tasks/new`,
        form: { engagementId: s.engagement.id, title: "Under archived project", projectId: s.project.id },
      });
      assert.equal(save.status, 303);
      const created = server.store.snapshot().tasks.find((task) => task.title === "Under archived project")!;
      assert.equal(created.projectId, s.project.id);

      // A meeting edit keeps the archived project choice labelled too.
      const meetingEdit = await send(server.origin, { path: `/meetings/${s.meeting.id}/edit` });
      assert.equal(meetingEdit.status, 200);
      const meetingOptions = [...meetingEdit.body.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)];
      const meetingChoice = meetingOptions.find((option) => option[1] === s.project.id);
      assert.ok(meetingChoice !== undefined, "the archived project is offered on the meeting form");
      assert.match(meetingChoice[3], /\(archived\)/);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The route table registers the endpoints
// ---------------------------------------------------------------------------

describe("archive routes are registered", () => {
  it("registers POST archive and unarchive for all five families and no GET", async () => {
    const store = await openStore(tempDir());
    try {
      const routes = archiveRoutes(store);
      assert.equal(routes.archive.post?.method, "POST");
      assert.equal(routes.unarchive.post?.method, "POST");
      assert.equal(routes.archive.get, undefined);
      assert.equal(routes.unarchive.get, undefined);
      // The full table dispatches them, so the shell answers 405 to a GET.
      const server = await startServer({ store, port: 0, routes: registerRoutes(store) });
      try {
        const reply = await send(server.origin, { path: "/tasks/task-1/archive" });
        assert.equal(reply.status, 405);
      } finally {
        await server.close();
      }
    } finally {
      await store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Restoring an ancestor preserves independent child flags
// ---------------------------------------------------------------------------

describe("restoring ancestors preserves child flags", () => {
  it("keeps a child's own flag when an archived ancestor is restored", async () => {
    const server = await running();
    try {
      const s = await seed(server.store);
      await server.store.setArchived("client", s.client.id, true);
      await server.store.setArchived("task", s.task.id, true);

      // Before restoring the client, the task is listed under its own family
      // (its nearest archive is its own flag), and no other record is.
      const before = archivedGroups(server.store.snapshot());
      assert.deepEqual(before.map((group) => group.title), ["Clients", "Tasks"]);
      const taskEntry = before.find((group) => group.family === "tasks")!.entries[0];
      assert.equal(taskEntry.inheritedOnly, false);
      assert.equal(taskEntry.reason, "self");

      // Restoring the client must not restore the task: its own flag is
      // independent. It is now the only archived record and still listed.
      await server.store.setArchived("client", s.client.id, false);
      assert.equal(flagOf(server.store, "clients", s.client.id), undefined);
      assert.equal(flagOf(server.store, "tasks", s.task.id), true, "the child keeps its own flag");
      const after = archivedGroups(server.store.snapshot());
      assert.deepEqual(after.map((group) => group.title), ["Tasks"]);
      assert.equal(after[0].entries[0].entry.href, `/tasks/${s.task.id}`);

      const page = await send(server.origin, { path: "/archived" });
      assert.equal(page.status, 200);
      assert.match(page.body, new RegExp(`href="/tasks/${s.task.id}"`));
      // The restored client is no longer an archived entry: it is not in the
      // main content of the discovery page, only in the global navigation.
      const main = page.body.slice(page.body.indexOf('<main id="main">'), page.body.indexOf("</main>"));
      assert.ok(!main.includes(`href="/clients/${s.client.id}"`), "the restored client is no longer archived");
    } finally {
      await server.close();
    }
  });
});
