/**
 * Loopback HTTP helpers for the transcript library integration test: reading
 * rendered pages, following a rendered multipart form the way a browser does,
 * and reading a source's three views over the network.
 *
 * These helpers use only Node's built-in `http` module. They never build a URL
 * the application did not render: form actions and links are read from the
 * page markup and sent back unchanged, so a misdirected or mislabelled link
 * fails the test instead of being papered over by a hand-built path.
 */

import assert from "node:assert/strict";
import {
  Agent,
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import { createConnection } from "node:net";

/** The boundary the helper uses for every submitted multipart body. */
export const BOUNDARY = "transcript-library-boundary";

/** The `Content-Type` of a submitted multipart body with that boundary. */
export const MULTIPART_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;

/** One HTTP reply: its status, headers and raw body bytes. */
export interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly bytes: Buffer;
  /** The body decoded as UTF-8, for HTML and text replies. */
  readonly body: string;
}

/**
 * A reply read by the bounded helper: the legacy reply fields plus the client
 * socket's local port, captured while that socket was attached to the reply.
 * Two sequential requests served by one kept-alive socket report the same port,
 * so a reconnect would show up as a different one. Only the bounded helper
 * observes the port; the legacy helpers keep their four-field `Reply`.
 */
interface TransportReply extends Reply {
  readonly localPort: number;
}

/** The application base URL's origin, for the origin checks. */
function originOf(base: string): URL {
  return new URL(base);
}

/**
 * The local port of a reply's socket, which the socket exposes while attached.
 * Returns null when the socket or its port is unavailable.
 */
function localPortOf(res: IncomingMessage): number | null {
  const port = res.socket?.localPort;
  return typeof port === "number" && Number.isInteger(port) && port > 0 ? port : null;
}

/** A legacy reply: its status, headers and raw body bytes, with no port. */
function replyFrom(
  status: number,
  headers: Record<string, string | string[] | undefined>,
  bytes: Buffer,
): Reply {
  return { status, headers, bytes, body: bytes.toString("utf8") };
}

/** A bounded reply: the legacy fields plus the captured local port. */
function transportReplyFrom(
  status: number,
  headers: Record<string, string | string[] | undefined>,
  bytes: Buffer,
  localPort: number,
): TransportReply {
  return { ...replyFrom(status, headers, bytes), localPort };
}

/**
 * A resolved link: the absolute href a browser follows (origin, path and query)
 * and the fragment it resolves locally. The fragment is returned raw, exactly
 * as it appears in the href, and the href keeps its origin, so a link pointing
 * at another origin is visible instead of being reduced to the local path.
 */
interface SplitLink {
  readonly href: string;
  readonly path: string;
  readonly fragment: string;
}

/**
 * Resolve one rendered href against the page that rendered it on the running
 * application: a root-relative href, a same-page `#fragment` href, a relative
 * or an absolute href becomes the absolute URL a browser would follow, and the
 * fragment is kept raw. The page is resolved against the application's own
 * origin and a link naming another origin is refused, so a link that leaves the
 * application is never requested from the local pages instead.
 */
export function splitLink(base: string, fromPath: string, href: string): SplitLink {
  assert.ok(href !== "", `the link ${href || "(empty)"} is not empty`);
  const origin = new URL(base).origin;
  const resolved = new URL(href, new URL(fromPath, origin));
  assert.equal(resolved.origin, origin, `the link ${href} on ${fromPath} names the application's own origin`);
  return {
    href: resolved.href,
    path: `${resolved.pathname}${resolved.search}`,
    fragment: resolved.hash === "" ? "" : resolved.hash.slice(1),
  };
}

/**
 * Send one GET over loopback HTTP. `path` is a root-relative request target
 * (its query included) or an absolute URL naming the application's own origin;
 * a target naming another origin, or a relative one resolved against `/`, is
 * refused, so a misdirected link fails instead of being fetched locally. A
 * fragment is resolved by the browser and never sent: the request target is
 * the path and query. The Host header is the origin's own authority; a plain
 * GET carries no Origin and is accepted by the shell.
 */
