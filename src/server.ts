/**
 * Native Node HTTP shell: loopback-only, origin-checked, server-rendered HTML
 * with plain form POSTs. The shell owns every request check; a route runs only
 * after Host, Origin, method, content type and body size have been accepted.
 *
 * Access boundary: the server binds 127.0.0.1 only. The OS account is the
 * access boundary (R18); there is no authentication service here, and no proxy
 * is trusted, so forwarded host and protocol headers are ignored.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  escapeHtml,
  FormError,
  redirect,
  renderForm,
  renderFormError,
  renderPage,
  type FieldError,
  type FieldSpec,
  type Page,
  type Redirect,
} from "./html.ts";
import { health } from "./index.ts";
import { MissingRecordError, ValidationError, type Store } from "./store.ts";

export { escapeHtml, FormError, redirect, renderForm, renderFormError, renderPage } from "./html.ts";
export type { FieldError, FieldSpec, Page, Redirect } from "./html.ts";

/** The request body limit: a form body is small. */
export const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

/**
 * A route's result: a page, a redirect, or a plain-text error. A route reports
 * missing records by throwing `MissingRecordError` and invalid input by
 * throwing `ValidationError`; a form problem is reported with `FormError`.
 * Headers on every result are advisory: the shell sets Content-Type and the
 * no-store policy itself, so a result can neither omit nor override them.
 */
export type RouteResult =
  | Page
  | Redirect
  | {
      readonly status: number;
      readonly body: string;
      readonly headers?: Readonly<Record<string, string>>;
    };

/** What a route may read from an accepted request. */
export interface RouteRequest {
  readonly method: "GET" | "POST";
  /** The request path only; the query string is never a route input. */
  readonly path: string;
  /** The canonical origin this server was bound to. */
  readonly origin: string;
  /** Form fields of an accepted POST; empty for a GET. */
  readonly form: Readonly<Record<string, string>>;
}

/**
 * A guarded route. Its `render` runs only after the request checks pass. A
 * rejected or unregistered request never reaches it, so a rejected request
 * never invokes a handler.
 */
export interface Route {
  readonly method: "GET" | "POST";
  render(request: RouteRequest): Promise<RouteResult> | RouteResult;
}

/**
 * The fixed route table: route names are server constants, never request data.
 * `home` serves `/` and `health` serves `/health`; each may carry a GET and a
 * POST route. An unregistered path is refused before any handler runs.
 */
export interface Routes {
  readonly home: { readonly get: Route; readonly post?: Route };
  readonly health: { readonly get: Route; readonly post?: Route };
}

export interface ServerOptions {
  /** The workspace store that routes read; the shell never mutates it. */
  readonly store: Store;
  readonly port: number;
  readonly routes: Routes;
}

export interface StartedServer {
  /** The canonical origin derived from the actual listening port. */
  readonly origin: string;
  /** The bound port, useful when `port` was 0. */
  readonly port: number;
  close(): Promise<void>;
}

/** Response headers the shell sets itself; routes cannot supply them. */
const TEXT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "text/plain; charset=utf-8",
});

const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";

function response(status: number, body: string): RouteResult {
  return { status, body: `${body}\n` };
}

/** A rejection before any route ran: explicit status and a fixed message. */
class Rejection {
  readonly status: number;

  constructor(status: number) {
    this.status = status;
  }
}

/**
 * The generic failure page. It carries no error text, no path and no stack:
 * details belong in the server's log, not in a response.
 */
const GENERIC_FAILURE = "An unexpected error occurred.";

/**
 * The response headers the shell owns. A route cannot set, omit or override
 * them: any route-supplied header whose name matches one of these (HTTP header
 * names are case-insensitive) is dropped before the response is written.
 */
const SHELL_HEADERS: ReadonlySet<string> = new Set(["content-type", "cache-control", "content-length"]);

