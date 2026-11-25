import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  startServer,
  type Route,
  type RouteRequest,
  type Routes,
  type StartedServer,
} from "../src/server.ts";
import { FILE_CONTROL, MAX_MULTIPART_BYTES } from "../src/transcript-multipart.ts";
import { openStore, type Store } from "../src/store.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "http-body-"));
  roots.push(dir);
  return dir;
}

/**
 * A test route table: a marked multipart POST import at `/import`, an
 * unmarked url-encoded POST at `/plain`, and their GET counterparts. Every
 * handler call is counted, so a refusal that reached a handler would show up.
 */
interface Harness {
  readonly server: StartedServer;
  readonly store: Store;
  readonly calls: { marked: number; unmarked: number; get: number };
  readonly seen: RouteRequest[];
  close(): Promise<void>;
}

async function fixture(): Promise<Harness> {
  const dir = tempDir();
  const store = await openStore(dir);
  const calls = { marked: 0, unmarked: 0, get: 0 };
  const seen: RouteRequest[] = [];
  const ok: Route = {
    method: "GET",
    render() {
      calls.get += 1;
      return { status: 200, body: "get" };
    },
  };
  const marked: Route = {
    method: "POST",
    bodyPolicy: "Multipart",
    render(request) {
      calls.marked += 1;
      seen.push(request);
      return { status: 200, body: "imported" };
    },
  };
  const unmarked: Route = {
    method: "POST",
    render(request) {
      calls.unmarked += 1;
      seen.push(request);
      return { status: 200, body: "plain" };
    },
  };
  const routes: Routes = {
    home: { get: ok },
    health: { get: ok },
    application: {
      match: (path) => (path === "/import" ? "import" : path === "/plain" ? "plain" : null),
      route: (matched, method) => {
        if (matched === "import") return method === "POST" ? marked : ok;
        return method === "POST" ? unmarked : ok;
      },
    },
  };
  const server = await startServer({ store, port: 0, routes });
  return {
    server,
    store,
    calls,
    seen,
    close: async () => {
      await server.close();
      await store.close();
    },
  };
}

const BOUNDARY = "test-boundary-7f3a";

function quoted(part: { name: string; filename?: string; body: string | Uint8Array }): Buffer {
  const lines: string[] = [`--${BOUNDARY}`];
  const params = [`name="${part.name}"`];
  if (part.filename !== undefined) params.push(`filename="${part.filename}"`);
  lines.push(`Content-Disposition: form-data; ${params.join("; ")}`);
  if (part.filename !== undefined) lines.push("Content-Type: application/octet-stream");
  lines.push("", "");
  const payload = typeof part.body === "string" ? Buffer.from(part.body, "utf8") : Buffer.from(part.body);
  return Buffer.concat([Buffer.from(lines.join("\r\n"), "utf8"), payload, Buffer.from("\r\n")]);
}

/** Build a complete multipart/form-data body from its parts. */
function multipartBody(parts: Array<{ name: string; filename?: string; body: string | Uint8Array }>): Buffer {
  const pieces = parts.map(quoted);
  return Buffer.concat([...pieces, Buffer.from(`--${BOUNDARY}--\r\n`)]);
}

const MULTIPART_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** POST a byte body to a path with a Content-Length and read the whole reply. */
function postBytes(
  origin: string,
  path: string,
  contentType: string | null,
  body: Uint8Array,
  options: { readonly origin?: string | null; readonly method?: string } = {},
): Promise<Reply> {
  const url = new URL(origin);
  const headers: Record<string, string> = { host: url.host, "content-length": String(body.byteLength) };
  const sentOrigin = options.origin === undefined ? origin : options.origin;
  if (sentOrigin !== null) headers.origin = sentOrigin;
  if (contentType !== null) headers["content-type"] = contentType;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: Number(url.port),
        method: options.method ?? "POST",
        path,
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
    req.end(Buffer.from(body));
  });
}

function post(
  origin: string,
  path: string,
  contentType: string | null,
  body: string,
  options: { readonly origin?: string | null; readonly method?: string } = {},
): Promise<Reply> {
  return postBytes(origin, path, contentType, Buffer.from(body, "utf8"), options);
}

