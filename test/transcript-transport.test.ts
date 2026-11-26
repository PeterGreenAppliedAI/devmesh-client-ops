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
import { createServer, type ServerResponse } from "node:http";
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
  sendStaged,
  type ClosedExchange,
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
interface RenderCounts {
  import: number;
  followUp: number;
}

interface Running {
  readonly dir: string;
  readonly store: Store;
  readonly server: StartedServer;
  readonly engagementId: string;
  readonly renders: RenderCounts;
  close(): Promise<void>;
}

async function running(): Promise<Running> {
  const dir = tempDir();
  const store = await openStore(dir);
  let server: StartedServer | null = null;
  try {
    const client = await store.createClient({ name: "Acme" });
    const engagement = await store.createEngagement({ clientId: client.id, name: "Eng" });
    const baseRoutes = registerRoutes(store);
    const renders: RenderCounts = { import: 0, followUp: 0 };
    // Count every route render while preserving the routes themselves: a GET
    // /health is the follow-up, and any hierarchy POST is the import path.
    const health = baseRoutes.health.get;
    const hierarchy = baseRoutes.hierarchy;
    const routes: Routes = {
      ...baseRoutes,
      health: {
        ...baseRoutes.health,
        get: {
          ...health,
          render(request) {
            renders.followUp += 1;
            return health.render(request);
          },
        },
      },
      ...(hierarchy === undefined
        ? {}
        : {
            hierarchy: {
              match: (path: string) => hierarchy.match(path),
              route(matched: unknown, method: "GET" | "POST") {
                const route = hierarchy.route(matched, method);
                if (route === undefined || method !== "POST") return route;
                return {
                  ...route,
                  render(request) {
                    renders.import += 1;
                    return route.render(request);
                  },
                };
              },
            },
          }),
    };
    server = await startServer({ store, port: 0, routes });
    return {
      dir,
      store,
      server,
      engagementId: engagement.id,
      renders,
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

/** The owner-specified inclusive whole-body limit, written out independently. */
const EXACT_BODY_BYTES = 15_728_640;

/**
 * A complete multipart body grown to exactly the whole-body limit only by a
 * legal epilogue after the CRLF-terminated closing delimiter. No submitted
 * control carries padding, so each paste still equals the text the request
 * supplied when the decoder stops at that close.
 */
function exactLimitMultipart(fields: Readonly<Record<string, string>>): Buffer {
  const complete = completeMultipart(fields);
  assert.ok(complete.length <= EXACT_BODY_BYTES, `the controls fit inside ${EXACT_BODY_BYTES} bytes`);
  return Buffer.concat([complete, Buffer.alloc(EXACT_BODY_BYTES - complete.length, 0x65)]);
}

/** The declared length one byte past the owner-specified inclusive body limit. */
const OVERSIZED_BODY_BYTES = EXACT_BODY_BYTES + 1;

/**
 * A complete multipart body grown to the declared over-limit length only by a
 * legal epilogue after the CRLF-terminated closing delimiter. The controls stay
 * valid and small, so only the declared whole-body length is in excess.
 */
function oversizedMultipart(fields: Readonly<Record<string, string>>): Buffer {
  const complete = completeMultipart(fields);
  assert.ok(complete.length <= OVERSIZED_BODY_BYTES, `the controls fit inside ${OVERSIZED_BODY_BYTES} bytes`);
  return Buffer.concat([complete, Buffer.alloc(OVERSIZED_BODY_BYTES - complete.length, 0x65)]);
}

/** A raw follow-up GET request, written on the retiring socket. */
function rawGet(base: string, path: string): Buffer {
  const url = new URL(base);
  return Buffer.from(`GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: keep-alive\r\n\r\n`, "utf8");
}

/** The one complete 413 a retiring connection must deliver, with its guidance. */
function assertOversizedRefusal(exchange: ClosedExchange, why: string): void {
  assert.equal(exchange.replies.length, 1, `${why}: the connection carries exactly one complete reply`);
  const reply = exchange.replies[0]!;
  assert.equal(reply.status, 413, `${why}: the reply is a 413`);
  assert.match(String(reply.headers["content-type"]), /^text\/plain; charset=utf-8/, `${why}: the reply is plain text`);
  assert.equal(reply.headers["cache-control"], "no-store", `${why}: the reply is not cached`);
  assert.equal(reply.headers["connection"], "close", `${why}: the reply retires the connection`);
  assert.equal(
    reply.body,
    `The request body is too large.\n\nKeep the whole submission at most ${EXACT_BODY_BYTES} bytes; nothing was truncated.\n`,
    `${why}: the reply carries the whole-body limit guidance`,
  );
  assert.ok(
    Number.isInteger(exchange.localPort) && exchange.localPort > 0,
    `${why}: the exchange used one positive client local port: ${exchange.localPort}`,
  );
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

// ---------------------------------------------------------------------------
// Real-clock scenario harness
// ---------------------------------------------------------------------------

/**
 * A real watchdog, independent of the helper's deadline, that rejects with an
 * error the expected rejection can never match. Its rejection is observed the
 * moment it is created, so it cannot surface as an unhandled rejection, and its
 * timer is cleared on every exit.
 */
function watchdog(milliseconds: number, reason: string): {
  readonly promise: Promise<never>;
  readonly clear: () => void;
} {
  let handle: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(`watchdog: ${reason}`)), milliseconds);
  });
  // Observe the rejection at creation, so a watchdog that fires while the
  // scenario is waiting for setup or delivery is handled even then.
  promise.catch(() => undefined);
  return {
    promise,
    clear() {
      if (handle !== null) {
        clearTimeout(handle);
        handle = null;
      }
    },
  };
}

