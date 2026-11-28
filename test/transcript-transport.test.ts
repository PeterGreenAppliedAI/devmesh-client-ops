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
 * Exact-limit and over-limit multipart imports extend that coverage: a valid
 * body at the inclusive 15 MiB limit commits, while one more body byte is
 * refused with one complete plain-text 413 that carries the whole-submission
 * guidance, Cache-Control: no-store and Connection: close. The refusal is
 * reserved on the first excess byte, drains and excludes any follow-up request,
 * ignores a late parser failure and a late CONNECT, and leaves the workspace
 * byte-for-byte unchanged. Each refusal is read through peer closure, including
 * while the final chunk terminator is withheld, after additional bytes of the
 * same upload arrive, and when the original socket is reused after the complete
 * 413. An eligible GET in a 50-client workspace must render once with an empty
 * form and no file, then share its socket with a complete health read.
 *
 * Only the temporary workspace receives data, and it is removed afterwards.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { registerRoutes } from "../src/index.ts";
import { startServer, type Route, type RouteRequest, type Routes, type StartedServer } from "../src/server.ts";
import { openStore, type Snapshot, type Store } from "../src/store.ts";
import { ORIGINALS_DIRECTORY } from "../src/transcript-files.ts";
import {
  BOUNDARY,
  keepAliveTransport,
  MULTIPART_TYPE,
  observeServerWrites,
  send,
  sendRaw,
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

interface RunningOptions {
  /** The number of synthetic clients in the workspace; one by default. */
  readonly clients?: number;
}

interface Running {
  readonly dir: string;
  readonly store: Store;
  readonly server: StartedServer;
  readonly engagementId: string;
  readonly renders: RenderCounts;
  /** Every hierarchy route request that reached a render, in order. */
  readonly requests: RouteRequest[];
  close(): Promise<void>;
}

async function running(options: RunningOptions = {}): Promise<Running> {
  const dir = tempDir();
  const store = await openStore(dir);
  let server: StartedServer | null = null;
  try {
    const clientCount = options.clients ?? 1;
    const client = await store.createClient({ name: "Acme" });
    for (let index = 1; index < clientCount; index += 1) {
      await store.createClient({ name: `Client ${index + 1}` });
    }
    const engagement = await store.createEngagement({ clientId: client.id, name: "Eng" });
    const baseRoutes = registerRoutes(store);
    const renders: RenderCounts = { import: 0, followUp: 0 };
    const requests: RouteRequest[] = [];
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
                if (route === undefined) return route;
                return {
                  ...route,
                  render(request) {
                    requests.push(request);
                    if (method === "POST") renders.import += 1;
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
      requests,
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

/**
 * A legal multipart body whose epilogue fills it to exactly the inclusive limit,
 * followed by one more body byte. The controls stay valid and small, so the
 * first excess byte is the only thing that makes the submission too large.
 */
function oneByteOverLimitMultipart(fields: Readonly<Record<string, string>>): Buffer {
  const exact = exactLimitMultipart(fields);
  assert.equal(exact.byteLength, EXACT_BODY_BYTES, `the padded body is exactly ${EXACT_BODY_BYTES} bytes`);
  return Buffer.concat([exact, Buffer.from([0x65])]);
}

/** A raw follow-up GET request, written on the retiring socket. */
function rawGet(base: string, path: string): Buffer {
  const url = new URL(base);
  return Buffer.from(`GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: keep-alive\r\n\r\n`, "utf8");
}

/** A raw CONNECT request, written on the retiring socket after a follow-up GET. */
function rawConnect(base: string): Buffer {
  const url = new URL(base);
  return Buffer.from(`CONNECT ${url.host} HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`, "utf8");
}
/** A raw POST with the supplied headers and optional exact body bytes. */
function rawPostRequest(
  base: string,
  path: string,
  headers: Readonly<Record<string, string>>,
  body?: Uint8Array,
): Buffer {
  const url = new URL(base);
  const lines = [`POST ${path} HTTP/1.1`, `Host: ${url.host}`];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  lines.push("", "");
  return Buffer.concat([Buffer.from(lines.join("\r\n"), "utf8"), body === undefined ? Buffer.alloc(0) : Buffer.from(body)]);
}

/** A POST whose header block carries an ordinary framing error. */
function malformedPost(base: string, path: string): Buffer {
  const url = new URL(base);
  return Buffer.from(
    [
      `POST ${path} HTTP/1.1`,
      `Host: ${url.host}`,
      `Origin: ${url.origin}`,
      `Content-Type: ${MULTIPART_TYPE}`,
      "Content-Length: 8",
      "Broken Header",
      "",
      "",
    ].join("\r\n"),
    "utf8",
  );
}

/** A multipart file part header and the first `size` bytes of its file, unclosed. */
function partialFileMultipart(size: number): Buffer {
  const head = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    "utf8",
  );
  return Buffer.concat([head, Buffer.alloc(size, 0x61)]);
}

/** The one complete ordinary parser-error reply with its no-store headers. */
function assertOrdinaryRefusal(reply: ClosedExchange["replies"][number], status: number, why: string): void {
  assert.equal(reply.status, status, `${why}: the reply is a ${status}`);
  assert.equal(reply.headers["cache-control"], "no-store", `${why}: the reply is not cached`);
  assert.equal(reply.headers["connection"], "close", `${why}: the reply closes the connection`);
  assert.equal(reply.headers["content-length"], "0", `${why}: the reply declares an empty body`);
  assert.equal(reply.bytes.byteLength, 0, `${why}: the reply carries no body`);
}

/** The inclusive cap for the fixture's 16 MiB reply and its headers. */
const LARGE_RESPONSE_CAP = 16 * 1024 * 1024 + 64 * 1024;

/** The inclusive cap for a small parser-error reply. */
const SMALL_RESPONSE_CAP = 64 * 1024;

/** True when an error is the peer reset Node reports after a malformed request. */
function isConnectionReset(error: Error): boolean {
  return (error as { readonly code?: string }).code === "ECONNRESET";
}

/**
 * Send one GET on a fresh ordinary socket, then pause after the first reply
 * bytes so a large response cannot finish, and write malformed request bytes.
 * The server's parser therefore fails while that response's headers are already
 * on the wire. Every byte read through peer closure is returned for framing
 * assertions; a peer reset is accepted only after the response started and the
 * malformed bytes were submitted, while other socket and write errors reject.
 * Reply bytes are capped rather than accumulated without bound.
 */
function largeResponseThenParserError(base: string): Promise<Buffer> {
  const url = new URL(base);
  return new Promise<Buffer>((resolve, reject) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    let started = false;
    let malformedSubmitted = false;
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (resumeTimer !== null) {
        clearTimeout(resumeTimer);
        resumeTimer = null;
      }
      socket.destroy();
      if (error !== undefined) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    socket.on("connect", () => {
      try {
        socket.write(
          `GET / HTTP/1.1\r\nHost: ${url.host}\r\nConnection: keep-alive\r\n\r\n`,
          (error?: Error | null) => {
            if (error !== undefined && error !== null) finish(error);
          },
        );
      } catch (error) {
        finish(error as Error);
      }
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      received += chunk.byteLength;
      if (received > LARGE_RESPONSE_CAP) {
        finish(new Error(`the reply bytes exceeded the ${LARGE_RESPONSE_CAP}-byte cap`));
        return;
      }
      chunks.push(chunk);
      if (!started) {
        started = true;
        // Stop reading so the large response stays in flight. The server still
        // receives the malformed bytes written now, so its parser fails while
        // the response headers are already on the wire.
        socket.pause();
        try {
          malformedSubmitted = true;
          socket.write("GARBAGE\r\n\r\n", (error?: Error | null) => {
            if (error !== undefined && error !== null) finish(error);
          });
        } catch (error) {
          finish(error as Error);
          return;
        }
        resumeTimer = setTimeout(() => {
          resumeTimer = null;
          socket.resume();
        }, 100);
      }
    });
    socket.on("end", () => finish());
    socket.on("close", () => finish());
    socket.on("error", (error: Error) => {
      if (isConnectionReset(error) && started && malformedSubmitted) finish();
      else finish(error);
    });
  });
}

/**
 * Send two pipelined GETs on one fresh socket, wait until the caller submits
 * malformed bytes, and read every reply byte through peer closure. The first
 * route's response never starts, while the second response's headers are
 * generated behind it. Reply data or peer closure before the malformed bytes
 * are submitted rejects instead of resolving a truncated prefix. Every reply
 * byte is capped; a peer reset is accepted only after a response started and
 * the malformed bytes were submitted, while other socket and write errors
 * reject.
 */
function queuedResponseThenParserError(base: string, writeMalformed: Promise<void>): Promise<Buffer> {
  const url = new URL(base);
  return new Promise<Buffer>((resolve, reject) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    let started = false;
    let malformedSubmitted = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error !== undefined) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    socket.on("connect", () => {
      try {
        const requests = [
          "GET / HTTP/1.1",
          `Host: ${url.host}`,
          "Connection: keep-alive",
          "",
          "",
          "GET /health HTTP/1.1",
          `Host: ${url.host}`,
          "",
          "",
        ].join("\r\n");
        socket.write(requests, (error?: Error | null) => {
          if (error !== undefined && error !== null) finish(error);
        });
      } catch (error) {
        finish(error as Error);
      }
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      received += chunk.byteLength;
      if (received > SMALL_RESPONSE_CAP) {
        finish(new Error(`the reply bytes exceeded the ${SMALL_RESPONSE_CAP}-byte cap`));
        return;
      }
      if (!malformedSubmitted) {
        finish(new Error("the server replied before the malformed bytes were submitted"));
        return;
      }
      chunks.push(chunk);
      started = true;
    });
    socket.on("end", () =>
      finish(malformedSubmitted ? undefined : new Error("the peer closed before the malformed bytes were submitted")),
    );
    socket.on("close", () =>
      finish(malformedSubmitted ? undefined : new Error("the peer closed before the malformed bytes were submitted")),
    );
    socket.on("error", (error: Error) => {
      if (isConnectionReset(error) && started && malformedSubmitted) finish();
      else finish(error);
    });
    writeMalformed.then(
      () => {
        if (settled) return;
        try {
          malformedSubmitted = true;
          socket.write("GARBAGE\r\n\r\n", (error?: Error | null) => {
            if (error !== undefined && error !== null) finish(error);
          });
        } catch (error) {
          finish(error as Error);
        }
      },
      (error: unknown) => finish(error as Error),
    );
  });
}

/** The one complete 413 a retiring connection must deliver, with its guidance. */
function assertOversizedRefusal(exchange: ClosedExchange, why: string): void {
  assert.equal(exchange.replies.length, 1, `${why}: the connection carries exactly one complete reply`);
  const reply = exchange.replies[0]!;
  assert.equal(reply.status, 413, `${why}: the reply is a 413`);
  assert.equal(reply.headers["content-type"], "text/plain; charset=utf-8", `${why}: the reply is plain text`);
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
    const guard = watchdog(5000, "the decoder-refusal reuse scenario did not finish");
    try {
      const before = baselineOf(runningFixture);
      const importPath = `/engagements/${encodeURIComponent(runningFixture.engagementId)}/transcripts/import`;

      // The POST sends the malformed body with an accurate Content-Length to the
      // engagement's import route, over the listener's own Host and Origin.
      const refusedPending = send(transport, runningFixture.server.origin, {
        method: "POST",
        path: importPath,
        contentType: MULTIPART_TYPE,
        body: unclosedMultipart(),
      });
      refusedPending.catch(() => undefined);
      const refused = await Promise.race([refusedPending, guard.promise]);
      assert.equal(refused.status, 400, "the malformed import is refused with 400");
      assert.match(String(refused.headers["content-type"]), /^text\/plain; charset=utf-8/, "the refusal is plain text");
      assert.equal(refused.headers["cache-control"], "no-store", "the refusal is not cached");
      assert.ok(refused.body.includes(MISSING_CLOSING), `the refusal carries the decoder's message: ${refused.body}`);
      assert.ok(refused.body.includes(MULTIPART_GUIDANCE), `the refusal carries the full guidance: ${refused.body}`);
      assert.equal(runningFixture.renders.import, 0, "the refused import never reached a handler");
      assertUnchanged(runningFixture, before, "after the refused import");

      // A following GET over the same transport is a complete 200.
      const healthPending = send(transport, runningFixture.server.origin, { path: "/health" });
      healthPending.catch(() => undefined);
      const health = await Promise.race([healthPending, guard.promise]);
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
      guard.clear();
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

  it("refuses an oversized declared import in flight, excludes a follow-up and writes nothing", async () => {
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

      // Start sending the whole declared body, then a complete follow-up GET,
      // before reading the reply; the 413 still answers from the declared
      // headers. The GET follows every declared body byte, so it is a real next
      // request on the socket rather than more POST body. It must never reach a
      // handler, and it must not add a second reply to the one 413.
      const pending = sendStaged(runningFixture.server.origin, {
        path: importPath,
        contentType: MULTIPART_TYPE,
        declaredLength: OVERSIZED_BODY_BYTES,
        bodyPrefix: body,
        followUp: rawGet(runningFixture.server.origin, "/health"),
      });
      pending.catch(() => undefined);
      const exchange = await Promise.race([pending, guard.promise]);
      assertOversizedRefusal(exchange, "in-flight body with follow-up");
      assert.equal(runningFixture.renders.import, 0, "the refused import never reached a handler");
      assert.equal(runningFixture.renders.followUp, 0, "the follow-up on the retiring socket never reached a handler");
      assertUnchanged(runningFixture, before, "after the in-flight refusal");
    } finally {
      guard.clear();
      await runningFixture.close();
    }
  });

  it("refuses one byte past an exact-limit epilogue while withholding the chunk terminator and writes nothing", async () => {
    const runningFixture = await running();
    const guard = watchdog(5000, "the withheld chunk terminator refusal did not finish");
    try {
      const before = baselineOf(runningFixture);
      const importPath = `/engagements/${encodeURIComponent(runningFixture.engagementId)}/transcripts/import`;
      const body = oneByteOverLimitMultipart({
        title: "Withheld terminator import",
        date: "2026-09-05",
        paste: "Dana: the withheld-terminator source.",
      });
      assert.equal(body.byteLength, OVERSIZED_BODY_BYTES, "the body is exactly one byte past the inclusive limit");

      // The first chunk is the whole exact-limit body; the second is the one
      // excess byte. No zero-length chunk follows, so the request stays
      // unfinished and the 413 must arrive from the excess byte alone, before
      // Node can end the request and the peer closes the connection.
      const pending = sendStaged(runningFixture.server.origin, {
        path: importPath,
        contentType: MULTIPART_TYPE,
        declaredLength: body.byteLength,
        bodyPrefix: body,
        chunked: true,
        chunkSize: EXACT_BODY_BYTES,
        withholdTerminator: true,
      });
      pending.catch(() => undefined);
      const exchange = await Promise.race([pending, guard.promise]);
      assertOversizedRefusal(exchange, "withheld chunk terminator");
      assert.equal(runningFixture.renders.import, 0, "the refused import never reached a handler");
      assert.equal(runningFixture.renders.followUp, 0, "no follow-up handler ran on the retiring socket");
      assertUnchanged(runningFixture, before, "after the withheld-terminator refusal");
    } finally {
      guard.clear();
      await runningFixture.close();
    }
  });

  it("drains a follow-up request and ignores a parser failure after a streaming overflow without another reply", async () => {
    const runningFixture = await running();
    const guard = watchdog(5000, "the streaming-overflow follow-up refusal did not finish");
    try {
      const before = baselineOf(runningFixture);
      const importPath = `/engagements/${encodeURIComponent(runningFixture.engagementId)}/transcripts/import`;
      const body = oneByteOverLimitMultipart({
        title: "Streaming overflow follow-up import",
        date: "2026-09-06",
        paste: "Eve: the streaming follow-up source.",
      });
      assert.equal(body.byteLength, OVERSIZED_BODY_BYTES, "the body is exactly one byte past the inclusive limit");

      // The body is complete after the excess byte, so the follow-up GET is a
      // real next request on the same socket. The trailing malformed bytes make
      // Node's parser fail during retirement. Neither may reach a handler, and
      // the parser failure must not replace, truncate or duplicate the one 413.
      const pending = sendStaged(runningFixture.server.origin, {
        path: importPath,
        contentType: MULTIPART_TYPE,
        declaredLength: body.byteLength,
        bodyPrefix: body,
        chunked: true,
        chunkSize: EXACT_BODY_BYTES,
        followUp: Buffer.concat([
          rawGet(runningFixture.server.origin, "/health"),
          Buffer.from("GARBAGE\r\n\r\n", "utf8"),
        ]),
      });
      pending.catch(() => undefined);
      const exchange = await Promise.race([pending, guard.promise]);
      assertOversizedRefusal(exchange, "streaming overflow with follow-up");
      assert.equal(runningFixture.renders.import, 0, "the refused import never reached a handler");
      assert.equal(runningFixture.renders.followUp, 0, "the follow-up on the retiring socket never reached a handler");
      assertUnchanged(runningFixture, before, "after the streaming-overflow refusal");
    } finally {
      guard.clear();
      await runningFixture.close();
    }
  });

  it("discards additional bytes of the same upload after the first excess byte and keeps one 413 through closure", async () => {
    const runningFixture = await running();
    const guard = watchdog(5000, "the additional-upload-bytes refusal did not finish");
    try {
      const before = baselineOf(runningFixture);
      const importPath = `/engagements/${encodeURIComponent(runningFixture.engagementId)}/transcripts/import`;
      const firstExcess = oneByteOverLimitMultipart({
        title: "Additional upload bytes import",
        date: "2026-09-07",
        paste: "Gail: the additional upload source.",
      });
      assert.equal(firstExcess.byteLength, OVERSIZED_BODY_BYTES, "the first excess byte is one past the inclusive limit");
      // The exact-limit prefix, the single excess byte and a further block of
      // the same upload are distinct HTTP chunks of one unfinished request, so
      // the server parser handles the excess byte before the rest of the
      // upload. Once the socket is reserved on that byte, the rest is discarded
      // rather than buffered or answered separately.
      const additional = Buffer.alloc(32 * 1024, 0x67);
      const body = Buffer.concat([firstExcess, additional]);
      const pending = sendStaged(runningFixture.server.origin, {
        path: importPath,
        contentType: MULTIPART_TYPE,
        declaredLength: body.byteLength,
        bodyPrefix: body,
        chunked: true,
        chunkSizes: [EXACT_BODY_BYTES, 1, additional.byteLength],
        withholdTerminator: true,
      });
      pending.catch(() => undefined);
      const exchange = await Promise.race([pending, guard.promise]);
      assertOversizedRefusal(exchange, "additional upload bytes after the first excess");
      assert.equal(runningFixture.renders.import, 0, "the refused import never reached a handler");
      assert.equal(runningFixture.renders.followUp, 0, "no follow-up handler ran on the retiring socket");
      assertUnchanged(runningFixture, before, "after the additional-upload-bytes refusal");
    } finally {
      guard.clear();
      await runningFixture.close();
    }
  });

  it("attempts sequential reuse of the original socket after the complete overflow 413 and gets no second reply", async () => {
    const runningFixture = await running();
    const guard = watchdog(5000, "the post-refusal reuse observation did not finish");
    try {
      const before = baselineOf(runningFixture);
      const importPath = `/engagements/${encodeURIComponent(runningFixture.engagementId)}/transcripts/import`;
      const body = oneByteOverLimitMultipart({
        title: "Post-refusal reuse import",
        date: "2026-09-08",
        paste: "Hana: the post-refusal reuse source.",
      });
      assert.equal(body.byteLength, OVERSIZED_BODY_BYTES, "the body is exactly one byte past the inclusive limit");

      // The client waits until the complete 413 has arrived, then writes a
      // bodyless GET on the original socket. The reserved socket must admit no
      // health render and deliver no second reply; closure at the reuse attempt
      // is the expected result.
      const pending = sendStaged(runningFixture.server.origin, {
        path: importPath,
        contentType: MULTIPART_TYPE,
        declaredLength: body.byteLength,
        bodyPrefix: body,
        chunked: true,
        chunkSize: EXACT_BODY_BYTES,
        reuseAfterReply: rawGet(runningFixture.server.origin, "/health"),
      });
      pending.catch(() => undefined);
      const exchange = await Promise.race([pending, guard.promise]);
      assertOversizedRefusal(exchange, "post-refusal original-socket reuse");
      assert.equal(exchange.reuseAttempted, true, "the client attempted reuse only after the complete 413");
      assert.equal(runningFixture.renders.import, 0, "the refused import never reached a handler");
      assert.equal(runningFixture.renders.followUp, 0, "the retired socket rendered zero health pages");
      assertUnchanged(runningFixture, before, "after the post-refusal reuse attempt");
    } finally {
      guard.clear();
      await runningFixture.close();
    }
  });

  it("protects a streaming overflow refusal from a late CONNECT and writes nothing", async () => {
    const runningFixture = await running();
    const guard = watchdog(5000, "the streaming-overflow CONNECT refusal did not finish");
    try {
      const before = baselineOf(runningFixture);
      const importPath = `/engagements/${encodeURIComponent(runningFixture.engagementId)}/transcripts/import`;
      const body = oneByteOverLimitMultipart({
        title: "Streaming overflow CONNECT import",
        date: "2026-09-07",
        paste: "Frank: the streaming CONNECT source.",
      });
      assert.equal(body.byteLength, OVERSIZED_BODY_BYTES, "the body is exactly one byte past the inclusive limit");

      // The body is complete after the excess byte, so the follow-up GET and the
      // CONNECT are real next messages on the same socket. Node dispatches the
      // CONNECT through its own event, which must not close the socket before
      // the reserved refusal writes its one complete 413.
      const pending = sendStaged(runningFixture.server.origin, {
        path: importPath,
        contentType: MULTIPART_TYPE,
        declaredLength: body.byteLength,
        bodyPrefix: body,
        chunked: true,
        chunkSize: EXACT_BODY_BYTES,
        combineTail: true,
        tailDelayMs: 200,
        followUp: Buffer.concat([
          rawGet(runningFixture.server.origin, "/health"),
          rawConnect(runningFixture.server.origin),
        ]),
      });
      pending.catch(() => undefined);
      const exchange = await Promise.race([pending, guard.promise]);
      assertOversizedRefusal(exchange, "streaming overflow with a late CONNECT");
      assert.equal(runningFixture.renders.import, 0, "the refused import never reached a handler");
      assert.equal(runningFixture.renders.followUp, 0, "the follow-up on the retiring socket never reached a handler");
      assertUnchanged(runningFixture, before, "after the streaming-overflow CONNECT refusal");
    } finally {
      guard.clear();
      await runningFixture.close();
    }
  });

  it("closes an ordinary connection after a parser error without appending a status line to a started response", async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    let server: StartedServer | null = null;
    const guard = watchdog(10000, "the started-response parser failure did not finish");
    try {
      // A large reply stays in flight because the client stops reading, so the
      // malformed bytes that follow are parsed while the response headers are
      // already on the wire.
      const large = Buffer.alloc(16 * 1024 * 1024, 0x61);
      const largeRoute: Route = {
        method: "GET",
        render() {
          return { status: 200, body: large, binary: true };
        },
      };
      const routes: Routes = { home: { get: largeRoute }, health: { get: largeRoute } };
      server = await startServer({ store, port: 0, routes });
      const pending = largeResponseThenParserError(server.origin);
      pending.catch(() => undefined);
      const bytes = await Promise.race([pending, guard.promise]);

      // The started response's own status line is the only one: a parser-error
      // reply must not be appended to the response stream after its headers.
      const text = bytes.toString("latin1");
      const statusLines = text.match(/HTTP\/1\.[01] /g) ?? [];
      assert.equal(statusLines.length, 1, "the started response is not followed by a parser-error status line");
      assert.ok(text.startsWith("HTTP/1.1 200 "), "the counted status line belongs to the started response");
    } finally {
      guard.clear();
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

  it("answers an ordinary parser error when only a later queued response has sent headers", async () => {
    const dir = tempDir();
    const store = await openStore(dir);
    let server: StartedServer | null = null;
    let firstGateResolve: () => void = () => undefined;
    const guard = watchdog(10000, "the queued-response parser failure did not finish");
    try {
      // The first route never resolves, so its response has not sent headers.
      // The second route renders at once and its response generates headers
      // while still queued behind the first. A parser failure must still get
      // the ordinary reply instead of being mistaken for a started response.
      const firstGate = new Promise<void>((resolve) => {
        firstGateResolve = resolve;
      });
      let queuedRendered!: () => void;
      const queuedRender = new Promise<void>((resolve) => {
        queuedRendered = resolve;
      });
      // The malformed bytes go out only after the second handler has rendered
      // and one turn has passed, so its headers are generated but queued behind
      // the still-pending first response.
      const writeMalformed = (async () => {
        await queuedRender;
        await new Promise<void>((resolve) => setImmediate(resolve));
      })();
      const slowRoute: Route = {
        method: "GET",
        render() {
          return firstGate.then(() => ({ status: 200, body: "first" }));
        },
      };
      const queuedRoute: Route = {
        method: "GET",
        render() {
          queuedRendered();
          return { status: 200, body: "queued" };
        },
      };
      const routes: Routes = { home: { get: slowRoute }, health: { get: queuedRoute } };
      server = await startServer({ store, port: 0, routes });
      const pending = queuedResponseThenParserError(server.origin, writeMalformed);
      pending.catch(() => undefined);
      // Race immediately, so a transport failure or watchdog expiry reaches
      // finally even when the second route never renders.
      const bytes = await Promise.race([pending, guard.promise]);

      const text = bytes.toString("latin1");
      const statusLines = text.match(/HTTP\/1\.[01] /g) ?? [];
      assert.equal(statusLines.length, 1, "the ordinary parser-error reply is written exactly once");
      const head = /^HTTP\/1\.1 400 [^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n/.exec(text);
      assert.ok(head !== null, "the complete parser-error status line and header block arrived through peer closure");
      assert.ok(!text.includes("HTTP/1.1 200 "), "the queued response's headers never reached the wire");
    } finally {
      guard.clear();
      firstGateResolve();
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

  it("rejects a staged reply whose partial status line runs into a second reply", async () => {
    const listener = testListener((req) => {
      req.resume();
      // A truncated 413 status line immediately followed by a complete 413:
      // the old parser ignored the second status line as a header without a
      // colon and counted the whole block as one valid reply.
      req.socket.write(
        "HTTP/1.1 413 Payload Too Large\r\n" +
          "HTTP/1.1 413 Payload Too Large\r\n" +
          "content-length: 9\r\n" +
          "content-type: text/plain\r\n" +
          "cache-control: no-store\r\n" +
          "connection: close\r\n\r\n" +
          "too large",
      );
      req.socket.end();
    });
    const guard = watchdog(5000, "the malformed staged reply did not finish");
    try {
      const pending = listener.ready.then(() =>
        sendStaged(`http://127.0.0.1:${listener.port()}`, {
          path: "/",
          contentType: "text/plain",
          declaredLength: 0,
        }),
      );
      const expected = assert.rejects(pending, /truncated reply/, "a partial status line cannot absorb a following reply");
      expected.catch(() => undefined);
      await Promise.race([Promise.all([listener.ready, expected]), guard.promise]);
    } finally {
      guard.clear();
      await listener.close();
    }
  });

  it("rejects a staged reply whose partial header line carries the next status line", async () => {
    const listener = testListener((req) => {
      req.resume();
      // The first reply stops just after `Connection: `, so the complete
      // reply's status line becomes that header's value. Its later
      // `connection: close` header would otherwise overwrite the evidence and
      // let the whole block be counted as one complete 413.
      req.socket.write(
        "HTTP/1.1 413 Payload Too Large\r\n" +
          "Connection: " +
          "HTTP/1.1 413 Payload Too Large\r\n" +
          "content-length: 9\r\n" +
          "content-type: text/plain\r\n" +
          "cache-control: no-store\r\n" +
          "connection: close\r\n\r\n" +
          "too large",
      );
      req.socket.end();
    });
    const guard = watchdog(5000, "the malformed staged reply did not finish");
    try {
      const pending = listener.ready.then(() =>
        sendStaged(`http://127.0.0.1:${listener.port()}`, {
          path: "/",
          contentType: "text/plain",
          declaredLength: 0,
        }),
      );
      const expected = assert.rejects(pending, /truncated reply/, "a status line inside a header value cannot complete a reply");
      expected.catch(() => undefined);
      await Promise.race([Promise.all([listener.ready, expected]), guard.promise]);
    } finally {
      guard.clear();
      await listener.close();
    }
  });

  it("counts a complete staged reply whose optional header value mentions a status line", async () => {
    const listener = testListener((req) => {
      req.resume();
      // An unrelated header value may legally mention a status line; it must
      // not make the parser reject an otherwise complete, correctly framed 413.
      req.socket.write(
        "HTTP/1.1 413 Payload Too Large\r\n" +
          "content-length: 9\r\n" +
          "content-type: text/plain\r\n" +
          "cache-control: no-store\r\n" +
          "connection: close\r\n" +
          "X-Diagnostic: upstream returned HTTP/1.1 200 OK\r\n\r\n" +
          "too large",
      );
      req.socket.end();
    });
    const guard = watchdog(5000, "the complete staged reply did not finish");
    try {
      const pending = listener.ready.then(() =>
        sendStaged(`http://127.0.0.1:${listener.port()}`, {
          path: "/",
          contentType: "text/plain",
          declaredLength: 0,
        }),
      );
      pending.catch(() => undefined);
      const exchange = await Promise.race([pending, guard.promise]);
      assert.equal(exchange.replies.length, 1, "the reply with an unrelated diagnostic header is counted once");
      const reply = exchange.replies[0]!;
      assert.equal(reply.status, 413, "the counted reply is a 413");
      assert.equal(reply.headers["x-diagnostic"], "upstream returned HTTP/1.1 200 OK", "the diagnostic header value is preserved");
      assert.equal(reply.body, "too large", "the counted reply carries its declared body");
    } finally {
      guard.clear();
      await listener.close();
    }
  });

  it("counts a complete staged reply with a legal constructor header", async () => {
    const listener = testListener((req) => {
      req.resume();
      // `constructor` is a legal header field name. It must be stored as data,
      // not confused with a property inherited by a plain object.
      req.socket.write(
        "HTTP/1.1 413 Payload Too Large\r\n" +
          "content-length: 9\r\n" +
          "content-type: text/plain\r\n" +
          "cache-control: no-store\r\n" +
          "connection: close\r\n" +
          "constructor: data\r\n\r\n" +
          "too large",
      );
      req.socket.end();
    });
    const guard = watchdog(5000, "the constructor-header staged reply did not finish");
    try {
      const pending = listener.ready.then(() =>
        sendStaged(`http://127.0.0.1:${listener.port()}`, {
          path: "/",
          contentType: "text/plain",
          declaredLength: 0,
        }),
      );
      pending.catch(() => undefined);
      const exchange = await Promise.race([pending, guard.promise]);
      assert.equal(exchange.replies.length, 1, "the reply with a legal constructor header is counted once");
      const reply = exchange.replies[0]!;
      assert.equal(reply.headers["constructor"], "data", "the constructor header value is stored as data");
      assert.equal(Object.getPrototypeOf(reply.headers), null, "the returned headers use prototype-free storage");
      assert.equal(reply.body, "too large", "the counted reply carries its declared body");
    } finally {
      guard.clear();
      await listener.close();
    }
  });

  it("rejects a staged reply that declares Transfer-Encoding alongside Content-Length", async () => {
    const listener = testListener((req) => {
      req.resume();
      // This reader frames replies by Content-Length only, so a transfer coding
      // is conflicting framing even when the declared length matches the body.
      req.socket.write(
        "HTTP/1.1 413 Payload Too Large\r\n" +
          "content-length: 9\r\n" +
          "transfer-encoding: chunked\r\n" +
          "content-type: text/plain\r\n" +
          "cache-control: no-store\r\n" +
          "connection: close\r\n\r\n" +
          "too large",
      );
      req.socket.end();
    });
    const guard = watchdog(5000, "the transfer-framed staged reply did not finish");
    try {
      const pending = listener.ready.then(() =>
        sendStaged(`http://127.0.0.1:${listener.port()}`, {
          path: "/",
          contentType: "text/plain",
          declaredLength: 0,
        }),
      );
      const expected = assert.rejects(pending, /truncated reply/, "conflicting transfer framing cannot complete a reply");
      expected.catch(() => undefined);
      await Promise.race([Promise.all([listener.ready, expected]), guard.promise]);
    } finally {
      guard.clear();
      await listener.close();
    }
  });

  it("rejects a staged reply whose header value carries a bare carriage return", async () => {
    const listener = testListener((req) => {
      req.resume();
      // A bare CR inside a field value is a control character, not line framing.
      req.socket.write(
        "HTTP/1.1 413 Payload Too Large\r\n" +
          "content-length: 9\r\n" +
          "x-diagnostic: before\rafter\r\n" +
          "content-type: text/plain\r\n" +
          "cache-control: no-store\r\n" +
          "connection: close\r\n\r\n" +
          "too large",
      );
      req.socket.end();
    });
    const guard = watchdog(5000, "the bare-carriage-return staged reply did not finish");
    try {
      const pending = listener.ready.then(() =>
        sendStaged(`http://127.0.0.1:${listener.port()}`, {
          path: "/",
          contentType: "text/plain",
          declaredLength: 0,
        }),
      );
      const expected = assert.rejects(pending, /truncated reply/, "a bare carriage return cannot complete a reply");
      expected.catch(() => undefined);
      await Promise.race([Promise.all([listener.ready, expected]), guard.promise]);
    } finally {
      guard.clear();
      await listener.close();
    }
  });

  it("rejects a staged reply whose Content-Length value carries a bare line feed", async () => {
    const listener = testListener((req) => {
      req.resume();
      // The bare LF before the digits must not be stripped and counted as a
      // valid length; it is a control character in the raw field value.
      req.socket.write(
        "HTTP/1.1 413 Payload Too Large\r\n" +
          "content-length: \n9\r\n" +
          "content-type: text/plain\r\n" +
          "cache-control: no-store\r\n" +
          "connection: close\r\n\r\n" +
          "too large",
      );
      req.socket.end();
    });
    const guard = watchdog(5000, "the bare-line-feed staged reply did not finish");
    try {
      const pending = listener.ready.then(() =>
        sendStaged(`http://127.0.0.1:${listener.port()}`, {
          path: "/",
          contentType: "text/plain",
          declaredLength: 0,
        }),
      );
      const expected = assert.rejects(pending, /truncated reply/, "a bare line feed in a length cannot complete a reply");
      expected.catch(() => undefined);
      await Promise.race([Promise.all([listener.ready, expected]), guard.promise]);
    } finally {
      guard.clear();
      await listener.close();
    }
  });

  it("rejects a staged reply whose Content-Type fields conflict before counting it", async () => {
    const listener = testListener((req) => {
      req.resume();
      // The first Content-Type is not the expected plain text, while the later
      // field overwrites it in the returned headers. Conflicting singleton
      // fields must not be resolved by the last header line.
      req.socket.write(
        "HTTP/1.1 413 Payload Too Large\r\n" +
          "content-length: 9\r\n" +
          "content-type: text/html\r\n" +
          "content-type: text/plain\r\n" +
          "cache-control: no-store\r\n" +
          "connection: close\r\n\r\n" +
          "too large",
      );
      req.socket.end();
    });
    const guard = watchdog(5000, "the conflicting Content-Type staged reply did not finish");
    try {
      const pending = listener.ready.then(() =>
        sendStaged(`http://127.0.0.1:${listener.port()}`, {
          path: "/",
          contentType: "text/plain",
          declaredLength: 0,
        }),
      );
      const expected = assert.rejects(pending, /truncated reply/, "conflicting Content-Type fields cannot complete a reply");
      expected.catch(() => undefined);
      await Promise.race([Promise.all([listener.ready, expected]), guard.promise]);
    } finally {
      guard.clear();
      await listener.close();
    }
  });

  it("rejects a staged reply whose Content-Length fields conflict before counting it", async () => {
    const listener = testListener((req) => {
      req.resume();
      // The last Content-Length agrees with the body, but the earlier field does
      // not: overwriting the earlier field would wrongly count this reply.
      req.socket.write(
        "HTTP/1.1 413 Payload Too Large\r\n" +
          "content-length: 10\r\n" +
          "content-length: 9\r\n" +
          "content-type: text/plain\r\n" +
          "cache-control: no-store\r\n" +
          "connection: close\r\n\r\n" +
          "too large",
      );
      req.socket.end();
    });
    const guard = watchdog(5000, "the conflicting staged reply did not finish");
    try {
      const pending = listener.ready.then(() =>
        sendStaged(`http://127.0.0.1:${listener.port()}`, {
          path: "/",
          contentType: "text/plain",
          declaredLength: 0,
        }),
      );
      const expected = assert.rejects(pending, /truncated reply/, "conflicting Content-Length fields cannot complete a reply");
      expected.catch(() => undefined);
      await Promise.race([Promise.all([listener.ready, expected]), guard.promise]);
    } finally {
      guard.clear();
      await listener.close();
    }
  });

  it("commits two exact-limit imports sequentially, the second chunked, and reuses one socket for each health read", async () => {
    const runningFixture = await running();
    const transport = keepAliveTransport();
    const guard = watchdog(10000, "the exact-limit sequential imports did not finish");
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

        const replyPending = send(transport, runningFixture.server.origin, {
          method: "POST",
          path: importPath,
          contentType: MULTIPART_TYPE,
          body,
          chunked: request.chunked,
        });
        replyPending.catch(() => undefined);
        const reply = await Promise.race([replyPending, guard.promise]);
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

        const healthPending = send(transport, runningFixture.server.origin, { path: "/health" });
        healthPending.catch(() => undefined);
        const health = await Promise.race([healthPending, guard.promise]);
        assert.equal(health.status, 200, `the health read after import ${index + 1} is a complete 200`);
        assert.ok(health.body.includes("ok"), `the health read after import ${index + 1} reports its status: ${health.body}`);
        assert.ok(isPositiveInteger(reply.localPort), `import ${index + 1}'s local port is a positive integer: ${reply.localPort}`);
        assert.ok(isPositiveInteger(health.localPort), `the health read after import ${index + 1} has a positive local port: ${health.localPort}`);
        assert.equal(reply.localPort, health.localPort, `import ${index + 1} and its health read reused one connection`);
      }
    } finally {
      guard.clear();
      transport.close();
      await runningFixture.close();
    }
  });

  it("renders an eligible GET once with an empty form and null file in a 50-client workspace, then reuses the socket for health", async () => {
    const runningFixture = await running({ clients: 50 });
    const transport = keepAliveTransport();
    const guard = watchdog(5000, "the 50-client eligible GET scenario did not finish");
    try {
      assert.equal(runningFixture.store.snapshot().clients.length, 50, "the synthetic workspace holds 50 clients");
      const before = baselineOf(runningFixture);

      // /clients is an eligible bodyless GET route. Its render sees the shell's
      // accepted request: method GET, the route path, the canonical origin, an
      // empty form and no file.
      const clientsPending = send(transport, runningFixture.server.origin, { path: "/clients" });
      clientsPending.catch(() => undefined);
      const clients = await Promise.race([clientsPending, guard.promise]);
      assert.equal(clients.status, 200, `the clients list is a complete 200: ${clients.body.slice(0, 200)}`);
      assert.equal(runningFixture.requests.length, 1, "the eligible GET route rendered exactly once");
      const request = runningFixture.requests[0]!;
      assert.equal(request.method, "GET", "the route request is a GET");
      assert.equal(request.path, "/clients", "the route request carries the request path");
      assert.equal(request.origin, runningFixture.server.origin, "the route request carries the canonical origin");
      assert.deepEqual(request.form, {}, "the route request carries an empty form");
      assert.equal(request.file, null, "the route request carries no file");
      assert.ok(clients.body.includes("Client 50"), "the usual clients response includes the last synthetic client");

      // The subsequent health read is a complete 200 on the same kept-alive
      // socket, proven by the equal positive client local ports.
      const healthPending = send(transport, runningFixture.server.origin, { path: "/health" });
      healthPending.catch(() => undefined);
      const health = await Promise.race([healthPending, guard.promise]);
      assert.equal(health.status, 200, `the health page is a complete 200: ${health.body}`);
      assert.ok(health.body.includes("ok"), `the health page reports its status: ${health.body}`);
      assert.equal(runningFixture.renders.followUp, 1, "the health route rendered once");
      assert.equal(runningFixture.requests.length, 1, "the health GET never reached a hierarchy route");
      assert.ok(isPositiveInteger(clients.localPort), `the clients reply's local port is a positive integer: ${clients.localPort}`);
      assert.ok(isPositiveInteger(health.localPort), `the health reply's local port is a positive integer: ${health.localPort}`);
      assert.equal(clients.localPort, health.localPort, "the eligible GET and the health read reused one connection");

      assertUnchanged(runningFixture, before, "after the eligible GET and health read");
    } finally {
      guard.clear();
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

describe("transcript HTTP transport: one settled final reply per request", () => {
  it("answers a framing error before any request object exists with one complete no-store 400 and closes", async () => {
    const runningFixture = await running();
    const guard = watchdog(5000, "the pre-dispatch framing error did not finish");
    try {
      const before = baselineOf(runningFixture);
      const pending = sendRaw(runningFixture.server.origin, {
        steps: [{ bytes: Buffer.from("GARBAGE\r\n\r\n", "utf8") }],
      });
      pending.catch(() => undefined);
      const exchange = await Promise.race([pending, guard.promise]);
      assert.equal(exchange.replies.length, 1, "the connection carries exactly one complete reply");
      assertOrdinaryRefusal(exchange.replies[0]!, 400, "pre-dispatch framing error");
      assert.ok(isPositiveInteger(exchange.localPort), `the exchange used one positive client local port: ${exchange.localPort}`);
      assert.equal(runningFixture.renders.import, 0, "the malformed request never reached an import handler");
      assertUnchanged(runningFixture, before, "after the pre-dispatch framing error");
    } finally {
      guard.clear();
      await runningFixture.close();
    }
  });

  it("answers a malformed import after a complete health reply on the same connection with one no-store 400", async () => {
    const runningFixture = await running();
    const guard = watchdog(5000, "the malformed import after health did not finish");
    try {
      const before = baselineOf(runningFixture);
      const importPath = `/engagements/${encodeURIComponent(runningFixture.engagementId)}/transcripts/import`;
      const pending = sendRaw(runningFixture.server.origin, {
        steps: [
          { bytes: rawGet(runningFixture.server.origin, "/health"), afterReplies: 1 },
          { bytes: malformedPost(runningFixture.server.origin, importPath) },
        ],
      });
      pending.catch(() => undefined);
      const exchange = await Promise.race([pending, guard.promise]);
      assert.equal(exchange.replies.length, 2, "the connection carries the earlier 200 and exactly one parser-error reply");
      const health = exchange.replies[0]!;
      assert.equal(health.status, 200, "the earlier health reply is a complete 200");
      assertOrdinaryRefusal(exchange.replies[1]!, 400, "malformed import after health");
      assert.ok(isPositiveInteger(exchange.localPort), `the exchange used one positive client local port: ${exchange.localPort}`);
      assert.equal(runningFixture.renders.followUp, 1, "the health read rendered once");
      assert.equal(runningFixture.renders.import, 0, "the malformed import never reached a handler");
      assertUnchanged(runningFixture, before, "after the malformed import");
    } finally {
      guard.clear();
      await runningFixture.close();
    }
  });

  it("answers an upload whose input ends before its declared body with one complete no-store 400", async () => {
    const runningFixture = await running();
    const guard = watchdog(5000, "the incomplete upload did not finish");
    try {
      const before = baselineOf(runningFixture);
      const importPath = `/engagements/${encodeURIComponent(runningFixture.engagementId)}/transcripts/import`;
      const prefix = Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="paste"\r\n\r\nAlice: the interrupted source.\r\n`,
        "utf8",
      );
      const declared = prefix.byteLength + 4096;
      const request = rawPostRequest(runningFixture.server.origin, importPath, {
        Origin: new URL(runningFixture.server.origin).origin,
        "Content-Type": MULTIPART_TYPE,
        "Content-Length": String(declared),
      }, prefix);
      const pending = sendRaw(runningFixture.server.origin, {
        steps: [{ bytes: request, endWrite: true }],
      });
      pending.catch(() => undefined);
      const exchange = await Promise.race([pending, guard.promise]);
      assert.equal(exchange.replies.length, 1, "the connection carries exactly one complete reply");
      assertOrdinaryRefusal(exchange.replies[0]!, 400, "incomplete upload");
      assert.equal(exchange.writeEnded, true, "the peer ended its write side before the declared body was complete");
      assert.equal(runningFixture.renders.import, 0, "the incomplete import never reached a handler");
      assertUnchanged(runningFixture, before, "after the incomplete upload");
    } finally {
      guard.clear();
      await runningFixture.close();
    }
  });

  it("closes after a guard reply when the same POST's framing fails without another final reply", async () => {
    const runningFixture = await running();
    const guard = watchdog(5000, "the guard reply followed by a framing error did not finish");
    try {
      const before = baselineOf(runningFixture);
      const importPath = `/engagements/${encodeURIComponent(runningFixture.engagementId)}/transcripts/import`;
      // The POST omits Origin, so the guard answers 403 before reading the
      // chunked body. The guard reply is complete before the malformed chunk is
      // written, so the same request's final reply has already finished.
      const request = rawPostRequest(runningFixture.server.origin, importPath, {
        "Content-Type": MULTIPART_TYPE,
        "Transfer-Encoding": "chunked",
      }, Buffer.from("5\r\nhello\r\n", "utf8"));
      const pending = sendRaw(runningFixture.server.origin, {
        steps: [
          { bytes: request, afterReplies: 1 },
          { bytes: Buffer.from("Z\r\n", "utf8") },
        ],
      });
      pending.catch(() => undefined);
      const exchange = await Promise.race([pending, guard.promise]);
      assert.equal(exchange.replies.length, 1, "the guard reply is the only final reply");
      assert.equal(exchange.replies[0]!.status, 403, "the only reply is the guard's 403");
      assert.equal(exchange.replies[0]!.headers["cache-control"], "no-store", "the guard reply is not cached");
      assert.equal(runningFixture.renders.import, 0, "the refused import never reached a handler");
      assertUnchanged(runningFixture, before, "after the guard reply and framing error");
    } finally {
      guard.clear();
      await runningFixture.close();
    }
  });

  it("makes no response attempt after the peer resets mid-upload", async () => {
    const runningFixture = await running();
    const observation = observeServerWrites();
    const guard = watchdog(15000, "the reset mid-upload did not finish");
    try {
      const before = baselineOf(runningFixture);
      const attemptsBeforeReset = observation.attempts();
      const importPath = `/engagements/${encodeURIComponent(runningFixture.engagementId)}/transcripts/import`;
      // The prefix carries the whole synthetic 10 MiB file but no closing
      // boundary, and the declared length asks for more. Completing the large
      // write before the reset shows the server consumed the partial upload;
      // the reset then leaves nothing for it to answer.
      const prefix = partialFileMultipart(10 * 1024 * 1024);
      const request = rawPostRequest(runningFixture.server.origin, importPath, {
        Origin: new URL(runningFixture.server.origin).origin,
        "Content-Type": MULTIPART_TYPE,
        "Content-Length": String(prefix.byteLength + 1024),
      }, prefix);
      const pending = sendRaw(runningFixture.server.origin, {
        deadlineMs: 10000,
        minimumReplies: 0,
        steps: [{ bytes: request, afterWrite: true, reset: true }],
      });
      pending.catch(() => undefined);
      const exchange = await Promise.race([pending, guard.promise]);
      assert.equal(exchange.resetRequested, true, "the peer reset the connection after the partial upload");
      assert.equal(exchange.replies.length, 0, "the failed upload receives no reply after the peer reset");
      assert.equal(exchange.bytes.byteLength, 0, "the peer receives no bytes after its reset");
      assert.equal(
        observation.attempts(),
        attemptsBeforeReset,
        "the server makes no further response write attempt after the peer loss",
      );
      assert.equal(runningFixture.renders.import, 0, "the failed upload never reached an import handler");
      assertUnchanged(runningFixture, before, "after the peer reset mid-upload");
    } finally {
      observation.close();
      guard.clear();
      await runningFixture.close();
    }
  });

  it("delivers the reserved overflow 413 as the only final reply when the same upload's framing fails during retirement", async () => {
    const runningFixture = await running();
    const guard = watchdog(5000, "the overflow with a framing failure during retirement did not finish");
    try {
      const before = baselineOf(runningFixture);
      const importPath = `/engagements/${encodeURIComponent(runningFixture.engagementId)}/transcripts/import`;
      const body = oneByteOverLimitMultipart({
        title: "Overflow framing retirement import",
        date: "2026-09-09",
        paste: "Iris: the overflow retirement source.",
      });
      assert.equal(body.byteLength, OVERSIZED_BODY_BYTES, "the body is exactly one byte past the inclusive limit");
      // The exact-limit chunk is followed by the single excess byte and then an
      // invalid chunk-size line in the same unfinished chunked upload. The
      // reserved refusal must survive that parser failure as the only reply.
      const pending = sendStaged(runningFixture.server.origin, {
        path: importPath,
        contentType: MULTIPART_TYPE,
        declaredLength: body.byteLength,
        bodyPrefix: body,
        chunked: true,
        chunkSizes: [EXACT_BODY_BYTES, 1],
        withholdTerminator: true,
        followUp: Buffer.from("Z\r\n", "utf8"),
      });
      pending.catch(() => undefined);
      const exchange = await Promise.race([pending, guard.promise]);
      assertOversizedRefusal(exchange, "overflow with a framing failure during retirement");
      assert.equal(runningFixture.renders.import, 0, "the refused import never reached a handler");
      assert.equal(runningFixture.renders.followUp, 0, "no follow-up handler ran on the retiring socket");
      assertUnchanged(runningFixture, before, "after the overflow framing failure");
    } finally {
      guard.clear();
      await runningFixture.close();
    }
  });
});
