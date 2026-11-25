/**
 * Meeting sources: the list on a meeting's detail page and the three read-only
 * GETs that serve one committed source (its original, its extracted text and its
 * passages). Every HTTP test starts a real loopback server over a real on-disk
 * store, so the requests and responses are the ones the application sends.
 *
 * The binary download is compared byte for byte with the original a client
 * pasted, including a BOM and mixed line endings, and every file download is
 * compared byte for byte with the fixture bytes. Each source's three links are
 * followed from the meeting detail page's own markup, not from a helper that
 * builds URLs, so a missing, mislabeled or misdirected link fails.
 *
 * Failures of a referenced original are injected through the store's own
 * original-file adapter (`originalsFs`), the interface `openStore` accepts,
 * never by mocking a module or changing the environment.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { escapeHtml, renderPage } from "../src/html.ts";
import { registerRoutes } from "../src/index.ts";
import { matchMeetingPath, meetingRoutes, routeForMeetingPattern } from "../src/meeting-pages.ts";
import { startServer } from "../src/server.ts";
import { openStore, type Snapshot, type Store, type TranscriptSource } from "../src/store.ts";
import { transcriptService, type TranscriptSourceRead } from "../src/transcript-store.ts";
import type { OriginalFileSystem } from "../src/transcript-files.ts";
import { importPdf } from "../src/transcript-pdf.ts";
import {
  headerSafeBasename,
  matchTranscriptSourcePath,
  meetingSourceSection,
  passagesSection,
  resolveSourceTarget,
  sourceHref,
  transcriptSourceRoutes,
  encodeSegment,
  decodeSegment,
  recordSegment,
} from "../src/transcript-source-pages.ts";
import { extractBlocks, importDocx } from "../src/transcript-docx.ts";
import type { Passage } from "../src/transcript.ts";
import { docxBytes } from "./fixtures/transcript-docx.ts";
import { pdfBytes } from "./fixtures/transcript-pdf.ts";

// ---------------------------------------------------------------------------
// Fixtures and HTTP helpers
// ---------------------------------------------------------------------------

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "transcript-source-pages-"));
  roots.push(dir);
  return dir;
}

interface Running {
  readonly origin: string;
  readonly port: number;
  readonly store: Store;
  readonly directory: string;
  close(): Promise<void>;
}

/** Start a server over a real on-disk store, on an ephemeral port. */
async function running(
  directory = tempDir(),
  options: Parameters<typeof openStore>[1] = {},
): Promise<Running> {
  const store = await openStore(directory, options);
  const server = await startServer({ store, port: 0, routes: registerRoutes(store) });
  return {
    origin: server.origin,
    port: server.port,
    store,
    directory,
    async close() {
      await server.close();
      await store.close();
    },
  };
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  /** The response body as raw bytes, exactly as sent. */
  readonly bytes: Buffer;
  readonly body: string;
}