export function get(base: string, path: string): Promise<Reply> {
  const url = originOf(base);
  assert.ok(path.startsWith("/") || path.startsWith(`${url.origin}/`), `the request target ${path} is root-relative`);
  const resolved = new URL(path, url.origin);
  assert.equal(resolved.origin, url.origin, `the request target ${path} names the application's own origin`);
  const target = `${resolved.pathname}${resolved.search}`;
  const headers: Record<string, string | number> = {
    host: url.host,
    "content-length": 0,
  };
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: Number(url.port), method: "GET", path: target, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve(replyFrom(res.statusCode ?? 0, res.headers, Buffer.concat(chunks)));
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Send one POST over loopback HTTP with an exact byte body. The Origin header
 * is the request's own origin, as a browser would send it for a same-origin
 * form submission.
 */
function postBytes(
  base: string,
  path: string,
  contentType: string,
  body: Uint8Array,
): Promise<Reply> {
  const url = originOf(base);
  const headers: Record<string, string> = {
    host: url.host,
    origin: url.origin,
    "content-length": String(body.byteLength),
    "content-type": contentType,
  };
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: Number(url.port), method: "POST", path, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve(replyFrom(res.statusCode ?? 0, res.headers, Buffer.concat(chunks)));
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// Bounded kept-alive requests
// ---------------------------------------------------------------------------

/** Node's largest supported timer delay, in milliseconds. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** The default inclusive cap, in bytes, for a bounded reply body. */
export const DEFAULT_RESPONSE_CAP = 8 * 1024 * 1024;

/** The default deadline, in milliseconds, for a bounded request's whole life. */
export const DEFAULT_DEADLINE_MS = 5000;

/** One request the bounded helper sends; `body` makes it a POST. */
export interface SendOptions {
  /** `GET` (the default) or `POST`. */
  readonly method?: "GET" | "POST";
  /** A root-relative request target (its query included). */
  readonly path: string;
  /** The POST body's `Content-Type`; ignored for a bodyless GET. */
  readonly contentType?: string;
  /** The POST body; its exact bytes are sent. */
  readonly body?: Uint8Array;
  /**
   * Send a POST body chunked, letting Node frame it, instead of declaring its
   * exact `Content-Length`.
   */
  readonly chunked?: boolean;
  /** The inclusive reply body cap; a larger reply fails the request. */
  readonly responseCap?: number;
  /** The deadline, from request creation through response end. */
  readonly deadlineMs?: number;
}

/**
 * A transport owning one `Agent` shared across sequential requests. The agent
 * keeps sockets alive and pools at most one, so two sequential requests reuse
 * the same connection instead of opening a second one.
 */
export interface Transport {
  readonly agent: Agent;
  /** Destroy the agent, releasing its kept-alive sockets. */
  close(): void;
}

/** Create the shared keep-alive transport with at most one pooled socket. */
export function keepAliveTransport(): Transport {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  return {
    agent,
    close() {
      agent.destroy();
    },
  };
}

/** The declared reply length, which must be one finite decimal count. */
function declaredLength(headers: Record<string, string | string[] | undefined>): number {
  const value = headers["content-length"];
  assert.equal(typeof value, "string", "the reply declares a single Content-Length header");
  assert.match(value as string, /^\d+$/, "the reply's Content-Length is a decimal byte count");
  const length = Number(value);
  assert.ok(Number.isSafeInteger(length) && length >= 0, "the reply's Content-Length is a finite byte count");
  return length;
}

/**
 * Send one bounded request over a shared keep-alive transport.
 *
 * The reply is consumed to its end and read only through Node's HTTP parser: a
 * reply body larger than the finite `responseCap` fails the request as it
 * arrives, the response must be complete (`IncomingMessage.complete`) and the
 * received byte count must equal the parsed `Content-Length` header. A missing
 * reply, a premature close, a deadline expiry, a request or response error, an
 * invalid length or a cap overflow rejects, and every exit clears the deadline
 * and aborts outstanding I/O by destroying the request.
 *
 * The `Host` (and, for a POST, the `Origin`) is the listener's own authority,
 * so the same-origin checks accept the request.
 */
export function send(transport: Transport, base: string, options: SendOptions): Promise<TransportReply> {
  const url = originOf(base);
  assert.ok(options.path.startsWith("/"), `the request target ${options.path} is root-relative`);
  const method = options.method ?? "GET";
  const chunked = options.chunked === true;
  if (options.body !== undefined) assert.equal(method, "POST", "a request body is sent with POST");
  if (chunked) assert.ok(options.body !== undefined, "a chunked request carries a body");
  const cap = options.responseCap ?? DEFAULT_RESPONSE_CAP;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  // A monotonic expiry keeps the budget independent of wall-clock
  // adjustments: the clock never steps, so a backward adjustment cannot
  // extend the deadline and a forward one cannot exhaust it early.
  const expiresAt = performance.now() + deadlineMs;
  const timedOut = (): boolean => performance.now() >= expiresAt;
  const timeoutError = (): Error => new Error(`no reply within ${deadlineMs} ms`);
  assert.ok(Number.isSafeInteger(cap) && cap >= 0, "the response cap is a finite byte count");
  // Node's timer stores its delay as a signed 32-bit integer and clamps a
  // longer one to 1 ms, so a deadline above that range would fire at once
  // instead of when asked. Refuse it rather than silently mis-time the run.
  assert.ok(
    Number.isSafeInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= MAX_TIMEOUT_MS,
    `the deadline is a finite positive duration of at most ${MAX_TIMEOUT_MS} ms`,
  );

  const headers: Record<string, string> = { host: url.host };
  if (method === "POST") headers.origin = url.origin;
  if (options.contentType !== undefined) headers["content-type"] = options.contentType;
  if (options.body !== undefined && !chunked) headers["content-length"] = String(options.body.byteLength);
  if (options.body === undefined) headers["content-length"] = "0";

  return new Promise<TransportReply>((resolve, reject) => {
    let settled = false;
    let seenResponse = false;
    let response: IncomingMessage | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearDeadline = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const abort = (): void => {
      response?.destroy();
      request?.destroy();
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearDeadline();
      abort();
      reject(error);
    };
    const finish = (reply: TransportReply): void => {
      if (settled) return;
      settled = true;
      clearDeadline();
      resolve(reply);
    };

    // The monotonic deadline's expiry was fixed above, before construction, so
    // synchronous construction time counts against the caller's whole-request
    // budget. A construction error then rejects through `fail`, which tolerates
    // a request that was never created and leaves no timer behind.
    let request: ClientRequest;
    try {
      request = httpRequest(
        {
          host: url.hostname,
          port: Number(url.port),
          method,
          path: options.path,
          headers,
          agent: transport.agent,
        },
        (res) => {
          seenResponse = true;
          response = res;
          try {
            // The port is read once, while the response's socket is attached. A
            // socket without a usable port rejects through `fail`, so a reply is
            // never resolved with a stale or invented port.
            const localPort = localPortOf(res);
            if (localPort === null) {
              fail(new Error("the reply socket carries no positive local port"));
              return;
            }
            const chunks: Buffer[] = [];
            let received = 0;
            let ended = false;
            res.on("data", (chunk: Buffer) => {
              if (settled) return;
              received += chunk.byteLength;
              if (received > cap) {
                fail(new Error(`the reply body exceeded the ${cap}-byte cap`));
                return;
              }
              chunks.push(chunk);
            });
            res.on("end", () => {
              if (settled) return;
              ended = true;
              if (!res.complete) {
                fail(new Error("the reply ended before its message was complete"));
                return;
              }
              // An end dispatched after the deadline but before its timer
              // callback still fails: the expiry is checked here as well, with
              // its own message so a late end is distinguishable from a reply
              // that never ended at all.
              if (timedOut()) {
                fail(new Error(`the reply ended after the ${deadlineMs} ms deadline`));
                return;
              }
              try {
                const declared = declaredLength(res.headers);
                if (declared !== received) {
                  fail(new Error(`the reply carried ${received} bytes but declared ${declared}`));
                  return;
                }
                // Building the reply (including decoding the body as a string)
                // is inside this try, so a throw here reaches `fail` and clears
                // the deadline instead of escaping the event callback.
                finish(transportReplyFrom(res.statusCode ?? 0, res.headers, Buffer.concat(chunks), localPort));
              } catch (error) {
                fail(error as Error);
                return;
              }
            });
            res.on("aborted", () => fail(new Error("the connection closed before the reply completed")));
            res.on("error", (error: Error) => fail(error));
            // A close before the reply's own end is a premature close.
            res.on("close", () => {
              if (!ended) fail(new Error("the connection closed before the reply completed"));
            });
          } catch (error) {
            // A synchronous throw while attaching handlers still rejects through
            // `fail`, which clears the deadline and aborts the request.
            fail(error as Error);
          }
        },
      );
    } catch (error) {
      // The request was never created: fail with no request to destroy, but the
      // cleanup still tolerates it and no deadline was armed.
      fail(error as Error);
      return;
    }
    try {
      request.on("error", (error: Error) => fail(error));
      // A close without any response at all is a missing reply.
      request.on("close", () => {
        if (!seenResponse && !settled) fail(new Error("the connection closed with no reply"));
      });

      // The deadline spans the whole request: creation, the reply and its end.
      // Construction already spent part of it, so only the remaining time is
      // armed. A fractional remainder may schedule a timer that fires before
      // the monotonic expiry, and a timer may be dispatched late; either way
      // the callback re-checks the clock, so it only rejects when the expiry
      // has truly passed and otherwise rearms for the time still left, directly
      // from the callback before it returns. An end dispatched after the expiry
      // is failed by the end handler above, with its own message, whether or
      // not the timer has run yet.
      const armDeadline = (): boolean => {
        const remaining = expiresAt - performance.now();
        if (remaining <= 0) {
          fail(timeoutError());
          return false;
        }
        timer = setTimeout(() => {
          // The callback fires with `timer` still set, so a settlement that
          // happens inside it still clears the timer the scheduler just ran.
          if (!settled && !timedOut()) {
            armDeadline();
            return;
          }
          fail(timeoutError());
        }, remaining);
        return true;
      };
      // A budget exhausted during construction fails before any body is copied
      // or written to the destroyed request.
      if (!armDeadline()) return;

      // A chunked body is written and then ended, so Node frames the body
      // itself; any other body is sent with the declared length in `end()`.
      // Re-check the deadline first: a long synchronous copy may have used the
      // rest of the budget, and nothing more is written to the request then.
      if (timedOut()) {
        fail(timeoutError());
        return;
      }
      if (options.body === undefined) {
        request.end();
      } else if (chunked) {
        request.write(Buffer.from(options.body));
        request.end();
      } else {
        request.end(Buffer.from(options.body));
      }
    } catch (error) {
      fail(error as Error);
    }
  });
}

// ---------------------------------------------------------------------------
// Staged raw exchanges read through peer closure
// ---------------------------------------------------------------------------

/** One raw exchange: every byte read before the peer closed, and its replies. */
export interface ClosedExchange {
  readonly bytes: Buffer;
  /** Every complete reply parsed from the bytes read through peer closure. */
  readonly replies: readonly Reply[];
  /** The client socket's local port, captured while it was connected. */
  readonly localPort: number;
  /**
   * True when the optional post-reply reuse bytes were submitted after the
   * first complete reply. The socket may already have been retired by then, so
   * the attempt itself is the observation; no reply is expected from it.
   */
  readonly reuseAttempted: boolean;
}

/** A staged POST whose body and follow-up bytes are written before the reply. */
export interface StagedSendOptions {
  /** A root-relative request target (its query included). */
  readonly path: string;
  readonly contentType: string;
  /** The declared POST body length; no body is required for the server's reply. */
  readonly declaredLength: number;
  /** Bytes of the declared body written after the headers, before the reply. */
  readonly bodyPrefix?: Uint8Array;
  /**
   * Send the body prefix as HTTP chunks, letting Node frame the transfer,
   * instead of declaring its exact length. The request then declares no
   * Content-Length.
   */
  readonly chunked?: boolean;
  /**
   * The maximum body bytes in each HTTP chunk. The prefix is split into chunks
   * of this size, with a shorter final chunk; without it the whole prefix is
   * one chunk.
   */
  readonly chunkSize?: number;
  /**
   * Leave the final zero-length chunk unwritten, so the chunked request stays
   * unfinished while the reply is read and the peer closes.
   */
  readonly withholdTerminator?: boolean;
  /**
   * Write the final body chunk together with any terminator and the follow-up
   * in one socket write, so Node's parser can see the final body byte and the
   * follow-up message in the same pass. Only used with a chunked staged send.
   */
  readonly combineTail?: boolean;
  /**
   * Wait this many real milliseconds after the earlier chunks are written before
   * writing the combined tail, so those chunks are parsed first and only the
   * final body byte arrives with the follow-up. Only used with `combineTail`.
   */
  readonly tailDelayMs?: number;
  /**
   * A raw follow-up request written on the same socket after the body prefix,
   * before the reply is read. It is never awaited as a separate reply.
   */
  readonly followUp?: Uint8Array;
  /**
   * A raw follow-up request written on the original socket only after the first
   * complete reply has arrived, so a retirement observation happens after the
   * client has the full refusal. A write to a socket already retired by the
   * peer is an accepted attempt: the complete reply and peer closure remain the
   * evidence, and no second reply is expected.
   */
  readonly reuseAfterReply?: Uint8Array;
  /** The inclusive cap for all bytes read through closure. */
  readonly responseCap?: number;
  /** The deadline, from connection creation through peer closure. */
  readonly deadlineMs?: number;
}

/** One valid HTTP/1.x status line, with a three-digit status and optional reason. */
const STATUS_LINE = /^HTTP\/1\.[01] ([1-5]\d\d)(?: [^\r\n]*)?$/;

/** One valid HTTP header field-name token. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** One Connection field value: comma-separated connection-option tokens. */
const CONNECTION_VALUE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+(?:[ \t]*,[ \t]*[!#$%&'*+\-.^_`|~0-9A-Za-z]+)*$/;

/**
 * Parse every complete Content-Length-framed reply in the received bytes. The
 * final reply's declared body must end at the final received byte; a partial
 * second reply or any trailing junk makes the whole exchange incomplete rather
 * than silently returning the replies parsed before it. The status line and
 * every header line are validated strictly, so a malformed or concatenated line
 * cannot be ignored and absorbed into an otherwise valid reply.
 *
 * Content-Length fields must agree before a reply is counted, so conflicting
 * framing is never resolved by the last header line. Any Transfer-Encoding is
 * rejected because this reader frames replies by Content-Length only.
 * Connection fields are validated as comma-separated option tokens; this
 * rejects a truncated header whose value absorbed the next reply's status line,
 * while leaving unrelated header values (which may legally contain
 * status-line-looking text) alone.
 *
 * Field values are validated raw, before any permitted whitespace is removed,
 * and only space and horizontal tab count as HTTP whitespace. The collected
 * fields and the returned headers use prototype-free objects, so a legal field
 * name such as `constructor` is stored as data rather than an inherited
 * property.
 */
function parseReplies(bytes: Buffer): { readonly replies: Reply[]; readonly complete: boolean } {
  const replies: Reply[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const headEnd = bytes.indexOf("\r\n\r\n", offset);
    if (headEnd < 0) return { replies, complete: false };
    const lines = bytes.subarray(offset, headEnd).toString("utf8").split("\r\n");
    const statusLine = lines[0] ?? "";
    // A second status line concatenated into the first line is not a reason
    // phrase; it is a truncated reply followed by another one.
    if ((statusLine.match(/HTTP\//g) ?? []).length !== 1) return { replies, complete: false };
    const statusMatch = STATUS_LINE.exec(statusLine);
    if (statusMatch === null) return { replies, complete: false };
    const status = Number(statusMatch[1]);
    const headers: Record<string, string> = Object.create(null);
    const fields: Record<string, string[]> = Object.create(null);
    for (const line of lines.slice(1)) {
      const at = line.indexOf(":");
      if (at <= 0) return { replies, complete: false };
      const name = line.slice(0, at);
      if (!HEADER_NAME.test(name)) return { replies, complete: false };
      // Validate the received value before removing permitted HTTP whitespace:
      // CR, LF, DEL and the other controls are never legal in a header value.
      const rawValue = line.slice(at + 1);
      if (/[\u0000-\u0008\u000A-\u001F\u007F]/.test(rawValue)) {
        return { replies, complete: false };
      }
      // Only space and horizontal tab are HTTP whitespace; strip just those.
      const value = rawValue.replace(/^[ \t]+|[ \t]+$/g, "");
      const lower = name.toLowerCase();
      if (lower === "connection" && !CONNECTION_VALUE.test(value)) {
        return { replies, complete: false };
      }
      (fields[lower] ??= []).push(value);
      headers[lower] = value;
    }
    // A reply's Content-Type is a single field. Conflicting occurrences must
    // not be resolved by the last header line, which would let an earlier value
    // be overwritten in the returned headers.
    const contentTypes = fields["content-type"];
    if (contentTypes !== undefined) {
      const first = contentTypes[0];
      for (const value of contentTypes) {
        if (value !== first) return { replies, complete: false };
      }
    }
    // This reader frames replies by Content-Length only, so any transfer coding
    // is conflicting framing and cannot complete a reply.
    if (fields["transfer-encoding"] !== undefined) return { replies, complete: false };
    const lengths = fields["content-length"];
    if (lengths === undefined) return { replies, complete: false };
    let length: number | null = null;
    for (const field of lengths) {
      for (const part of field.split(",")) {
        const text = part.replace(/^[ \t]+|[ \t]+$/g, "");
        if (!/^\d+$/.test(text)) return { replies, complete: false };
        const value = Number(text);
        if (!Number.isSafeInteger(value) || value < 0) return { replies, complete: false };
        if (length === null) length = value;
        else if (length !== value) return { replies, complete: false };
      }
    }
    if (length === null) return { replies, complete: false };
    const bodyStart = headEnd + 4;
    if (bytes.length < bodyStart + length) return { replies, complete: false };
    replies.push(replyFrom(status, headers, bytes.subarray(bodyStart, bodyStart + length)));
    offset = bodyStart + length;
  }
  return { replies, complete: true };
}

/**
 * Send a staged POST and read every byte until the peer closes the connection.
 *
 * The headers declare the whole body length or, when `chunked` is set, frame
 * the body as HTTP chunks. The optional body prefix and follow-up request are
 * written on the same socket before any reply is read. A reply is complete only
 * when its headers and declared body have fully arrived; the exchange resolves
 * with every such reply it saw and the raw bytes read through closure. A
 * missing or truncated reply, a cap overflow, a socket error before any
 * complete reply, or the deadline rejects. A socket reset after a complete
 * reply still resolves: the reply is what the caller checks, and the peer
 * closure has already happened.
 */
export function sendStaged(base: string, options: StagedSendOptions): Promise<ClosedExchange> {
  const url = originOf(base);
  assert.ok(options.path.startsWith("/"), `the request target ${options.path} is root-relative`);
  assert.ok(
    Number.isSafeInteger(options.declaredLength) && options.declaredLength >= 0,
    "the declared length is a finite byte count",
  );
  const chunked = options.chunked === true;
  if (chunked) {
    assert.ok(options.bodyPrefix !== undefined, "a chunked staged send carries a body prefix");
    if (options.chunkSize !== undefined) {
      assert.ok(
        Number.isSafeInteger(options.chunkSize) && options.chunkSize > 0,
        "the chunk size is a positive finite byte count",
      );
    }
  } else {
    assert.equal(options.chunkSize, undefined, "a chunk size is only used with a chunked staged send");
    assert.notEqual(options.withholdTerminator, true, "a chunk terminator is only withheld from a chunked staged send");
    assert.notEqual(options.combineTail, true, "a combined tail is only used with a chunked staged send");
  }
  assert.ok(options.tailDelayMs === undefined || options.combineTail === true, "a tail delay is only used with a combined tail");
  if (options.tailDelayMs !== undefined) {
    assert.ok(
      Number.isSafeInteger(options.tailDelayMs) && options.tailDelayMs >= 0,
      "the tail delay is a finite non-negative duration",
    );
  }
  const cap = options.responseCap ?? DEFAULT_RESPONSE_CAP;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  assert.ok(Number.isSafeInteger(cap) && cap >= 0, "the response cap is a finite byte count");
  assert.ok(
    Number.isSafeInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= MAX_TIMEOUT_MS,
    `the deadline is a finite positive duration of at most ${MAX_TIMEOUT_MS} ms`,
  );
  const expiresAt = performance.now() + deadlineMs;
  const timedOut = (): boolean => performance.now() >= expiresAt;
  const timeoutError = (): Error => new Error(`no reply within ${deadlineMs} ms`);

  return new Promise<ClosedExchange>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let tailTimer: ReturnType<typeof setTimeout> | null = null;
    // A combined tail is not submitted until `writeTail` runs. A peer close
    // before that write would let the exchange report success without ever
    // sending the final body byte and follow-up, so it fails instead.
    let tailSubmitted = options.combineTail !== true;
    let socketError: Error | null = null;
    let localPort = 0;
    let reuseAttempted = false;
    const chunks: Buffer[] = [];
    let received = 0;
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });

    const clearDeadline = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const clearTail = (): void => {
      if (tailTimer !== null) {
        clearTimeout(tailTimer);
        tailTimer = null;
      }
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearDeadline();
      clearTail();
      socket.destroy();
      reject(error);
    };
    const finish = (): void => {
      if (settled) return;
      // A peer close before the combined tail was submitted must fail rather
      // than report a complete reply read through a closure the tail never
      // reached.
      if (!tailSubmitted) {
        fail(new Error("the peer closed before the combined tail was written"));
        return;
      }
      // A peer close dispatched after the expiry but before the timer callback
      // still fails; the monotonic deadline is checked at completion too.
      if (timedOut()) {
        fail(timeoutError());
        return;
      }
      const bytes = Buffer.concat(chunks);
      const parsed = parseReplies(bytes);
      if (!parsed.complete) {
        fail(socketError ?? new Error("the peer closed with a truncated reply"));
        return;
      }
      const replies = parsed.replies;
      if (replies.length === 0) {
        fail(socketError ?? new Error("the peer closed with no complete reply"));
        return;
      }
      if (!(Number.isInteger(localPort) && localPort > 0)) {
        fail(new Error("the exchange socket carries no positive local port"));
        return;
      }
      settled = true;
      clearDeadline();
      clearTail();
      socket.destroy();
      resolve({ bytes, replies, localPort, reuseAttempted });
    };
    const armDeadline = (): boolean => {
      const remaining = expiresAt - performance.now();
      if (remaining <= 0) {
        fail(timeoutError());
        return false;
      }
      timer = setTimeout(() => {
        if (!settled && !timedOut()) {
          armDeadline();
          return;
        }
        fail(timeoutError());
      }, remaining);
      return true;
    };

    socket.on("connect", () => {
      localPort = socket.localPort ?? 0;
      if (timedOut()) {
        fail(timeoutError());
        return;
      }
      try {
        const lines = [
          `POST ${options.path} HTTP/1.1`,
          `Host: ${url.host}`,
          `Origin: ${url.origin}`,
          `Content-Type: ${options.contentType}`,
          chunked ? "Transfer-Encoding: chunked" : `Content-Length: ${options.declaredLength}`,
          "Connection: keep-alive",
          "",
          "",
        ];
        socket.write(lines.join("\r\n"));
        if (chunked) {
          const prefix = Buffer.from(options.bodyPrefix!);
          const chunkSize = options.chunkSize ?? prefix.byteLength;
          const frames: Buffer[] = [];
          for (let offset = 0; offset < prefix.byteLength; offset += chunkSize) {
            const chunk = prefix.subarray(offset, Math.min(offset + chunkSize, prefix.byteLength));
            frames.push(
              Buffer.from(`${chunk.byteLength.toString(16)}\r\n`),
              chunk,
              Buffer.from("\r\n"),
            );
          }
          if (options.combineTail === true) {
            // Each chunk contributes a size line, its data and a CRLF. Keep
            // the entire final chunk frame, the terminator and the follow-up in
            // one write so the first excess body byte reaches the parser only
            // together with the messages that follow it.
            const tail: Buffer[] = [];
            if (frames.length >= 3) tail.push(...frames.splice(frames.length - 3, 3));
            if (options.withholdTerminator !== true) tail.push(Buffer.from("0\r\n\r\n"));
            if (options.followUp !== undefined) tail.push(Buffer.from(options.followUp));
            for (const frame of frames) socket.write(frame);
            const writeTail = (): void => {
              tailTimer = null;
              if (settled) return;
              if (timedOut()) {
                fail(timeoutError());
                return;
              }
              // The write is submitted once it is handed to the socket; a
              // close before this point is a failed exchange.
              tailSubmitted = true;
              try {
                socket.write(Buffer.concat(tail));
              } catch (tailError) {
                fail(tailError as Error);
              }
            };
            const delay = options.tailDelayMs ?? 0;
            if (delay > 0) tailTimer = setTimeout(writeTail, delay);
            else writeTail();
          } else {
            for (const frame of frames) socket.write(frame);
            if (options.withholdTerminator !== true) socket.write("0\r\n\r\n");
            if (options.followUp !== undefined) socket.write(Buffer.from(options.followUp));
          }
        } else {
          if (options.bodyPrefix !== undefined) socket.write(Buffer.from(options.bodyPrefix));
          if (options.followUp !== undefined) socket.write(Buffer.from(options.followUp));
        }
      } catch (error) {
        fail(error as Error);
      }
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      received += chunk.byteLength;
      if (received > cap) {
        fail(new Error(`the reply bytes exceeded the ${cap}-byte cap`));
        return;
      }
      chunks.push(chunk);
      if (!reuseAttempted && options.reuseAfterReply !== undefined && !settled) {
        const parsed = parseReplies(Buffer.concat(chunks));
        if (parsed.complete && parsed.replies.length > 0) {
          // Record the attempt before writing: a retired socket may already be
          // unwritable, and a write error after the complete reply must not
          // turn that reply into a failed exchange.
          reuseAttempted = true;
          try {
            socket.write(Buffer.from(options.reuseAfterReply));
          } catch {
            // The peer's closure is the expected result of reusing a retired
            // socket; the reply already received remains the only answer.
          }
        }
      }
    });
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", (error: Error) => {
      if (!settled) socketError = error;
    });
    if (!armDeadline()) return;
  });
}

// ---------------------------------------------------------------------------
// HTML reading
// ---------------------------------------------------------------------------

/** Undo the five HTML escapes the renderer writes, and nothing else. */
export function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** One section of a page: from its own `<h2>` to the next one. */
export function sectionOf(body: string, title: string): string {
  const heading = `<h2>${unescapeHtml(title).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char)}</h2>`;
  const start = body.indexOf(heading);
  if (start < 0) return "";
  const rest = body.slice(start + heading.length);
  const next = rest.indexOf("<h2>");
  return next < 0 ? rest : rest.slice(0, next);
}

/** One rendered form control, keeping the type it is rendered with. */
interface FormControl {
  readonly name: string;
  /** The control's rendered type: `text`, `date`, `textarea`, `select`, `file`, `hidden`. */
  readonly type: string;
  /** The rendered value; a file control has none. */
  readonly value: string;
  /** True for a control a browser would submit (never a disabled one). */
  readonly enabled: boolean;
}

/** The single `<form>` of a page: its action, encoding, method and controls. */
export interface ParsedForm {
  readonly action: string;
  readonly method: string;
  readonly enctype: string | null;
  /** Every named control with its rendered type, value and enabled state. */
  readonly controls: Map<string, FormControl>;
  /** Select controls: name to the option values an operator can select. */
  readonly options: Map<string, string[]>;
  /** Names the page renders as a select, whether or not it offers an option. */
  readonly selects: ReadonlySet<string>;
}

/** True for an element rendered with a `disabled` attribute. */
function isDisabled(attributes: string): boolean {
  return /\sdisabled(?:[=\s]|>|$)/.test(attributes);
}

/**
 * The positions of the form's `<fieldset ... disabled>` elements (and of their
 * closing tags), so a control rendered inside one is recognised as unavailable:
 * a browser does not submit a control of a disabled fieldset even when the
 * control itself carries no `disabled` attribute.
 */
function disabledFieldsets(inner: string): { readonly start: number; readonly end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const tags = [...inner.matchAll(/<fieldset([^>]*)>|<\/fieldset>/g)];
  for (const [index, match] of tags.entries()) {
    if (match[0] === "</fieldset>") continue;
    if (!isDisabled(match[1])) continue;
    // The fieldset's own close is the first closing tag with no further open
    // fieldset between them, so a nested fieldset's close does not end it.
    let depth = 0;
    let end = inner.length;
    for (const nested of tags.slice(index + 1)) {
      if (nested[0] === "</fieldset>") {
        if (depth === 0) {
          end = nested.index!;
          break;
        }
        depth -= 1;
      } else {
        depth += 1;
      }
    }
    spans.push({ start: match.index!, end });
  }
  return spans;
}

/** True when a control at `index` lies inside one of the disabled fieldsets. */
function insideDisabledFieldset(spans: readonly { readonly start: number; readonly end: number }[], index: number): boolean {
  return spans.some((span) => index > span.start && index < span.end);
}

/** Parse the one form of a rendered page, keeping each control's rendered type. */
export function parseForm(document: string): ParsedForm {
  const form = /<form[^>]*>([\s\S]*?)<\/form>/.exec(document);
  assert.ok(form !== null, "the page carries a form");
  const open = /<form[^>]*>/.exec(form[0])![0];
  const attribute = (name: string): string | null => {
    const match = new RegExp(`\\s${name}="([^"]*)"`).exec(open);
    return match === null ? null : unescapeHtml(match[1]);
  };
  const action = attribute("action");
  assert.notEqual(action, null, "the form carries an action");
  const controls = new Map<string, FormControl>();
  const options = new Map<string, string[]>();
  const selects = new Set<string>();
  const inner = form[1];
  const disabledSpans = disabledFieldsets(inner);
  for (const match of inner.matchAll(/<textarea([^>]*)>([\s\S]*?)<\/textarea>/g)) {
    const name = /\sname="([^"]+)"/.exec(match[1]);
    if (name === null) continue;
    controls.set(unescapeHtml(name[1]), {
      name: unescapeHtml(name[1]),
      type: "textarea",
      value: unescapeHtml(match[2]),
      enabled: !isDisabled(match[1]) && !insideDisabledFieldset(disabledSpans, match.index!),
    });
  }
  for (const match of inner.matchAll(/<input([^>]*)>/g)) {
    const attrs = match[1];
    const name = /\sname="([^"]+)"/.exec(attrs);
    if (name === null) continue;
    const type = /\stype="([^"]*)"/.exec(attrs);
    const value = /\svalue="([^"]*)"/.exec(attrs);
    controls.set(unescapeHtml(name[1]), {
      name: unescapeHtml(name[1]),
      type: unescapeHtml(type === null ? "text" : type[1]).toLowerCase(),
      value: value === null ? "" : unescapeHtml(value[1]),
      enabled: !isDisabled(attrs) && !insideDisabledFieldset(disabledSpans, match.index!),
    });
  }
  for (const match of inner.matchAll(/<select([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = /\sname="([^"]+)"/.exec(match[1]);
    assert.notEqual(name, null, "the select carries a name");
    const content = match[2];
    // An option inside a disabled optgroup, like a disabled option itself, is
    // unavailable to the operator, so the choices are only the enabled ones.
    const groups = [...content.matchAll(/<optgroup([^>]*)>/g)];
    const disabledGroups = groups
      .filter((group) => isDisabled(group[1]))
      .map((group) => {
        const rest = content.slice(group.index!);
        const close = rest.indexOf("</optgroup>");
        return { start: group.index!, end: close < 0 ? content.length : group.index! + close };
      });
    const offered = [...content.matchAll(/<option([^>]*)>/g)].filter(
      (option) =>
        !isDisabled(option[1]) &&
        !disabledGroups.some((span) => option.index! >= span.start && option.index! < span.end),
    );
    const valueOf = (attributes: string): string => {
      const value = /\svalue="([^"]*)"/.exec(attributes);
      return unescapeHtml(value === null ? "" : value[1]);
    };
    const choices = offered.map((option) => valueOf(option[1]));
    // The rendered default is the last enabled offered option marked selected,
    // or the first enabled offered option, never a disabled option.
    const selected = offered.filter((option) => /\sselected(?:[=\s]|>|$)/.test(option[1])).pop();
    const value = selected === undefined ? (choices[0] ?? "") : valueOf(selected[1]);
    options.set(unescapeHtml(name![1]), choices);
    selects.add(unescapeHtml(name![1]));
    controls.set(unescapeHtml(name![1]), {
      name: unescapeHtml(name![1]),
      type: "select",
      value,
      enabled: !isDisabled(match[1]) && !insideDisabledFieldset(disabledSpans, match.index!),
    });
  }
  return {
    action: action!,
    method: (attribute("method") ?? "get").toLowerCase(),
    enctype: attribute("enctype"),
    controls,
    options,
    selects,
  };
}

