import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  escapeHtml,
  FormError,
  redirect,
  renderForm,
  renderFormError,
  renderPage,
  type FieldSpec,
} from "../src/html.ts";
import {
  appRoutes,
  canonicalOrigin,
  DEFAULT_MAX_BODY_BYTES,
  startServer,
  type Route,
  type RouteResult,
  type Routes,
  type StartedServer,
} from "../src/server.ts";
import { health as healthOf } from "../src/index.ts";
import { MissingRecordError, openStore, ValidationError, type Store } from "../src/store.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "server-"));
  roots.push(dir);
  return dir;
}

/**
 * A test-only POST route for the home path. It is the only route that may
 * reach the store, and only through `mutate`; the fixture's home POST wraps
 * it so a rejected request that reached a handler would be counted.
 *
 * The mutation is awaited before the redirect is returned, so the reply a test
 * waits for is only sent once the write has completed (or has failed, which
 * propagates as the route's failure) and a test's assertions read finished
 * state rather than racing the write.
 */
function postHomeRoute(mutate: () => Promise<void>): Route {
  return {
    method: "POST",
    async render() {
      await mutate();
      return redirect("/");
    },
  };
}

/** Counts of every route invocation and every store mutation. */
interface Calls {
  get: number;
  post: number;
  mutations: number;
}

function newCalls(): Calls {
  return { get: 0, post: 0, mutations: 0 };
}

/**
 * Wrap a real on-disk store so every mutation method is counted before it is
 * called. A route that mutated would really change the workspace, so the
 * shell's checks must keep mutation methods from ever running.
 */
function instrumentedStore(inner: Store, calls: Calls): Store {
  const count = <T>(op: () => Promise<T>): Promise<T> => {
    calls.mutations += 1;
    return op();
  };
  return {
    snapshot: () => inner.snapshot(),
    createClient: (input) => count(() => inner.createClient(input)),
    updateClient: (id, edit) => count(() => inner.updateClient(id, edit)),
    createEngagement: (input) => count(() => inner.createEngagement(input)),
    updateEngagement: (id, edit) => count(() => inner.updateEngagement(id, edit)),
    createProject: (input) => count(() => inner.createProject(input)),
    updateProject: (id, edit) => count(() => inner.updateProject(id, edit)),
    createTask: (input) => count(() => inner.createTask(input)),
    updateTask: (id, edit) => count(() => inner.updateTask(id, edit)),
    createItem: (input) => count(() => inner.createItem(input)),
    updateItem: (id, edit) => count(() => inner.updateItem(id, edit)),
    createMeeting: (input) => count(() => inner.createMeeting(input)),
    updateMeeting: (id, edit) => count(() => inner.updateMeeting(id, edit)),
    listTasks: (filter) => inner.listTasks(filter),
    listItems: (filter) => inner.listItems(filter),
    listMeetings: (filter) => inner.listMeetings(filter),
    close: () => inner.close(),
  };
}

/**
 * Wrap every route so each invocation is counted. The wrapped table is the
 * only table the server dispatches to, so a rejected request that invoked a
 * handler would be counted here.
 */
function instrumented(app: Routes, calls: Calls): Routes {
  const wrap = (route: Route, method: "GET" | "POST"): Route => ({
    method,
    render: (req) => {
      if (method === "POST") calls.post += 1;
      else calls.get += 1;
      return route.render(req);
    },
  });
  const post = (route: Route | undefined): Route | undefined =>
    route === undefined ? undefined : wrap(route, "POST");
  return {
    home: { get: wrap(app.home.get, "GET"), post: post(app.home.post) },
    health: { get: wrap(app.health.get, "GET"), post: post(app.health.post) },
  };
}

/**
 * A fixture: one real store, one route table, and one server, all sharing the
 * same instrumented store. `closeFixture` closes the server as well as the
 * store, so no fixture leaks a listener into the event loop.
 */
interface Fixture {
  readonly server: StartedServer;
  readonly calls: Calls;
  readonly store: Store;
}

/**
 * Build a fixture from a route factory. The factory receives the instrumented
 * store and the app's own routes, so the store a handler can reach is the
 * store the assertions read.
 */
async function fixtureWith(
  factory: (store: Store, app: Routes) => Routes,
  withPostHome = false,
): Promise<Fixture> {
  const calls = newCalls();
  const store = instrumentedStore(await openStore(tempDir()), calls);
  const app = appRoutes(store);
  const home: { get: Route; post?: Route } = withPostHome
    ? {
        get: app.home.get,
        // The test-only POST destination mutates through the same instrumented
        // store, so a mutation a handler makes is counted on `fixture.store`.
        // The write is awaited by the route, so the 303 is sent only after it
        // has completed and its failure is reported, never swallowed.
        post: postHomeRoute(async () => {
          await store.createClient({ name: "from a handler" });
        }),
      }
    : { get: app.home.get };
  const routes = instrumented(factory(store, { home, health: app.health }), calls);
  const server = await startServer({ store, port: 0, routes });
  return { server, calls, store };
}

async function newFixture(withPostHome = false): Promise<Fixture> {
  return fixtureWith((_store, base) => base, withPostHome);
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.server.close();
  await fixture.store.close();
}

/**
 * Run a test against a freshly started server that uses the fixture's store,
 * and always close both the server and the store afterwards. The route table
 * built by `routes` is instrumented on the fixture's counters, so a handler a
 * rejected request reached would show up in `fixture.calls`.
 */
