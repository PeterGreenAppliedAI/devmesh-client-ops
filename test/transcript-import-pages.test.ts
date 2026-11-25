import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { escapeHtml, FormError } from "../src/html.ts";
import { registerRoutes, startApplication } from "../src/index.ts";
import { ValidationError } from "../src/model.ts";
import {
  engagementImportHref,
  matchMeetingPath,
  meetingImportHref,
  meetingRoutes,
  projectImportHref,
} from "../src/meeting-pages.ts";
import { startServer, type Routes } from "../src/server.ts";
import { openStore, type Store } from "../src/store.ts";
import { transcriptService, type TranscriptStore } from "../src/transcript-store.ts";
import {
  engagementImportHref as importEngagementHref,
  importLimitsText,
  matchTranscriptImportPath,
  meetingImportHref as importMeetingHref,
  projectImportHref as importProjectHref,
  routeForTranscriptImportPattern,
  supportedFormatsText,
  transcriptImportRoutes,
  type TranscriptImportRequest,
} from "../src/transcript-import-pages.ts";
import { FILE_CONTROL, MAX_FILE_BYTES, MAX_MULTIPART_BYTES, MAX_PASTE_BYTES, PASTE_CONTROL } from "../src/transcript-multipart.ts";

// ---------------------------------------------------------------------------
// Fixtures and HTTP helpers
// ---------------------------------------------------------------------------

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "transcript-import-pages-"));
  roots.push(dir);
  return dir;
}

/** Escape text for a regular expression, so a literal is matched literally. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match a literal attribute value, escaped as the renderer writes it. */
function attribute(pattern: string, value: string): RegExp {
  return new RegExp(`${pattern}="${literal(escapeHtml(value))}"`);
}

/** The stored records a workspace fixture holds. */
interface Fixture {
  readonly store: Store;
  readonly clientId: string;
  readonly engagementId: string;
  readonly projectId: string;
  readonly secondProjectId: string;
  readonly foreignProjectId: string;
  readonly meetingId: string;
  readonly otherMeetingId: string;
}

/** A workspace with an engagement, two of its projects, a sibling engagement's
 * project, and two manual meetings in the engagement. */
async function seed(store: Store): Promise<Fixture> {
  const client = await store.createClient({ name: "Acme <Ltd>" });
  const engagement = await store.createEngagement({ clientId: client.id, name: "Eng & Co" });
  const project = await store.createProject({ engagementId: engagement.id, name: "Proj <one>" });
  const second = await store.createProject({ engagementId: engagement.id, name: "Second" });
  const sibling = await store.createEngagement({ clientId: client.id, name: "Sibling" });
  const foreign = await store.createProject({ engagementId: sibling.id, name: "Foreign" });
  const meeting = await store.createMeeting({
    clientId: client.id,
    engagementId: engagement.id,
    title: "Manual meeting",
    date: "2026-01-10",
    notes: "Kept notes",
  });
  const other = await store.createMeeting({
    clientId: client.id,
    engagementId: engagement.id,
    title: "Other meeting",
    date: "2026-01-11",
    notes: "",
  });
  return {
    store,
    clientId: client.id,
    engagementId: engagement.id,
    projectId: project.id,
    secondProjectId: second.id,
    foreignProjectId: foreign.id,
    meetingId: meeting.id,
    otherMeetingId: other.id,
  };
}

interface Running {
  readonly origin: string;
  readonly store: Store;
  close(): Promise<void>;
}

/** Start a server over a real on-disk store, on an ephemeral port. */
async function running(): Promise<Running & Fixture> {
  const store = await openStore(tempDir());
  const server = await startServer({ store, port: 0, routes: registerRoutes(store) });
  const fixture = await seed(store);
  return {
    ...fixture,
    origin: server.origin,
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

/** Send a plain GET over loopback HTTP. */
function get(origin: string, path: string): Promise<Reply> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: Number(url.port), method: "GET", path, headers: { host: url.host }, agent: false },
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
    req.end();
  });
}

// ---------------------------------------------------------------------------
// The multipart form a browser submits
// ---------------------------------------------------------------------------

const BOUNDARY = "import-boundary-4c1f";
const MULTIPART_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;

/** One submitted control: text, or a file part when `filename` is given. */
interface Part {
  readonly name: string;
  readonly body?: string | Uint8Array;
  readonly filename?: string;
}

/** Build one complete multipart/form-data body, as a browser sends it. */
function multipart(parts: readonly Part[]): Buffer {
  const pieces = parts.map((part) => {
    const disposition = [`name="${part.name}"`];
    if (part.filename !== undefined) disposition.push(`filename="${part.filename}"`);
    const lines = [
      `--${BOUNDARY}`,
      `Content-Disposition: form-data; ${disposition.join("; ")}`,
      ...(part.filename !== undefined ? ["Content-Type: application/octet-stream"] : []),
      "",
      "",
    ];
    const payload = typeof part.body === "string" ? Buffer.from(part.body, "utf8") : Buffer.from(part.body ?? "");
    return Buffer.concat([Buffer.from(lines.join("\r\n"), "utf8"), payload, Buffer.from("\r\n")]);
  });
  return Buffer.concat([...pieces, Buffer.from(`--${BOUNDARY}--\r\n`)]);
}

/** POST a byte body to a path with a Content-Length and read the whole reply. */
function postBytes(origin: string, path: string, contentType: string | null, body: Uint8Array): Promise<Reply> {
  const url = new URL(origin);
  const headers: Record<string, string> = {
    host: url.host,
    origin,
    "content-length": String(body.byteLength),
  };
  if (contentType !== null) headers["content-type"] = contentType;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: Number(url.port), method: "POST", path, headers, agent: false },
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

/** One control a browser submits from a rendered form, with its values. */
interface Control {
  readonly name: string;
  readonly kind: "input" | "textarea" | "select" | "file";
  readonly required: boolean;
  readonly options: readonly string[];
}

/** The controls of the one form on a rendered page, in order. */
function controls(form: string): Control[] {
  const found: Control[] = [];
  const pattern = /<(input|textarea|select)([^>]*)>/g;
  for (const match of form.matchAll(pattern)) {
    const tag = match[1];
    const attrs = match[2];
    const name = /\sname="([^"]+)"/.exec(attrs);
    assert.ok(name !== null, `every control has a name: ${match[0]}`);
    const type = /\stype="([^"]+)"/.exec(attrs);
    found.push({
      name: unescapeHtml(name[1]),
      kind: tag === "textarea" ? "textarea" : tag === "select" ? "select" : type !== null && type[1] === "file" ? "file" : "input",
      required: /\srequired(\s|>)/.test(attrs),
      options: [...(match[0].matchAll(/<option value="([^"]*)"/g) ?? [])].map((option) => unescapeHtml(option[1])),
    });
  }
  return found;
}