/**
 * Read one raw HTTP reply until it is complete: the header block ends with a
 * blank line and the declared Content-Length body has arrived. The socket is
 * destroyed before the promise settles.
 */
function readReply(socket: Socket, timeoutMs: number): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (error: Error | null, reply?: Reply): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error === null && reply !== undefined) resolve(reply);
      else reject(error ?? new Error("no reply"));
    };
    const check = (eof: boolean): void => {
      const buffer = Buffer.concat(chunks);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (eof) settle(new Error("connection ended before the reply headers arrived"));
        return;
      }
      const head = buffer.subarray(0, end).toString("utf8").split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of head.slice(1)) {
        const at = line.indexOf(":");
        if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
      }
      const bodyBuffer = buffer.subarray(end + 4);
      const declared = headers["content-length"];
      if (declared !== undefined && /^\d+$/.test(declared) && bodyBuffer.byteLength < Number(declared)) {
        if (eof) settle(new Error("connection ended before the reply body arrived"));
        return;
      }
      settle(null, { status: Number(head[0]?.split(" ")[1] ?? 0), headers, body: bodyBuffer.toString("utf8") });
    };
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      check(false);
    });
    socket.on("end", () => check(true));
    socket.on("close", () => check(true));
    socket.on("error", (error) => settle(error));
    socket.setTimeout(timeoutMs, () => settle(new Error("timed out waiting for a reply")));
  });
}

/**
 * Write raw request lines (and an empty body separator) to the server, then read
 * one complete reply. No body bytes follow, so a request refused on its declared
 * length is answered before anything is buffered.
 */
function exchange(url: URL, lines: string[]): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    readReply(socket, 5000).then(resolve, reject);
    socket.on("connect", () => socket.write(lines.join("\r\n")));
  });
}

/**
 * Start a chunked multipart POST, write the given chunks, optionally finish the
 * request, and read the reply. Without `terminate` the request stays
 * unfinished, so a 413 must not depend on the connection being dropped.
 */
function chunked(
  origin: string,
  path: string,
  contentType: string,
  chunks: Uint8Array[],
  options: { readonly terminate?: boolean; readonly origin?: string | null } = {},
): Promise<Reply> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    const reply = readReply(socket, 5000);
    reply.then(resolve, reject);
    socket.on("connect", () => {
      const lines = ["POST " + path + " HTTP/1.1", `Host: ${url.host}`];
      const sentOrigin = options.origin === undefined ? origin : options.origin;
      if (sentOrigin !== null) lines.push(`Origin: ${sentOrigin}`);
      lines.push(`Content-Type: ${contentType}`, "Transfer-Encoding: chunked", "", "");
      socket.write(lines.join("\r\n"));
      for (const chunk of chunks) {
        const buffer = Buffer.from(chunk);
        socket.write(`${buffer.byteLength.toString(16)}\r\n`);
        socket.write(buffer);
        socket.write("\r\n");
      }
      if (options.terminate) socket.write("0\r\n\r\n");
    });
  });
}

/** A chunk of a multipart body padded to `bytes` so the whole body exceeds the limit. */
function oversizedMultipart(): Buffer {
  const padding = "a".repeat(MAX_MULTIPART_BYTES);
  const body = multipartBody([{ name: "paste", body: padding }]);
  assert.ok(body.byteLength > MAX_MULTIPART_BYTES, "the body must exceed the limit");
  return body;
}

function assertNoHandlerRan(harness: Harness): void {
  assert.equal(harness.calls.marked, 0);
  assert.equal(harness.calls.unmarked, 0);
  assert.equal(harness.calls.get, 0);
}