async function withServer(
  routes: Routes,
  body: (server: StartedServer, fixture: Fixture) => Promise<void>,
): Promise<void> {
  const fixture = await newFixture();
  const server = await startServer({ store: fixture.store, port: 0, routes: instrumented(routes, fixture.calls) });
  try {
    await body(server, fixture);
  } finally {
    await server.close();
    await closeFixture(fixture);
  }
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

interface RawOptions {
  readonly method?: string;
  readonly path?: string;
  /** Host header; `null` omits it. */
  readonly host?: string | null;
  /** Origin header; `null` or omitted omits it. */
  readonly origin?: string | null;
  readonly contentType?: string | null;
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

/** Parse a raw HTTP response from a socket. */
function parseReply(text: string): Reply {
  const [head, body] = text.split("\r\n\r\n");
  const lines = (head ?? "").split("\r\n");
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const at = line.indexOf(":");
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return { status: Number(lines[0]?.split(" ")[1] ?? 0), headers, body: body ?? "" };
}

/**
 * The state of a raw HTTP response read from a socket. It never depends on
 * packet boundaries: `incomplete` means more bytes are still expected (no
 * header block yet, or a declared Content-Length not yet satisfied) and
 * `truncated` means the peer finished the response early, so what arrived can
 * never be a complete response.
 */
type ReplyState =
  | { readonly state: "incomplete" }
  | { readonly state: "truncated" }
  | { readonly state: "complete"; readonly reply: Reply };

/**
 * Accumulates a raw HTTP response and reports it complete only once the header
 * block ends with a blank line and any declared Content-Length body has fully
 * arrived. A response with no declared length is complete when its headers are.
 */
function replyReader() {
  const chunks: Buffer[] = [];
  const read = (eof: boolean): ReplyState => {
    const buffer = Buffer.concat(chunks);
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return { state: eof ? "truncated" : "incomplete" };
    // Read the body as bytes, not as decoded text, so a multi-byte character
    // split across packets still counts as received.
    const bodyBuffer = buffer.subarray(end + 4);
    const text = buffer.toString("utf8");
    const reply = parseReply(text);
    const declared = typeof reply.headers["content-length"] === "string" ? reply.headers["content-length"] : undefined;
    if (declared !== undefined && /^\d+$/.test(declared)) {
      if (bodyBuffer.byteLength < Number(declared)) return { state: eof ? "truncated" : "incomplete" };
    }
    return { state: "complete", reply };
  };
  return {
    push(chunk: Buffer): void {
      chunks.push(chunk);
    },
    /** The state after the bytes received so far; `eof` marks the peer's end. */
    read,
    /** The parsed reply once complete, otherwise null. */
    complete(): Reply | null {
      const reply = read(false);
      return reply.state === "complete" ? reply.reply : null;
    },
  };
}

/**
 * Settle one raw exchange as soon as the accumulated bytes form a complete
 * response, or fail it when the peer finishes early. The socket is always
 * destroyed before the promise settles, the wait is bounded by a timeout, and
 * a `close` that follows a settled promise is ignored.
 */
function exchange(
  options: { readonly host: string; readonly port: number; readonly timeoutMs: number },
  writeRequest: (socket: Socket) => void,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: options.host, port: options.port });
    const reader = replyReader();
    let settled = false;
    const settle = (error: Error | null, reply?: Reply): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error === null && reply !== undefined) resolve(reply);
      else reject(error ?? new Error("no reply"));
    };
    const check = (): void => {
      const state = reader.read(false);
      if (state.state === "complete") settle(null, state.reply);
    };
    socket.on("connect", () => writeRequest(socket));
    socket.on("data", (chunk: Buffer) => {
      reader.push(chunk);
      check();
    });
    // The peer finished the response before it was complete: fail explicitly
    // rather than leave the promise waiting for bytes that will never arrive.
    socket.on("end", () => {
      const state = reader.read(true);
      if (state.state === "complete") settle(null, state.reply);
      else if (!settled) settle(new Error("connection ended before the complete reply arrived"));
    });
    socket.on("close", () => {
      const state = reader.read(true);
      if (state.state === "complete") settle(null, state.reply);
      else if (!settled) settle(new Error("connection closed before the complete reply arrived"));
    });
    socket.setTimeout(options.timeoutMs, () => settle(new Error("timed out waiting for a complete reply")));
    socket.on("error", (error) => settle(error));
  });
}

/**
 * Send a request over a raw socket. Node's client always adds a Host header
 * and rewrites an empty one, so a request with a missing or empty Host has to
 * be written by hand. The reply is read until complete (see `replyReader`) and
 * only then is the socket destroyed, so no connection outlives the test and no
 * assertion runs on a partial reply.
 */
function raw(origin: string, requestLines: string[], body = ""): Promise<Reply> {
  const url = new URL(origin);
  return exchange({ host: url.hostname, port: Number(url.port), timeoutMs: 2000 }, (socket) => {
    const head = requestLines.join("\r\n");
    const payload = body === "" ? "" : `\r\n${body}`;
    socket.write(`${head}${payload}\r\n\r\n`);
  });
}

/** A raw HTTP/1.0 request with no Host header, as the acceptance test requires. */
function rawGetWithoutHost(origin: string): Promise<Reply> {
  return raw(origin, ["GET / HTTP/1.0", "Accept: text/html"]);
}