/** Send a request over loopback HTTP and keep the body bytes. */
function send(base: string, path: string, method = "GET", origin?: string): Promise<Reply> {
  const url = new URL(base);
  const headers: Record<string, string | number> = {
    host: url.host,
    "content-length": 0,
  };
  if (method === "POST") {
    headers.origin = origin ?? url.origin;
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: Number(url.port), method, path, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const bytes = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            bytes,
            body: bytes.toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const encoder = new TextEncoder();

/** Create one client and engagement and return their ids. */
async function hierarchy(store: Store): Promise<{ clientId: string; engagementId: string }> {
  const client = await store.createClient({ name: "Acme" });
  const engagement = await store.createEngagement({ clientId: client.id, name: "Eng" });
  return { clientId: client.id, engagementId: engagement.id };
}

/** One imported source, with the meeting and transcript it was committed to. */
interface Imported {
  readonly meetingId: string;
  readonly transcriptId: string;
  readonly sourceId: string;
  readonly sourceIds: readonly string[];
}

/** Import one raw source for one meeting through the borrowed service. */
async function importFor(
  store: Store,
  meetingId: string,
  input: Parameters<ReturnType<typeof transcriptService>["importTranscript"]>[0],
): Promise<Imported> {
  const service = transcriptService(store);
  const result = await service.importTranscript(input, { meetingId });
  return {
    meetingId: result.meeting.id,
    transcriptId: result.transcript.id,
    sourceId: result.sourceIds[result.sourceIds.length - 1],
    sourceIds: result.sourceIds,
  };
}

/** A meeting created directly (notes-only, no transcript). */
async function notesMeeting(
  store: Store,
  parents: { clientId: string; engagementId: string },
  title = "Notes only",
  date = "2026-03-04",
): Promise<string> {
  const meeting = await store.createMeeting({ ...parents, title, date, notes: "Some notes." });
  return meeting.id;
}

/** The three view paths of one source, from the production helper. */
function views(
  meetingId: string,
  transcriptId: string,
  sourceId: string,
): { original: string; text: string; passages: string } {
  return {
    original: sourceHref(meetingId, transcriptId, sourceId, "original"),
    text: sourceHref(meetingId, transcriptId, sourceId, "text"),
    passages: sourceHref(meetingId, transcriptId, sourceId, "passages"),
  };
}

/**
 * The hrefs of every source row on a meeting detail page, read from the page's
 * own markup. Each row is the list item that carries a source's filename; its
 * three anchors are returned in the order the page renders them.
 */
interface DetailRow {
  readonly filename: string;
  readonly format: string;
  readonly viewLinks: Record<"original" | "text" | "passages", string>;
}

async function detailRows(server: Running, meetingId: string): Promise<DetailRow[]> {
  const detail = await send(server.origin, `/meetings/${encodeURIComponent(meetingId)}`);
  assert.equal(detail.status, 200);
  const rows: DetailRow[] = [];
  const items = [...detail.body.matchAll(/<li class="card">(.*?)<\/li>/gs)].map((match) => match[1]);
  for (const body of items) {
    const filename = /<span class="source-filename">(.*?)<\/span>/.exec(body)?.[1];
    if (filename === undefined) continue;
    // The row's visible format is read from the page's own markup, so a row
    // that drops or mislabels the format is not silently accepted.
    const format = /<span class="source-format">(.*?)<\/span>/.exec(body)?.[1];
    assert.notEqual(format, undefined, "a row shows its stored format");
    const anchors = [...body.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)];
    const byLabel = new Map(anchors.map((match) => [match[2], match[1]]));
    const original = byLabel.get("Download original");
    const text = byLabel.get("Extracted text");
    const passages = byLabel.get("Passages");
    assert.notEqual(original, undefined, "a row links its original");
    assert.notEqual(text, undefined, "a row links its text");
    assert.notEqual(passages, undefined, "a row links its passages");
    rows.push({
      filename: unescapeHtml(filename),
      format: unescapeHtml(format!),
      viewLinks: { original: original!, text: text!, passages: passages! },
    });
  }
  return rows;
}

/** Undo the HTML escaping of a rendered text so it compares with stored text. */
function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Follow the three links a detail row shows and return each reply. */
async function followRowLinks(server: Running, row: DetailRow): Promise<Record<"original" | "text" | "passages", Reply>> {
  const out: Record<string, Reply> = {};
  for (const view of ["original", "text", "passages"] as const) {
    const reply = await send(server.origin, row.viewLinks[view]);
    assert.equal(reply.status, 200, `${row.filename} ${view} ${row.viewLinks[view]}`);
    out[view] = reply;
  }
  return out as Record<"original" | "text" | "passages", Reply>;
}

/** The single row of one meeting's detail page, asserting it is the only one. */
async function onlyRow(server: Running, meetingId: string): Promise<DetailRow> {
  const rows = await detailRows(server, meetingId);
  assert.equal(rows.length, 1, "the meeting lists exactly one source");
  return rows[0];
}

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

describe("transcript source paths: exact fixed shapes", () => {
  it("matches only the three exact source views and keeps the meeting paths", () => {
    const base =
      `/meetings/${encodeSegment("meeting-1")}` +
      `/transcripts/${encodeSegment("sha256:abc")}` +
      `/sources/${encodeSegment("src-1")}`;
    for (const view of ["original", "text", "passages"] as const) {
      const matched = matchTranscriptSourcePath(`${base}/${view}`);
      assert.notEqual(matched, null);
      assert.equal(matched?.view, view);
      // The matcher keeps the raw, still-encoded segments; only a handler
      // decodes them.
      assert.equal(matched?.meetingId, encodeSegment("meeting-1"));
      assert.equal(matched?.transcriptId, encodeSegment("sha256:abc"));
      assert.equal(matched?.sourceId, encodeSegment("src-1"));
      assert.equal(matched?.pattern, `/meetings/:id/transcripts/:transcriptId/sources/:sourceId/${view}`);
    }
    // Another view, a missing segment, an extra segment and a query keep it a
    // non-match (the query is stripped before matching).
    for (const path of [
      `${base}/raw`,
      `${base}`,
      `${base}/original/extra`,
      `/meetings/${encodeSegment("meeting-1")}/transcripts/${encodeSegment("sha256:abc")}/sources/original`,
      "/engagements/engagement-1/transcripts/import",
      // An inherited property name of an ordinary object names no view.
      `${base}/constructor`,
      `${base}/toString`,
      `${base}/__proto__`,
      `${base}/hasOwnProperty`,
      // A path without its leading separator does not match, and no empty
      // segment is accepted, so no leading component is silently discarded.
      base.slice(1) + "/text",
      `/meetings//transcripts/${encodeSegment("sha256:abc")}/sources/${encodeSegment("src-1")}/text`,
      `${base}//text`,
    ]) {
      assert.equal(matchTranscriptSourcePath(path), null, path);
    }
    assert.notEqual(matchTranscriptSourcePath(`${base}/text?x=1`), null);
    // The ordinary meeting paths are still matched by the meeting table.
    assert.equal(matchMeetingPath(`${base}/text`), null);
    assert.notEqual(matchMeetingPath(`/meetings/${encodeSegment("meeting-1")}`), null);
    assert.notEqual(matchMeetingPath(`/meetings/${encodeSegment("meeting-1")}/edit`), null);
  });

  it("encodes each id as one reversible, collision-free segment that survives URL resolution", () => {
    // The encoding is one segment for any stored id, including a stored `.`,
    // `..`, a slash, a query or a fragment character, a dot and supplementary
    // characters. A browser's URL resolution against the canonical origin keeps
    // the segment exactly as written.
    const ids = [".", "..", "a/b", "a?b", "a#b", "p.1", "p_1", "p😀", "p😁", "\u0000", "", "sha256:abc"];
    // `recordSegment` refuses the empty id (a stored id is never blank) and
    // otherwise equals the reversible encoding.
    ids.filter((id) => id !== "").forEach((id) => assert.equal(recordSegment(id), encodeSegment(id), id));
    assert.throws(() => recordSegment(""), /No record/);
    for (const id of ids) {
      const encoded = encodeSegment(id);
      assert.match(encoded, /^~[A-Za-z0-9_-]*$/);
      assert.equal(encoded.includes("/"), false, id);
      // Every nonempty id round-trips; the blank encoding names no record.
      if (id === "") assert.throws(() => decodeSegment(encoded), /No record/);
      else assert.equal(decodeSegment(encoded), id, id);
    }
    // Distinct ids never share an encoding.
    const encodings = ids.map((id) => encodeSegment(id));
    assert.equal(new Set(encodings).size, encodings.length, "no two ids collide");
    // A generated href survives the browser's own URL resolution: the segment
    // keeps its exact spelling and the ids decode back to the stored ones.
    const href = sourceHref(".", "..", "p.", "text");
    const resolved = new URL(href, "http://127.0.0.1:3000");
    assert.equal(resolved.pathname, href, "a dot id is never normalised away");
    const parts = resolved.pathname.split("/");
    assert.equal(parts.length, 8);
    assert.equal(decodeSegment(parts[2]), ".");
    assert.equal(decodeSegment(parts[4]), "..");
    assert.equal(decodeSegment(parts[6]), "p.");
    // Anything but the exact encoding is refused, decoded no further.
    // The bare prefix `~` is refused: a record id is never blank, so the empty
    // encoding names no record.
    assert.throws(() => decodeSegment("~"), /No record/);
    for (const raw of ["meeting-1", "", "~", "%7E", "~!!!!", encodeSegment("a") + "=", "~YQB", "~a"]) {
      assert.throws(() => decodeSegment(raw), /No record/, raw);
    }
  });

  it("keeps a header-safe basename from an unsafe stored filename", () => {
    assert.equal(headerSafeBasename("report.pdf"), "report.pdf");
    assert.equal(headerSafeBasename('evil"; filename="x.txt'), "evil filename x.txt");
    assert.equal(headerSafeBasename("../../etc/passwd"), "passwd");
    assert.equal(headerSafeBasename("C:\\temp\\notes.txt"), "notes.txt");
    assert.equal(headerSafeBasename("quote\"s.txt"), "quote s.txt");
    assert.equal(headerSafeBasename(""), "download");
    assert.equal(headerSafeBasename(".."), "download");
    assert.equal(headerSafeBasename("tab\there.txt"), "tab here.txt");
  });

  it("names each stored passage its own anchor from a lossless encoding", () => {
    // Two stored passage ids that a character-replacing encoding would collapse
    // to the same value keep distinct anchors, and their links select their own
    // rows. `passageAnchorId` is exercised through the rendered page below; here
    // distinct ids are checked directly through the rendered markup.
    const anchorOf = (id: string): string =>
      anchorIn(markedSourceRead([{ id, text: "x" }]));
    assert.notEqual(anchorOf("p.1"), anchorOf("p_1"));
    assert.notEqual(anchorOf("p-1"), anchorOf("p_1"));
    assert.notEqual(anchorOf("p 1"), anchorOf("p_1"));
    assert.equal(anchorOf("p_1"), anchorOf("p_1"));
    // A supplementary character keeps both surrogate halves, so two ids that
    // differ only in it keep distinct anchors.
    assert.notEqual(anchorOf("p😀"), anchorOf("p😁"));
  });
});

// ---------------------------------------------------------------------------
// A detached source read for pure rendering checks
// ---------------------------------------------------------------------------

/**
 * The 1-based line and column of a UTF-16 offset in a text, counting from one:
 * a line break ends its line, and the first character of the next line is
 * column 1.
 */
function positionOf(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      column = 1;
    } else if (text[index] !== "\r") {
      column += 1;
    }
  }
  return { line, column };
}

