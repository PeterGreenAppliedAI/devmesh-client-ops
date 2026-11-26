/**
 * The transcript HTTP fixture's bounded keep-alive transport, exercised over a
 * real on-disk workspace and the application's own server.
 *
 * The regression sends one malformed multipart import over a kept-alive socket
 * and requires a complete plain-text 400 carrying the decoder's own reason for
 * the missing closing boundary and its full corrective guidance. Nothing may be
 * written by that refused request: the store snapshot, the exact bytes of
 * `workspace.json` and the originals directory (absent, or its entries and
 * their bytes) are compared before and after. A following GET /health must be
 * a complete 200, and both replies must report the same positive client local
 * port, so the two requests reused one connection instead of reconnecting.
 *
 * Only the temporary workspace receives data, and it is removed afterwards.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { registerRoutes } from "../src/index.ts";
import { startServer, type Route, type Routes, type StartedServer } from "../src/server.ts";
import { openStore, type Snapshot, type Store } from "../src/store.ts";
import { ORIGINALS_DIRECTORY } from "../src/transcript-files.ts";
import {
  BOUNDARY,
  keepAliveTransport,
  MULTIPART_TYPE,
  send,
  type Transport,
} from "./fixtures/transcript-http.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "transcript-transport-"));
  roots.push(dir);
  return dir;
}

/** The workspace file inside a store directory. */
function storePath(dir: string): string {
  return join(dir, "workspace.json");
}

/** One originals-directory entry: its name and its exact bytes. */
interface OriginalEntry {
  readonly name: string;
  readonly bytes: Buffer;
}

/**
 * The originals directory's state: null when the directory is absent, else its
 * entries (sorted by name) with each entry's exact bytes. Absence and presence
 * are distinguished, so an empty directory is not mistaken for no directory.
 */
function originalsState(dir: string): OriginalEntry[] | null {
  const originals = join(dir, ORIGINALS_DIRECTORY);
  if (!existsSync(originals)) return null;
  return readdirSync(originals)
    .sort()
    .map((name) => ({ name, bytes: readFileSync(join(originals, name)) }));
}

/** The exact workspace bytes, for a byte-for-byte comparison. */
function workspaceBytes(dir: string): Buffer {
  return readFileSync(storePath(dir));
}

/**
 * A workspace seeded with one client and one engagement, served by the real
 * application routes. The client and engagement are committed before the
 * server starts, so the baseline state is the one the refused import must leave
 * unchanged.
 */
interface Running {
  readonly dir: string;
  readonly store: Store;
  readonly server: StartedServer;
  readonly engagementId: string;
  close(): Promise<void>;
}

async function running(): Promise<Running> {
  const dir = tempDir();
  const store = await openStore(dir);
  let server: StartedServer | null = null;
  try {
    const client = await store.createClient({ name: "Acme" });
    const engagement = await store.createEngagement({ clientId: client.id, name: "Eng" });
    server = await startServer({ store, port: 0, routes: registerRoutes(store) });
    return {
      dir,
      store,
      server,
      engagementId: engagement.id,
      async close() {
        // Attempt every teardown step even when one fails, so a failed server
        // close cannot skip the store close that protects the workspace. Both
        // results are retained; if both fail, the store's error is rethrown as
        // the cause of the server's, so neither failure is swallowed.
        let serverError: unknown = null;
        try {
          await server!.close();
        } catch (error) {
          serverError = error;
        }
        let storeError: unknown = null;
        try {
          await store.close();
        } catch (error) {
          storeError = error;
        }
        if (serverError !== null && storeError !== null) {
          throw new AggregateError([serverError, storeError], "both the server and the store failed to close");
        }
        if (serverError !== null) throw serverError;
        if (storeError !== null) throw storeError;
      },
    };
  } catch (error) {
    // Clean up after a failed setup, retaining each cleanup failure instead of
    // discarding a later one behind the setup error.
    const failures: unknown[] = [error];
    if (server !== null) {
      try {
        await server.close();
      } catch (closeError) {
        failures.push(closeError);
      }
    }
    try {
      await store.close();
    } catch (closeError) {
      failures.push(closeError);
    }
    if (failures.length === 1) throw error;
    throw new AggregateError(failures, "the setup failed and cleanup failed too");
  }
}

/**
 * A multipart body with a valid opening delimiter, part headers and payload,
 * and no closing delimiter line: the decoder's "no closing boundary" refusal.
 */