function send(origin: string, options: RawOptions): Promise<Reply> {
  const url = new URL(origin);
  const headers: Record<string, string> = {};
  if (options.host !== null) headers.host = options.host ?? url.host;
  if (options.origin !== undefined && options.origin !== null) headers.origin = options.origin;
  if (options.contentType !== null) {
    headers["content-type"] = options.contentType ?? "application/x-www-form-urlencoded";
  }
  const body = options.body ?? "";
  Object.assign(headers, options.headers);
  headers["content-length"] = String(Buffer.byteLength(body));
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: Number(url.port),
        method: options.method ?? "GET",
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

/**
 * Send a chunked POST and read the reply. With `terminate`, the chunked body is
 * completed after the oversized chunk; without it, the request stays unfinished,
 * so the 413 must not depend on the connection being dropped. The reply is read
 * until complete and the socket destroyed before the promise settles, so it
 * never keeps the test open.
 */
function chunkedOversized(origin: string, terminate = false): Promise<Reply> {
  const url = new URL(origin);
  return exchange({ host: url.hostname, port: Number(url.port), timeoutMs: 2000 }, (socket) => {
    socket.write(
      [
        "POST / HTTP/1.1",
        `Host: ${url.host}`,
        `Origin: ${origin}`,
        "Content-Type: application/x-www-form-urlencoded",
        "Transfer-Encoding: chunked",
        "",
        "",
      ].join("\r\n"),
    );
    // One chunk larger than the body limit; without `terminate`, no
    // terminator is sent, so the request stays unfinished.
    const payload = `name=${"a".repeat(DEFAULT_MAX_BODY_BYTES + 1)}`;
    socket.write(`${payload.length.toString(16)}\r\n${payload}\r\n`);
    if (terminate) socket.write("0\r\n\r\n");
  });
}

/**
 * Connect to a local address and complete an HTTP exchange. This goes to
 * `requestHost`, which need not be the server's canonical Host, so it shows
 * which local interfaces actually accept connections regardless of the server's
 * Host guard.
 *
 * The three outcomes are distinct: a refused or failed connection rejects (the
 * address is not served), a connection that completes a response resolves with
 * that response, and a connection that is accepted but whose response never
 * completes rejects with an incomplete-exchange error. That error is never
 * reported as a refusal, so the binding test can tell a wildcard listener
 * answering on another address from an address no listener accepts.
 */
function probe(requestHost: string, port: number): Promise<Reply> {
  return exchange({ host: requestHost, port, timeoutMs: 1500 }, (socket) => {
    socket.write(`GET / HTTP/1.1\r\nHost: ${requestHost}:${port}\r\nConnection: close\r\n\r\n`);
  }).then(
    (reply) => reply,
    (error: Error) => {
      // Only a refused connection means no listener; an accepted connection
      // whose exchange failed stays a failure.
      if (isConnectionRefused(error)) throw new ConnectionRefusedError(error.message);
      throw error;
    },
  );
}

/** A refusal to connect: the address has no listener. */
class ConnectionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionRefusedError";
  }
}

/** True for the error a refused TCP connection raises on every platform. */
function isConnectionRefused(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === "ECONNREFUSED";
}

function assertNoHandlerRan(calls: Calls): void {
  assert.equal(calls.get + calls.post, 0);
  assert.equal(calls.mutations, 0);
}

/**
 * A local TCP listener that answers each connection with fixed raw bytes and
 * then closes it. It stands in for a misbehaving peer, so the reply reader's
 * early-closure handling can be exercised without touching any server code.
 */