/** The form controls whose submitted value is a choice from a list. */
const CHOICE_CONTROLS: ReadonlySet<string> = new Set(["projectId"]);

/**
 * Submit a rendered form over HTTP exactly as a browser would. For a
 * multipart form the file control is sent as its own file part (or as the
 * empty filename a browser sends when no file was chosen); every other control
 * is sent as a text part carrying the value the caller supplied or the value
 * the form rendered. For a url-encoded form, every control is one field.
 *
 * A fixture file may be supplied only for a control the page actually renders
 * as an enabled file input, so a replaced picker cannot silently carry an
 * upload.
 */
export function submit(
  base: string,
  pagePath: string,
  form: ParsedForm,
  values: Readonly<Record<string, string | { readonly filename: string; readonly body: string | Uint8Array }>> = {},
): Promise<Reply> {
  // A submitted form is always a POST, as the pages render it; a creation or
  // archive form that renders GET or omits its method is not followed here.
  assert.equal(form.method, "post", `the form at ${form.action} posts`);
  for (const [name, supplied] of Object.entries(values)) {
    const control = form.controls.get(name);
    assert.ok(control !== undefined, `the form carries ${name}`);
    assert.ok(control!.enabled, `the supplied control ${name} is enabled`);
    if (typeof supplied !== "string") {
      assert.equal(control!.type, "file", `the form renders ${name} as a file control`);
    } else if (CHOICE_CONTROLS.has(name) || form.selects.has(name)) {
      // The import forms' choice controls are projects. A supplied choice must
      // come from the rendered, enabled select and be one of its enabled
      // options; a hidden or ordinary input standing in for the select, or a
      // value the operator cannot pick, is refused.
      assert.equal(control!.type, "select", `the form renders the choice ${name} as a select, not ${control!.type}`);
      const choices = form.options.get(name) ?? [];
      assert.ok(choices.includes(supplied), `the select ${name} offers ${JSON.stringify(supplied)}`);
    } else {
      assert.notEqual(control!.type, "select", `the select ${name} is rendered with its options`);
    }
  }
  // A browser does not submit a control rendered unavailable, so neither does
  // the helper: a disabled control is left out of the request.
  const parts: Part[] = [];
  for (const [name, control] of form.controls) {
    if (!control.enabled) continue;
    const supplied = values[name];
    parts.push({
      control,
      value: supplied === undefined ? control.value : supplied,
    });
  }
  const multipartBody = form.enctype === "multipart/form-data";
  for (const part of parts) {
    if (multipartBody && typeof part.value !== "string") {
      assert.equal(part.control.type, "file", `a file part is sent only for a file control, not ${part.control.name}`);
    }
  }
  // The action is the link the page rendered, resolved against the page it was
  // rendered on (a page-relative action stays on that page's directory) and
  // naming the application's own origin; a misdirected action is refused.
  const { path } = splitLink(base, pagePath, form.action);
  if (multipartBody) {
    return postBytes(base, path, MULTIPART_TYPE, multipart(parts));
  }
  const fields = new URLSearchParams();
  for (const part of parts) {
    if (typeof part.value !== "string") assert.fail(`the url-encoded form carries text for ${part.control.name}`);
    fields.set(part.control.name, part.value);
  }
  const body = Buffer.from(fields.toString(), "utf8");
  return postBytes(base, path, "application/x-www-form-urlencoded", body);
}

