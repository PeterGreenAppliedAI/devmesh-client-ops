import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { escapeHtml } from "../src/html.ts";
import {
  DEFAULT_PORT,
  cliEnvironment,
  defaultDataDirectory,
  requireOutsideRepository,
  isEntryPoint,
  main,
  parseCliArguments,
  registerRoutes,
  startApplication,
  REAL_DEPENDENCIES,
  CliError,
  StartupError,
  health,
  type Application,
  type ApplicationDependencies,
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

  it("importing index.ts starts no listener, in an isolated child process", async () => {
    // The import runs in a fresh Node process, so no other test's listener or
    // a listener on a fixed port can confuse the result. The child imports
    // index.ts, then reports whether the process holds any TCP listening handle
    // of its own. An import that started a listener would show one.
    const { spawnSync } = await import("node:child_process");
    const script = [
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "src/index.ts")).href)});`,
      'const { getActiveResourcesInfo } = await import("node:process");',
      'await new Promise((resolve) => setTimeout(resolve, 50));',
      'const listeners = getActiveResourcesInfo().filter((name) => name === "TCPServerWrap" || name === "TCPSocketWrap");',
      'process.stdout.write(JSON.stringify(listeners));',
    ].join("\n");
    const child = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", script],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    // A socket from the eval harness itself is not the module's; the module
    // must hold no listening handle. No listener means no TCPServerWrap.
    const listeners = JSON.parse(child.stdout) as string[];
    assert.ok(!listeners.includes("TCPServerWrap"), `import started a listener: ${child.stdout}`);
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

  it("refuses a data directory inside the repository", () => {
    // Portable containment check using join/relative, no POSIX-only path.
    const repository = join(tempDir(), "repo");
    const inside = join(repository, "workspace", "data");
    const outside = join(tempDir(), "elsewhere", "data");
    assert.throws(() => requireOutsideRepository(inside, repository), StartupError);
    assert.throws(() => requireOutsideRepository(repository, repository), StartupError);
    assert.equal(requireOutsideRepository(outside, repository), outside);
    // The CLI refuses it clearly before starting anything and exits 2.
    const recorded = recordingEnvironment(["--data-dir", inside], async () => {
      throw new Error("must not start");
    });
    (recorded.environment as { repositoryDirectory?: string }).repositoryDirectory = repository;
    return main(recorded.environment).then((result) => {
      assert.equal(result, null);
      assert.deepEqual(recorded.exits, [2]);
      assert.equal(recorded.stderr.length, 1);
      assert.match(recorded.stderr[0], /inside the repository/);
      assert.deepEqual(recorded.stdout, []);
    });
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

  it("releases the opened store when the server fails to start through injection", async () => {
    // The occupied-port error is injected through the start dependency, and the
    // store is a recording stub, so the cleanup is observed directly rather
    // than induced by binding a real port or touching the environment.
    let closed = 0;
    const store = {
      closed: () => closed,
      async close() {
        closed += 1;
      },
    } as unknown as Store;
    let started = 0;
    const failure = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    const dependencies: ApplicationDependencies = {
      open: async () => store,
      start: async () => {
        started += 1;
        throw failure;
      },
    };
    await assert.rejects(
      startApplication({ dataDirectory: tempDir(), port: 3000 }, dependencies),
      (error: unknown) => {
        assert.ok(error instanceof StartupError);
        assert.match(error.message, /Port 3000 is already in use/);
        return true;
      },
    );
    assert.equal(started, 1);
    // Startup released the store it opened, so its lock is not left behind.
    assert.equal(closed, 1);
  });

  it("reports a store release failure alongside the startup failure", async () => {
    // A failed store close must not be swallowed while reporting the startup
    // failure: both are reported. Everything is injected.
    let closed = 0;
    const store = {
      async close() {
        closed += 1;
        throw new Error("lock still held");
      },
    } as unknown as Store;
    const dependencies: ApplicationDependencies = {
      open: async () => store,
      start: async () => {
        throw new Error("could not bind");
      },
    };
    await assert.rejects(
      startApplication({ dataDirectory: tempDir(), port: 3001 }, dependencies),
      (error: unknown) => {
        assert.ok(error instanceof StartupError);
        // Both failures appear in the message.
        assert.match(error.message, /Cannot start the server: could not bind/);
        assert.match(error.message, /could not be closed either: lock still held/);
        // The release error is the reported cause.
        assert.match(String((error.cause as Error).message), /lock still held/);
        return true;
      },
    );
    assert.equal(closed, 1);
  });

  it("reports a clear message when the store cannot be opened through injection", async () => {
    // The file/system failure is injected through the open dependency instead
    // of being induced by making a real path invalid.
    let started = 0;
    const dependencies: ApplicationDependencies = {
      open: async () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
      start: async () => {
        started += 1;
        throw new Error("must not start");
      },
    };
    await assert.rejects(
      startApplication({ dataDirectory: tempDir(), port: 0 }, dependencies),
      (error: unknown) => {
        assert.ok(error instanceof StartupError);
        assert.match(error.message, /Cannot open the workspace store/);
        assert.match(error.message, /permission denied/);
        return true;
      },
    );
    // No server was started when the store could not open.
    assert.equal(started, 0);
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
      assert.match(String(badStatus.headers["content-type"]), /^text\/html/);
      // The invalid-status response itself is a correctable form, not the
      // earlier client response.
      assert.match(badStatus.body, /role="alert"/);
      assert.match(badStatus.body, /must be one of planned, active, on_hold, completed/);
      // The submitted values are kept, including the hidden parent, and the
      // rejected status is shown as the selected option so it can be corrected.
      assert.ok(containsEscaped(badStatus.body, "keep me"));
      assert.match(badStatus.body, new RegExp(`type="hidden" name="clientId" value="${client.id}"`));
      assert.match(badStatus.body, /<option value="nope" selected>nope \(not a valid choice\)<\/option>/);
      // Nothing was written.
      assert.equal(JSON.stringify(server.store.snapshot().engagements), engagementBefore);
    } finally {
      await server.close();
    }
  });

  it("corrects and resubmits an invalid edit for every record type", async () => {
    const server = await running();
    try {
      const client = await server.store.createClient({ name: "Acme", objectives: "old" });
      const engagement = await server.store.createEngagement({
        clientId: client.id,
        name: "Discovery",
        objectives: "old",
        status: "planned",
      });
      const project = await server.store.createProject({
        engagementId: engagement.id,
        name: "Prototype",
        objectives: "old",
        status: "planned",
      });
      // Each invalid edit is refused with the record id still in the form, so
      // the corrected resubmission reaches the same record and saves.
      const cases: {
        path: string;
        fields: Record<string, string>;
        corrected: Record<string, string>;
        check: (snapshot: ReturnType<Store["snapshot"]>) => void;
      }[] = [
        {
          path: `/clients/${client.id}/edit`,
          fields: { name: "   ", objectives: "correctable" },
          corrected: { name: "Acme again", objectives: "correctable" },
          check: (snapshot: ReturnType<Store["snapshot"]>) => {
            assert.equal(snapshot.clients[0].name, "Acme again");
            assert.equal(snapshot.clients[0].objectives, "correctable");
          },
        },
        {
          path: `/engagements/${engagement.id}/edit`,
          fields: { name: "   ", objectives: "correctable", status: "active" },
          corrected: { name: "Discovery again", objectives: "correctable", status: "active" },
          check: (snapshot: ReturnType<Store["snapshot"]>) => {
            assert.equal(snapshot.engagements[0].name, "Discovery again");
            assert.equal(snapshot.engagements[0].status, "active");
          },
        },
        {
          path: `/projects/${project.id}/edit`,
          fields: { name: "   ", objectives: "correctable", status: "completed" },
          corrected: { name: "Prototype again", objectives: "correctable", status: "completed" },
          check: (snapshot: ReturnType<Store["snapshot"]>) => {
            assert.equal(snapshot.projects[0].name, "Prototype again");
            assert.equal(snapshot.projects[0].status, "completed");
          },
        },
      ];
      for (const item of cases) {
        const id = item.path.split("/")[2];
        const before = JSON.stringify(server.store.snapshot());
        const invalid = await send(server.origin, {
          method: "POST",
          path: item.path,
          form: { id, ...item.fields },
        });
        assert.equal(invalid.status, 400, item.path);
        assert.match(String(invalid.headers["content-type"]), /^text\/html/, item.path);
        assert.match(invalid.body, /role="alert"/, item.path);
        // The id survives the error re-render, so resubmitting is possible.
        assert.match(invalid.body, new RegExp(`type="hidden" name="id" value="${id}"`), item.path);
        assert.match(invalid.body, new RegExp(`action="${item.path}"`), item.path);
        for (const value of Object.values(item.fields)) {
          if (value.trim() === "") continue;
          assert.ok(containsEscaped(invalid.body, value), `${item.path} keeps ${value}`);
        }
        // Nothing was written by the refused edit.
        assert.equal(JSON.stringify(server.store.snapshot()), before, item.path);

        // Correct and resubmit with the id the rendered form carries.
        const corrected = await send(server.origin, {
          method: "POST",
          path: item.path,
          form: { id, ...item.corrected },
        });
        assert.equal(redirectTarget(corrected), `/${item.path.split("/")[1]}/${id}`, item.path);
        item.check(server.store.snapshot());
      }
    } finally {
      await server.close();
    }
  });

  it("edits the record named by its URL and rejects a conflicting submitted id", async () => {
    const server = await running();
    try {
      const first = await server.store.createClient({ name: "First" });
      const second = await server.store.createClient({ name: "Second" });
      const before = JSON.stringify(server.store.snapshot());
      // Posting another record's id to this record's edit URL is refused, and
      // no record is changed.
      const conflict = await send(server.origin, {
        method: "POST",
        path: `/clients/${first.id}/edit`,
        form: { id: second.id, name: "Hijacked" },
      });
      assert.equal(conflict.status, 400);
      assert.equal(JSON.stringify(server.store.snapshot()), before);

      // Without a submitted id, the URL still names the target.
      const edited = await send(server.origin, {
        method: "POST",
        path: `/clients/${first.id}/edit`,
        form: { name: "First edited" },
      });
      assert.equal(redirectTarget(edited), `/clients/${first.id}`);
      const snapshot = server.store.snapshot();
      assert.equal(snapshot.clients[0].name, "First edited");
      assert.equal(snapshot.clients[1].name, "Second");

      // The same rule holds for engagements and projects.
      const engagement = await server.store.createEngagement({ clientId: first.id, name: "E" });
      const otherEngagement = await server.store.createEngagement({ clientId: first.id, name: "E2" });
      const badEngagement = await send(server.origin, {
        method: "POST",
        path: `/engagements/${engagement.id}/edit`,
        form: { id: otherEngagement.id, name: "X" },
      });
      assert.equal(badEngagement.status, 400);
      const project = await server.store.createProject({ engagementId: engagement.id, name: "P" });
      const otherProject = await server.store.createProject({ engagementId: engagement.id, name: "P2" });
      const badProject = await send(server.origin, {
        method: "POST",
        path: `/projects/${project.id}/edit`,
        form: { id: otherProject.id, name: "X" },
      });
      assert.equal(badProject.status, 400);
      const after = server.store.snapshot();
      assert.equal(after.engagements.find((e) => e.id === otherEngagement.id)?.name, "E2");
      assert.equal(after.projects.find((p) => p.id === otherProject.id)?.name, "P2");
    } finally {
      await server.close();
    }
  });

  it("keeps omitted fields when an edit supplies only some of them", async () => {
    const server = await running();
    try {
      const client = await server.store.createClient({
        name: "Acme",
        background: "b",
        contacts: "c",
        stakeholders: "s",
        requirements: "r",
        objectives: "o",
      });
      const engagement = await server.store.createEngagement({
        clientId: client.id,
        name: "Discovery",
        objectives: "keep objectives",
        status: "active",
      });
      const project = await server.store.createProject({
        engagementId: engagement.id,
        name: "Prototype",
        objectives: "keep project objectives",
        status: "on_hold",
      });

      // A name-only client edit changes only the name.
      const nameOnly = await send(server.origin, {
        method: "POST",
        path: `/clients/${client.id}/edit`,
        form: { name: "Renamed" },
      });
      assert.equal(redirectTarget(nameOnly), `/clients/${client.id}`);
      const storedClient = server.store.snapshot().clients[0];
      assert.equal(storedClient.name, "Renamed");
      assert.equal(storedClient.background, "b");
      assert.equal(storedClient.contacts, "c");
      assert.equal(storedClient.stakeholders, "s");
      assert.equal(storedClient.requirements, "r");
      assert.equal(storedClient.objectives, "o");

      // An objectives-only engagement edit keeps its name and status.
      const objectivesOnly = await send(server.origin, {
        method: "POST",
        path: `/engagements/${engagement.id}/edit`,
        form: { objectives: "new objectives" },
      });
      assert.equal(redirectTarget(objectivesOnly), `/engagements/${engagement.id}`);
      let storedEngagement = server.store.snapshot().engagements[0];
      assert.equal(storedEngagement.objectives, "new objectives");
      assert.equal(storedEngagement.name, "Discovery");
      assert.equal(storedEngagement.status, "active");

      // A status-only edit keeps the project's other fields.
      const statusOnly = await send(server.origin, {
        method: "POST",
        path: `/projects/${project.id}/edit`,
        form: { status: "completed" },
      });
      assert.equal(redirectTarget(statusOnly), `/projects/${project.id}`);
      const storedProject = server.store.snapshot().projects[0];
      assert.equal(storedProject.status, "completed");
      assert.equal(storedProject.name, "Prototype");
      assert.equal(storedProject.objectives, "keep project objectives");

      // An explicitly empty status is invalid input: it is refused, not
      // defaulted, and nothing is changed.
      const before = JSON.stringify(server.store.snapshot());
      const emptyStatus = await send(server.origin, {
        method: "POST",
        path: `/engagements/${engagement.id}/edit`,
        form: { status: "" },
      });
      assert.equal(emptyStatus.status, 400);
      assert.match(emptyStatus.body, /role="alert"/);
      assert.equal(JSON.stringify(server.store.snapshot()), before);
      storedEngagement = server.store.snapshot().engagements[0];
      assert.equal(storedEngagement.status, "active");
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
