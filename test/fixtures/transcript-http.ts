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
import { request as httpRequest } from "node:http";

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

function originOf(base: string): URL {
  return new URL(base);
}

/** A reply body decoded as a string; text is UTF-8 in this application. */
function replyFrom(status: number, headers: Record<string, string | string[] | undefined>, bytes: Buffer): Reply {
  return { status, headers, bytes, body: bytes.toString("utf8") };
}

/**
 * Send one GET over loopback HTTP. The Host header is the origin's own
 * authority; a plain GET carries no Origin and is accepted by the shell.
 */
export function get(base: string, path: string): Promise<Reply> {
  const url = originOf(base);
  const headers: Record<string, string | number> = {
    host: url.host,
    "content-length": 0,
  };
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: Number(url.port), method: "GET", path, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(replyFrom(res.statusCode ?? 0, res.headers, Buffer.concat(chunks))));
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
 * form submission; it can be overridden only to build a deliberately foreign
 * request.
 */
export function postBytes(
  base: string,
  path: string,
  contentType: string,
  body: Uint8Array,
  options: { readonly method?: string; readonly origin?: string } = {},
): Promise<Reply> {
  const url = originOf(base);
  const headers: Record<string, string> = {
    host: url.host,
    origin: options.origin ?? url.origin,
    "content-length": String(body.byteLength),
    "content-type": contentType,
  };
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: Number(url.port), method: options.method ?? "POST", path, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(replyFrom(res.statusCode ?? 0, res.headers, Buffer.concat(chunks))));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
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

/** The main content region of a page, without the shared shell. */
export function mainOf(body: string): string {
  const start = body.indexOf('<main id="main">');
  assert.ok(start >= 0, "the page carries a main landmark");
  const end = body.indexOf("</main>", start);
  assert.ok(end >= 0, "the main landmark is closed");
  return body.slice(start, end);
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

/** The single `<form>` of a page: its action, encoding, method and controls. */
export interface ParsedForm {
  readonly action: string;
  readonly method: string;
  readonly enctype: string | null;
  /** Text, select, textarea and hidden controls: name to rendered value. */
  readonly controls: Map<string, string>;
  /** Select controls: name to the option values it offers. */
  readonly options: Map<string, string[]>;
}

/** Parse the one form of a rendered page, keeping each control's value. */
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
  const controls = new Map<string, string>();
  const options = new Map<string, string[]>();
  const inner = form[1];
  for (const match of inner.matchAll(/<textarea[^>]*\sname="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) {
    controls.set(unescapeHtml(match[1]), unescapeHtml(match[2]));
  }
  for (const match of inner.matchAll(/<input([^>]*)>/g)) {
    const attrs = match[1];
    const name = /\sname="([^"]+)"/.exec(attrs);
    if (name === null) continue;
    const value = /\svalue="([^"]*)"/.exec(attrs);
    controls.set(unescapeHtml(name[1]), value === null ? "" : unescapeHtml(value[1]));
  }
  for (const match of inner.matchAll(/<select([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = /\sname="([^"]+)"/.exec(match[1]);
    assert.notEqual(name, null, "the select carries a name");
    const choices = [...match[2].matchAll(/<option value="([^"]*)"/g)].map((option) => unescapeHtml(option[1]));
    options.set(unescapeHtml(name![1]), choices);
    const selected = /<option value="([^"]*)"[^>]*\sselected/.exec(match[2]);
    controls.set(unescapeHtml(name![1]), selected === null ? (choices[0] ?? "") : unescapeHtml(selected[1]));
  }
  return {
    action: action!,
    method: (attribute("method") ?? "get").toLowerCase(),
    enctype: attribute("enctype"),
    controls,
    options,
  };
}

/**
 * Submit a rendered form over HTTP exactly as a browser would. For a
 * multipart form the file control is sent as its own file part (or as the
 * empty filename a browser sends when no file was chosen); every other control
 * is sent as a text part carrying the value the caller supplied or the value
 * the form rendered. For a url-encoded form, every control is one field.
 */
export function submit(
  base: string,
  form: ParsedForm,
  values: Readonly<Record<string, string | { readonly filename: string; readonly body: string | Uint8Array }>> = {},
): Promise<Reply> {
  for (const name of Object.keys(values)) {
    assert.ok(form.controls.has(name), `the form carries ${name}`);
  }
  const parts: Part[] = [];
  for (const [name, rendered] of form.controls) {
    const supplied = values[name];
    parts.push({ name, value: supplied === undefined ? rendered : supplied });
  }
  if (form.enctype === "multipart/form-data") {
    const body = multipart(parts);
    return postBytes(base, form.action, MULTIPART_TYPE, body, { method: form.method.toUpperCase() });
  }
  const fields = new URLSearchParams();
  for (const part of parts) {
    if (typeof part.value !== "string") assert.fail(`the url-encoded form carries text for ${part.name}`);
    fields.set(part.name, part.value);
  }
  const body = Buffer.from(fields.toString(), "utf8");
  return postBytes(base, form.action, "application/x-www-form-urlencoded", body, { method: form.method.toUpperCase() });
}

/** One submitted control: a text value or a file part. */
interface Part {
  readonly name: string;
  readonly value: string | { readonly filename: string; readonly body: string | Uint8Array };
}

/** Build one complete multipart/form-data body with the helper's boundary. */
function multipart(parts: readonly Part[]): Buffer {
  const pieces = parts.map((part) => {
    const isFile = typeof part.value !== "string";
    const disposition = [`name="${part.name}"`];
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
 * The fragment of a fragment link: the part after `#`, already decoded to the
 * anchor the browser would find, exactly as `renderedPassages` reads an `id`.
 */
export function fragmentOf(link: string): string {
  const at = link.indexOf("#");
  assert.ok(at >= 0, `the link ${link} carries a fragment`);
  const raw = link.slice(at + 1);
  return decodeURIComponent(raw);
}