/** One submitted control: its rendered control and the text or file it carries. */
interface Part {
  readonly control: FormControl;
  readonly value: string | { readonly filename: string; readonly body: string | Uint8Array };
}

/** Build one complete multipart/form-data body with the helper's boundary. */
function multipart(parts: readonly Part[]): Buffer {
  const pieces = parts.map((part) => {
    const isFile = typeof part.value !== "string";
    const disposition = [`name="${part.control.name}"`];
    if (isFile) disposition.push(`filename="${part.value.filename}"`);
    const lines = [
      `--${BOUNDARY}`,
      `Content-Disposition: form-data; ${disposition.join("; ")}`,
      ...(isFile ? ["Content-Type: application/octet-stream"] : []),
      "",
      "",
    ];
    let payload: Buffer;
    if (typeof part.value === "string") {
      payload = Buffer.from(part.value, "utf8");
    } else if (typeof part.value.body === "string") {
      payload = Buffer.from(part.value.body, "utf8");
    } else {
      payload = Buffer.from(part.value.body);
    }
    return Buffer.concat([Buffer.from(lines.join("\r\n"), "utf8"), payload, Buffer.from("\r\n")]);
  });
  return Buffer.concat([...pieces, Buffer.from(`--${BOUNDARY}--\r\n`)]);
}