function unclosedMultipart(): Buffer {
  return Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="paste"\r\n\r\nAlice: hello there.\r\n`,
    "utf8",
  );
}

/** A complete multipart body from its text controls, each sent once. */
function completeMultipart(fields: Readonly<Record<string, string>>): Buffer {
  const pieces = Object.entries(fields).map(([name, value]) =>
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, "utf8"),
  );
  return Buffer.concat([...pieces, Buffer.from(`--${BOUNDARY}--\r\n`, "utf8")]);
}

/** The decoder's exact message for a body that has no closing delimiter. */
const MISSING_CLOSING = "The multipart body is not valid: the body has no closing boundary.";
/** The decoder's full corrective guidance for an invalid multipart body. */
const MULTIPART_GUIDANCE =
  "Submit the form once as a well-formed multipart/form-data body: CRLF line endings, a single closing boundary, and one form-data part per control.";

/** The exact workspace state a test compares across the refused request. */
interface Baseline {
  readonly snapshot: Snapshot;
  readonly bytes: Buffer;
  readonly originals: OriginalEntry[] | null;
}

function baselineOf(running: Running): Baseline {
  return {
    snapshot: running.store.snapshot(),
    bytes: workspaceBytes(running.dir),
    originals: originalsState(running.dir),
  };
}

/** Require a refused request to have left the workspace byte-for-byte unchanged. */
function assertUnchanged(running: Running, before: Baseline, why: string): void {
  assert.deepEqual(running.store.snapshot(), before.snapshot, `${why}: the store snapshot is unchanged`);
  assert.deepEqual(workspaceBytes(running.dir), before.bytes, `${why}: workspace.json is byte-for-byte unchanged`);
  assert.deepEqual(originalsState(running.dir), before.originals, `${why}: the originals directory is unchanged`);
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

describe("transcript HTTP fixture: bounded keep-alive transport", () => {
  it("refuses an unclosed multipart import with a complete 400, writes nothing and reuses one socket", async () => {
    const runningFixture = await running();
    const transport: Transport = keepAliveTransport();
    try {
      const before = baselineOf(runningFixture);
      const importPath = `/engagements/${encodeURIComponent(runningFixture.engagementId)}/transcripts/import`;

      // The POST sends the malformed body with an accurate Content-Length to the
      // engagement's import route, over the listener's own Host and Origin.
      const refused = await send(transport, runningFixture.server.origin, {
        method: "POST",
        path: importPath,
        contentType: MULTIPART_TYPE,
        body: unclosedMultipart(),
      });
      assert.equal(refused.status, 400, "the malformed import is refused with 400");
      assert.match(String(refused.headers["content-type"]), /^text\/plain; charset=utf-8/, "the refusal is plain text");
      assert.equal(refused.headers["cache-control"], "no-store", "the refusal is not cached");
      assert.ok(refused.body.includes(MISSING_CLOSING), `the refusal carries the decoder's message: ${refused.body}`);
      assert.ok(refused.body.includes(MULTIPART_GUIDANCE), `the refusal carries the full guidance: ${refused.body}`);
      assertUnchanged(runningFixture, before, "after the refused import");

      // A following GET over the same transport is a complete 200.
      const health = await send(transport, runningFixture.server.origin, { path: "/health" });
      assert.equal(health.status, 200, "the health page is a 200");
      assert.ok(health.body.includes("ok"), `the health page reports its status: ${health.body}`);

      // Both replies name one positive client local port: the kept-alive socket
      // was reused, never replaced by a reconnect.
      const importPort = refused.localPort;
      const healthPort = health.localPort;
      assert.ok(isPositiveInteger(importPort), `the import reply's local port is a positive integer: ${importPort}`);
      assert.ok(isPositiveInteger(healthPort), `the health reply's local port is a positive integer: ${healthPort}`);
      assert.equal(importPort, healthPort, "the two requests reused one connection");

      // Neither a GET nor a refusal changed the workspace.
      assertUnchanged(runningFixture, before, "after the health read");
    } finally {
      transport.close();
      await runningFixture.close();
    }
  });

  it("commits a chunked multipart import framed by Node", async () => {
    const runningFixture = await running();
    const transport = keepAliveTransport();
    try {
      const importPath = `/engagements/${encodeURIComponent(runningFixture.engagementId)}/transcripts/import`;
      const reply = await send(transport, runningFixture.server.origin, {
        method: "POST",
        path: importPath,
        contentType: MULTIPART_TYPE,
        body: completeMultipart({
          title: "Chunked import",
          date: "2026-09-01",
          paste: "Alice: Hello there.\n\nBob: Hi.",
        }),
        chunked: true,
      });
      assert.equal(reply.status, 200, `the chunked import commits: ${reply.body.slice(0, 200)}`);
      assert.equal(runningFixture.store.snapshot().meetings.length, 1, "the chunked import committed one meeting");
    } finally {
      transport.close();
      await runningFixture.close();
    }
  });

  it("frames a chunked POST with Transfer-Encoding, not Content-Length", async () => {
    const transport = keepAliveTransport();
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    const listener = createServer((req, res) => {
      seen.push({ ...req.headers });
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-length": "2", "content-type": "text/plain" });
        res.end("ok");
      });
    });
    try {
      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", () => resolve()));
      const port = (listener.address() as { port: number }).port;
      const reply = await send(transport, `http://127.0.0.1:${port}`, {
        method: "POST",
        path: "/chunked",
        contentType: "text/plain",
        body: Buffer.from("hello"),
        chunked: true,
      });
      assert.equal(reply.status, 200, "the chunked POST gets a reply");
      assert.equal(seen.length, 1, "the listener saw one request");
      assert.equal(seen[0]["content-length"], undefined, "a chunked POST declares no Content-Length");
      assert.equal(seen[0]["transfer-encoding"], "chunked", "a chunked POST is framed by Node with Transfer-Encoding: chunked");
    } finally {
      transport.close();
      // Propagate the listener's close error rather than resolving regardless.
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("fails a reply that exceeds the inclusive response cap", async () => {
    const runningFixture = await running();
    const transport = keepAliveTransport();
    try {
      await assert.rejects(
        send(transport, runningFixture.server.origin, { path: "/health", responseCap: 1 }),
        /exceeded the 1-byte cap/,
        "a reply over the cap fails instead of being buffered unbounded",
      );
    } finally {
      transport.close();
      await runningFixture.close();
    }
  });

  it("fails a request that outstays its deadline and aborts it", async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    const transport = keepAliveTransport();
    let server: StartedServer | null = null;
    try {
      // A route that answers well after the deadline, so the deadline is the
      // only reason the request fails.
      const slow: Route = {
        method: "GET",
        render() {
          return new Promise((resolve) => setTimeout(() => resolve({ status: 200, body: "late" }), 250));
        },
      };
      const routes: Routes = {
        home: { get: slow },
        health: { get: slow },
        hierarchy: {
          match: (path) => (path === "/slow" ? "slow" : null),
          route: () => slow,
        },
      };
      server = await startServer({ store, port: 0, routes });
      await assert.rejects(
        send(transport, server.origin, { path: "/slow", deadlineMs: 20 }),
        /no reply within 20 ms/,
        "a request past its deadline fails",
      );
      // Let the slow handler finish before the server is closed.
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      transport.close();
      // Close the server and the store independently, retaining each cleanup
      // failure; a failed server close must not swallow a store close error.
      let serverError: unknown = null;
      if (server !== null) {
        try {
          await server.close();
        } catch (error) {
          serverError = error;
        }
      }
      let storeError: unknown = null;
      try {
        await store.close();
      } catch (error) {
        storeError = error;
      }
      if (serverError !== null && storeError !== null) {
        throw new AggregateError([serverError, storeError], "both the server and the store failed to close");
      }
      if (serverError !== null) throw serverError;
      if (storeError !== null) throw storeError;
    }
  });

  it("refuses a deadline above the timer's supported range", async () => {
    const transport = keepAliveTransport();
    try {
      // Node clamps a delay above 2^31-1 ms to 1 ms; accepting it would fail a
      // valid reply long before the caller's deadline, so it is refused.
      assert.throws(
        () => send(transport, "http://127.0.0.1:1", { path: "/", deadlineMs: 2_147_483_648 }),
        /the deadline is a finite positive duration of at most 2147483647 ms/,
        "an out-of-range deadline is refused instead of mis-timed",
      );
    } finally {
      transport.close();
    }
  });

  it("fails a reply that is held open past its deadline and closes it", async () => {
    const transport = keepAliveTransport();
    // The listener reads the whole request but holds the reply open, so the
    // helper's own deadline is the only reason the request fails. The request
    // may expire before or after the listener receives it: both are valid
    // timeout outcomes, so nothing waits for the reply to be held.
    let held: import("node:http").ServerResponse | null = null;
    const listener = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        held = res;
      });
    });
    // The watchdog is retained so its timer is cleared on every exit, and its
    // rejection is observed at creation so it never surfaces unhandled.
    let watchdogHandle: ReturnType<typeof setTimeout> | null = null;
    const guard = new Promise<never>((_, reject) => {
      watchdogHandle = setTimeout(() => reject(new Error("watchdog: the held-reply scenario did not finish")), 5000);
    });
    guard.catch(() => undefined);
    try {
      // Race the setup against the watchdog, so a hung listen still reaches the
      // test instead of waiting forever.
      await Promise.race([
        new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", () => resolve())),
        guard,
      ]);
      const port = (listener.address() as { port: number }).port;
      await Promise.race([
        assert.rejects(
          send(transport, `http://127.0.0.1:${port}`, { path: "/", deadlineMs: 40 }),
          /no reply within 40 ms/,
          "a held-open reply is failed by the deadline",
        ),
        guard,
      ]);
    } finally {
      if (watchdogHandle !== null) {
        clearTimeout(watchdogHandle);
        watchdogHandle = null;
      }
      transport.close();
      // Close the held response before the listener, so no socket outlives it.
      (held as import("node:http").ServerResponse | null)?.destroy();
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  // The fixture registers its two fixed deadline-order regressions itself when
  // it is imported; they need no call here.

  it("fails a request Node cannot construct without leaving a deadline behind", async () => {
    const transport = keepAliveTransport();
    try {
      // A CR in the request target makes Node's own construction throw. The
      // helper must reject through its cleanup, which tolerates a request that
      // was never created, and must not leave an armed timer that would touch
      // an uninitialised request.
      await assert.rejects(
        send(transport, "http://127.0.0.1:1", { path: "/bad\rpath" }),
        (error: unknown) => error instanceof Error,
        "a construction error rejects instead of escaping",
      );
    } finally {
      transport.close();
    }
  });
});