/**
 * Send one response. `Cache-Control: no-store` is set here for every response,
 * so no route result can omit it or replace it with a cacheable value; the
 * Content-Type is the shell's own too.
 */
function send(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  extra: Readonly<Record<string, string>> = {},
): void {
  const payload = Buffer.from(body, "utf8");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(extra)) {
    if (!SHELL_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  headers["Content-Type"] = contentType;
  headers["Cache-Control"] = "no-store";
  headers["Content-Length"] = String(payload.byteLength);
  res.writeHead(status, headers);
  res.end(payload);
}

function sendPage(res: ServerResponse, status: number, page: Page): void {
  send(res, status, page.html, "text/html; charset=utf-8", page.headers);
}

function sendRedirect(res: ServerResponse, target: Redirect): void {
  // A POST/redirect/GET: 303 keeps the follow-up a GET, so GET never mutates
  // when the browser follows it.
  send(res, 303, "", "text/plain; charset=utf-8", target.headers);
}

function sendRouteResult(res: ServerResponse, result: RouteResult): void {
  if ("location" in result) {
    sendRedirect(res, result);
    return;
  }
  if ("html" in result) {
    sendPage(res, 200, result);
    return;
  }
  send(res, result.status, result.body, "text/plain; charset=utf-8", result.headers);
}

/**
 * Parse the authority of a Host header into a lowercase `host:port` form.
 * Bracketed IPv6 literals are accepted; anything malformed is refused.
 */
function parseAuthority(header: string): string | null {
  const text = header.trim();
  if (text === "") return null;
  let host: string;
  let port: string;
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close < 0) return null;
    host = text.slice(0, close + 1);
    const rest = text.slice(close + 1);
    if (rest === "") return `${host.toLowerCase()}`;
    if (!rest.startsWith(":") || !/^\d{1,5}$/.test(rest.slice(1))) return null;
    port = rest.slice(1);
  } else {
    const parts = text.split(":");
    if (parts.length > 2) return null;
    if (parts.length === 1) {
      host = parts[0];
      port = "";
    } else {
      host = parts[0];
      port = parts[1];
      if (!/^\d{1,5}$/.test(port)) return null;
    }
    if (!/^[a-z0-9.-]+$/i.test(host)) return null;
    host = host.toLowerCase();
  }
  return port === "" ? host : `${host}:${port}`;
}

/**
 * The canonical origin and its authority, built through one URL so both are
 * serialized the same way (a default port is dropped by both). A browser
 * serializes Origin and Host the same way, so they compare equal.
 */
export function canonicalOrigin(port: number): { origin: string; authority: string } {
  const url = new URL(`http://127.0.0.1:${port}`);
  return { origin: url.origin, authority: url.host.toLowerCase() };
}