describe("multipart import body policy", () => {
  it("delivers a file byte-for-byte and a paste larger than 16 KiB to the marked POST", async () => {
    const harness = await fixture();
    try {
      const fileBytes = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256));
      const paste = "x".repeat(16 * 1024 + 777);
      const body = multipartBody([
        { name: "paste", body: paste },
        { name: FILE_CONTROL, filename: "transcript.txt", body: fileBytes },
      ]);
      const reply = await postBytes(harness.server.origin, "/import", MULTIPART_TYPE, body);
      assert.equal(reply.status, 200);
      assert.equal(harness.calls.marked, 1);
      assert.equal(harness.calls.unmarked, 0);
      assert.equal(harness.seen.length, 1);
      const request = harness.seen[0];
      assert.equal(request.method, "POST");
      assert.equal(request.path, "/import");
      assert.equal(request.origin, harness.server.origin);
      assert.deepEqual({ ...request.form }, { paste });
      assert.ok(request.file !== null);
      assert.equal(request.file?.filename, "transcript.txt");
      assert.deepEqual(Buffer.from(request.file?.bytes ?? new Uint8Array()), fileBytes);
    } finally {
      await harness.close();
    }
  });

  it("accepts a chunked multipart body delivered across chunks", async () => {
    const harness = await fixture();
    try {
      const paste = "y".repeat(5000);
      const body = multipartBody([{ name: "paste", body: paste }]);
      const mid = Math.floor(body.byteLength / 2);
      const reply = await chunked(harness.server.origin, "/import", MULTIPART_TYPE, [
        body.subarray(0, mid),
        body.subarray(mid),
      ], { terminate: true });
      assert.equal(reply.status, 200);
      assert.equal(harness.calls.marked, 1);
      assert.equal(harness.seen[0]?.form.paste, paste);
      assert.equal(harness.seen[0]?.file, null);
    } finally {
      await harness.close();
    }
  });

  it("refuses a wrong media type with 415 and the decoder's reason and guidance", async () => {
    const harness = await fixture();
    try {
      const body = multipartBody([{ name: "paste", body: "hello" }]);
      for (const contentType of [
        "application/x-www-form-urlencoded",
        "text/plain",
        null,
      ]) {
        const reply = await postBytes(harness.server.origin, "/import", contentType, body);
        assert.equal(reply.status, 415, String(contentType));
        assert.match(reply.body, /not a multipart\/form-data body/);
        assert.match(reply.body, /Submit the form as multipart\/form-data/);
        assert.equal(reply.headers["cache-control"], "no-store");
      }
      assertNoHandlerRan(harness);
    } finally {
      await harness.close();
    }
  });

  it("refuses a multipart body whose boundary parameter is missing with 400", async () => {
    const harness = await fixture();
    try {
      const body = multipartBody([{ name: "paste", body: "hello" }]);
      for (const contentType of ["multipart/form-data", `multipart/form-data; boundary=""`]) {
        const reply = await postBytes(harness.server.origin, "/import", contentType, body);
        assert.equal(reply.status, 400, contentType);
        assert.match(reply.body, /boundary parameter is missing or malformed/);
        assert.match(reply.body, /well-formed multipart\/form-data body/);
      }
      assertNoHandlerRan(harness);
    } finally {
      await harness.close();
    }
  });

  it("refuses malformed multipart with 400 and the decoder's reason and guidance", async () => {
    const harness = await fixture();
    try {
      const noClose = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="paste"\r\n\r\nhello\r\n`);
      const bareLf = Buffer.from(`--${BOUNDARY}\nContent-Disposition: form-data; name="paste"\n\nhello\n--${BOUNDARY}--\n`);
      for (const body of [noClose, bareLf]) {
        const reply = await postBytes(harness.server.origin, "/import", MULTIPART_TYPE, body);
        assert.equal(reply.status, 400);
        assert.match(reply.body, /The multipart body is not valid/);
        assert.match(reply.body, /Submit the form once as a well-formed multipart\/form-data body/);
      }
      assertNoHandlerRan(harness);
    } finally {
      await harness.close();
    }
  });

  it("refuses a duplicate control with 400 and the decoder's reason and guidance", async () => {
    const harness = await fixture();
    try {
      const body = multipartBody([
        { name: "paste", body: "one" },
        { name: "paste", body: "two" },
      ]);
      const reply = await postBytes(harness.server.origin, "/import", MULTIPART_TYPE, body);
      assert.equal(reply.status, 400);
      assert.match(reply.body, /"paste" was submitted more than once/);
      assert.match(reply.body, /Each control must be submitted once/);
      assertNoHandlerRan(harness);
    } finally {
      await harness.close();
    }
  });

  it("refuses a declared excess size before buffering with the limit guidance and closes the connection", async () => {
    const harness = await fixture();
    try {
      const url = new URL(harness.server.origin);
      const reply = await exchange(url, [
        "POST /import HTTP/1.1",
        `Host: ${url.host}`,
        `Origin: ${harness.server.origin}`,
        `Content-Type: ${MULTIPART_TYPE}`,
        `Content-Length: ${MAX_MULTIPART_BYTES + 1}`,
        "Connection: keep-alive",
        "",
        "",
      ]);
      assert.equal(reply.status, 413);
      assert.match(reply.body, /too large/);
      assert.match(reply.body, new RegExp(`at most ${MAX_MULTIPART_BYTES} bytes`));
      assert.equal(reply.headers["connection"], "close");
      assert.equal(reply.headers["cache-control"], "no-store");
      assertNoHandlerRan(harness);
    } finally {
      await harness.close();
    }
  });

  it("refuses an excess size counted while arriving and closes the connection", async () => {
    const harness = await fixture();
    try {
      const body = oversizedMultipart();
      // Chunked body that crosses the limit while arriving, request unfinished.
      const reply = await chunked(harness.server.origin, "/import", MULTIPART_TYPE, [body]);
      assert.equal(reply.status, 413);
      assert.match(reply.body, /too large/);
      assert.match(reply.body, /Keep the whole submission at most/);
      assert.equal(reply.headers["connection"], "close");
      assert.equal(reply.headers["cache-control"], "no-store");
      assertNoHandlerRan(harness);
    } finally {
      await harness.close();
    }
  });

  it("refuses a foreign or missing POST Origin before the multipart body is read", async () => {
    const harness = await fixture();
    try {
      const body = multipartBody([{ name: "paste", body: "hello" }]);
      for (const sentOrigin of ["http://evil.example", "null", null]) {
        const reply = await postBytes(harness.server.origin, "/import", MULTIPART_TYPE, body, { origin: sentOrigin });
        assert.equal(reply.status, 403, String(sentOrigin));
        assert.equal(reply.headers["cache-control"], "no-store");
      }
      assertNoHandlerRan(harness);
    } finally {
      await harness.close();
    }
  });

  it("keeps the url-encoded policy for an unmarked POST", async () => {
    const harness = await fixture();
    try {
      const multipartReply = await postBytes(
        harness.server.origin,
        "/plain",
        MULTIPART_TYPE,
        multipartBody([{ name: "paste", body: "hello" }]),
      );
      assert.equal(multipartReply.status, 415);
      assertNoHandlerRan(harness);

      const formReply = await post(
        harness.server.origin,
        "/plain",
        "application/x-www-form-urlencoded",
        "name=Ada+Lovelace",
      );
      assert.equal(formReply.status, 200);
      assert.equal(harness.calls.unmarked, 1);
      assert.equal(harness.calls.marked, 0);
      assert.deepEqual({ ...harness.seen[0]?.form }, { name: "Ada Lovelace" });
      assert.equal(harness.seen[0]?.file, null);
    } finally {
      await harness.close();
    }
  });

  it("rejects an import-looking unregistered URL with multipart as 404", async () => {
    const harness = await fixture();
    try {
      const body = multipartBody([{ name: "paste", body: "hello" }]);
      for (const path of ["/imports", "/import/now", "/transcript/import", "/importing"]) {
        const reply = await postBytes(harness.server.origin, path, MULTIPART_TYPE, body);
        assert.equal(reply.status, 404, path);
        assert.equal(reply.headers["cache-control"], "no-store");
      }
      assertNoHandlerRan(harness);
    } finally {
      await harness.close();
    }
  });

  it("keeps the 16 KiB limit and url-encoded parsing for other POSTs", async () => {
    const harness = await fixture();
    try {
      const reply = await post(
        harness.server.origin,
        "/plain",
        "application/x-www-form-urlencoded",
        `name=${"a".repeat(16 * 1024 + 1)}`,
      );
      assert.equal(reply.status, 413);
      assert.match(reply.body, /too large/);
      assertNoHandlerRan(harness);
    } finally {
      await harness.close();
    }
  });
});