// ---------------------------------------------------------------------------
// Source rows and their three views
// ---------------------------------------------------------------------------

/** One listed source on a meeting's detail page, read from its own markup. */
export interface SourceRow {
  readonly filename: string;
  readonly format: string;
  readonly original: string;
  readonly text: string;
  readonly passages: string;
}

/**
 * The source rows of a meeting's detail page, in rendered order. Each row is
 * the list item carrying a source's filename and its three labelled links;
 * the links are read from the page, never built here.
 */
export function sourceRows(document: string): SourceRow[] {
  const rows: SourceRow[] = [];
  for (const match of document.matchAll(/<li class="card">([\s\S]*?)<\/li>/g)) {
    const inner = match[1];
    const filename = /<span class="source-filename">([\s\S]*?)<\/span>/.exec(inner);
    if (filename === null) continue;
    const format = /<span class="source-format">([\s\S]*?)<\/span>/.exec(inner);
    assert.notEqual(format, null, "a source row shows its stored format");
    const byLabel = new Map(
      [...inner.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((anchor) => [unescapeHtml(anchor[2]), unescapeHtml(anchor[1])]),
    );
    const original = byLabel.get("Download original");
    const text = byLabel.get("Extracted text");
    const passages = byLabel.get("Passages");
    assert.notEqual(original, undefined, "a source row links its original");
    assert.notEqual(text, undefined, "a source row links its text");
    assert.notEqual(passages, undefined, "a source row links its passages");
    rows.push({
      filename: unescapeHtml(filename[1]),
      format: unescapeHtml(format![1]),
      original: original!,
      text: text!,
      passages: passages!,
    });
  }
  return rows;
}

/**
 * Resolve every link of every source row rendered on the meeting page at
 * `meetingPath`, against that page. A relative href resolves against the
 * meeting path's directory, a same-origin absolute href keeps its path and
 * query, and a link naming another origin is refused. Each resolved row has
 * the same fields as a rendered row, now holding root-relative request targets
 * on the application's own origin, so it can be saved as a restart baseline.
 */
export function meetingSourceRows(base: string, meetingPath: string, document: string): SourceRow[] {
  return sourceRows(document).map((row) => ({
    filename: row.filename,
    format: row.format,
    original: splitLink(base, meetingPath, row.original).path,
    text: splitLink(base, meetingPath, row.text).path,
    passages: splitLink(base, meetingPath, row.passages).path,
  }));
}

/** One passage as the passages page renders it: its anchor, text, and metadata. */
export interface RenderedPassage {
  readonly anchor: string;
  readonly text: string;
  readonly offsets: string;
  readonly position: string;
  readonly location: string;
  /** The fragment link the row renders, unescaped. */
  readonly link: string;
}

/**
 * The passages a passages page renders, in stored order. The anchor, the
 * escaped passage text and the offsets, line/column and location metadata are
 * read from the page's own markup, so a changed text, range or location fails.
 */
export function renderedPassages(document: string): RenderedPassage[] {
  const passages: RenderedPassage[] = [];
  for (const match of document.matchAll(/<li class="passage" id="([^"]+)">([\s\S]*?)<\/li>/g)) {
    const anchor = unescapeHtml(match[1]);
    const inner = match[2];
    const text = /<p class="passage-text">([\s\S]*?)<\/p>/.exec(inner);
    assert.notEqual(text, null, "a passage row shows its text");
    const offsets = /<span class="offsets">([\s\S]*?)<\/span>/.exec(inner);
    const position = /<span class="position">([\s\S]*?)<\/span>/.exec(inner);
    assert.notEqual(offsets, null, "a passage row shows its offsets");
    assert.notEqual(position, null, "a passage row shows its position");
    const location = /<span class="location">([\s\S]*?)<\/span>/.exec(inner);
    const link = /<a class="passage-link" href="([^"]+)">/.exec(inner);
    assert.notEqual(link, null, "a passage row links itself");
    passages.push({
      anchor,
      text: unescapeHtml(text![1]),
      offsets: unescapeHtml(offsets![1]),
      position: unescapeHtml(position![1]),
      location: location === null ? "" : unescapeHtml(location[1]),
      link: unescapeHtml(link![1]),
    });
  }
  return passages;
}