/** True when a header was supplied once; Node folds duplicates into a joined string. */
function singleHeader(message: IncomingMessage, name: string): string | undefined {
  const value = message.headers[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? undefined : value;
}

/**
 * True when a Content-Type header names the form media type with only
 * parameters this server understands. A charset of utf-8 (or none) is
 * accepted; any other charset, or a type parameter, is a different type.
 */
function isFormContentType(header: string | undefined): boolean {
  if (header === undefined) return false;
  const [type, ...params] = header.split(";");
  if (type.trim().toLowerCase() !== FORM_MEDIA_TYPE) return false;
  const seen = new Set<string>();
  for (const param of params) {
    const at = param.indexOf("=");
    if (at < 0) return false;
    const name = param.slice(0, at).trim().toLowerCase();
    const value = param.slice(at + 1).trim().replace(/^"|"$/g, "").toLowerCase();
    if (name !== "charset" || value !== "utf-8" || seen.has("charset")) return false;
    seen.add("charset");
  }
  return true;
}

/**
 * Read a size-bounded form body. A declared length over the limit is refused
 * before any bytes are read; chunks that add up past it are refused as soon as
 * the limit is crossed, before the request has finished.
 *
 * The reader never tears the request stream down. `for await` (or removing the
 * listeners) would abort the request and destroy its socket before the caller
 * can answer, so the listeners stay in place and keep draining any remaining
 * bytes; the promise settles at the moment the limit is crossed, and the
 * caller writes the 413. The connection is then answered in full instead of
 * being dropped under the client.
 */
function readForm(message: IncomingMessage, limit: number): Promise<Record<string, string>> {
  const declaredHeader = message.headers["content-length"];
  const declared = typeof declaredHeader === "string" && /^\d+$/.test(declaredHeader) ? Number(declaredHeader) : null;
  if (declared !== null && declared > limit) return Promise.reject(new Rejection(413));
  return new Promise<Record<string, string>>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    function onData(chunk: Buffer | string): void {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > limit) {
        settled = true;
        reject(new Rejection(413));
        return;
      }
      chunks.push(buffer);
    }
    function onEnd(): void {
      cleanup();
      if (settled) return;
      settled = true;
      if (declared !== null && declared !== size) {
        reject(new Rejection(400));
        return;
      }
      resolve(parseForm(Buffer.concat(chunks).toString("utf8")));
    }
    function onError(): void {
      cleanup();
      if (settled) return;
      settled = true;
      reject(new Rejection(400));
    }
    function cleanup(): void {
      message.off("end", onEnd);
      message.off("error", onError);
    }
    message.on("data", onData);
    message.on("end", onEnd);
    message.on("error", onError);
  });
}

/** Decode a parsed urlencoded body into fields; the last of a repeated key wins. */
function parseForm(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(text)) {
    fields[key] = value;
  }
  return fields;
}

/** The status a thrown error maps to; unexpected errors map to 500. */
function errorStatus(error: unknown): number {
  if (error instanceof Rejection) return error.status;
  if (error instanceof MissingRecordError) return 404;
  if (error instanceof ValidationError || error instanceof FormError) return 400;
  return 500;
}

function rejectionMessage(status: number): string {
  if (status === 413) return "The request body is too large.";
  if (status === 415) return "Unsupported content type.";
  if (status === 405) return "Method not allowed.";
  if (status === 404) return "Not found.";
  return "Invalid request.";
}