/**
 * Submit a rendered multipart form over HTTP exactly as a browser would: read
 * the discovery page, take the form's action, its encoding, the method and its
 * controls, then send one part per control. A text control carries the value
 * given (or its rendered initial value); a file control carries the selected
 * file, or the empty filename a browser sends when no file was chosen.
 */
async function submitRendered(
  origin: string,
  path: string,
  entries: ReadonlyMap<string, string | { readonly filename: string; readonly body: string | Uint8Array }>,
  options: { readonly unselectedFile?: boolean; readonly contentTypeOverride?: string | null } = {},
): Promise<{ readonly reply: Reply; readonly form: string }> {
  const page = await get(origin, path);
  assert.equal(page.status, 200, path);
  const form = formOf(page.body);
  assert.match(form, /method="post"/, path);
  assert.match(form, /enctype="multipart\/form-data"/, path);
  const action = /<form[^>]*\saction="([^"]*)"/.exec(form);
  assert.ok(action !== null, "the form has an action");
  assert.equal(unescapeHtml(action[1]), path, "the form posts back to the page it was read from");
  const rendered = controls(form);
  const parts: Part[] = [];
  for (const control of rendered) {
    const entry = entries.get(control.name);
    if (control.kind === "file") {
      if (entry === undefined || (options.unselectedFile === true && entry === "")) {
        // The browser sends the file control as an empty file part when nothing
        // was chosen; the decoder reads that as no selected file.
        parts.push({ name: control.name, filename: "", body: "" });
      } else if (typeof entry === "string") {
        assert.fail(`a file control carries a file, not ${JSON.stringify(entry)}`);
      } else {
        parts.push({ name: control.name, filename: entry.filename, body: entry.body });
      }
      continue;
    }
    if (entry === undefined) {
      if (!control.required) continue;
      assert.fail(`the required control ${control.name} must be submitted`);
    }
    assert.equal(typeof entry, "string", `the text control ${control.name} carries text`);
    parts.push({ name: control.name, body: entry as string });
  }
  for (const name of entries.keys()) {
    assert.ok(rendered.some((control) => control.name === name), `the form carries ${name}`);
  }
  const contentType = options.contentTypeOverride === undefined ? MULTIPART_TYPE : options.contentTypeOverride;
  return { reply: await postBytes(origin, unescapeHtml(action[1]), contentType, multipart(parts)), form };
}

/** Submit a rendered form with the given text controls, pasted text only. */
function submitPaste(
  origin: string,
  path: string,
  entries: ReadonlyMap<string, string>,
): Promise<{ readonly reply: Reply; readonly form: string }> {
  return submitRendered(origin, path, entries, { unselectedFile: true });
}

/** The main content region of a rendered page, without the global shell. */
function mainOf(body: string): string {
  const start = body.indexOf('<main id="main">');
  assert.ok(start >= 0, "page has a main landmark");
  const end = body.indexOf("</main>", start);
  assert.ok(end >= 0, "the main landmark is closed");
  return body.slice(start, end);
}

/** The markup of the one form on a page. */
function formOf(document: string): string {
  const form = /<form[^>]*>([\s\S]*?)<\/form>/.exec(document);
  assert.ok(form !== null, "page has a form");
  return form[0];
}

/** Decode the five characters `escapeHtml` replaces, and nothing else (so a
 * numeric entity inside a submitted value survives unchanged). */
function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The names of the controls a rendered form carries, in order. */
function controlNames(document: string): string[] {
  const inner = formOf(document);
  const names: string[] = [];
  for (const match of inner.matchAll(/<(?:input|textarea|select)[^>]*\sname="([^"]+)"/g)) {
    names.push(unescapeHtml(match[1]));
  }
  return names;
}

/** The value a rendered select shows as selected, or null when it has none. */
function selectedOption(document: string, name: string): string | null {
  const field = new RegExp(`<select[^>]*\\sname="${name}"[^>]*>([\\s\\S]*?)</select>`).exec(document);
  assert.ok(field !== null, `select ${name} is rendered`);
  const selected = /<option value="([^"]*)"[^>]*\sselected/.exec(field[1]);
  return selected === null ? null : unescapeHtml(selected[1]);
}

/**
 * Create one record through the application's own rendered form: read the form
 * at `formPath`, submit it to `action` with the given values, and return the id
 * in the redirect target.
 */
async function createThroughForm(
  origin: string,
  formPath: string,
  action: string,
  values: Record<string, string>,
): Promise<string> {
  const form = await get(origin, formPath);
  assert.equal(form.status, 200, formPath);
  const names = new Set(controlNames(form.body));
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    assert.ok(names.has(name), `the form carries ${name}`);
    body.set(name, value);
  }
  const reply = await postBytes(origin, action, "application/x-www-form-urlencoded", Buffer.from(body.toString()));
  assert.equal(reply.status, 303, `${action} created the record`);
  return String(reply.headers.location ?? "").split("/").pop() as string;
}

/** The counts an import could change. */
function counts(store: Store): { meetings: number; transcripts: number; sources: number } {
  const snapshot = store.snapshot();
  const transcripts = snapshot.transcripts ?? [];
  return {
    meetings: snapshot.meetings.length,
    transcripts: transcripts.length,
    sources: transcripts.reduce((sum, transcript) => sum + transcript.sources.length, 0),
  };
}

// ---------------------------------------------------------------------------
// Matching and registration
// ---------------------------------------------------------------------------