/**
 * Resolve one rendered passage link, rendered on the page at `fromPath` on the
 * running application, against the page that rendered it. The destination must
 * be the application's own, carry exactly one row with the decoded fragment's
 * anchor, and that row must show the passage's own quote. A fragment link is a
 * same-page anchor: the fragment names a row on the page, and the page is
 * fetched, so the resolved request target and raw fragment are returned.
 */
export async function resolvePassageLink(
  base: string,
  fromPath: string,
  passage: RenderedPassage,
  expectedText: string = passage.text,
): Promise<{ readonly path: string; readonly fragment: string }> {
  const { href, path, fragment } = splitLink(base, fromPath, passage.link);
  assert.notEqual(fragment, "", `the passage link ${passage.link} carries a fragment`);
  // The browser decodes the fragment to find the anchor; the raw fragment is
  // kept for the saved URL, and the decoded one is compared with the HTML id.
  const anchor = decodeURIComponent(fragment);
  const destination = await get(base, href);
  assert.equal(destination.status, 200, `the passage link destination ${href} is readable`);
  const targets = renderedPassages(destination.body).filter((row) => row.anchor === anchor);
  assert.equal(targets.length, 1, `the fragment ${anchor} targets exactly one passage row at ${href}`);
  assert.equal(targets[0].text, expectedText, `the target row ${anchor} shows the passage's own quote`);
  return { path, fragment };
}