/** A detached source read with stored passages at exact offsets. */
function markedSourceRead(
  passages: readonly { readonly id: string; readonly text: string; readonly page?: number }[],
  options: {
    format?: TranscriptSource["format"];
    filename?: string;
    sourceId?: string;
    transcriptId?: string;
    meetingId?: string;
  } = {},
): TranscriptSourceRead {
  const sourceId = options.sourceId ?? "src-1";
  const transcriptId = options.transcriptId ?? "sha256:" + "a".repeat(64);
  const meetingId = options.meetingId ?? "meeting-1";
  const extractedText = passages.map((passage) => passage.text).join("\n\n");
  let cursor = 0;
  const stored: Passage[] = passages.map((passage) => {
    const start = cursor;
    const end = start + passage.text.length;
    const range = { start, end };
    // The stored location is the exact 1-based line and column of the start,
    // computed from the very text the offsets index into (so the second passage
    // after one blank line sits at line 3, column 1).
    const position = positionOf(extractedText, start);
    const location = { start, end, line: position.line, column: position.column };
    cursor = end + 2; // two line breaks between stored passages
    return {
      id: passage.id,
      sourceId,
      range,
      location,
      text: passage.text,
      ...(passage.page === undefined ? {} : { page: passage.page }),
    };
  });
  return {
    transcriptId,
    engagementId: "engagement-1",
    meetingId,
    sourceId,
    format: options.format ?? "paste",
    filename: options.filename ?? "a.txt",
    originalBytes: encoder.encode(extractedText),
    originalSha256: "b".repeat(64),
    extractedText,
    passages: stored,
  };
}

/** The HTML `id` of the row whose passage text is exactly `text`. */
function anchorIn(read: TranscriptSourceRead): string {
  const section = passagesSection(read, read.meetingId);
  const first = /<li class="passage" id="([^"]+)">/.exec(section.body);
  assert.notEqual(first, null, "the page renders the passage's row");
  return first![1];
}

/** The href of the row whose passage text is exactly `text`. */
function linkForText(read: TranscriptSourceRead, text: string): string {
  const section = passagesSection(read, read.meetingId);
  const rows = section.body.split('<li class="passage"').slice(1);
  for (const row of rows) {
    if (row.includes(`<p class="passage-text">${escapeHtml(text)}</p>`)) {
      const href = /<a class="passage-link" href="([^"]+)">/.exec(row)?.[1];
      if (href !== undefined) return href;
    }
  }
  assert.fail(`no row with passage text ${JSON.stringify(text)}`);
}

/** The HTML `id` of the row whose passage text is exactly `text`. */
function anchorIdForText(read: TranscriptSourceRead, text: string): string {
  const section = passagesSection(read, read.meetingId);
  const rows = section.body.split('<li class="passage"').slice(1);
  for (const row of rows) {
    if (row.includes(`<p class="passage-text">${escapeHtml(text)}</p>`)) {
      const id = /^ id="([^"]+)">/.exec(row)?.[1];
      if (id !== undefined) return id;
    }
  }
  assert.fail(`no row with passage text ${JSON.stringify(text)}`);
}

// ---------------------------------------------------------------------------
// Original, text and passages
// ---------------------------------------------------------------------------