describe("transcript import paths", () => {
  it("matches exactly the three four-segment import shapes and nothing else", () => {
    assert.deepEqual(matchTranscriptImportPath("/engagements/engagement-1/transcripts/import"), {
      pattern: "/engagements/:id/transcripts/import",
      kind: "engagement",
      id: "engagement-1",
    });
    assert.deepEqual(matchTranscriptImportPath("/projects/project-1/transcripts/import"), {
      pattern: "/projects/:id/transcripts/import",
      kind: "project",
      id: "project-1",
    });
    assert.deepEqual(matchTranscriptImportPath("/meetings/meeting-1/transcripts/import"), {
      pattern: "/meetings/:id/transcripts/import",
      kind: "meeting",
      id: "meeting-1",
    });
    // The raw id is carried still encoded; a query string is never a route input.
    assert.equal(matchTranscriptImportPath("/projects/a%2Fb/transcripts/import")?.id, "a%2Fb");
    assert.equal(matchTranscriptImportPath("/projects/project-1/transcripts/import?x=1")?.kind, "project");
    for (const path of [
      "/engagements/engagement-1/transcripts",
      "/engagements/engagement-1/transcripts/import/now",
      "/clients/client-1/transcripts/import",
      "/engagements//transcripts/import",
      "/engagements/engagement-1/transcripts/import/",
      "/transcripts/import",
      "/engagements/engagement-1/transcripts/other",
    ]) {
      assert.equal(matchTranscriptImportPath(path), null, path);
    }
  });

  it("registers a GET form and a marked multipart POST under each import path", () => {
    const routes = transcriptImportRoutes;
    assert.equal(typeof routes, "function");
    const store = {
      snapshot: () => ({
        clients: [],
        engagements: [],
        projects: [],
        meetings: [],
        tasks: [],
        items: [],
        transcripts: [],
      }),
    } as unknown as Store;
    const service = {
      store,
      submitTranscript: async () => {
        throw new Error("must not run for a GET");
      },
      importTranscript: async () => {
        throw new Error("must not run");
      },
      readSource: async () => {
        throw new Error("must not run");
      },
      transcripts: () => [],
      close: async () => {},
    } as unknown as TranscriptStore;
    // The service is resolved lazily, only when an import POST needs it.
    const table = transcriptImportRoutes(store, () => service);
    for (const pattern of [
      "/engagements/:id/transcripts/import",
      "/projects/:id/transcripts/import",
      "/meetings/:id/transcripts/import",
    ] as const) {
      assert.equal(routeForTranscriptImportPattern(table, pattern, "GET")?.method, "GET");
      const post = routeForTranscriptImportPattern(table, pattern, "POST");
      assert.equal(post?.method, "POST");
      assert.equal(post?.bodyPolicy, "Multipart");
      assert.equal(routeForTranscriptImportPattern(table, pattern, "GET")?.bodyPolicy, undefined);
    }
  });

  it("shows a refused submission as a correctable form and never swallows another failure", async () => {
    const store = {
      snapshot: () => ({
        clients: [{ id: "client-1", name: "C", background: "", contacts: "", stakeholders: "", requirements: "", objectives: "" }],
        engagements: [{ id: "engagement-1", clientId: "client-1", name: "E", objectives: "", status: "active" }],
        projects: [],
        meetings: [],
        tasks: [],
        items: [],
        transcripts: [],
      }),
    } as unknown as Store;
    // The service is injected through the interface the routes accept: a
    // validation refusal and an unexpected failure are each raised there.
    const makeService = (failure: unknown) => () =>
      ({
        submitTranscript: async () => {
          throw failure;
        },
      }) as unknown as TranscriptStore;
    const request: TranscriptImportRequest = {
      method: "POST",
      path: "/engagements/engagement-1/transcripts/import",
      form: { title: "T", date: "2026-01-01", paste: "Words." },
      file: null,
    };
    const refusal = transcriptImportRoutes(store, makeService(new ValidationError("meeting.date is invalid")));
    await assert.rejects(
      async () => refusal.engagementImport.post!.render(request),
      (error: unknown) => error instanceof FormError && error.message === "meeting.date is invalid",
    );
    // A failure that is not a refusal is reported unchanged, never rendered as
    // a form problem.
    const unexpected = new Error("the store is unavailable");
    const broken = transcriptImportRoutes(store, makeService(unexpected));
    await assert.rejects(async () => broken.engagementImport.post!.render(request), (error: unknown) => error === unexpected);
    // An import POST resolved under the wrong URL shape is refused as missing,
    // not rendered.
    await assert.rejects(
      async () =>
        refusal.engagementImport.get!.render({ ...request, method: "GET", path: "/projects/project-1/transcripts/import" }),
    );
  });

  it("leaves the url-encoded form behaviour on every non-import POST", async () => {
    const server = await running();
    try {
      // A meeting history and the meeting's own edit POST are not import routes.
      const history = await get(server.origin, `/engagements/${server.engagementId}`);
      assert.equal(history.status, 200);
      const reply = await postBytes(
        server.origin,
        `/meetings/${server.meetingId}/edit`,
        MULTIPART_TYPE,
        multipart([{ name: "title", body: "x" }]),
      );
      // The unmarked edit POST keeps the url-encoded media check.
      assert.equal(reply.status, 415);
      assert.deepEqual(counts(server.store).meetings, 2);
    } finally {
      await server.close();
    }
  });

  it("opts in only the three import POST slots and leaves meeting routes otherwise unchanged", async () => {
    // Registration itself needs nothing beyond what every page reads: a store
    // object with no original repository still registers, and a real import
    // over it is refused rather than silently writing against another store.
    const store = {
      snapshot: () => ({
        clients: [],
        engagements: [],
        projects: [],
        meetings: [],
        tasks: [],
        items: [],
        transcripts: [],
      }),
    } as unknown as Store;
    const routes: Routes = registerRoutes(store);
    const table = routes.hierarchy;
    assert.ok(table !== undefined);
    // The import patterns are matched and routed to marked POSTs.
    for (const [path, pattern] of [
      ["/engagements/engagement-1/transcripts/import", "/engagements/:id/transcripts/import"],
      ["/projects/project-1/transcripts/import", "/projects/:id/transcripts/import"],
      ["/meetings/meeting-1/transcripts/import", "/meetings/:id/transcripts/import"],
    ] as const) {
      const matched = table.match(path);
      assert.equal((matched as { pattern: string }).pattern, pattern);
      const post = table.route(matched, "POST");
      assert.equal(post?.bodyPolicy, "Multipart", path);
      const page = table.route(matched, "GET");
      assert.equal(page?.bodyPolicy, undefined, path);
    }
    // No other route carries the policy, and the meeting routes are unchanged.
    for (const path of ["/engagements/engagement-1/meetings/new", "/projects/project-1/meetings/new", "/meetings/meeting-1/edit"]) {
      const matched = table.match(path);
      assert.notEqual(matched, null, path);
      assert.equal(table.route(matched, "POST")?.bodyPolicy, undefined, path);
    }
    // Matching the import shapes does not disturb the meeting matcher.
    assert.equal(matchMeetingPath("/engagements/engagement-1/transcripts/import"), null);
    const meetingTable = meetingRoutes(store);
    assert.equal(meetingTable.meetingsNew.get?.method, "GET");
    assert.equal(meetingTable.meetingsNew.post?.method, "POST");
    // The import POST over this store refuses at the service it builds, not at
    // registration: the failure is reported, and nothing pretends to write.
    const importRoute = table.route(table.match("/engagements/e/transcripts/import"), "POST");
    assert.ok(importRoute !== undefined);
    await assert.rejects(async () => importRoute.render({ method: "POST", path: "/engagements/e/transcripts/import", origin: "http://127.0.0.1", form: {}, file: null }));
  });

  it("shares one spelling of the encoded import links", () => {
    for (const id of ["engagement-1", "a b/c", "ünïcode&<"]) {
      const encoded = encodeURIComponent(id);
      assert.equal(engagementImportHref(id), `/engagements/${encoded}/transcripts/import`);
      assert.equal(projectImportHref(id), `/projects/${encoded}/transcripts/import`);
      assert.equal(meetingImportHref(id), `/meetings/${encoded}/transcripts/import`);
      assert.equal(importEngagementHref(id), engagementImportHref(id));
      assert.equal(importProjectHref(id), projectImportHref(id));
      assert.equal(importMeetingHref(id), meetingImportHref(id));
    }
  });
});

