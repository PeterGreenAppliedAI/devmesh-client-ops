import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { escapeHtml } from "../src/html.ts";
import {
  DEFAULT_PORT,
  cliEnvironment,
  defaultDataDirectory,
  isEntryPoint,
  main,
  parseCliArguments,
  registerRoutes,
  startApplication,
  CliError,
  StartupError,
  health,
  type Application,
  type CliEnvironment,
} from "../src/index.ts";
import { startServer, canonicalOrigin } from "../src/server.ts";
import { openStore, MissingRecordError, type Store } from "../src/store.ts";

// ---------------------------------------------------------------------------
// Fixtures and HTTP helpers
// ---------------------------------------------------------------------------

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hierarchy-"));
  roots.push(dir);
  return dir;
}

interface Running {
  readonly origin: string;
  readonly port: number;
  readonly store: Store;
  close(): Promise<void>;
}

/**
 * Start a server over a real on-disk store with the application's routes,
 * always on an ephemeral port so tests never clash with a fixed port.
 */
async function running(): Promise<Running> {
  const store = await openStore(tempDir());
  const server = await startServer({ store, port: 0, routes: registerRoutes(store) });
  return {
    origin: server.origin,
    port: server.port,
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
  readonly form?: Record<string, string>;
}

function formBody(form: Record<string, string>): string {
  return new URLSearchParams(form).toString();
}

/** Send a request to the running server over loopback HTTP. */
function send(base: string, options: RequestOptions = {}): Promise<Reply> {
  const url = new URL(base);
  const method = options.method ?? "GET";
  const body = options.form === undefined ? "" : formBody(options.form);
  const headers: Record<string, string | number> = {
    host: options.host ?? url.host,
    "content-length": Buffer.byteLength(body),
  };
  if (method === "POST") {
    headers["content-type"] = "application/x-www-form-urlencoded";
    // A same-origin Origin header is required for POST; it defaults to the
    // canonical origin unless a test overrides it.
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

/** True when a page body contains the escaped form of `text`. */
function containsEscaped(body: string, text: string): boolean {
  return body.includes(escapeHtml(text));
}

function assertNoRaw(body: string, hostile: string): void {
  // The hostile text must not appear as raw markup; only its escaped form.
  assert.ok(!body.includes(hostile), `hostile text must be escaped, found ${JSON.stringify(hostile)}`);
  assert.ok(containsEscaped(body, hostile), `escaped hostile text must be shown: ${JSON.stringify(hostile)}`);
}

/** A client profile with every field populated, including hostile text. */
function fullProfile(): Record<string, string> {
  return {
    name: "Acme <Ltd>",
    background: "Founded < 1990 & grew",
    contacts: 'Ada "Lovelace" <ada@example.test>',
    stakeholders: "Board & 'staff'",
    requirements: "Must <work> offline",
    objectives: "Ship <v1> & learn",
  };
}

// ---------------------------------------------------------------------------
// health, entry point and CLI parsing (no listener started)
// ---------------------------------------------------------------------------

describe("index exports and entry point", () => {
  it("keeps exported health() returning ok", () => {
    assert.deepEqual(health(), { status: "ok" });
  });

  it("importing index.ts does not start a listener", async () => {
    // Import resolved through the module cache; if index.ts had started a
    // listener on import, this import would have bound a port. Check that the
    // default port is free after importing by binding it ourselves.
    const { createServer } = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(DEFAULT_PORT, "127.0.0.1", () => {
        probe.close(() => resolve());
      });
    });
  });

  it("recognises its own entry point and not an import", () => {
    const entry = join(tempDir(), "index.js");
    const url = new URL(`file://${entry.replace(/\\/g, "/")}`).href;
    assert.equal(isEntryPoint(url, ["node", entry]), true);
    assert.equal(isEntryPoint(url, ["node", "dist/other.js"]), false);
    assert.equal(isEntryPoint(url, ["node"]), false);
  });

  it("defaults the data directory to a location under the user's home", () => {
    const dir = defaultDataDirectory();
    // The default is an absolute location outside the repository working
    // directory, so workspace data never lands in the source tree.
    assert.ok(dir.length > 0);
    const cwd = process.cwd();
    assert.equal(dir === cwd, false);
    assert.ok(!dir.startsWith(cwd + (cwd.endsWith("/") ? "" : "/")));
  });
});

describe("CLI argument parsing", () => {
  const defaults = { dataDirectory: "/home/user/data" };

  it("defaults to port 3000 and the default data directory", () => {
    assert.deepEqual(parseCliArguments([], defaults), {
      port: DEFAULT_PORT,
      dataDirectory: "/home/user/data",
    });
    assert.equal(DEFAULT_PORT, 3000);
  });

  it("accepts --port and --data-dir in any order", () => {
    assert.deepEqual(parseCliArguments(["--port", "8080", "--data-dir", "/tmp/x"], defaults), {
      port: 8080,
      dataDirectory: "/tmp/x",
    });
    assert.deepEqual(parseCliArguments(["--data-dir", "/tmp/x", "--port", "1"], defaults), {
      port: 1,
      dataDirectory: "/tmp/x",
    });
  });

  it("rejects invalid ports and unknown arguments clearly", () => {
    for (const bad of ["0", "65536", "abc", "-1", "3000.5", "1e3", ""]) {
      assert.throws(() => parseCliArguments(["--port", bad], defaults), CliError, bad);
    }
    assert.throws(() => parseCliArguments(["--bogus"], defaults), /Unknown argument/);
    assert.throws(() => parseCliArguments(["--port"], defaults), /Missing value/);
    assert.throws(() => parseCliArguments(["--port", "--data-dir", "/x"], defaults), /Missing value/);
    assert.throws(() => parseCliArguments(["--port", "3000", "--port", "3001"], defaults), /once/);
    assert.throws(() => parseCliArguments(["--data-dir", "/a", "--data-dir", "/b"], defaults), /once/);
  });
});

// ---------------------------------------------------------------------------
// CLI startup, shutdown and failure cleanup, with an injected environment
// ---------------------------------------------------------------------------

interface CliRecorder {
  readonly environment: CliEnvironment;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly exits: number[];
  readonly handlers: (() => void)[];
}

function recordingEnvironment(
  args: string[],
  start: CliEnvironment["start"],
): CliRecorder {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const handlers: (() => void)[] = [];
  return {
    stdout,
    stderr,
    exits,
    handlers,
    environment: {
      args,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      defaultDataDirectory: "/home/user/default",
      start,
      onShutdown: (handler) => {
        handlers.push(handler);
        return () => {
          const at = handlers.indexOf(handler);
          if (at >= 0) handlers.splice(at, 1);
        };
      },
      exit: (code) => exits.push(code),
    },
  };
}

/** A fake application that records its close count. */
function fakeApplication(url: string): { application: Application; closes: () => number } {
  let closes = 0;
  return {
    closes: () => closes,
    application: {
      url,
      port: Number(new URL(url).port),
      async close() {
        closes += 1;
      },
    },
  };
}

describe("CLI main and startup cleanup", () => {
  it("prints the canonical URL and releases resources on shutdown", async () => {
    const runningApp = await running();
    const recorded = recordingEnvironment([], async (options) => {
      assert.equal(options.port, DEFAULT_PORT);
      assert.equal(options.dataDirectory, "/home/user/default");
      return {
        url: runningApp.origin,
        port: runningApp.port,
        close: async () => {
          await runningApp.close();
        },
      };
    });
    try {
      const result = await main(recorded.environment);
      assert.ok(result !== null);
      assert.deepEqual(recorded.stdout, [`Listening on ${runningApp.origin}`]);
      assert.deepEqual(recorded.exits, []);
      // The shutdown handler is registered but not yet fired.
      assert.equal(recorded.handlers.length, 1);
      await result.shutdown();
      // After shutdown the handler is removed and the app is closed exactly once.
      assert.equal(recorded.handlers.length, 0);
      // Closing again is idempotent.
      await result.shutdown();
      // The listener is really gone: a request is refused.
      await assert.rejects(send(runningApp.origin, {}));
    } finally {
      // The fake may have closed already; closing again is idempotent.
      await runningApp.close().catch(() => undefined);
    }
  });

  it("shuts down through a signal handler and exits 0", async () => {
    const fake = fakeApplication("http://127.0.0.1:3000");
    const recorded = recordingEnvironment([], async () => fake.application);
    const result = await main(recorded.environment);
    assert.ok(result !== null);
    assert.equal(recorded.handlers.length, 1);
    // Fire the registered shutdown handler, as a SIGINT would.
    recorded.handlers[0]();
    // Let the shutdown promise (and its exit call) settle.
    await result.shutdown();
    assert.equal(fake.closes(), 1);
    assert.deepEqual(recorded.exits, [0]);
  });

  it("rejects an invalid argument without starting anything", async () => {
    let started = 0;
    const recorded = recordingEnvironment(["--port", "not-a-number"], async () => {
      started += 1;
      return fakeApplication("http://127.0.0.1:3000").application;
    });
    const result = await main(recorded.environment);
    assert.equal(result, null);
    assert.equal(started, 0);
    assert.deepEqual(recorded.exits, [2]);
    assert.equal(recorded.stderr.length, 1);
    assert.match(recorded.stderr[0], /Invalid port/);
    assert.deepEqual(recorded.stdout, []);
  });

  it("exits 1 with a clear message when startup fails", async () => {
    const recorded = recordingEnvironment([], async () => {
      throw new StartupError("Port 3000 is already in use");
    });
    const result = await main(recorded.environment);
    assert.equal(result, null);
    assert.deepEqual(recorded.exits, [1]);
    assert.deepEqual(recorded.stdout, []);
    assert.match(recorded.stderr[0], /already in use/);
    // No shutdown handler is registered after a failed startup.
    assert.equal(recorded.handlers.length, 0);
  });
});

describe("startApplication startup and cleanup", () => {
  it("starts on an ephemeral port, prints a canonical URL, and releases on close", async () => {
    const dir = tempDir();
    const app = await startApplication({ dataDirectory: dir, port: 0 });
    try {
      assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(new URL(app.url).port, String(app.port));
      const reply = await send(app.url, { path: "/clients" });
      assert.equal(reply.status, 200);
    } finally {
      await app.close();
    }
    // After close, the store lock is released: a fresh open succeeds.
    const reopened = await openStore(dir);
    await reopened.close();
  });

  it("cleans up the store when the port is already occupied", async () => {
    // Bind an occupied port with a plain listener, then start the application
    // on that port. The startup must fail clearly and release the store it
    // opened before starting the server, so the lock is gone afterwards.
    const { createServer } = await import("node:net");
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const address = blocker.address();
    assert.ok(address !== null && typeof address !== "string");
    const port = address.port;
    const dir = tempDir();
    try {
      await assert.rejects(
        startApplication({ dataDirectory: dir, port }),
        (error: unknown) => {
          assert.ok(error instanceof StartupError);
          assert.match(error.message, /Port \d+ is already in use/);
          return true;
        },
      );
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
    // The store lock from the failed startup is released; reopening works and
    // the workspace is empty (no partial data was written).
    const reopened = await openStore(dir);
    try {
      assert.equal(reopened.snapshot().clients.length, 0);
    } finally {
      await reopened.close();
    }
  });

  it("reports a clear message when the data directory cannot be opened", async () => {
    // Inject a failing file system through openStore's interface is not
    // reachable from startApplication, so exercise a real failure: a path that
    // is a regular file, which cannot be a directory on any platform.
    const file = join(tempDir(), "not-a-dir");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, "x");
    await assert.rejects(
      startApplication({ dataDirectory: file, port: 0 }),
      (error: unknown) => {
        assert.ok(error instanceof StartupError);
        assert.match(error.message, /Cannot open the workspace store/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Hierarchy pages: rendering and HTTP form submissions
// ---------------------------------------------------------------------------

describe("hierarchy pages", () => {
  it("lists clients and links to the new-client form", async () => {
    const server = await running();
    try {
      const empty = await send(server.origin, { path: "/clients" });
      assert.equal(empty.status, 200);
      assert.match(empty.headers["content-type"] as string, /^text\/html/);
      assert.match(empty.body, /href="\/clients\/new"/);
      assert.match(empty.body, /None yet/);
      // A GET never mutates.
      assert.equal(server.store.snapshot().clients.length, 0);
    } finally {
      await server.close();
    }
  });

  it("creates a full client profile, redirects and reopens it", async () => {
    const server = await running();
    try {
      const created = await send(server.origin, {
        method: "POST",
        path: "/clients/new",
        form: fullProfile(),
      });
      const target = redirectTarget(created);
      assert.match(target, /^\/clients\/client-1$/);

      const detail = await send(server.origin, { path: target });
      assert.equal(detail.status, 200);
      // Every profile field is shown, escaped.
      for (const value of Object.values(fullProfile())) {
        assert.ok(containsEscaped(detail.body, value), `profile field shown: ${value}`);
      }
      assertNoRaw(detail.body, "Acme <Ltd>");
      assertNoRaw(detail.body, "Must <work> offline");
      // Breadcrumbs/navigation link back to the list.
      assert.match(detail.body, /href="\/clients"/);

      // The list now links the client.
      const list = await send(server.origin, { path: "/clients" });
      assert.ok(containsEscaped(list.body, "Acme <Ltd>"));
    } finally {
      await server.close();
    }
  });

  it("persists a created client across reopening the store", async () => {
    const dir = tempDir();
    let store = await openStore(dir);
    let app = await startServer({ store, port: 0, routes: registerRoutes(store) });
    let id: string;
    try {
      const created = await send(app.origin, {
        method: "POST",
        path: "/clients/new",
        form: fullProfile(),
      });
      id = redirectTarget(created).split("/").pop() as string;
    } finally {
      await app.close();
      await store.close();
    }
    store = await openStore(dir);
    app = await startServer({ store, port: 0, routes: registerRoutes(store) });
    try {
      const detail = await send(app.origin, { path: `/clients/${id}` });
      assert.equal(detail.status, 200);
      for (const value of Object.values(fullProfile())) {
        assert.ok(containsEscaped(detail.body, value));
      }
    } finally {
      await app.close();
      await store.close();
    }
  });

  it("edits a client profile and redirects to the saved record", async () => {
    const server = await running();
    try {
      const client = await server.store.createClient({ name: "Old", background: "b" });
      const form = await send(server.origin, { path: `/clients/${client.id}/edit` });
      assert.equal(form.status, 200);
      assert.match(form.body, /<form method="post"/);
      assert.match(form.body, /name="background"/);
      assert.match(form.body, new RegExp(`value="Old"`));
      // A hidden id travels with the edit.
      assert.match(form.body, /type="hidden" name="id"/);

      const edited = await send(server.origin, {
        method: "POST",
        path: `/clients/${client.id}/edit`,
        form: { ...fullProfile(), id: client.id },
      });
      assert.equal(redirectTarget(edited), `/clients/${client.id}`);
      const stored = server.store.snapshot().clients[0];
      assert.equal(stored.name, fullProfile().name);
      assert.equal(stored.objectives, fullProfile().objectives);
    } finally {
      await server.close();
    }
  });

  it("creates two engagements and two projects with child lists and breadcrumbs", async () => {
    const server = await running();
    try {
      const client = await server.store.createClient({ name: "Acme" });

      // Engagement create form links from the client detail page.
      const clientPage = await send(server.origin, { path: `/clients/${client.id}` });
      assert.match(clientPage.body, new RegExp(`/clients/${client.id}/engagements/new`));

      const newEngagementPath = `/clients/${client.id}/engagements/new`;
      const newEngagement = await send(server.origin, { path: newEngagementPath });
      assert.equal(newEngagement.status, 200);
      assert.match(newEngagement.body, /<form method="post"/);
      // The parent client id travels as a hidden field, and the form posts to
      // the collection's new endpoint.
      assert.match(newEngagement.body, new RegExp(`type="hidden" name="clientId" value="${client.id}"`));
      assert.match(newEngagement.body, /action="\/engagements\/new"/);

      const engagementIds: string[] = [];
      for (const name of ["Discovery", "Delivery"]) {
        const reply = await send(server.origin, {
          method: "POST",
          path: "/engagements/new",
          form: { clientId: client.id, name, objectives: `${name} objectives`, status: "active" },
        });
        engagementIds.push(redirectTarget(reply).split("/").pop() as string);
      }
      assert.equal(engagementIds.length, 2);

      // The client page lists both engagements as children.
      const withChildren = await send(server.origin, { path: `/clients/${client.id}` });
      for (const name of ["Discovery", "Delivery"]) {
        assert.ok(containsEscaped(withChildren.body, name), name);
      }

      const projectIds: string[] = [];
      for (const engagementId of engagementIds) {
        const detail = await send(server.origin, { path: `/engagements/${engagementId}` });
        assert.equal(detail.status, 200);
        assert.match(detail.body, new RegExp(`/engagements/${engagementId}/projects/new`));
        // Breadcrumb back to the client.
        assert.match(detail.body, new RegExp(`href="/clients/${client.id}"`));
        // The new-project form is reachable and posts to the collection endpoint.
        const form = await send(server.origin, { path: `/engagements/${engagementId}/projects/new` });
        assert.equal(form.status, 200);
        assert.match(form.body, new RegExp(`type="hidden" name="engagementId" value="${engagementId}"`));
        assert.match(form.body, /action="\/projects\/new"/);
        const reply = await send(server.origin, {
          method: "POST",
          path: "/projects/new",
          form: { engagementId, name: `Project of ${engagementId}`, objectives: "o", status: "planned" },
        });
        projectIds.push(redirectTarget(reply).split("/").pop() as string);
      }
      assert.equal(projectIds.length, 2);

      // Each engagement lists its own project only.
      for (let index = 0; index < engagementIds.length; index += 1) {
        const detail = await send(server.origin, { path: `/engagements/${engagementIds[index]}` });
        assert.ok(containsEscaped(detail.body, `Project of ${engagementIds[index]}`));
        const other = engagementIds[1 - index];
        assert.ok(!detail.body.includes(`Project of ${other}`));
      }

      // The project detail shows the full breadcrumb chain: client, engagement.
      const project = await send(server.origin, { path: `/projects/${projectIds[0]}` });
      assert.equal(project.status, 200);
      assert.match(project.body, new RegExp(`href="/clients/${client.id}"`));
      assert.match(project.body, new RegExp(`href="/engagements/${engagementIds[0]}"`));
    } finally {
      await server.close();
    }
  });

  it("edits objectives and statuses and keeps other fields", async () => {
    const server = await running();
    try {
      const client = await server.store.createClient({ name: "Acme" });
      const engagement = await server.store.createEngagement({
        clientId: client.id,
        name: "Discovery",
        objectives: "old objectives",
        status: "planned",
      });
      const project = await server.store.createProject({
        engagementId: engagement.id,
        name: "Prototype",
        objectives: "old",
        status: "planned",
      });

      const editedEngagement = await send(server.origin, {
        method: "POST",
        path: `/engagements/${engagement.id}/edit`,
        form: { id: engagement.id, name: "Discovery", objectives: "new objectives", status: "active" },
      });
      assert.equal(redirectTarget(editedEngagement), `/engagements/${engagement.id}`);
      const storedEngagement = server.store.snapshot().engagements[0];
      assert.equal(storedEngagement.objectives, "new objectives");
      assert.equal(storedEngagement.status, "active");
      assert.equal(storedEngagement.name, "Discovery");

      const editedProject = await send(server.origin, {
        method: "POST",
        path: `/projects/${project.id}/edit`,
        form: { id: project.id, name: "Prototype", objectives: "new", status: "completed" },
      });
      assert.equal(redirectTarget(editedProject), `/projects/${project.id}`);
      const storedProject = server.store.snapshot().projects[0];
      assert.equal(storedProject.objectives, "new");
      assert.equal(storedProject.status, "completed");
    } finally {
      await server.close();
    }
  });

  it("rejects invalid input without mutating the store and keeps submitted values", async () => {
    const server = await running();
    try {
      const before = JSON.stringify(server.store.snapshot());
      const invalid = await send(server.origin, {
        method: "POST",
        path: "/clients/new",
        form: { ...fullProfile(), name: "   " },
      });
      assert.equal(invalid.status, 400);
      assert.match(String(invalid.headers["content-type"]), /^text\/html/);
      assert.match(invalid.body, /role="alert"/);
      // The submitted values are preserved for correction: every other field
      // survives, and the invalid name is shown in its control too.
      const submitted = { ...fullProfile(), name: "   " };
      for (const [field, value] of Object.entries(submitted)) {
        if (field === "name") continue;
        assert.ok(containsEscaped(invalid.body, value), `kept submitted value ${value}`);
      }
      assert.match(invalid.body, /value="   "/);
      // Nothing was written.
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // An invalid status is refused too, with values kept.
      const client = await server.store.createClient({ name: "Acme" });
      const engagementBefore = JSON.stringify(server.store.snapshot().engagements);
      const badStatus = await send(server.origin, {
        method: "POST",
        path: "/engagements/new",
        form: { clientId: client.id, name: "E", objectives: "keep me", status: "nope" },
      });
      assert.equal(badStatus.status, 400);
      assert.ok(invalid.body.includes("role=\"alert\""));
      assert.ok(containsEscaped(badStatus.body, "keep me"));
      assert.equal(JSON.stringify(server.store.snapshot().engagements), engagementBefore);
    } finally {
      await server.close();
    }
  });

  it("shows a missing-record error for an unknown id", async () => {
    const server = await running();
    try {
      for (const path of ["/clients/client-99", "/engagements/engagement-99", "/projects/project-99"]) {
        const reply = await send(server.origin, { path });
        assert.equal(reply.status, 404, path);
        assert.match(reply.body, /Not found/);
      }
    } finally {
      await server.close();
    }
  });

  it("escapes hostile text in the client list, details and edit forms", async () => {
    const server = await running();
    try {
      const hostile = '<script>alert("x")</script>&';
      const created = await send(server.origin, {
        method: "POST",
        path: "/clients/new",
        form: { name: hostile, background: hostile, objectives: hostile },
      });
      const target = redirectTarget(created);
      for (const path of ["/clients", target, `${target}/edit`]) {
        const reply = await send(server.origin, { path });
        assert.equal(reply.status, 200, path);
        assertNoRaw(reply.body, hostile);
        assert.ok(containsEscaped(reply.body, hostile), path);
      }
    } finally {
      await server.close();
    }
  });

  it("rejects an edit for a record that is missing without mutating", async () => {
    const server = await running();
    try {
      const before = JSON.stringify(server.store.snapshot());
      const reply = await send(server.origin, {
        method: "POST",
        path: "/clients/client-99/edit",
        form: { id: "client-99", ...fullProfile() },
      });
      assert.equal(reply.status, 404);
      assert.equal(JSON.stringify(server.store.snapshot()), before);
    } finally {
      await server.close();
    }
  });

  it("refuses POST where only GET is registered, without invoking a handler", async () => {
    const server = await running();
    try {
      const before = JSON.stringify(server.store.snapshot());
      for (const path of ["/clients", "/clients/client-1", "/engagements/engagement-1"]) {
        const reply = await send(server.origin, { method: "POST", path, form: { name: "x" } });
        assert.equal(reply.status, 405, path);
      }
      assert.equal(JSON.stringify(server.store.snapshot()), before);
    } finally {
      await server.close();
    }
  });

  it("refuses unregistered paths and keeps POST-only endpoints method-guarded", async () => {
    const server = await running();
    try {
      // A path the hierarchy matcher does not know is a plain 404.
      for (const path of ["/unknown", "/clients/", "/clients/client-1/other"]) {
        const reply = await send(server.origin, { path });
        assert.equal(reply.status, 404, path);
      }
      // The collection new endpoints are POST-only; GET is refused by the
      // shell before any handler runs, and the store is untouched.
      const before = JSON.stringify(server.store.snapshot());
      for (const path of ["/engagements/new", "/projects/new"]) {
        const reply = await send(server.origin, { path });
        assert.equal(reply.status, 405, path);
        assert.equal(reply.headers.allow, "GET, POST", path);
      }
      // A same-origin POST to a path with no POST route is refused too.
      const childNew = await send(server.origin, {
        method: "POST",
        path: "/clients/client-99/engagements/new",
        form: { name: "x" },
      });
      assert.equal(childNew.status, 405);
      assert.equal(JSON.stringify(server.store.snapshot()), before);
    } finally {
      await server.close();
    }
  });

  it("keeps the Host check ahead of hierarchy dispatch", async () => {
    const server = await running();
    try {
      // A foreign Host is refused before the hierarchy path is matched, so a
      // handler that would mutate never runs.
      const before = JSON.stringify(server.store.snapshot());
      const reply = await send(server.origin, {
        method: "POST",
        path: "/clients/new",
        host: "evil.example",
        form: { name: "x" },
      });
      assert.equal(reply.status, 403);
      assert.equal(JSON.stringify(server.store.snapshot()), before);
    } finally {
      await server.close();
    }
  });

  it("keeps the Host/Origin check on hierarchy routes", async () => {
    const server = await running();
    try {
      // A foreign Origin on a POST is refused before any handler runs.
      const before = JSON.stringify(server.store.snapshot());
      const foreign = await send(server.origin, {
        method: "POST",
        path: "/clients/new",
        origin: "http://evil.example",
        form: { name: "x" },
      });
      assert.equal(foreign.status, 403);
      assert.equal(JSON.stringify(server.store.snapshot()), before);
    } finally {
      await server.close();
    }
  });
});

describe("hierarchy route matching", () => {
  it("registers the canonical list and detail routes plus explicit forms", async () => {
    const store = await openStore(tempDir());
    try {
      const routes = registerRoutes(store);
      assert.ok(routes.hierarchy !== undefined);
      const match = routes.hierarchy.match;
      assert.deepEqual(match("/clients"), { pattern: "/clients", id: "" });
      assert.deepEqual(match("/clients/client-1"), { pattern: "/clients/:id", id: "client-1" });
      assert.deepEqual(match("/clients/client-1/edit"), { pattern: "/clients/:id/edit", id: "client-1" });
      assert.deepEqual(match("/clients/new"), { pattern: "/clients/new", id: "" });
      assert.deepEqual(match("/engagements/engagement-1"), { pattern: "/engagements/:id", id: "engagement-1" });
      assert.deepEqual(match("/engagements/new"), { pattern: "/engagements/new", id: "" });
      assert.deepEqual(match("/engagements/engagement-1/projects/new"), { pattern: "/engagements/:id/projects/new", id: "engagement-1" });
      assert.deepEqual(match("/clients/client-1/engagements/new"), { pattern: "/clients/:id/engagements/new", id: "client-1" });
      assert.deepEqual(match("/projects/project-1"), { pattern: "/projects/:id", id: "project-1" });
      assert.deepEqual(match("/projects/new"), { pattern: "/projects/new", id: "" });
      // Paths outside the hierarchy patterns are not matched.
      for (const path of ["/", "/health", "/unknown", "/clients/", "/clients/client-1/other"]) {
        assert.equal(match(path), null, path);
      }
    } finally {
      await store.close();
    }
  });

  it("derives the canonical URL from the same origin helper", () => {
    assert.equal(canonicalOrigin(3000).origin, "http://127.0.0.1:3000");
    assert.equal(new URL(`http://127.0.0.1:${DEFAULT_PORT}`).origin, canonicalOrigin(DEFAULT_PORT).origin);
  });

  it("reports a missing record error type from a detail lookup", async () => {
    const store = await openStore(tempDir());
    try {
      const server = await startServer({ store, port: 0, routes: registerRoutes(store) });
      try {
        const reply = await send(server.origin, { path: "/engagements/missing" });
        assert.equal(reply.status, 404);
      } finally {
        await server.close();
      }
      // The store itself raises MissingRecordError; the route maps it to 404.
      await assert.rejects(store.updateEngagement("engagement-99", { name: "x" }), MissingRecordError);
    } finally {
      await store.close();
    }
  });
});