describe("transcript source views: original, text and passages", () => {
  it("follows all three links for a pasted source and compares the download byte for byte", async () => {
    const server = await running();
    try {
      const parents = await hierarchy(server.store);
      const meetingId = await notesMeeting(server.store, parents, "Kickoff", "2026-01-02");
      // A BOM and mixed line endings: the bytes are exactly what the client pasted.
      const pasted = "\uFEFFAlice: Hello there.\r\n\r\nBob: Hi.\n\nAlice: Fine.\t";
      const imported = await importFor(server.store, meetingId, { kind: "paste", text: pasted });
      const row = await onlyRow(server, meetingId);
      assert.equal(row.filename, "Pasted text");
      const replies = await followRowLinks(server, row);

      // The binary download is the pasted original, byte for byte.
      assert.deepEqual(new Uint8Array(replies.original.bytes), encoder.encode(pasted));
      assert.equal(replies.original.headers["content-type"], "application/octet-stream");
      assert.equal(replies.original.headers["content-length"], String(encoder.encode(pasted).byteLength));
      assert.equal(replies.original.headers["x-content-type-options"], "nosniff");
      assert.equal(replies.original.headers["cache-control"], "no-store");
      assert.equal(replies.original.headers["content-disposition"], 'attachment; filename="Pasted text"');

      // The extracted text is exact, as UTF-8, with no added newline.
      assert.equal(replies.text.headers["content-type"], "text/plain; charset=utf-8");
      assert.equal(replies.text.headers["content-length"], String(encoder.encode(pasted).byteLength));
      assert.deepEqual(new Uint8Array(replies.text.bytes), encoder.encode(pasted));
      assert.equal(replies.text.body, pasted);
      assert.equal(replies.text.body.endsWith("\n"), false);

      // Passages are served as an HTML page inside the shared shell with one
      // anchor per stored passage.
      assert.match(String(replies.passages.headers["content-type"]), /^text\/html/);
      assert.match(String(replies.passages.headers["content-security-policy"]), /default-src 'none'/);
      // The passages page sets its own nosniff header, from the route's page
      // headers through the shell's forwarding of them.
      assert.equal(replies.passages.headers["x-content-type-options"], "nosniff");
      assert.ok(replies.passages.body.includes("<!doctype html>"));
      assert.ok(replies.passages.body.includes('<main'), "inside the shared application shell");
      assert.equal(replies.passages.body.includes('http-equiv="Content-Security-Policy"'), false);
      const read = await transcriptService(server.store).readSource(
        imported.transcriptId,
        imported.sourceId,
        parents.engagementId,
      );
      for (const passage of read.passages) {
        const href = linkForText(read, passage.text);
        const fragment = href.slice(href.indexOf("#") + 1);
        const anchor = anchorIdForText(read, passage.text);
        // The row is the one the link selects, and the fragment is its id once
        // the browser percent-decodes it.
        assert.equal(decodeURIComponent(fragment), anchor, passage.id);
        assert.ok(replies.passages.body.includes(`id="${escapeHtml(anchor)}"`), passage.id);
        assert.ok(replies.passages.body.includes(escapeHtml(passage.text)), passage.text);
        assert.ok(replies.passages.body.includes(`offsets ${passage.range.start}–${passage.range.end}`));
        assert.ok(replies.passages.body.includes(`line ${passage.location.line}, column ${passage.location.column}`));
      }
    } finally {
      await server.close();
    }
  });

  it("shows a recorded PDF page and labels a DOCX passage as an extracted block", async () => {
    const server = await running();
    try {
      const parents = await hierarchy(server.store);
      const pdfMeeting = await notesMeeting(server.store, parents, "Deck", "2026-02-02");
      const docxMeeting = await notesMeeting(server.store, parents, "Minutes", "2026-02-03");
      // Pages 1 and 3 carry text; page 2 is a blank page with no extraction.
      const pdfFixture = pdfBytes([["First page."], [], ["Third page."]]);
      const pdfOutcome = await importPdf(pdfFixture, "deck.pdf");
      if (!pdfOutcome.ok) assert.fail("the PDF fixture imports");
      await importFor(server.store, pdfMeeting, { kind: "file", bytes: pdfFixture, filename: "deck.pdf" });
      const pdfRow = await onlyRow(server, pdfMeeting);
      const pdfReplies = await followRowLinks(server, pdfRow);
      assert.equal(pdfReplies.original.headers["content-type"], "application/octet-stream");
      assert.equal(pdfReplies.original.headers["content-length"], String(pdfFixture.byteLength));
      assert.equal(pdfReplies.original.headers["content-disposition"], 'attachment; filename="deck.pdf"');
      // The PDF download is the fixture's bytes exactly.
      assert.deepEqual(new Uint8Array(pdfReplies.original.bytes), pdfFixture);
      assert.ok(pdfReplies.passages.body.includes("PDF page 1"));
      assert.ok(pdfReplies.passages.body.includes("PDF page 3"));
      // The blank page is skipped, never invented or renumbered.
      assert.equal(pdfReplies.passages.body.includes("PDF page 2"), false);
      assert.ok(pdfReplies.passages.body.indexOf("First page.") < pdfReplies.passages.body.indexOf("Third page."));
      assert.equal(pdfReplies.passages.body.includes("Extracted block"), false);
      // The extracted text is the parser's exact text, page 1 before page 3.
      assert.equal(pdfReplies.text.headers["content-type"], "text/plain; charset=utf-8");
      assert.ok(pdfReplies.text.body.indexOf("First page.") < pdfReplies.text.body.indexOf("Third page."));
      assert.equal(pdfReplies.text.body, pdfOutcome.result.extractedText);

      const docxFixture = docxBytes(["Intro block.", "Second block."]);
      await importFor(server.store, docxMeeting, {
        kind: "file",
        bytes: docxFixture,
        filename: 'minutes "1".docx',
      });
      const docxRow = await onlyRow(server, docxMeeting);
      const docxReplies = await followRowLinks(server, docxRow);
      // The stored filename is escaped in the page and header-safe in a header.
      assert.ok(docxReplies.passages.body.includes(escapeHtml('minutes "1".docx')));
      assert.equal(docxReplies.original.headers["content-disposition"], 'attachment; filename="minutes 1 .docx"');
      assert.equal(docxReplies.original.headers["content-length"], String(docxFixture.byteLength));
      // The DOCX download is the fixture's bytes exactly.
      assert.deepEqual(new Uint8Array(docxReplies.original.bytes), docxFixture);
      // Each passage names an extracted block; no page is invented for a DOCX.
      assert.ok(docxReplies.passages.body.includes("Extracted block"));
      assert.equal((docxReplies.passages.body.match(/Extracted block/g) ?? []).length, 2);
      assert.equal(docxReplies.passages.body.includes("PDF page"), false);
      assert.ok(docxReplies.text.body.includes("Intro block."));
      assert.ok(docxReplies.text.body.includes("Second block."));

      // The DOCX adapter's own passages carry no page: they are extracted blocks
      // of the document's block structure, never an invented page or paragraph.
      const blocks = extractBlocks("<ul><li>A list item</li><li>Another item</li></ul>");
      assert.deepEqual(blocks.map((block) => [block.kind, block.text]), [
        ["list_item", "A list item"],
        ["list_item", "Another item"],
      ]);
      const docx = await importDocx(docxFixture, "a.docx");
      assert.equal(docx.ok, true);
      assert.ok(docx.ok && docx.result.passages.every((candidate) => candidate.page === undefined));
    } finally {
      await server.close();
    }
  });

  it("lists every committed source by stored filename and format on the detail page", async () => {
    const server = await running();
    try {
      const parents = await hierarchy(server.store);
      const meetingId = await notesMeeting(server.store, parents, "Listed", "2026-04-04");
      await importFor(server.store, meetingId, { kind: "paste", text: "Shared words." });
      // A distinct original attaches as a second source to the same transcript.
      const second = await importFor(server.store, meetingId, { kind: "paste", text: " Shared words.\r\n" });
      const transcript = server.store.snapshot().transcripts!.find((candidate) => candidate.meetingId === meetingId)!;
      assert.equal(second.transcriptId, transcript.id);
      assert.equal(transcript.sources.length, 2);

      const rows = await detailRows(server, meetingId);
      assert.equal(rows.length, transcript.sources.length);
      for (const source of transcript.sources) {
        // Each row's own links name that source, not another.
        const textHref = sourceHref(meetingId, transcript.id, source.id, "text");
        const row = rows.find((candidate) => candidate.viewLinks.text === textHref);
        assert.notEqual(row, undefined, source.id);
        assert.equal(row!.filename, source.filename);
        // The row shows the stored format of that very source, escaped.
        assert.equal(row!.format, source.format, source.id);
        assert.equal(row!.viewLinks.original, sourceHref(meetingId, transcript.id, source.id, "original"));
        assert.equal(row!.viewLinks.passages, sourceHref(meetingId, transcript.id, source.id, "passages"));
        for (const view of ["original", "text", "passages"] as const) {
          assert.equal((await send(server.origin, row!.viewLinks[view])).status, 200, `${source.id} ${view}`);
        }
        // Each source's extracted text is its own, served from its own links.
        const text = await send(server.origin, row!.viewLinks.text);
        assert.equal(text.body, source.extractedText);
      }
    } finally {
      await server.close();
    }
  });

  it("lists nothing (and does not fail) for a meeting with no transcript", async () => {
    const server = await running();
    try {
      const parents = await hierarchy(server.store);
      const meetingId = await notesMeeting(server.store, parents);
      const detail = await send(server.origin, `/meetings/${meetingId}`);
      assert.equal(detail.status, 200);
      assert.ok(detail.body.includes("No transcript sources recorded yet."));
      // The meeting detail still offers its one import action, encoded.
      assert.match(detail.body, /href="[^"]*\/transcripts\/import"/);
      assert.equal((detail.body.match(/href="[^"]*\/transcripts\/import"/g) ?? []).length, 1);
      // A source path of an absent transcript is a 404, never a page or a read.
      const missing = await send(
        server.origin,
        `/meetings/${encodeSegment(meetingId)}/transcripts/${encodeSegment("sha256:" + "0".repeat(64))}/sources/${encodeSegment("source-1")}/text`,
      );
      assert.equal(missing.status, 404);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Escaping: filenames and passage text
// ---------------------------------------------------------------------------

describe("transcript source views: escaped text and quotes", () => {
  it("escapes a stored filename and passage text carrying quotes and markup", () => {
    const tricky = 'He said "hello" & <script>alert("x")</script> \'quoted\'';
    const read = markedSourceRead(
      [
        { id: "p.1", text: tricky },
        { id: "p_1", text: 'Second "one".' },
      ],
      { filename: 'notes "draft" & <b>.txt' },
    );
    const section = passagesSection(read, read.meetingId);
    // The exact stored text is present escaped, and never as raw markup.
    assert.ok(section.body.includes(escapeHtml(tricky)), "escaped passage text");
    assert.equal(section.body.includes(tricky), false, "raw passage text is never emitted");
    assert.equal(section.body.includes("<script>"), false, "no raw document markup");
    assert.ok(section.body.includes(escapeHtml('notes "draft" & <b>.txt')), "escaped filename");
    assert.equal(section.body.includes('notes "draft" & <b>.txt'), false, "raw filename is never emitted");

    // Distinct stored ids keep distinct anchors, and each link reaches its row.
    const firstHref = linkForText(read, tricky);
    const secondHref = linkForText(read, 'Second "one".');
    assert.notEqual(firstHref, secondHref);
    assert.equal(decodeURIComponent(firstHref.slice(firstHref.indexOf("#") + 1)), anchorIdForText(read, tricky));
    assert.equal(decodeURIComponent(secondHref.slice(secondHref.indexOf("#") + 1)), anchorIdForText(read, 'Second "one".'));
    // Both rows exist once, so each link selects exactly one row.
    const ids = [...section.body.matchAll(/<li class="passage" id="([^"]+)">/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, "every anchor id is unique within the source");
    assert.equal(ids.length, 2);
  });

  it("scopes anchors to their source and shows half-open offsets and 1-based positions", () => {
    const read = markedSourceRead([{ id: "p1", text: "First" }, { id: "p2", text: "Second" }], {
      sourceId: "src-a",
    });
    const other = markedSourceRead([{ id: "p1", text: "First" }], { sourceId: "src-b" });
    // The same passage id in two sources of one transcript never collides.
    assert.notEqual(anchorIdForText(read, "First"), anchorIdForText(other, "First"));
    const section = passagesSection(read, read.meetingId);
    assert.ok(section.body.includes("offsets 0–5 (UTF-16, start inclusive, end exclusive)"));
    assert.ok(section.body.includes("line 1, column 1"));
    // The second passage follows one blank line, so it is at line 3, column 1;
    // its half-open offsets index the very text it sits in, and its row shows
    // that stored position (never the row number).
    assert.ok(section.body.includes("offsets 7–13 (UTF-16, start inclusive, end exclusive)"));
    assert.ok(section.body.includes("line 3, column 1"));
    assert.equal(section.body.includes("line 2, column 1"), false, "no row is given its row number as a line");
    // A passage starting mid-line shows its exact 1-based column.
    // A passage starting after two spaces on its line is at column 3.
    const inlineSource = markedSourceRead([{ id: "p1", text: "  Second" }]);
    const inline = {
      ...inlineSource,
      passages: [{ ...inlineSource.passages[0], location: { ...inlineSource.passages[0].location, column: 3 } }],
    };
    const inlineBody = passagesSection(inline, inline.meetingId).body;
    assert.ok(inlineBody.includes("line 1, column 3"), "a passage starting mid-line keeps its column");
    // In stored order, the second row follows the first.
    assert.ok(section.body.indexOf("First") < section.body.indexOf("Second"));
    // The anchors name the source, so a link never points into another source.
    assert.ok(anchorIdForText(read, "First").includes("src-a"));
    // The passages page carries links back to this source's text and original.
    const hrefs = [...section.body.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(hrefs.includes(sourceHref(read.meetingId, read.transcriptId, "src-a", "text")));
    assert.ok(hrefs.includes(sourceHref(read.meetingId, read.transcriptId, "src-a", "original")));
  });

  it("labels a DOCX passage as an extracted block even when a page is recorded", () => {
    // A stored page on a DOCX source is not a PDF page: the label follows the
    // source format, so the passage is shown as an extracted block, never as a
    // page the document does not have.
    for (const format of ["docx", "pdf", "txt", "markdown", "paste"] as const) {
      const read = markedSourceRead([{ id: "p1", text: "Text", page: 4 }], { format });
      const body = passagesSection(read, read.meetingId).body;
      if (format === "docx") {
        assert.ok(body.includes("Extracted block"));
        assert.equal(body.includes("PDF page"), false);
      } else if (format === "pdf") {
        assert.ok(body.includes("PDF page 4"));
        assert.equal(body.includes("Extracted block"), false);
      } else {
        assert.equal(body.includes("PDF page"), false);
        assert.equal(body.includes("Extracted block"), false);
      }
    }
    // A PDF passage without a recorded page names no page at all.
    const noPage = markedSourceRead([{ id: "p1", text: "Text" }], { format: "pdf" });
    assert.equal(passagesSection(noPage, noPage.meetingId).body.includes("PDF page"), false);
  });

  it("pages the passages view through the existing renderPage helper", async () => {
    // A source route over a real open store with one committed source: its
    // passages answer is the helper's page shape (a title and a body the shell
    // wraps), carrying the helper's own CSP.
    const server = await running();
    try {
      const parents = await hierarchy(server.store);
      const meetingId = await notesMeeting(server.store, parents, "Rendered", "2026-03-09");
      await importFor(server.store, meetingId, { kind: "paste", text: "Body words." });
      const row = await onlyRow(server, meetingId);
      const passages = await send(server.origin, row.viewLinks.passages);
      assert.equal(passages.status, 200);
      const transcript = server.store.snapshot().transcripts![0];
      const source = transcript.sources[0];
      const section = passagesSection(
        await transcriptService(server.store).readSource(transcript.id, source.id, parents.engagementId),
        meetingId,
      );
      const page = renderPage(section.title, section.body);
      assert.equal(page.title, "Passages");
      // The document the shell sent is the helper's layout around the section
      // body: its heading and every stored passage text appear inside the shell.
      assert.ok(passages.body.includes("<h1>Passages</h1>"));
      for (const passage of source.passages) {
        assert.ok(passages.body.includes(escapeHtml(passage.text)), passage.text);
      }
      assert.equal(passages.headers["content-security-policy"], page.headers["Content-Security-Policy"]);
      assert.equal(passages.headers["x-content-type-options"], "nosniff");
      assert.equal(passages.headers["cache-control"], "no-store");
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Reference resolution
// ---------------------------------------------------------------------------

describe("transcript source views: resolved references", () => {
  it("refuses swapped references, malformed ids and an orphan transcript with 404", async () => {
    const server = await running();
    try {
      const parents = await hierarchy(server.store);
      const firstMeeting = await notesMeeting(server.store, parents, "First", "2026-05-01");
      const secondMeeting = await notesMeeting(server.store, parents, "Second", "2026-05-02");
      const first = await importFor(server.store, firstMeeting, { kind: "paste", text: "First words." });
      const second = await importFor(server.store, secondMeeting, { kind: "paste", text: "Second words." });
      // Each source is served under its own meeting.
      const firstRow = await onlyRow(server, firstMeeting);
      const secondRow = await onlyRow(server, secondMeeting);
      assert.equal((await send(server.origin, firstRow.viewLinks.text)).body, "First words.");
      assert.equal((await send(server.origin, secondRow.viewLinks.text)).body, "Second words.");

      // Swapping the meeting (or the transcript) makes the reference mismatched.
      for (const path of [
        sourceHref(secondMeeting, first.transcriptId, first.sourceId, "text"),
        sourceHref(firstMeeting, second.transcriptId, second.sourceId, "text"),
        sourceHref(secondMeeting, second.transcriptId, first.sourceId, "text"),
      ]) {
        const reply = await send(server.origin, path);
        assert.equal(reply.status, 404, path);
        assert.equal(reply.body.trim(), "Not found.", "a refused reference names nothing");
      }

      // A reference that is not the exact single-segment encoding is a 404
      // before any read: a malformed escape, a bare stored id, a percent-escaped
      // encoding and a padded or trailing-bit variant of a valid one.
      const good = sourceHref(firstMeeting, first.transcriptId, first.sourceId, "text");
      const encodedSource = encodeSegment(first.sourceId);
      const encodedMeeting = encodeSegment(firstMeeting);
      const encodedTranscript = encodeSegment(first.transcriptId);
      for (const path of [
        `/meetings/${encodedMeeting}/transcripts/%E0%A4%A/sources/${encodedSource}/text`,
        `/meetings/${encodedMeeting}/transcripts/${encodedTranscript}/sources/%ZZ/text`,
        `/meetings/%E0%A4%A/transcripts/${encodedTranscript}/sources/${encodedSource}/text`,
        // The raw stored ids, not their encoding.
        `/meetings/${firstMeeting}/transcripts/${encodedTranscript}/sources/${first.sourceId}/text`,
        // An encoded id with one percent-escaped character is not the encoding.
        good.replace("~", "%7E"),
        // A padded base64 tail is not the canonical encoding.
        `/meetings/${encodedMeeting}/transcripts/${encodedTranscript}/sources/${encodedSource}=/text`,
      ]) {
        const reply = await send(server.origin, path);
        assert.equal(reply.status, 404, path);
      }
      // A path missing its `~` prefix names no record either.
      const barePath = `/meetings/${encodedMeeting}/transcripts/${encodedTranscript}/sources/${encodedSource.slice(1)}/text`;
      assert.equal((await send(server.origin, barePath)).status, 404, barePath);
    } finally {
      await server.close();
    }
  });

  it("exercises a real orphan: a source whose transcript has no meeting, and a retained original with no source", async () => {
    const server = await running();
    try {
      const parents = await hierarchy(server.store);
      const meetingId = await notesMeeting(server.store, parents, "Detached", "2026-05-03");
      // A file original is retained under its hash; the committed metadata names it.
      const imported = await importFor(server.store, meetingId, {
        kind: "file",
        bytes: encoder.encode("Orphan original words."),
        filename: "orphan.txt",
      });
      const snapshot = server.store.snapshot();
      const transcript = snapshot.transcripts!.find((candidate) => candidate.meetingId === meetingId)!;
      const source = transcript.sources.find((candidate) => candidate.id === imported.sourceId)!;

      // A detached snapshot where the transcript's recorded meeting is absent:
      // every reference to it resolves to nothing (the encoded ids decode, but
      // the meeting they name is missing).
      const detached = {
        ...snapshot,
        meetings: snapshot.meetings.filter((candidate) => candidate.id !== meetingId),
      } as Snapshot;
      assert.throws(
        () => resolveSourceTarget(
          detached,
          encodeSegment(meetingId),
          encodeSegment(transcript.id),
          encodeSegment(source.id),
        ),
        /No meeting/,
        "a transcript whose meeting is absent names no source",
      );
      // The detached transcript still names a source, but no meeting holds it,
      // so no detail page can show or link it, and every source route for it
      // resolves to nothing.
      assert.equal(detached.meetings.some((candidate) => candidate.id === meetingId), false);
      assert.equal(detached.transcripts!.length, 1);

      // A detached snapshot where a retained original is no longer named by any
      // committed source (in the same workspace state, the store's own snapshot
      // is read through the resolver here): its hash is not reachable through any
      // source route, and the committed source is still listed and read.
      const withoutSource = {
        ...snapshot,
        transcripts: snapshot.transcripts!.map((candidate) => ({
          ...candidate,
          sources: candidate.sources.filter((each) => each.id !== source.id),
        })).filter((candidate) => candidate.sources.length > 0),
      } as Snapshot;
      assert.throws(
        () => resolveSourceTarget(
          withoutSource,
          encodeSegment(meetingId),
          encodeSegment(transcript.id),
          encodeSegment(source.id),
        ),
        /No transcript|No source/,
        "a retained original with no committed source names no source",
      );
      // The same workspace state as the open store: the committed source is
      // listed once in the section built from the store's own snapshot.
      const listed = server.store.snapshot().transcripts!.find((candidate) => candidate.id === transcript.id)!;
      assert.equal(listed.sources.some((each) => each.id === source.id), true);
      const section = meetingSourceSection(server.store.snapshot(), meetingId);
      assert.ok(section.includes(`<li class="card">`));
      assert.equal((section.match(/<li class="card">/g) ?? []).length, listed.sources.length);
      const row = await onlyRow(server, meetingId);
      assert.equal((await send(server.origin, row.viewLinks.text)).body, "Orphan original words.");
      const hashPath = `/meetings/${encodeSegment(meetingId)}/transcripts/${encodeSegment(transcript.id)}/sources/${encodeSegment(source.originalSha256!)}/text`;
      assert.equal((await send(server.origin, hashPath)).status, 404, "no source id equals the hash");
    } finally {
      await server.close();
    }
  });

  it("keeps equal canonical text in two engagements with distinguishable sources", async () => {
    const server = await running();
    try {
      const acme = await hierarchy(server.store);
      const otherClient = await server.store.createClient({ name: "Other client" });
      const otherEngagement = await server.store.createEngagement({ clientId: otherClient.id, name: "Other eng" });
      const acmeMeeting = await notesMeeting(server.store, acme, "Acme sync", "2026-06-01");
      const otherMeeting = await notesMeeting(
        server.store,
        { clientId: otherClient.id, engagementId: otherEngagement.id },
        "Other sync",
        "2026-06-02",
      );
      // Equal canonical text, distinguishable originals (whitespace and line
      // endings differ but the canonical content is the same).
      const acmeImport = await importFor(server.store, acmeMeeting, { kind: "paste", text: "Shared words." });
      const otherImport = await importFor(server.store, otherMeeting, { kind: "paste", text: " Shared words.\r\n" });
      assert.equal(acmeImport.transcriptId, otherImport.transcriptId, "the canonical transcript id is the same");
      assert.notEqual(acmeImport.sourceId, otherImport.sourceId);

      const acmeRow = await onlyRow(server, acmeMeeting);
      const otherRow = await onlyRow(server, otherMeeting);
      const acmeText = await send(server.origin, acmeRow.viewLinks.text);
      const otherText = await send(server.origin, otherRow.viewLinks.text);
      assert.equal(acmeText.body, "Shared words.");
      assert.equal(otherText.body, " Shared words.\r\n");
      assert.deepEqual(new Uint8Array(acmeText.bytes), encoder.encode("Shared words."));
      assert.deepEqual(new Uint8Array(otherText.bytes), encoder.encode(" Shared words.\r\n"));
      // A cross-engagement swap is a mismatched reference.
      const crossed = await send(
        server.origin,
        sourceHref(acmeMeeting, otherImport.transcriptId, otherImport.sourceId, "text"),
      );
      assert.equal(crossed.status, 404);
    } finally {
      await server.close();
    }
  });

  it("answers a POST to a source path with 405 and writes nothing", async () => {
    const server = await running();
    try {
      const parents = await hierarchy(server.store);
      const meetingId = await notesMeeting(server.store, parents);
      const imported = await importFor(server.store, meetingId, { kind: "paste", text: "Read only." });
      const before = JSON.stringify(server.store.snapshot());
      const reply = await send(
        server.origin,
        views(imported.meetingId, imported.transcriptId, imported.sourceId).text,
        "POST",
        server.origin,
      );
      assert.equal(reply.status, 405);
      assert.equal(JSON.stringify(server.store.snapshot()), before, "a source request writes nothing");
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Unreadable originals
// ---------------------------------------------------------------------------

/** An original adapter that fails reads for one hash and delegates the rest. */
function failingReads(hash: string, mode: "missing" | "corrupt"): Partial<OriginalFileSystem> {
  const failure = Object.assign(new Error(mode === "missing" ? "simulated ENOENT" : "simulated corrupt read"), {
    code: mode === "missing" ? "ENOENT" : "EIO",
  });
  return {
    readFileSync(path: string): Uint8Array {
      if (path.endsWith(hash)) {
        if (mode === "missing") throw failure;
        return new Uint8Array(encoder.encode("tampered bytes"));
      }
      // The real adapter reads the file at `path`.
      return new Uint8Array(readFileSync(path));
    },
  };
}

describe("transcript source views: an unreadable referenced original", () => {
  it("answers the generic 500 for every view of a missing or corrupt original", async () => {
    // A first store publishes the files; a second store over the same directory
    // is given an adapter that fails exactly one original's read.
    const directory = tempDir();
    const setup = await openStore(directory);
    const parents = await hierarchy(setup);
    // The parents are recorded once here so the reopened store below reuses them.
    const meetingId = await notesMeeting(setup, parents, "Broken original", "2026-07-07");
    // A file original is a hash reference, so its read goes through the adapter.
    const imported = await importFor(setup, meetingId, {
      kind: "file",
      bytes: encoder.encode("File words for the broken original."),
      filename: "file.txt",
    });
    const transcript = setup.snapshot().transcripts![0];
    const hash = transcript.sources.find((source) => source.id === imported.sourceId)!.originalSha256!;
    await setup.close();

    for (const mode of ["missing", "corrupt"] as const) {
      const server = await running(directory, { originalsFs: failingReads(hash, mode) });
      try {
        // The meeting detail still opens from snapshot metadata alone, and still
        // lists the source whose original cannot be read.
        const detail = await send(server.origin, `/meetings/${encodeURIComponent(meetingId)}`);
        assert.equal(detail.status, 200);

        const row = await onlyRow(server, meetingId);
        for (const view of ["original", "text", "passages"] as const) {
          const reply = await send(server.origin, row.viewLinks[view]);
          assert.equal(reply.status, 500, `${mode} ${view}`);
          assert.equal(reply.body.trim(), "An unexpected error occurred.", "the shell's generic failure");
          assert.equal(reply.headers["content-type"], "text/plain; charset=utf-8");
        }
        // An unaffected source (another client's meeting, so another engagement)
        // still reads.
        const otherClient = await server.store.createClient({ name: "Unaffected client" });
        const otherEngagement = await server.store.createEngagement({ clientId: otherClient.id, name: "Unaffected eng" });
        const unaffectedMeeting = await notesMeeting(
          server.store,
          { clientId: otherClient.id, engagementId: otherEngagement.id },
          "Unaffected",
          "2026-07-08",
        );
        await importFor(server.store, unaffectedMeeting, { kind: "paste", text: "Still readable." });
        const unaffectedRow = await onlyRow(server, unaffectedMeeting);
        assert.equal((await send(server.origin, unaffectedRow.viewLinks.text)).body, "Still readable.");
      } finally {
        await server.close();
      }
    }
  });

  it("answers the generic 500 for a referenced original whose file is absent on disk", async () => {
    // Publish an original, then reopen the store with a filesystem adapter that
    // reports the file as absent: a missing referenced file is the same generic
    // failure as one that cannot be read, never a page or a download of nothing.
    const directory = tempDir();
    const setup = await openStore(directory);
    const parents = await hierarchy(setup);
    const meetingId = await notesMeeting(setup, parents, "Gone", "2026-07-09");
    await importFor(setup, meetingId, {
      kind: "file",
      bytes: encoder.encode("Gone original words."),
      filename: "gone.txt",
    });
    await setup.close();
    const hash = setup.snapshot().transcripts![0].sources[0].originalSha256!;

    const server = await running(directory, {
      originalsFs: {
        readFileSync(path: string): Uint8Array {
          if (path.endsWith(hash)) {
            throw Object.assign(new Error("simulated ENOENT"), { code: "ENOENT" });
          }
          return new Uint8Array(readFileSync(path));
        },
      },
    });
    try {
      const row = await onlyRow(server, meetingId);
      for (const view of ["original", "text", "passages"] as const) {
        const reply = await send(server.origin, row.viewLinks[view]);
        assert.equal(reply.status, 500, view);
        assert.equal(reply.body.trim(), "An unexpected error occurred.");
      }
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Snapshot metadata, empty collection and route tables
// ---------------------------------------------------------------------------

describe("transcript source pages: snapshot-built listing and route table", () => {
  it("treats an absent transcript collection as empty", () => {
    const snapshot = {
      clients: [],
      engagements: [],
      projects: [],
      tasks: [],
      items: [],
      meetings: [{ id: "meeting-1", clientId: "client-1", engagementId: "engagement-1", title: "M", date: "2026-01-01", notes: "" }],
    };
    const section = meetingSourceSection(snapshot, "meeting-1");
    assert.ok(section.includes("No transcript sources recorded yet."));
    // The empty section repeats no second import action; the meeting's own
    // header already offers it once.
    assert.equal(section.includes("/transcripts/import"), false);
    // Every nonempty id encodes as one segment; a blank record id names no
    // record at all and is refused before any href is built.
    assert.equal(recordSegment("meeting-1"), encodeSegment("meeting-1"));
    assert.throws(() => recordSegment(""), /No record/);
    // No transcript collection at all is still an empty list, never a failure.
    assert.equal(section.includes("card-list"), false);
  });

  it("borrows the transcript service on demand from the application's own open store", async () => {
    const server = await running();
    try {
      const parents = await hierarchy(server.store);
      const meetingId = await notesMeeting(server.store, parents);
      const imported = await importFor(server.store, meetingId, { kind: "paste", text: "Borrowed words." });

      // The application's routes are registered over its own store. Showing a
      // meeting needs no original read, and a valid source read returns the
      // store's own committed text through the borrowed service; both requests
      // reach the registered table, so a service borrowed during them would be
      // the application's own.
      type SourceMatch = { readonly pattern: string; readonly source?: { readonly meetingId: string } };
      const registered = registerRoutes(server.store).hierarchy!;
      const detailMatch = registered.match(`/meetings/${encodeSegment(meetingId)}`) as SourceMatch | null;
      assert.equal(detailMatch?.pattern, "/meetings/:id");
      const sourceMatch = registered.match(
        `/meetings/${encodeSegment(meetingId)}/transcripts/${encodeSegment(imported.transcriptId)}/sources/${encodeSegment(imported.sourceId)}/text`,
      ) as SourceMatch | null;
      // The match keeps the route's own encoded spelling; its handler decodes it.
      assert.equal(sourceMatch?.source?.meetingId, encodeSegment(meetingId));
      // The registered table's source route borrows a service whose read names
      // the same snapshot the open store serves, and the store stays open after.
      const table = meetingRoutes(server.store);
      // The handler receives the matched, still-encoded segments and decodes
      // them exactly once to reach the store's committed source.
      const read = await table.sources.text.get.render({
        method: "GET",
        meetingId: encodeSegment(meetingId),
        transcriptId: encodeSegment(imported.transcriptId),
        sourceId: encodeSegment(imported.sourceId),
      });
      assert.equal((read as { body: string }).body, "Borrowed words.");
      assert.equal(server.store.snapshot().transcripts![0].sources.length, 1);
      const row = await onlyRow(server, meetingId);
      assert.equal((await send(server.origin, row.viewLinks.text)).body, "Borrowed words.");
      // The table's meeting slot is still a GET, and the source slots are GET-only.
      assert.equal(routeForMeetingPattern(table, "/meetings/:id", "GET")?.method, "GET");
      assert.equal(table.sources.original.get.method, "GET");
      assert.equal(table.sources.text.get.method, "GET");
      assert.equal(table.sources.passages.get.method, "GET");
    } finally {
      await server.close();
    }
  });
});