// ---------------------------------------------------------------------------
// Links from the histories and the meeting page
// ---------------------------------------------------------------------------

describe("transcript import links", () => {
  it("links the import action from the engagement and project histories", async () => {
    const server = await running();
    try {
      const engagement = await get(server.origin, `/engagements/${server.engagementId}`);
      assert.equal(engagement.status, 200);
      assert.match(engagement.body, attribute("href", engagementImportHref(server.engagementId)));
      // The manual creation action keeps its place beside it.
      assert.match(engagement.body, new RegExp(`href="/engagements/${server.engagementId}/meetings/new"`));

      const project = await get(server.origin, `/projects/${server.projectId}`);
      assert.equal(project.status, 200);
      assert.match(project.body, attribute("href", projectImportHref(server.projectId)));
      assert.match(project.body, new RegExp(`href="/projects/${server.projectId}/meetings/new"`));

      // A client-wide history has no single scope, so it never offers an import.
      const client = await get(server.origin, `/clients/${server.clientId}`);
      assert.equal(client.status, 200);
      assert.ok(!client.body.includes("/transcripts/import"));
    } finally {
      await server.close();
    }
  });

  it("links the attachment action from a manual meeting's own page", async () => {
    const server = await running();
    try {
      const reply = await get(server.origin, `/meetings/${server.meetingId}`);
      assert.equal(reply.status, 200);
      assert.match(reply.body, attribute("href", meetingImportHref(server.meetingId)));
      assert.match(reply.body, /Import transcript/);
    } finally {
      await server.close();
    }
  });

  it("keeps a scoped history's empty state offering the import when it has no meetings", async () => {
    const server = await running();
    try {
      const empty = await server.store.createEngagement({ clientId: server.clientId, name: "Empty" });
      const reply = await get(server.origin, `/engagements/${empty.id}`);
      assert.equal(reply.status, 200);
      const start = reply.body.indexOf("<h2>Meeting history</h2>");
      const section = reply.body.slice(start, reply.body.indexOf("</section>", start));
      assert.match(section, /No meetings recorded yet\./);
      assert.match(section, attribute("href", engagementImportHref(empty.id)));
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The rendered forms
// ---------------------------------------------------------------------------

describe("transcript import forms", () => {
  it("renders a create form with title, date, optional notes, a blank project select and the source alternatives", async () => {
    const server = await running();
    try {
      const reply = await get(server.origin, engagementImportHref(server.engagementId));
      assert.equal(reply.status, 200);
      assert.match(reply.headers["content-type"] as string, /^text\/html/);
      assert.equal(reply.headers["cache-control"], "no-store");
      const page = mainOf(reply.body);
      assert.deepEqual(controlNames(reply.body), ["title", "date", "notes", "projectId", PASTE_CONTROL, "file"]);
      // The controls are typed as the meeting fields are.
      assert.match(formOf(reply.body), /<input type="text"[^>]*name="title"[^>]*required>/);
      assert.match(formOf(reply.body), /<input type="date"[^>]*name="date"[^>]*required>/);
      assert.match(formOf(reply.body), /<textarea[^>]*name="notes"/);
      assert.match(formOf(reply.body), /<textarea[^>]*name="paste"/);
      // The source file is a native file input, so a browser sends it as its
      // own multipart part, and the form states the multipart encoding.
      assert.match(formOf(reply.body), /<input type="file"[^>]*\sname="file"[^>]*>/);
      assert.ok(!/<input type="text"[^>]*\sname="file"/.test(formOf(reply.body)));
      assert.match(formOf(reply.body), /enctype="multipart\/form-data"/);
      // The engagement-scoped form starts with a blank project selection.
      assert.equal(selectedOption(reply.body, "projectId"), "");
      // The engagement's own projects are offered, escaped, labelled as archived
      // when archived, and never a sibling engagement's project.
      const options = formOf(reply.body).match(/<option value="([^"]*)"[^>]*>[^<]*<\/option>/g) ?? [];
      assert.ok(options.some((option) => option.includes(`value="${server.projectId}"`)));
      assert.ok(options.some((option) => option.includes(`value="${server.secondProjectId}"`)));
      assert.ok(!formOf(reply.body).includes(`value="${server.foreignProjectId}"`));
      assert.ok(page.includes(escapeHtml("Proj <one>")));
      assert.ok(!reply.body.includes("Proj <one>"));
      // The action is the fixed, server-built import path.
      assert.match(formOf(reply.body), attribute("action", engagementImportHref(server.engagementId)));
      assert.match(formOf(reply.body), /method="post"/);
    } finally {
      await server.close();
    }
  });

  it("offers paste and a file as labelled alternatives, with the formats and the size limits", async () => {
    const server = await running();
    try {
      for (const path of [
        engagementImportHref(server.engagementId),
        projectImportHref(server.projectId),
        meetingImportHref(server.meetingId),
      ]) {
        const reply = await get(server.origin, path);
        assert.equal(reply.status, 200, path);
        const form = formOf(reply.body);
        // Both source controls are present and labelled as alternatives.
        assert.match(form, /<label for="field-paste">[^<]*alternative[^<]*<\/label>/, path);
        assert.match(form, /<label for="field-file">[^<]*alternative[^<]*<\/label>/, path);
        assert.match(form, /<textarea[^>]*name="paste"/, path);
        assert.match(form, /<input type="file"[^>]*\sname="file"/, path);
        assert.match(form, /enctype="multipart\/form-data"/, path);
        // The supported formats and the total, per-paste and per-file limits.
        const page = mainOf(reply.body);
        assert.ok(page.includes(escapeHtml(supportedFormatsText())), path);
        assert.ok(page.includes(escapeHtml(importLimitsText())), path);
        assert.match(page, /15 MiB/, path);
        assert.match(page, /10 MiB/, path);
        assert.match(page, /\.txt/, path);
        assert.match(page, /\.docx/, path);
        assert.match(page, /\.pdf/, path);
        assert.match(page, /extracted text/, path);
        assert.equal(MAX_MULTIPART_BYTES, 15 * 1024 * 1024);
        assert.equal(MAX_PASTE_BYTES, 10 * 1024 * 1024);
        assert.equal(MAX_FILE_BYTES, 10 * 1024 * 1024);
        assert.match(page, new RegExp(`extracted text[^<]*${MAX_PASTE_BYTES} bytes|at most ${MAX_PASTE_BYTES / 1024 / 1024} MiB`), path);
      }
    } finally {
      await server.close();
    }
  });

  it("preselects the URL project on a project form and starts the engagement form blank", async () => {
    const server = await running();
    try {
      const engagement = await get(server.origin, engagementImportHref(server.engagementId));
      assert.equal(selectedOption(engagement.body, "projectId"), "");
      const project = await get(server.origin, projectImportHref(server.projectId));
      assert.equal(selectedOption(project.body, "projectId"), server.projectId);
      // A project form's cancel returns to the project, an engagement form's to
      // the engagement.
      assert.match(formOf(project.body), attribute("action", projectImportHref(server.projectId)));
      assert.match(mainOf(project.body), new RegExp(`href="/projects/${server.projectId}"`));
      assert.match(mainOf(engagement.body), new RegExp(`href="/engagements/${server.engagementId}"`));
    } finally {
      await server.close();
    }
  });

  it("renders an attachment form that takes only the source", async () => {
    const server = await running();
    try {
      const reply = await get(server.origin, meetingImportHref(server.meetingId));
      assert.equal(reply.status, 200);
      assert.deepEqual(controlNames(reply.body), [PASTE_CONTROL, "file"]);
      // The meeting's title, date, notes and project are not controls here.
      assert.ok(!formOf(reply.body).includes('name="title"'));
      assert.ok(!formOf(reply.body).includes('name="date"'));
      assert.ok(!formOf(reply.body).includes('name="notes"'));
      assert.ok(!formOf(reply.body).includes('name="projectId"'));
      // The page names the meeting it attaches to, escaped.
      assert.ok(mainOf(reply.body).includes(escapeHtml("2026-01-10 — Manual meeting")));
      assert.match(formOf(reply.body), attribute("action", meetingImportHref(server.meetingId)));
    } finally {
      await server.close();
    }
  });

  it("keeps an archived scope's page usable with its notice", async () => {
    const server = await running();
    try {
      await server.store.setArchived("engagement", server.engagementId, true);
      for (const path of [engagementImportHref(server.engagementId), projectImportHref(server.projectId), meetingImportHref(server.meetingId)]) {
        const reply = await get(server.origin, path);
        assert.equal(reply.status, 200, path);
        assert.match(reply.body, /class="archive-notice"/, path);
        // The page is still a usable form.
        assert.match(formOf(reply.body), /name="paste"/, path);
      }
      // The notice is on the project form when only the project is archived.
      await server.store.setArchived("engagement", server.engagementId, false);
      await server.store.setArchived("project", server.projectId, true);
      const project = await get(server.origin, projectImportHref(server.projectId));
      assert.match(project.body, /class="archive-notice"/);
      assert.match(project.body, /\(archived\)/);
    } finally {
      await server.close();
    }
  });

  it("keeps an archived URL project's notice on a refused submission that selected an active sibling", async () => {
    const server = await running();
    try {
      // The URL names the archived project; the submitted project select names an
      // active sibling of the same engagement, and the date is invalid. The
      // refusal is a correctable form, and it keeps the archived URL project's
      // notice, not the silently selected sibling's empty one.
      await server.store.setArchived("project", server.projectId, true);
      const before = counts(server.store);
      const reply = (await submitPaste(
        server.origin,
        projectImportHref(server.projectId),
        new Map([
          ["title", "Archived project"],
          ["date", "2026-02-30"],
          ["projectId", server.secondProjectId],
          [PASTE_CONTROL, "Words."],
        ]),
      )).reply;
      assert.equal(reply.status, 400);
      const page = mainOf(reply.body);
      assert.match(page, /class="archive-notice"/);
      assert.match(page, /real calendar date/);
      // The rejected selection is shown as it was submitted, marked selected.
      assert.ok(page.includes(`<option value="${escapeHtml(server.secondProjectId)}" selected>`));
      assert.deepEqual(counts(server.store), before);
    } finally {
      await server.close();
    }
  });

  it("escapes every displayed stored value and encodes the id in the URL", async () => {
    const store = await openStore(tempDir());
    const server = await startServer({ store, port: 0, routes: registerRoutes(store) });
    try {
      const client = await store.createClient({ name: "Client <&>" });
      const engagement = await store.createEngagement({ clientId: client.id, name: "Eng <script>" });
      const project = await store.createProject({ engagementId: engagement.id, name: "P <\"q\">" });
      const meeting = await store.createMeeting({
        clientId: client.id,
        engagementId: engagement.id,
        title: "M <alert>",
        date: "2026-01-01",
        notes: "",
      });
      for (const path of [engagementImportHref(engagement.id), projectImportHref(project.id), meetingImportHref(meeting.id)]) {
        const reply = await get(server.origin, path);
        assert.equal(reply.status, 200, path);
        assert.ok(!reply.body.includes("<script>"), path);
        assert.ok(!reply.body.includes("<alert>"), path);
        assert.ok(reply.body.includes(escapeHtml("Eng <script>")), path);
      }
      const projectPage = await get(server.origin, projectImportHref(project.id));
      assert.ok(projectPage.body.includes(escapeHtml('P <"q">')));
      // The link itself carries the encoded id, never the raw stored text.
      assert.match(projectPage.body, new RegExp(`href="/projects/${encodeURIComponent(project.id)}"`));
    } finally {
      await server.close();
      await store.close();
    }
  });

  it("answers a missing or malformed URL id as a missing record", async () => {
    const server = await running();
    try {
      for (const path of [
        engagementImportHref("engagement-999"),
        projectImportHref("project-999"),
        meetingImportHref("meeting-999"),
        "/engagements/%E0%A4%A/transcripts/import",
      ]) {
        const reply = await get(server.origin, path);
        assert.equal(reply.status, 404, path);
      }
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Submitting the rendered form over HTTP
// ---------------------------------------------------------------------------

describe("transcript import submissions", () => {
  it("creates a meeting from a pasted transcript in an engagement and shows the result", async () => {
    const server = await running();
    try {
      const before = counts(server.store);
      const { reply, form } = await submitPaste(
        server.origin,
        engagementImportHref(server.engagementId),
        new Map([
          ["title", "Kickoff <notes>"],
          ["date", "2026-02-02"],
          ["notes", "Agenda"],
          ["projectId", ""],
          [PASTE_CONTROL, "Alice: Hello there.\n\nBob: Hi."],
        ]),
      );
      // The browser sent the file control unselected, and no file was stored.
      assert.match(form, /<input type="file"[^>]*name="file"/);
      assert.equal(counts(server.store).sources, before.sources + 1);
      assert.equal(reply.status, 200);
      assert.equal(reply.headers["cache-control"], "no-store");
      const page = mainOf(reply.body);
      assert.match(page, /Transcript imported/);
      const after = counts(server.store);
      assert.equal(after.transcripts, before.transcripts + 1);
      assert.equal(after.meetings, before.meetings + 1);
      assert.equal(after.sources, before.sources + 1);

      const snapshot = server.store.snapshot();
      const created = snapshot.meetings.find((meeting) => meeting.title === "Kickoff <notes>");
      assert.ok(created !== undefined);
      assert.equal(created.engagementId, server.engagementId);
      assert.equal(created.clientId, server.clientId);
      assert.equal(created.projectId, undefined);
      assert.equal(created.date, "2026-02-02");
      assert.equal(created.notes, "Agenda");
      // The result links the created meeting and escapes its stored title.
      assert.match(page, new RegExp(`href="/meetings/${created.id}"`));
      assert.ok(page.includes(escapeHtml("2026-02-02 — Kickoff <notes>")));
      assert.ok(!page.includes("<notes>"));

      // The created meeting is reachable and its history shows it.
      const detail = await get(server.origin, `/meetings/${created.id}`);
      assert.equal(detail.status, 200);
      const history = await get(server.origin, `/engagements/${server.engagementId}`);
      assert.match(history.body, new RegExp(`href="/meetings/${created.id}"`));
    } finally {
      await server.close();
    }
  });

  it("creates a meeting in the URL project from a submitted file", async () => {
    const server = await running();
    try {
      const { reply } = await submitRendered(
        server.origin,
        projectImportHref(server.projectId),
        new Map<string, string | { readonly filename: string; readonly body: string }>([
          ["title", "Project kickoff"],
          ["date", "2026-02-03"],
          ["notes", ""],
          ["projectId", server.projectId],
          [FILE_CONTROL, { filename: "transcript.txt", body: "File words here." }],
        ]),
      );
      assert.equal(reply.status, 200);
      const snapshot = server.store.snapshot();
      const created = snapshot.meetings.find((meeting) => meeting.title === "Project kickoff");
      assert.ok(created !== undefined);
      assert.equal(created.projectId, server.projectId);
      assert.equal(created.engagementId, server.engagementId);
      const transcript = (snapshot.transcripts ?? []).find((entry) => entry.meetingId === created.id);
      assert.ok(transcript !== undefined);
      assert.equal(transcript.sources[0]?.format, "txt");
      assert.equal(transcript.sources[0]?.filename, "transcript.txt");
      assert.match(mainOf(reply.body), new RegExp(`href="/projects/${server.projectId}"`));
    } finally {
      await server.close();
    }
  });

  it("attaches the first transcript once to a manual meeting, keeping its metadata", async () => {
    const server = await running();
    try {
      const before = server.store.snapshot().meetings.find((meeting) => meeting.id === server.meetingId);
      const { reply } = await submitPaste(
        server.origin,
        meetingImportHref(server.meetingId),
        new Map([[PASTE_CONTROL, "First attachment words."]]),
      );
      assert.equal(reply.status, 200);
      const after = server.store.snapshot().meetings.find((meeting) => meeting.id === server.meetingId);
      assert.deepEqual(after, before, "the meeting's own metadata is kept");
      const transcript = (server.store.snapshot().transcripts ?? []).find((entry) => entry.meetingId === server.meetingId);
      assert.ok(transcript !== undefined, "the meeting holds its first transcript");
      assert.match(mainOf(reply.body), new RegExp(`href="/meetings/${server.meetingId}"`));
      assert.match(mainOf(reply.body), /Open the meeting/);
    } finally {
      await server.close();
    }
  });

  it("explains an exact repeat on a transient result page", async () => {
    const server = await running();
    try {
      const entries = new Map([
        ["title", "Repeat"],
        ["date", "2026-03-01"],
        [PASTE_CONTROL, "Same words."],
      ]);
      const first = await submitPaste(server.origin, engagementImportHref(server.engagementId), entries);
      assert.equal(first.reply.status, 200);
      const created = server.store.snapshot().meetings.find((meeting) => meeting.title === "Repeat");
      assert.ok(created !== undefined);
      const before = counts(server.store);
      const repeat = await submitPaste(server.origin, engagementImportHref(server.engagementId), entries);
      assert.equal(repeat.reply.status, 200);
      assert.deepEqual(counts(server.store), before, "a repeat writes nothing");
      const page = mainOf(repeat.reply.body);
      assert.match(page, /canonical meeting is reused/);
      assert.match(page, /exact original is already stored and was reused/);
      assert.match(page, new RegExp(`href="/meetings/${created.id}"`));
      // No redirect carries the result: the page is the response itself.
      assert.equal(repeat.reply.headers.location, undefined);
    } finally {
      await server.close();
    }
  });

  it("repeats an attachment aimed at another meeting and links the canonical meeting", async () => {
    const server = await running();
    try {
      const first = await submitPaste(
        server.origin,
        engagementImportHref(server.engagementId),
        new Map([
          ["title", "Canonical"],
          ["date", "2026-03-02"],
          [PASTE_CONTROL, "Canonical words."],
        ]),
      );
      assert.equal(first.reply.status, 200);
      const canonical = server.store.snapshot().meetings.find((meeting) => meeting.title === "Canonical");
      assert.ok(canonical !== undefined);
      const otherBefore = server.store.snapshot().meetings.find((meeting) => meeting.id === server.otherMeetingId);
      const before = counts(server.store);
      const repeat = await submitPaste(
        server.origin,
        meetingImportHref(server.otherMeetingId),
        new Map([[PASTE_CONTROL, "Canonical words."]]),
      );
      assert.equal(repeat.reply.status, 200);
      const page = mainOf(repeat.reply.body);
      // The target stayed unchanged, and the canonical meeting is explained and linked.
      assert.deepEqual(server.store.snapshot().meetings.find((meeting) => meeting.id === server.otherMeetingId), otherBefore);
      assert.deepEqual(counts(server.store), before);
      assert.match(page, /target meeting .* was left unchanged/);
      assert.match(page, new RegExp(`href="/meetings/${canonical.id}"`));
      assert.ok(!page.includes(`href="/meetings/${server.otherMeetingId}"`) || page.includes("left unchanged"));
    } finally {
      await server.close();
    }
  });

  it("refuses a submission that carries both inputs or neither, with guidance and no write", async () => {
    const server = await running();
    try {
      const before = counts(server.store);
      const path = engagementImportHref(server.engagementId);
      const cases: { readonly title: string; readonly entries: ReadonlyMap<string, string | { readonly filename: string; readonly body: string }>; readonly unselectedFile: boolean }[] = [
        // Both a nonempty paste and a selected file.
        {
          title: "Both",
          entries: new Map<string, string | { readonly filename: string; readonly body: string }>([
            ["title", "Both"],
            ["date", "2026-04-01"],
            [PASTE_CONTROL, "Pasted words."],
            [FILE_CONTROL, { filename: "also.txt", body: "File words." }],
          ]),
          unselectedFile: false,
        },
        // Neither: a blank paste and the file control left unselected.
        {
          title: "Neither",
          entries: new Map<string, string | { readonly filename: string; readonly body: string }>([
            ["title", "Neither"],
            ["date", "2026-04-02"],
            [PASTE_CONTROL, ""],
            [FILE_CONTROL, ""],
          ]),
          unselectedFile: true,
        },
        // Neither at all: the source controls were not submitted.
        {
          title: "Nothing",
          entries: new Map<string, string | { readonly filename: string; readonly body: string }>([
            ["title", "Nothing"],
            ["date", "2026-04-03"],
          ]),
          unselectedFile: false,
        },
      ];
      for (const attempt of cases) {
        const { reply, form } = await submitRendered(server.origin, path, attempt.entries, {
          unselectedFile: attempt.unselectedFile,
        });
        assert.equal(reply.status, 400, attempt.title);
        const page = mainOf(reply.body);
        assert.match(page, /exactly one transcript/i);
        assert.match(page, /never both and never neither/);
        // The corrected form is a native multipart form again, and its submitted
        // title is kept.
        assert.match(formOf(reply.body), /enctype="multipart\/form-data"/);
        assert.ok(page.includes(`value="${escapeHtml(attempt.title)}"`));
      }
      assert.deepEqual(counts(server.store), before, "no meeting or source was created");
    } finally {
      await server.close();
    }
  });

  it("refuses an invalid date and shows the submitted value back for correction", async () => {
    const server = await running();
    try {
      const before = counts(server.store);
      const reply = (await submitPaste(
        server.origin,
        engagementImportHref(server.engagementId),
        new Map([
          ["title", "Bad date"],
          ["date", "2026-02-30"],
          [PASTE_CONTROL, "Words."],
        ]),
      )).reply;
      assert.equal(reply.status, 400);
      const page = mainOf(reply.body);
      assert.match(page, /real calendar date/);
      assert.ok(page.includes('value="2026-02-30"'));
      assert.ok(page.includes('aria-invalid="true"'));
      assert.match(page, /<textarea[^>]*name="paste"[^>]*>Words\.<\/textarea>/);
      assert.deepEqual(counts(server.store), before);
      // A missing title is refused like a missing date.
      const noTitle = (await submitPaste(
        server.origin,
        engagementImportHref(server.engagementId),
        new Map([
          ["date", "2026-05-01"],
          [PASTE_CONTROL, "Words."],
        ]),
      )).reply;
      assert.equal(noTitle.status, 400);
      assert.match(mainOf(noTitle.body), /needs a title and a date/);
      assert.deepEqual(counts(server.store), before);
    } finally {
      await server.close();
    }
  });

  it("refuses a foreign project selection with guidance and no write", async () => {
    const server = await running();
    try {
      const before = counts(server.store);
      for (const projectId of [server.foreignProjectId, "project-999"]) {
        const reply = (await submitPaste(
          server.origin,
          engagementImportHref(server.engagementId),
          new Map([
            ["title", "Foreign"],
            ["date", "2026-06-01"],
            ["projectId", projectId],
            [PASTE_CONTROL, "Fresh words."],
          ]),
        )).reply;
        assert.equal(reply.status, 400, projectId);
        const page = mainOf(reply.body);
        assert.match(page, /projectId/);
        // The rejected choice stays visible and marked, so it can be corrected.
        assert.ok(page.includes(`value="${escapeHtml(projectId)}"`));
        assert.match(page, /not a valid choice/);
      }
      assert.deepEqual(counts(server.store), before);
    } finally {
      await server.close();
    }
  });

  it("refuses an unsupported extension and an oversized file with guidance and no write", async () => {
    const server = await running();
    try {
      const before = counts(server.store);
      const unsupported = (await submitRendered(
        server.origin,
        engagementImportHref(server.engagementId),
        new Map<string, string | { readonly filename: string; readonly body: string }>([
          ["title", "Unsupported"],
          ["date", "2026-06-02"],
          [FILE_CONTROL, { filename: "notes.exe", body: "Some bytes." }],
        ]),
      )).reply;
      assert.equal(unsupported.status, 400);
      const page = mainOf(unsupported.body);
      assert.match(page, /not a supported format/);
      assert.match(page, /import pasted text, or a UTF-8 \.txt or \.md file/);
      assert.deepEqual(counts(server.store), before);

      // An oversize file part is refused by the multipart decoder with its own
      // guidance, before any handler ran.
      const oversized = (await submitRendered(
        server.origin,
        projectImportHref(server.projectId),
        new Map<string, string | { readonly filename: string; readonly body: string }>([
          [FILE_CONTROL, { filename: "big.txt", body: "a".repeat(MAX_FILE_BYTES + 1) }],
        ]),
      )).reply;
      assert.equal(oversized.status, 413);
      assert.match(oversized.body, /at most 10485760 bytes/);
      assert.match(oversized.body, /nothing was truncated/i);
      assert.deepEqual(counts(server.store), before, "no meeting or source was created");
    } finally {
      await server.close();
    }
  });

  it("refuses an oversize whole body with the total limit and creates nothing", async () => {
    const server = await running();
    try {
      const before = counts(server.store);
      // A paste just past the 15 MiB body total: the decoder refuses it as too
      // large, naming the whole-submission limit.
      const reply = (await submitRendered(
        server.origin,
        engagementImportHref(server.engagementId),
        new Map<string, string | { readonly filename: string; readonly body: string }>([
          [PASTE_CONTROL, "a".repeat(MAX_MULTIPART_BYTES)],
        ]),
      )).reply;
      assert.equal(reply.status, 413);
      assert.match(reply.body, /too large/);
      assert.match(reply.body, new RegExp(`at most ${MAX_MULTIPART_BYTES} bytes|at most ${MAX_MULTIPART_BYTES / 1024 / 1024} MiB`));
      assert.deepEqual(counts(server.store), before);
    } finally {
      await server.close();
    }
  });

  it("refuses an attachment of different content to a meeting that already holds one", async () => {
    const server = await running();
    try {
      const first = (await submitPaste(
        server.origin,
        meetingImportHref(server.meetingId),
        new Map([[PASTE_CONTROL, "First words."]]),
      )).reply;
      assert.equal(first.status, 200);
      const before = counts(server.store);
      const second = (await submitPaste(
        server.origin,
        meetingImportHref(server.meetingId),
        new Map([[PASTE_CONTROL, "Different words."]]),
      )).reply;
      assert.equal(second.status, 400);
      assert.match(mainOf(second.body), /an attachment is never replaced/);
      assert.deepEqual(counts(server.store), before);
    } finally {
      await server.close();
    }
  });

  it("refuses a non-multipart body on an import POST as a media type mismatch", async () => {
    const server = await running();
    try {
      const before = counts(server.store);
      // The rendered form is multipart; a body sent with the wrong encoding to a
      // marked slot is refused by the shell's media check.
      const reply = (await submitRendered(
        server.origin,
        engagementImportHref(server.engagementId),
        new Map<string, string | { readonly filename: string; readonly body: string }>([
          ["title", "x"],
          ["date", "2026-01-01"],
          [PASTE_CONTROL, "Words"],
        ]),
        { contentTypeOverride: "application/x-www-form-urlencoded" },
      )).reply;
      assert.equal(reply.status, 415);
      assert.deepEqual(counts(server.store), before);
    } finally {
      await server.close();
    }
  });

  it("resolves the URL record through the scoped handler before rendering the refusal form", async () => {
    // The URL names a record that does not exist when the page's snapshot is
    // read: the scoped handler resolves it inside the store's own queue turn,
    // after an earlier queued write created it. The POST is handed the kind and
    // raw id first, so it commits instead of answering 404 from the stale page.
    const store = await openStore(tempDir());
    const server = await startServer({ store, port: 0, routes: registerRoutes(store) });
    try {
      const fixture = await seed(store);
      // A queued write creates an engagement; the import's URL is resolved
      // against the draft that write commits, not the snapshot read before it.
      const creating = store.createEngagement({ clientId: fixture.clientId, name: "Queued" });
      const engagement = await creating;
      const reply = (await submitPaste(
        server.origin,
        engagementImportHref(engagement.id),
        new Map([
          ["title", "Queued import"],
          ["date", "2026-07-02"],
          [PASTE_CONTROL, "Queued words."],
        ]),
      )).reply;
      assert.equal(reply.status, 200);
      assert.ok(store.snapshot().meetings.some((meeting) => meeting.title === "Queued import"));
    } finally {
      await server.close();
      await store.close();
    }
  });

  it("commits through the registered route table built over one borrowed service", async () => {
    // The application wires the routes over one transcript service that
    // borrows the same open store, so an import shares the store's own queue.
    const store = await openStore(tempDir());
    const server = await startServer({ store, port: 0, routes: registerRoutes(store) });
    try {
      const fixture = await seed(store);
      const reply = (await submitPaste(
        server.origin,
        engagementImportHref(fixture.engagementId),
        new Map([
          ["title", "Through the table"],
          ["date", "2026-07-01"],
          [PASTE_CONTROL, "Table words."],
        ]),
      )).reply;
      assert.equal(reply.status, 200);
      assert.ok(store.snapshot().meetings.some((meeting) => meeting.title === "Through the table"));
      assert.ok((store.snapshot().transcripts ?? []).length > 0);
    } finally {
      await server.close();
      await store.close();
    }
  });

  it("serves the import forms through startApplication and its one owned store", async () => {
    const dir = tempDir();
    const app = await startApplication({ dataDirectory: dir, port: 0 });
    try {
      // The application owns one store; a client is created through it, and its
      // engagement's import form is served over the application's own URL.
      // The creation forms are POST-only under the collection paths; their GET
      // forms are read to carry the hidden parent the form submits.
      const clientId = await createThroughForm(app.url, "/clients/new", "/clients/new", {
        name: "Owned",
        background: "",
        contacts: "",
        stakeholders: "",
        requirements: "",
        objectives: "",
      });
      const engagementId = await createThroughForm(
        app.url,
        `/clients/${clientId}/engagements/new`,
        "/engagements/new",
        { clientId, name: "Owned Eng", objectives: "", status: "planned" },
      );
      const form = await get(app.url, engagementImportHref(engagementId));
      assert.equal(form.status, 200);
      const reply = (await submitPaste(
        app.url,
        engagementImportHref(engagementId),
        new Map([
          ["title", "Owned import"],
          ["date", "2026-08-01"],
          [PASTE_CONTROL, "Owned words."],
        ]),
      )).reply;
      assert.equal(reply.status, 200);
      assert.match(mainOf(reply.body), /Transcript imported/);
      assert.match(mainOf(reply.body), new RegExp(`href="/meetings/meeting-`));
    } finally {
      await app.close();
    }
  });

  it("shows the URL project on a project create form even when the store is reopened", async () => {
    // The form is derived from the snapshot, never from a stored draft: a
    // reopened store serves the same preselection.
    const dir = tempDir();
    let store = await openStore(dir);
    const client = await store.createClient({ name: "Reopen" });
    const engagement = await store.createEngagement({ clientId: client.id, name: "R" });
    const project = await store.createProject({ engagementId: engagement.id, name: "R project" });
    let server = await startServer({ store, port: 0, routes: registerRoutes(store) });
    try {
      const first = await get(server.origin, projectImportHref(project.id));
      assert.equal(selectedOption(first.body, "projectId"), project.id);
    } finally {
      await server.close();
      await store.close();
    }
    store = await openStore(dir);
    server = await startServer({ store, port: 0, routes: registerRoutes(store) });
    try {
      const reopened = await get(server.origin, projectImportHref(project.id));
      assert.equal(reopened.status, 200);
      assert.equal(selectedOption(reopened.body, "projectId"), project.id);
    } finally {
      await server.close();
      await store.close();
    }
  });
});