/**
 * A listener owned and started before any await, so its close can always be
 * registered in `finally`. A bind failure is kept as the setup outcome and
 * rethrown by `close`, and a later server error is retained and reported by
 * `close` rather than swallowed into the already-settled bind promise.
 */
interface TestListener {
  /** Resolves once the listener is accepting connections. */
  readonly ready: Promise<void>;
  /** The bound port; only valid once `ready` has resolved. */
  port(): number;
  close(): Promise<void>;
}

/** Create and start a listener synchronously, before the caller awaits. */
function testListener(
  onRequest: (req: import("node:http").IncomingMessage, res: ServerResponse) => void,
): TestListener {
  const listener = createServer(onRequest);
  let bindState: "pending" | "listening" | "failed" = "pending";
  let bindError: Error | null = null;
  let lateError: Error | null = null;
  // Settles once with the bind outcome: null for success, the error otherwise.
  const outcome = new Promise<Error | null>((resolve) => {
    listener.on("error", (error: Error) => {
      if (bindState === "pending") {
        bindState = "failed";
        bindError = error;
        resolve(error);
      } else if (bindState === "listening") {
        // Keep the handler installed so a later server error is reported by
        // `close` instead of disappearing into an already-settled bind promise.
        lateError = error;
      }
    });
    listener.listen(0, "127.0.0.1", () => {
      bindState = "listening";
      resolve(null);
    });
  });
  const ready = outcome.then((error) => {
    if (error !== null) throw error;
  });
  // Observe a bind failure at creation, so a watchdog win cannot leave it
  // unhandled; the caller still races `ready` to see the failure.
  ready.catch(() => undefined);
  return {
    ready,
    port() {
      const address = listener.address();
      if (address === null || typeof address === "string") {
        throw new Error("the listener is not bound to a TCP port");
      }
      return address.port;
    },
    async close() {
      if (bindState === "pending") {
        // Do not wait for a bind that has not settled: close cancels the
        // outstanding listen, so a stalled bind cannot hold up the failure the
        // watchdog is about to report. Node reports ERR_SERVER_NOT_RUNNING for
        // a close of a server that never started listening; that cancellation is
        // expected here. A bind that failed while closing is still reported.
        let closeError: unknown = null;
        try {
          await new Promise<void>((resolve, reject) => {
            listener.close((error) => (error ? reject(error) : resolve()));
          });
        } catch (error) {
          closeError = error;
        }
        // The bind may have failed while the close was cancelling it.
        if (bindError !== null) throw bindError;
        if (closeError !== null && (closeError as { code?: string }).code !== "ERR_SERVER_NOT_RUNNING") {
          throw closeError;
        }
        return;
      }
      if (bindState === "failed") throw bindError ?? new Error("the listener failed to bind");
      let closeError: unknown = null;
      try {
        await new Promise<void>((resolve, reject) => {
          listener.close((error) => (error ? reject(error) : resolve()));
        });
      } catch (error) {
        closeError = error;
      }
      if (closeError !== null && lateError !== null) {
        throw new AggregateError([closeError, lateError], "the listener close failed and a server error was retained");
      }
      if (closeError !== null) throw closeError;
      if (lateError !== null) throw lateError;
    },
  };
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

  it("refuses an oversized declared import on headers alone and writes nothing", async () => {
    const runningFixture = await running();
    const guard = watchdog(5000, "the withheld-body refusal did not finish");
    try {
      const before = baselineOf(runningFixture);
      const importPath = `/engagements/${encodeURIComponent(runningFixture.engagementId)}/transcripts/import`;
      const body = oversizedMultipart({
        title: "Withheld oversized import",
        date: "2026-09-02",
        paste: "Alice: the withheld source.",
      });
      assert.equal(body.byteLength, OVERSIZED_BODY_BYTES, "the valid body is exactly the declared over-limit length");
      assert.ok(body.byteLength > EXACT_BODY_BYTES, "the declared whole-body length is over the inclusive limit");

      // No body byte is written at all, so the 413 must arrive from the
      // declared headers alone and the socket must then retire.
      const pending = sendStaged(runningFixture.server.origin, {
        path: importPath,
        contentType: MULTIPART_TYPE,
        declaredLength: OVERSIZED_BODY_BYTES,
      });
      pending.catch(() => undefined);
      const exchange = await Promise.race([pending, guard.promise]);
      assertOversizedRefusal(exchange, "withheld body");
      assert.equal(runningFixture.renders.import, 0, "the refused import never reached a handler");
      assert.equal(runningFixture.renders.followUp, 0, "no follow-up handler ran on the retiring socket");
      assertUnchanged(runningFixture, before, "after the withheld-body refusal");
    } finally {
      guard.clear();
      await runningFixture.close();
    }
  });

  it("refuses an oversized declared import while its body is in flight and excludes a follow-up", async () => {
    const runningFixture = await running();
    const guard = watchdog(5000, "the in-flight refusal did not finish");
    try {
      const before = baselineOf(runningFixture);
      const importPath = `/engagements/${encodeURIComponent(runningFixture.engagementId)}/transcripts/import`;
      const body = oversizedMultipart({
        title: "In-flight oversized import",
        date: "2026-09-03",
        paste: "Bob: the in-flight source.",
      });
      assert.equal(body.byteLength, OVERSIZED_BODY_BYTES, "the valid body is exactly the declared over-limit length");

      // Start sending the whole declared body, then a follow-up request, before
      // reading the reply; the 413 still answers from the declared headers. The
      // GET follows every declared body byte, so it is a real next request on
      // the socket rather than more POST body. The peer may close before Node
      // emits that request event; either way no handler may run.
      const pending = sendStaged(runningFixture.server.origin, {
        path: importPath,
        contentType: MULTIPART_TYPE,
        declaredLength: OVERSIZED_BODY_BYTES,
        bodyPrefix: body,
        followUp: rawGet(runningFixture.server.origin, "/health"),
      });
      pending.catch(() => undefined);
      const exchange = await Promise.race([pending, guard.promise]);
      assertOversizedRefusal(exchange, "in-flight body");
      assert.equal(runningFixture.renders.import, 0, "the refused import never reached a handler");
      assert.equal(runningFixture.renders.followUp, 0, "the follow-up on the retiring socket never reached a handler");
      assertUnchanged(runningFixture, before, "after the in-flight refusal");
    } finally {
      guard.clear();
      await runningFixture.close();
    }
  });

  it("commits two exact-limit imports sequentially, the second chunked, and reuses one socket for each health read", async () => {
    const runningFixture = await running();
    const transport = keepAliveTransport();
    try {
      const importPath = `/engagements/${encodeURIComponent(runningFixture.engagementId)}/transcripts/import`;
      const requests = [
        {
          title: "First exact-limit import",
          date: "2026-09-02",
          paste: "Alice: the first small paste.",
          chunked: false,
        },
        {
          title: "Second exact-limit import",
          date: "2026-09-03",
          paste: "Bob: the second small paste.",
          chunked: true,
        },
      ] as const;
      assert.notEqual(
        requests[0].paste.replace(/\s+/g, " ").trim(),
        requests[1].paste.replace(/\s+/g, " ").trim(),
        "the two small pastes remain distinct after whitespace normalization",
      );

      for (const [index, request] of requests.entries()) {
        const body = exactLimitMultipart({
          title: request.title,
          date: request.date,
          paste: request.paste,
        });
        assert.equal(body.byteLength, EXACT_BODY_BYTES, `import ${index + 1} is exactly ${EXACT_BODY_BYTES} bytes before transfer coding`);
        const before = runningFixture.store.snapshot();

        const reply = await send(transport, runningFixture.server.origin, {
          method: "POST",
          path: importPath,
          contentType: MULTIPART_TYPE,
          body,
          chunked: request.chunked,
        });
        assert.equal(reply.status, 200, `import ${index + 1} is a complete 200: ${reply.body.slice(0, 200)}`);

        const after = runningFixture.store.snapshot();
        const meetingIdsBefore = new Set(before.meetings.map((meeting) => meeting.id));
        const newMeetings = after.meetings.filter(
          (meeting) => !meetingIdsBefore.has(meeting.id) && meeting.engagementId === runningFixture.engagementId,
        );
        assert.equal(newMeetings.length, 1, `import ${index + 1} creates exactly one new meeting in the engagement`);
        const meeting = newMeetings[0]!;
        assert.equal(meeting.title, request.title, `import ${index + 1} keeps its title`);
        assert.equal(meeting.date, request.date, `import ${index + 1} keeps its date`);

        const transcriptIdsBefore = new Set((before.transcripts ?? []).map((transcript) => transcript.id));
        const newTranscripts = (after.transcripts ?? []).filter((transcript) => !transcriptIdsBefore.has(transcript.id));
        const attached = newTranscripts.filter((transcript) => transcript.meetingId === meeting.id);
        assert.equal(attached.length, 1, `import ${index + 1} creates exactly one transcript whose meetingId names the new meeting`);
        assert.equal(newTranscripts.length, 1, `import ${index + 1} creates no transcript for another meeting`);
        const transcript = attached[0]!;
        assert.equal(transcript.sources.length, 1, `import ${index + 1} stores exactly one source`);
        const source = transcript.sources[0]!;
        assert.equal(source.format, "paste", `import ${index + 1} stores a pasted source`);
        assert.equal(source.originalText, request.paste, `import ${index + 1}'s pasted source is exactly its small text, without the padded epilogue`);

        const health = await send(transport, runningFixture.server.origin, { path: "/health" });
        assert.equal(health.status, 200, `the health read after import ${index + 1} is a complete 200`);
        assert.ok(health.body.includes("ok"), `the health read after import ${index + 1} reports its status: ${health.body}`);
        assert.ok(isPositiveInteger(reply.localPort), `import ${index + 1}'s local port is a positive integer: ${reply.localPort}`);
        assert.ok(isPositiveInteger(health.localPort), `the health read after import ${index + 1} has a positive local port: ${health.localPort}`);
        assert.equal(reply.localPort, health.localPort, `import ${index + 1} and its health read reused one connection`);
      }
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
    const transport = keepAliveTransport();
    const guard = watchdog(5000, "the cap scenario did not finish");
    const listener = testListener((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-length": "2", "content-type": "text/plain" });
        res.end("ok");
      });
    });
    try {
      // The request is readiness-dependent, but its rejection handler is
      // attached before this test yields, and the watchdog bounds the setup
      // wait as well as the request itself.
      const pending = listener.ready.then(() =>
        send(transport, `http://127.0.0.1:${listener.port()}`, { path: "/", responseCap: 1 }),
      );
      const expected = assert.rejects(pending, /exceeded the 1-byte cap/, "a reply over the cap fails instead of being buffered unbounded");
      // Observe the assertion at creation so a watchdog win cannot leave it unhandled.
      expected.catch(() => undefined);
      await Promise.race([Promise.all([listener.ready, expected]), guard.promise]);
    } finally {
      guard.clear();
      transport.close();
      await listener.close();
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
    const guard = watchdog(5000, "the held-reply scenario did not finish");
    // The listener reads the whole request but holds the reply open, so the
    // helper's own deadline is the only reason the request fails. The request
    // may expire before or after the listener receives it: both are valid
    // timeout outcomes, so nothing waits for the reply to be held.
    const held: { response: ServerResponse | null } = { response: null };
    const listener = testListener((req, res) => {
      req.resume();
      req.on("end", () => {
        held.response = res;
      });
    });
    let startedAt = 0;
    try {
      // The listener is created before this await; its close is registered in
      // the finally below, so a bind that succeeds late still has a teardown
      // owner. The request is readiness-dependent, but its rejection handler is
      // attached before this test yields, and the watchdog bounds the setup wait
      // as well as the request itself.
      const pending = listener.ready.then(() => {
        startedAt = performance.now();
        return send(transport, `http://127.0.0.1:${listener.port()}`, { path: "/", deadlineMs: 40 });
      });
      const expected = assert.rejects(pending, /no reply within 40 ms/, "a held-open reply is failed by the deadline");
      // Observe the assertion at creation so a watchdog win cannot leave it unhandled.
      expected.catch(() => undefined);
      await Promise.race([Promise.all([listener.ready, expected]), guard.promise]);
      // The rejection must come from the real clock, not merely carry the
      // timeout message: the whole 40 ms budget must have elapsed.
      const elapsed = performance.now() - startedAt;
      assert.ok(elapsed >= 40, `the deadline held for its full 40 ms budget: ${elapsed.toFixed(1)} ms`);
    } finally {
      guard.clear();
      transport.close();
      // Close the held response before the listener, so no socket outlives it.
      held.response?.destroy();
      await listener.close();
    }
  });

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