export async function startServer(options: ServerOptions): Promise<StartedServer> {
  const { routes } = options;
  let canonical = "";
  let canonicalAuthority = "";

  // The canonical origin and authority are both derived from the listening
  // port through `canonicalOrigin`, so the origin the shell compares an
  // Origin header against and the authority it compares a Host header against
  // are serialized the same way, including default-port normalization.
  const originFor = (port: number): string => canonicalOrigin(port).origin;
  const authorityFor = (port: number): string => canonicalOrigin(port).authority;

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, `${GENERIC_FAILURE}\n`, "text/plain; charset=utf-8");
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Every check runs before a route is looked up or invoked.
    const host = singleHeader(req, "host");
    const origin = singleHeader(req, "origin");
    // Forwarded host/protocol headers are ignored outright: no proxy is trusted.
    if (host === undefined || parseAuthority(host) !== canonicalAuthority) {
      send(res, 403, "Forbidden.\n", "text/plain; charset=utf-8");
      return;
    }
    if (origin !== undefined && origin !== canonical) {
      send(res, 403, "Forbidden.\n", "text/plain; charset=utf-8");
      return;
    }

    const method = req.method ?? "";
    const path = (req.url ?? "").split("?")[0];
    const isGet = method === "GET";
    const isPost = method === "POST";
    if (!isGet && !isPost) {
      send(res, 405, "Method not allowed.\n", "text/plain; charset=utf-8", { Allow: "GET, POST" });
      return;
    }
    if (isPost && origin === undefined) {
      send(res, 403, "Forbidden.\n", "text/plain; charset=utf-8");
      return;
    }

    // The form checks run before dispatch so an unsupported type or an
    // oversized body is answered as such, whatever the destination.
    try {
      let form: Record<string, string> = {};
      if (isPost) {
        if (!isFormContentType(singleHeader(req, "content-type"))) {
          throw new Rejection(415);
        }
        form = await readForm(req, DEFAULT_MAX_BODY_BYTES);
      }

      // Dispatch only on the fixed route table; an unknown path is 404.
      const page = path === "/" ? routes.home : path === "/health" ? routes.health : undefined;
      if (page === undefined) {
        send(res, 404, "Not found.\n", "text/plain; charset=utf-8");
        return;
      }
      const route = isPost ? page.post : page.get;
      if (route === undefined || route.method !== method) {
        send(res, 405, "Method not allowed.\n", "text/plain; charset=utf-8", { Allow: "GET, POST" });
        return;
      }

      const result = await route.render({ method, path, origin: canonical, form });
      sendRouteResult(res, result);
    } catch (error) {
      if (error instanceof Rejection && error.status === 413) {
        // The body was refused before it was fully read; answer, then close the
        // connection instead of trying to reuse it for another request.
        res.setHeader("Connection", "close");
      }
      const status = errorStatus(error);
      const result = errorResponse(error);
      if ("location" in result) {
        throw new Error("An error response cannot be a redirect");
      }
      if ("html" in result) sendPage(res, status, result);
      else send(res, status, result.body, "text/plain; charset=utf-8", result.headers);
    }
  }

  // 127.0.0.1 is the only interface bound: no wildcard, no LAN address.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("The server did not report a TCP listening address");
  }
  const boundPort = (address as AddressInfo).port;
  canonical = originFor(boundPort);
  canonicalAuthority = authorityFor(boundPort);

  return {
    origin: canonical,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
        // A request that is still streaming (or whose client never read the
        // reply) must not hold close open forever; close ends every remaining
        // connection instead of waiting for them.
        server.closeAllConnections();
      }),
  };
}

function errorResponse(error: unknown): RouteResult {
  if (error instanceof FormError) return renderFormError(error);
  const status = errorStatus(error);
  if (status === 500) return response(500, GENERIC_FAILURE);
  if (error instanceof Rejection) return response(status, rejectionMessage(status));
  const message = error instanceof Error ? error.message : GENERIC_FAILURE;
  if (status === 400) return response(400, `Invalid input: ${message}`);
  if (status === 404) return response(404, "Not found.");
  return response(status, message);
}

/**
 * The minimal home and health shell. Home is a read-only page: it reports the
 * workspace counts from `store.snapshot()` and links to Health. It offers no
 * form and no route that creates, changes or deletes a workspace record.
 * Health answers a fixed page from `health()`. Both are GET routes; POST to
 * either is refused by the shell before any handler runs.
 */
export function appRoutes(store: Store): Routes {
  const home: Route = {
    method: "GET",
    render() {
      const snapshot = store.snapshot();
      const body = [
        '<nav><a href="/">Home</a><a href="/health">Health</a></nav>',
        `<p>This shell reads the workspace and changes nothing. Records: ${[
          `clients ${escapeHtml(String(snapshot.clients.length))}`,
          `engagements ${escapeHtml(String(snapshot.engagements.length))}`,
          `projects ${escapeHtml(String(snapshot.projects.length))}`,
          `tasks ${escapeHtml(String(snapshot.tasks.length))}`,
          `items ${escapeHtml(String(snapshot.items.length))}`,
          `meetings ${escapeHtml(String(snapshot.meetings.length))}`,
        ].join(", ")}.</p>`,
      ].join("\n");
      return renderPage("Client operations", body);
    },
  };

  const healthRoute: Route = {
    method: "GET",
    render() {
      return renderPage("Health", `<p>${escapeHtml(health().status)}</p>`);
    },
  };

  return { home: { get: home }, health: { get: healthRoute } };
}