async function rawPeer(bytes: string): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.end(bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("raw peer did not report a TCP address");
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Destroy every peer connection first, or close waits for them.
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("reply reader and probe outcomes", () => {
  it("reads a complete reply from a peer that closes the connection", async () => {
    const peer = await rawPeer("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    try {
      const reply = await probe("127.0.0.1", peer.port);
      assert.equal(reply.status, 200);
      assert.equal(reply.body, "ok");
      assert.equal(reply.headers["content-length"], "2");
    } finally {
      await peer.close();
    }
  });

  it("rejects a reply cut short by the peer instead of waiting forever", async () => {
    // The peer declares a body but closes after the headers: the reader must
    // report a truncated response, not an incomplete one that never settles.
    const peer = await rawPeer("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort");
    try {
      await assert.rejects(probe("127.0.0.1", peer.port), /before the complete reply arrived/);
    } finally {
      await peer.close();
    }
  });

  it("reports a refusal only when the connection could not be made", async () => {
    // A closed listener's port is refused, while an accepted connection that
    // fails its exchange is a different outcome.
    const peer = await rawPeer("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort");
    const port = peer.port;
    await peer.close();
    await assert.rejects(probe("127.0.0.1", port), ConnectionRefusedError);
  });
});

describe("startServer binding", () => {
  it("binds loopback on an ephemeral port and derives the canonical origin", async () => {
    const fixture = await newFixture();
    try {
      assert.match(fixture.server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(new URL(fixture.server.origin).port, String(fixture.server.port));
      assert.ok(fixture.server.port > 0);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("listens on 127.0.0.1 only, not on another local interface", async () => {
    // The request Host here is the address actually connected to, so a wildcard
    // listener would accept a connection on every local address; a
    // loopback-only listener accepts only 127.0.0.1. No HTTP Host guard decides
    // this outcome: the probe writes the Host of the address it connected to.
    const fixture = await newFixture();
    try {
      const loopback = await probe("127.0.0.1", fixture.server.port);
      assert.ok(loopback !== null, "127.0.0.1 must accept connections");
      // The probe writes the Host of the address it connected to, which is the
      // canonical authority here, so a live listener answers the page.
      assert.equal(loopback.status, 200);
      // Another loopback address must not reach the listener at all: a
      // wildcard (0.0.0.0) listener would accept it and answer (here the Host
      // guard would refuse it), while a 127.0.0.1-only listener refuses the
      // connection outright, before any request or Host guard is involved. So
      // only a refused connection counts as "not served": an accepted
      // connection whose exchange failed is a defect and fails this test. A
      // host name such as "localhost" resolves to 127.0.0.1 on many systems, so
      // it is not used as the discriminator here.
      await assert.rejects(probe("127.0.0.2", fixture.server.port), ConnectionRefusedError);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("reports the actual bound address, which is IPv4 loopback", async () => {
    const fixture = await newFixture();
    try {
      // `origin` is derived from the real listening port, never from the options.
      assert.equal(new URL(fixture.server.origin).hostname, "127.0.0.1");
      assert.equal(new URL(fixture.server.origin).protocol, "http:");
    } finally {
      await closeFixture(fixture);
    }
  });

  it("closes idempotently and stops accepting requests", async () => {
    const fixture = await newFixture();
    await fixture.server.close();
    await fixture.server.close();
    await assert.rejects(send(fixture.server.origin, {}));
    await fixture.store.close();
  });
});

describe("canonical origin and Host checks", () => {
  it("derives origin and Host authority from the same canonical URL", async () => {
    const fixture = await newFixture();
    try {
      // The origin is already in canonical URL form, and the exact Host a
      // browser would serialize for it is accepted.
      const origin = fixture.server.origin;
      assert.equal(new URL(origin).origin, origin);
      const authority = new URL(origin).host;
      const explicit = await send(origin, { host: authority });
      assert.equal(explicit.status, 200);
      const withOrigin = await send(origin, { host: authority, origin });
      assert.equal(withOrigin.status, 200);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("normalizes the Host authority the way the URL does", async () => {
    // Both origin and authority come from one URL serialization, so the
    // accepted Host authority is exactly the origin's URL host, with no
    // separate port formatting. At a default port both forms drop `:80`, so
    // they agree at any port.
    const fixture = await newFixture();
    try {
      const origin = fixture.server.origin;
      const authority = new URL(origin).host;
      assert.equal(authority, origin.replace(/^http:\/\//, ""));
      const upper = await send(origin, { host: authority.toUpperCase() });
      assert.equal(upper.status, 200);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("derives the canonical origin and Host authority from one URL at ports 80 and 8080", () => {
    // The production derivation, exercised without a listener (no privileged
    // port is needed): origin and authority both come from one URL, so a
    // default port is dropped from each and a browser's serialized Origin and
    // Host match. This drives the exported function startServer uses, so a
    // reverted normalization would fail here.
    assert.deepEqual(canonicalOrigin(80), { origin: "http://127.0.0.1", authority: "127.0.0.1" });
    assert.deepEqual(canonicalOrigin(8080), {
      origin: "http://127.0.0.1:8080",
      authority: "127.0.0.1:8080",
    });
    for (const port of [80, 443, 8080, 65535]) {
      const { origin, authority } = canonicalOrigin(port);
      // One serialization: the origin is already canonical, and the authority
      // a browser sends as Host is exactly the origin's URL host.
      assert.equal(new URL(origin).origin, origin, `port ${port}`);
      assert.equal(authority, new URL(origin).host.toLowerCase(), `port ${port}`);
    }
  });

  it("accepts a canonical GET with or without the canonical Origin", async () => {
    const fixture = await newFixture();
    try {
      const withoutOrigin = await send(fixture.server.origin, { origin: null });
      assert.equal(withoutOrigin.status, 200);
      assert.equal(fixture.calls.get, 1);
      const withOrigin = await send(fixture.server.origin, { origin: fixture.server.origin });
      assert.equal(withOrigin.status, 200);
      assert.equal(fixture.calls.get, 2);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("serves the minimal home and health pages", async () => {
    const fixture = await newFixture();
    try {
      const home = await send(fixture.server.origin, {});
      assert.equal(home.status, 200);
      assert.match(String(home.headers["content-type"]), /^text\/html; charset=utf-8/);
      assert.equal(home.headers["cache-control"], "no-store");
      assert.match(home.body, /<!doctype html>/);
      // The home page is a read-only shell: no form, no inputs, no mutating link.
      assert.ok(!home.body.includes("<form"));
      assert.ok(!home.body.includes("<input"));
      assert.ok(!home.body.includes("<textarea"));
      const health = await send(fixture.server.origin, { path: "/health" });
      assert.equal(health.status, 200);
      assert.equal(health.headers["cache-control"], "no-store");
      // Health reflects the shared health() function.
      assert.match(health.body, new RegExp(escapeHtml(healthOf().status)));
      // Both pages were served by their GET routes, and nothing was mutated.
      assert.equal(fixture.calls.get, 2);
      assert.equal(fixture.calls.mutations, 0);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("offers no POST route for the home or health pages", async () => {
    const fixture = await newFixture();
    try {
      for (const path of ["/", "/health"]) {
        const reply = await send(fixture.server.origin, {
          method: "POST",
          path,
          origin: fixture.server.origin,
          body: "name=Ada",
        });
        assert.equal(reply.status, 405, path);
        assert.match(String(reply.headers.allow), /GET, POST/);
      }
      assert.equal(fixture.calls.post, 0);
      assert.equal(fixture.calls.mutations, 0);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("rejects a foreign or missing Host before any handler runs", async () => {
    const fixture = await newFixture();
    try {
      // No Host header at all: Node's client would add one, so write it raw.
      const absent = await rawGetWithoutHost(fixture.server.origin);
      assert.equal(absent.status, 403);
      assertNoHandlerRan(fixture.calls);
      for (const host of ["example.com", `evil.example:${fixture.server.port}`, `localhost:${fixture.server.port}`, "127.0.0.1"]) {
        const reply = await send(fixture.server.origin, { host });
        assert.equal(reply.status, 403, `host ${host}`);
        assertNoHandlerRan(fixture.calls);
      }
      // An explicitly empty Host is also not the canonical authority.
      const empty = await raw(fixture.server.origin, ["GET / HTTP/1.1", "Host: ", "Connection: close"]);
      assert.equal(empty.status, 403);
      assertNoHandlerRan(fixture.calls);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("ignores forwarded host and protocol headers", async () => {
    const fixture = await newFixture();
    try {
      const reply = await send(fixture.server.origin, {
        headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
      });
      assert.equal(reply.status, 200);
      const rejected = await send(fixture.server.origin, {
        host: "evil.example",
        headers: { "x-forwarded-host": new URL(fixture.server.origin).host },
      });
      assert.equal(rejected.status, 403);
      assert.equal(fixture.calls.get, 1);
      assert.equal(fixture.calls.mutations, 0);
    } finally {
      await closeFixture(fixture);
    }
  });
});

describe("Origin checks before routes", () => {
  it("rejects every supplied foreign or null Origin", async () => {
    const fixture = await newFixture();
    try {
      for (const origin of ["http://evil.example", "null", "https://127.0.0.1:1"]) {
        const reply = await send(fixture.server.origin, { origin });
        assert.equal(reply.status, 403, `origin ${origin}`);
        assertNoHandlerRan(fixture.calls);
      }
    } finally {
      await closeFixture(fixture);
    }
  });

  it("rejects a POST with a foreign, null or missing Origin", async () => {
    const fixture = await newFixture(true);
    try {
      for (const origin of [null, "http://evil.example", "null", "https://127.0.0.1"]) {
        const reply = await send(fixture.server.origin, {
          method: "POST",
          origin,
          body: "name=Ada",
        });
        assert.equal(reply.status, 403, `origin ${String(origin)}`);
        assertNoHandlerRan(fixture.calls);
      }
    } finally {
      await closeFixture(fixture);
    }
  });
});

describe("method, path and content-type checks", () => {
  it("rejects unsupported methods explicitly", async () => {
    const fixture = await newFixture();
    try {
      for (const method of ["PUT", "DELETE", "PATCH", "HEAD"]) {
        const reply = await send(fixture.server.origin, { method, origin: fixture.server.origin });
        assert.equal(reply.status, 405, method);
        assert.match(String(reply.headers.allow), /GET, POST/);
        assertNoHandlerRan(fixture.calls);
      }
    } finally {
      await closeFixture(fixture);
    }
  });

  it("rejects unknown GET and POST paths without invoking a handler", async () => {
    const fixture = await newFixture(true);
    try {
      for (const path of ["/unknown", "/api", "/workspace/new", "/health/", "//", "/home", "/Health", "/index.html", "/nowhere/"]) {
        for (const method of ["GET", "POST"]) {
          const reply = await send(fixture.server.origin, {
            method,
            path,
            origin: fixture.server.origin,
            body: method === "POST" ? "a=1" : "",
          });
          assert.equal(reply.status, 404, `${method} ${path}`);
          assertNoHandlerRan(fixture.calls);
        }
      }
    } finally {
      await closeFixture(fixture);
    }
  });

  it("rejects unsupported content types with 415", async () => {
    const fixture = await newFixture();
    try {
      for (const contentType of ["application/json", "text/plain", null, "multipart/form-data; boundary=x"]) {
        const reply = await send(fixture.server.origin, {
          method: "POST",
          origin: fixture.server.origin,
          contentType,
          body: "name=Ada",
        });
        assert.equal(reply.status, 415, String(contentType));
        assertNoHandlerRan(fixture.calls);
      }
    } finally {
      await closeFixture(fixture);
    }
  });

  it("accepts a form content type with or without a utf-8 charset", async () => {
    const seen: Record<string, string>[] = [];
    const fixture = await newFixture();
    const app = appRoutes(fixture.store);
    const routes: Routes = {
      home: {
        get: app.home.get,
        post: {
          method: "POST",
          render(req) {
            seen.push({ ...req.form });
            return { status: 200, body: "accepted" };
          },
        },
      },
      health: app.health,
    };
    const server = await startServer({ store: fixture.store, port: 0, routes: instrumented(routes, fixture.calls) });
    try {
      for (const contentType of [
        "application/x-www-form-urlencoded",
        "Application/X-WWW-Form-Urlencoded; Charset=UTF-8",
        'application/x-www-form-urlencoded; charset="utf-8"',
        "application/x-www-form-urlencoded;charset=utf-8",
        "application/x-www-form-urlencoded ; charset = utf-8",
      ]) {
        const reply = await send(server.origin, {
          method: "POST",
          origin: server.origin,
          contentType,
          body: "name=Ada+Lovelace&note=a%3Db",
        });
        assert.equal(reply.status, 200, contentType);
      }
      assert.deepEqual(
        seen,
        Array.from({ length: 5 }, () => ({ name: "Ada Lovelace", note: "a=b" })),
      );
      assert.equal(fixture.calls.mutations, 0);
    } finally {
      await server.close();
      await closeFixture(fixture);
    }
  });

  it("rejects a form content type with an unsupported charset or parameter", async () => {
    const fixture = await newFixture();
    try {
      for (const contentType of [
        "application/x-www-form-urlencoded; charset=iso-8859-1",
        "application/x-www-form-urlencoded; boundary=x",
      ]) {
        const reply = await send(fixture.server.origin, {
          method: "POST",
          origin: fixture.server.origin,
          contentType,
          body: "a=1",
        });
        assert.equal(reply.status, 415, contentType);
        assertNoHandlerRan(fixture.calls);
      }
    } finally {
      await closeFixture(fixture);
    }
  });

  it("returns a 405 for a POST to a route that only has GET", async () => {
    const fixture = await newFixture();
    try {
      const reply = await send(fixture.server.origin, {
        method: "POST",
        origin: fixture.server.origin,
        path: "/health",
        body: "a=1",
      });
      assert.equal(reply.status, 405);
      assert.equal(fixture.calls.post, 0);
    } finally {
      await closeFixture(fixture);
    }
  });
});

describe("body size", () => {
  it("rejects a declared oversized body with 413 before the route runs", async () => {
    const fixture = await newFixture(true);
    try {
      const reply = await send(fixture.server.origin, {
        method: "POST",
        origin: fixture.server.origin,
        body: `name=${"a".repeat(DEFAULT_MAX_BODY_BYTES + 1)}`,
      });
      assert.equal(reply.status, 413);
      assert.match(reply.body, /too large/);
      assert.equal(reply.headers["cache-control"], "no-store");
      assertNoHandlerRan(fixture.calls);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("answers 413 for a chunked oversized body while the request is unfinished", async () => {
    const fixture = await newFixture(true);
    try {
      const reply = await chunkedOversized(fixture.server.origin);
      assert.equal(reply.status, 413);
      assert.match(reply.body, /too large/);
      assert.equal(reply.headers["cache-control"], "no-store");
      assertNoHandlerRan(fixture.calls);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("rejects a completed chunked oversized body before the route runs", async () => {
    const fixture = await newFixture(true);
    try {
      const reply = await chunkedOversized(fixture.server.origin, true);
      assert.equal(reply.status, 413);
      assert.match(reply.body, /too large/);
      assertNoHandlerRan(fixture.calls);
    } finally {
      await closeFixture(fixture);
    }
  });
});

describe("route results and errors", () => {
  it("keeps no-store on every route-result variant, even with supplied headers", async () => {
    const variants: Record<string, RouteResult> = {
      bare: { html: "<p>page</p>", headers: {} },
      page: { html: "<p>page</p>", headers: { "X-Extra": "yes" } },
      override: { status: 200, body: "text", headers: { "Cache-Control": "public, max-age=60" } },
      lowercase: { status: 200, body: "text", headers: { "cache-control": "public, max-age=60" } },
      contentType: { status: 200, body: "text", headers: { "Content-Type": "text/html" } },
      redirect: redirect("/health"),
      redirectWithHeaders: { ...redirect("/"), headers: { "Cache-Control": "public" } },
    };
    let current: keyof typeof variants = "bare";
    const routes: Routes = {
      home: { get: { method: "GET", render: () => variants[current] } },
      health: { get: { method: "GET", render: () => ({ html: "<p>ok</p>", headers: {} }) } },
    };
    await withServer(routes, async (server) => {
      for (const variant of Object.keys(variants) as (keyof typeof variants)[]) {
        current = variant;
        const reply = await send(server.origin, {});
        assert.equal(reply.headers["cache-control"], "no-store", variant);
      }
      current = "page";
      const page = await send(server.origin, {});
      assert.equal(page.headers["x-extra"], "yes");
      assert.match(String(page.headers["content-type"]), /^text\/html; charset=utf-8/);
      current = "contentType";
      const contentType = await send(server.origin, {});
      assert.match(String(contentType.headers["content-type"]), /^text\/plain; charset=utf-8/);
    });
  });

  it("keeps no-store on every shell-generated rejection and error", async () => {
    const fixture = await newFixture(true);
    try {
      const replies = [
        await rawGetWithoutHost(fixture.server.origin),
        await send(fixture.server.origin, { host: "evil.example" }),
        await send(fixture.server.origin, { origin: "http://evil.example" }),
        await send(fixture.server.origin, { method: "PUT" }),
        await send(fixture.server.origin, { path: "/nowhere" }),
        await send(fixture.server.origin, { method: "POST", origin: fixture.server.origin, contentType: "application/json" }),
        await send(fixture.server.origin, { method: "POST", origin: fixture.server.origin, body: `a=${"b".repeat(DEFAULT_MAX_BODY_BYTES + 1)}` }),
      ];
      for (const reply of replies) {
        assert.equal(reply.headers["cache-control"], "no-store");
      }
      assertNoHandlerRan(fixture.calls);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("maps missing records to 404 and invalid input to 400 from a route", async () => {
    let fault: "missing" | "invalid" = "missing";
    const routes: Routes = {
      home: {
        get: {
          method: "GET",
          render() {
            if (fault === "missing") throw new MissingRecordError("No client with that id");
            throw new ValidationError("client.name must be nonblank");
          },
        },
      },
      health: { get: { method: "GET", render: () => ({ html: "", headers: {} }) } },
    };
    await withServer(routes, async (server) => {
      const missing = await send(server.origin, {});
      assert.equal(missing.status, 404);
      fault = "invalid";
      const invalid = await send(server.origin, {});
      assert.equal(invalid.status, 400);
      assert.match(invalid.body, /nonblank/);
      assert.equal(invalid.headers["cache-control"], "no-store");
    });
  });

  it("returns a generic 500 without paths or stacks for an unexpected failure", async () => {
    const secret = join(tempDir(), "secret-workspace.json");
    const routes: Routes = {
      home: {
        get: {
          method: "GET",
          render() {
            throw new Error(`Failed to read ${secret}\n    at StoreImpl.snapshot (/src/store.ts:1:1)`);
          },
        },
      },
      health: { get: { method: "GET", render: () => ({ html: "", headers: {} }) } },
    };
    await withServer(routes, async (server) => {
      const reply = await send(server.origin, {});
      assert.equal(reply.status, 500);
      assert.match(reply.body, /An unexpected error occurred\./);
      assert.ok(!reply.body.includes(secret));
      assert.ok(!reply.body.includes("store.ts"));
      assert.ok(!reply.body.includes("StoreImpl"));
      assert.equal(reply.headers["cache-control"], "no-store");
    });
  });

  it("returns a generic 500 when a store read fails unexpectedly", async () => {
    const calls = newCalls();
    const store = instrumentedStore(await openStore(tempDir()), calls);
    const failingStore: Store = {
      ...store,
      snapshot: () => {
        throw new Error("Failed to read workspace.json");
      },
    };
    const routes: Routes = {
      home: {
        get: {
          method: "GET",
          render() {
            const snapshot = failingStore.snapshot();
            return renderPage("Counts", `<p>${escapeHtml(String(snapshot.clients.length))}</p>`);
          },
        },
      },
      health: { get: { method: "GET", render: () => ({ html: "", headers: {} }) } },
    };
    const server = await startServer({ store, port: 0, routes: instrumented(routes, calls) });
    try {
      const reply = await send(server.origin, {});
      assert.equal(reply.status, 500);
      assert.match(reply.body, /An unexpected error occurred\./);
      assert.ok(!reply.body.includes("workspace.json"));
    } finally {
      await server.close();
      await store.close();
    }
  });

  it("renders a correctable 400 form error with submitted values for a POST", async () => {
    const fields: readonly FieldSpec[] = [{ name: "name", label: "Name", required: true }];
    const routes: Routes = {
      home: {
        get: { method: "GET", render: () => renderPage("Home", renderForm({ action: "/", fields })) },
        post: {
          method: "POST",
          render(req) {
            const value = req.form.name ?? "";
            if (value.trim() === "") {
              throw new FormError("Check the form.", req.form, [{ field: "name", message: "Enter your name.", value }], fields, "/");
            }
            return redirect("/");
          },
        },
      },
      health: { get: { method: "GET", render: () => ({ html: "<p>ok</p>", headers: {} }) } },
    };
    await withServer(routes, async (server, fixture) => {
      const invalid = await send(server.origin, {
        method: "POST",
        origin: server.origin,
        body: "name=&kept=submitted",
      });
      assert.equal(invalid.status, 400);
      assert.match(String(invalid.headers["content-type"]), /^text\/html; charset=utf-8/);
      assert.match(invalid.body, /Enter your name\./);
      assert.match(invalid.body, /aria-invalid="true"/);
      assert.equal(invalid.headers["cache-control"], "no-store");

      const accepted = await send(server.origin, {
        method: "POST",
        origin: server.origin,
        body: "name=Ada+%3Cscript%3E",
      });
      assert.equal(accepted.status, 303);
      assert.equal(accepted.headers.location, "/");
      assert.equal(accepted.headers["cache-control"], "no-store");
      assert.equal(fixture.store.snapshot().clients.length, 0);
      assert.equal(fixture.calls.mutations, 0);
    });
  });

  it("does not mutate the store on any accepted GET request", async () => {
    // The fixture's store is the same instrumented store its routes use, so a
    // mutation from any handler would change the workspace and be counted.
    const fixture = await newFixture(true);
    try {
      const before = JSON.stringify(fixture.store.snapshot());
      for (const options of [
        {},
        { path: "/health" },
        { origin: fixture.server.origin },
        { headers: { "x-forwarded-proto": "https" } },
      ]) {
        const reply = await send(fixture.server.origin, options);
        assert.equal(reply.status, 200);
      }
      // The accepted GETs reached the handlers (so the check is live), while
      // no GET invoked the POST handler or any store mutation.
      assert.equal(fixture.calls.get, 4);
      assert.equal(fixture.calls.post, 0);
      assert.equal(fixture.calls.mutations, 0);
      assert.equal(JSON.stringify(fixture.store.snapshot()), before);
      // The POST route on the same table does go through the store, so the
      // counters above are not vacuous.
      const accepted = await send(fixture.server.origin, {
        method: "POST",
        origin: fixture.server.origin,
        body: "name=Ada",
      });
      assert.equal(accepted.status, 303);
      assert.equal(fixture.calls.post, 1);
      assert.equal(fixture.calls.mutations, 1);
      assert.equal(fixture.store.snapshot().clients.length, 1);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("never calls a store mutation from a GET route, even one that writes", async () => {
    const calls = newCalls();
    const store = instrumentedStore(await openStore(tempDir()), calls);
    let getHandled = 0;
    let postHandled = 0;
    const routes: Routes = {
      home: {
        get: {
          method: "GET",
          render() {
            getHandled += 1;
            return { html: "<p>read only</p>", headers: {} };
          },
        },
        post: {
          method: "POST",
          render() {
            postHandled += 1;
            return redirect("/");
          },
        },
      },
      health: { get: { method: "GET", render: () => ({ html: "", headers: {} }) } },
    };
    const server = await startServer({ store, port: 0, routes: instrumented(routes, calls) });
    try {
      const get = await send(server.origin, {});
      assert.equal(get.status, 200);
      assert.equal(getHandled, 1);
      assert.equal(postHandled, 0);
      assert.equal(calls.mutations, 0);
      assert.equal(store.snapshot().clients.length, 0);
    } finally {
      await server.close();
      await store.close();
    }
  });

  it("returns a redirect result with a fixed internal destination", async () => {
    const routes: Routes = {
      home: { get: { method: "GET", render: () => redirect("/health") } },
      health: { get: { method: "GET", render: () => ({ html: "", headers: {} }) } },
    };
    await withServer(routes, async (server) => {
      const reply = await send(server.origin, {});
      assert.equal(reply.status, 303);
      assert.equal(reply.headers.location, "/health");
      assert.equal(reply.headers["cache-control"], "no-store");
    });
  });
});

describe("html helpers", () => {
  it("escapes text and attribute values", () => {
    const raw = `<script>alert("x")</script> & 'quoted'`;
    const escaped = escapeHtml(raw);
    assert.equal(escaped, "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;");
    assert.ok(!escaped.includes("<"));
  });

  it("escapes user-derived values in a page body and attribute", async () => {
    const evil = '<img src=x onerror="alert(1)"> & "name"';
    const routes: Routes = {
      home: {
        get: {
          method: "GET",
          render() {
            return renderPage(`Title ${evil}`, `<p title="${escapeHtml(evil)}">${escapeHtml(evil)}</p>`);
          },
        },
      },
      health: { get: { method: "GET", render: () => ({ html: "", headers: {} }) } },
    };
    await withServer(routes, async (server) => {
      const reply = await send(server.origin, {});
      assert.equal(reply.status, 200);
      const escaped = "&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;name&quot;";
      assert.ok(!reply.body.includes("<img"));
      assert.ok(reply.body.includes(escaped));
      assert.ok(reply.body.includes(`title="${escaped}"`));
      assert.ok(reply.body.includes(`<title>Title ${escaped}</title>`));
    });
  });

  it("escapes submitted values in rendered form attributes", () => {
    const html = renderForm({
      action: '/?a="b"',
      fields: [{ name: "name", label: "Name" }],
      values: { name: '"><script>alert(1)</script>' },
      errors: [{ field: "name", message: "Bad <value>", value: "" }],
    });
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&quot;&gt;&lt;script&gt;"));
    assert.ok(html.includes("Bad &lt;value&gt;"));
    assert.ok(html.includes('action="/?a=&quot;b&quot;"'));
  });

  it("refuses redirect destinations that browsers resolve off-origin", () => {
    const foreign = [
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example/",
      "/\\\\evil.example/",
      "\\\\evil.example/",
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r\n/evil.example",
      "/\u0000/evil.example",
      "/ /evil.example",
      " //evil.example",
      "/%2f%2fevil.example",
      "javascript:alert(1)",
      "evil.example",
      "/../evil.example",
      "/.//evil.example",
      "/health/%5c/evil.example",
      "/%09/evil.example",
      "/%0d/evil.example",
    ];
    for (const location of foreign) {
      assert.throws(() => redirect(location), /internal routes/, JSON.stringify(location));
    }
  });

  it("refuses destinations that are not among the server's fixed routes", () => {
    for (const location of ["/evil", "/health/", "/index.html", "/admin", "/nowhere"]) {
      assert.throws(() => redirect(location), /internal routes/, JSON.stringify(location));
    }
  });

  it("keeps internal redirect destinations fixed and cacheless", () => {
    for (const location of ["/", "/health", "/health?tab=1"]) {
      assert.equal(redirect(location).location, location);
      assert.equal(redirect(location).headers["Cache-Control"], "no-store");
    }
  });

  it("keeps the submitted values and renders a correctable form error", () => {
    const fields: readonly FieldSpec[] = [{ name: "name", label: "Name" }];
    const error = new FormError("Check", { name: "<Ada>" }, [{ field: "name", message: "Bad <name>" }], fields, "/health");
    assert.deepEqual(error.values, { name: "<Ada>" });
    assert.equal(error.fieldErrors[0].field, "name");
    const page = renderFormError(error);
    assert.match(page.html, /Check/);
    assert.match(page.html, /value="&lt;Ada&gt;"/);
    assert.match(page.html, /Bad &lt;name&gt;/);
    assert.match(page.html, /action="\/health"/);
    assert.equal(page.headers["Cache-Control"], "no-store");
  });
});
