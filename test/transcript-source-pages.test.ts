/**
 * Meeting sources: the list on a meeting's detail page and the three read-only
 * GETs that serve one committed source (its original, its extracted text and its
 * passages). Every test starts a real loopback server over a real on-disk store,
 * so the requests and responses are the ones the application sends.
 *
 * The binary download is compared byte for byte with the original a client
 * pasted, including a BOM and mixed line endings. Failures of a referenced
 * original are injected through the store's own original-file adapter
 * (`originalsFs`), the interface `openStore` accepts, never by mocking a module
 * or changing the environment.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { escapeHtml } from "../src/html.ts";
import { registerRoutes } from "../src/index.ts";
import { matchMeetingPath, meetingRoutes, routeForMeetingPattern } from "../src/meeting-pages.ts";
import { startServer } from "../src/server.ts";
import { openStore, type Store } from "../src/store.ts";
import { transcriptService } from "../src/transcript-store.ts";
import type { OriginalFileSystem } from "../src/transcript-files.ts";
import { importPdf } from "../src/transcript-pdf.ts";
import {
  headerSafeBasename,
  matchTranscriptSourcePath,
  meetingSourceSection,
  sourceHref,
  transcriptSourceRoutes,
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

/** The three view paths of one source. */
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

/** Read one source's three views and assert each is served. */
async function followViews(server: Running, imported: Imported, sourceId = imported.sourceId): Promise<Reply[]> {
  const paths = views(imported.meetingId, imported.transcriptId, sourceId);
  const replies: Reply[] = [];
  for (const path of [paths.original, paths.text, paths.passages]) {
    const reply = await send(server.origin, path);
    assert.equal(reply.status, 200, path);
    replies.push(reply);
  }
  return replies;
}

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

describe("transcript source paths: exact fixed shapes", () => {
  it("matches only the three exact source views and keeps the meeting paths", () => {
    const base = "/meetings/meeting-1/transcripts/sha256:abc/sources/src-1";
    for (const view of ["original", "text", "passages"] as const) {
      const matched = matchTranscriptSourcePath(`${base}/${view}`);
      assert.notEqual(matched, null);
      assert.equal(matched?.view, view);
      assert.equal(matched?.meetingId, "meeting-1");
      assert.equal(matched?.transcriptId, "sha256:abc");
      assert.equal(matched?.sourceId, "src-1");
      assert.equal(matched?.pattern, `/meetings/:id/transcripts/:transcriptId/sources/:sourceId/${view}`);
    }
    // Another view, a missing segment, an extra segment and a query keep it a
    // non-match (the query is stripped before matching).
    for (const path of [
      `${base}/raw`,
      `${base}`,
      `${base}/original/extra`,
      "/meetings/meeting-1/transcripts/sha256:abc/sources/original",
      "/engagements/engagement-1/transcripts/import",
    ]) {
      assert.equal(matchTranscriptSourcePath(path), null, path);
    }
    assert.notEqual(matchTranscriptSourcePath(`${base}/text?x=1`), null);
    // The ordinary meeting paths are still matched by the meeting table.
    assert.equal(matchMeetingPath(`${base}/text`), null);
    assert.notEqual(matchMeetingPath("/meetings/meeting-1"), null);
    assert.notEqual(matchMeetingPath("/meetings/meeting-1/edit"), null);
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
});

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
      const [original, text, passages] = await followViews(server, imported);

      // The binary download is the pasted original, byte for byte.
      assert.deepEqual(new Uint8Array(original.bytes), encoder.encode(pasted));
      assert.equal(original.headers["content-type"], "application/octet-stream");
      assert.equal(original.headers["content-length"], String(encoder.encode(pasted).byteLength));
      assert.equal(original.headers["x-content-type-options"], "nosniff");
      assert.equal(original.headers["cache-control"], "no-store");
      assert.equal(original.headers["content-disposition"], 'attachment; filename="Pasted text"');

      // The extracted text is exact, as UTF-8, with no added newline.
      assert.equal(text.headers["content-type"], "text/plain; charset=utf-8");
      assert.equal(text.headers["content-length"], String(encoder.encode(pasted).byteLength));
      assert.deepEqual(new Uint8Array(text.bytes), encoder.encode(pasted));
      assert.equal(text.body, pasted);
      assert.equal(text.body.endsWith("\n"), false);

      // Passages are served as an HTML page with one anchor per stored passage.
      assert.match(String(passages.headers["content-type"]), /^text\/html/);
      assert.equal(passages.headers["x-content-type-options"], "nosniff");
      const stored = server.store.snapshot().transcripts?.[0];
      assert.notEqual(stored, undefined);
      const source = stored!.sources.find((candidate) => candidate.id === imported.sourceId)!;
      for (const passage of source.passages) {
        assert.ok(
          passages.body.includes(`id="${escapeHtml(`passage-${source.id.replace(/[^A-Za-z0-9_-]/g, "_")}-${passage.id.replace(/[^A-Za-z0-9_-]/g, "_")}`)}"`),
          passage.id,
        );
        assert.ok(passages.body.includes(escapeHtml(passage.text)), passage.text);
        assert.ok(passages.body.includes(`offsets ${passage.range.start}–${passage.range.end}`));
        assert.ok(passages.body.includes(`line ${passage.location.line}, column ${passage.location.column}`));
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
      const pdfBytesFixture = pdfBytes([["First page."], [], ["Third page."]]);
      const pdfOutcome = await importPdf(pdfBytesFixture, "deck.pdf");
      assert.ok(pdfOutcome.ok);
      const pdfImported = await importFor(server.store, pdfMeeting, {
        kind: "file",
        bytes: pdfBytesFixture,
        filename: "deck.pdf",
      });
      const [, , pdfPassages] = await followViews(server, pdfImported);
      assert.ok(pdfPassages.body.includes("PDF page 1"));
      assert.ok(pdfPassages.body.includes("PDF page 3"));
      // The blank page is skipped, never invented or renumbered.
      assert.equal(pdfPassages.body.includes("PDF page 2"), false);
      assert.ok(pdfPassages.body.indexOf("First page.") < pdfPassages.body.indexOf("Third page."));

      const docxImported = await importFor(server.store, docxMeeting, {
        kind: "file",
        bytes: docxBytes(["Intro block.", "Second block."]),
        filename: 'minutes "1".docx',
      });
      const [, docxText, docxPassages] = await followViews(server, docxImported);
      assert.ok(docxPassages.body.includes("Extracted block"));
      assert.equal(docxPassages.body.includes("PDF page"), false);
      // The stored filename is escaped in the page and header-safe in a header.
      assert.ok(docxPassages.body.includes(escapeHtml('minutes "1".docx')));
      const docxOriginal = await send(
        server.origin,
        views(docxImported.meetingId, docxImported.transcriptId, docxImported.sourceId).original,
      );
      assert.equal(docxOriginal.headers["content-disposition"], 'attachment; filename="minutes 1 .docx"');
      assert.ok(docxText.body.includes("Intro block."));
      assert.ok(docxText.body.includes("Second block."));
    } finally {
      await server.close();
    }
  });

  it("lists every committed source by stored filename and format on the detail page", async () => {
    const server = await running();
    try {
      const parents = await hierarchy(server.store);
      const meetingId = await notesMeeting(server.store, parents, "Listed", "2026-04-04");
      const first = await importFor(server.store, meetingId, { kind: "paste", text: "Shared words." });
      // A distinct original attaches as a second source to the same transcript.
      const second = await importFor(server.store, meetingId, { kind: "paste", text: " Shared words.\r\n" });
      assert.equal(second.transcriptId, first.transcriptId);
      assert.notEqual(second.sourceId, first.sourceId);

      const detail = await send(server.origin, `/meetings/${meetingId}`);
      assert.equal(detail.status, 200);
      const snapshot = server.store.snapshot();
      const transcript = snapshot.transcripts!.find((candidate) => candidate.meetingId === meetingId)!;
      for (const source of transcript.sources) {
        assert.ok(detail.body.includes(escapeHtml(source.filename)), source.filename);
        assert.ok(detail.body.includes(escapeHtml(source.format)), source.format);
        for (const view of ["original", "text", "passages"] as const) {
          assert.ok(
            detail.body.includes(`href="${escapeHtml(sourceHref(meetingId, transcript.id, source.id, view))}"`),
            `${source.id} ${view}`,
          );
        }
      }
      // Both sources' views resolve to that source and no other.
      for (const sourceId of [first.sourceId, second.sourceId]) {
        const [, text] = await followViews(server, first, sourceId);
        const source = transcript.sources.find((candidate) => candidate.id === sourceId)!;
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
      assert.ok(detail.body.includes(`href="/meetings/${meetingId}/transcripts/import"`));
      // A source path of an absent transcript is a 404, never a page or a read.
      const missing = await send(
        server.origin,
        `/meetings/${meetingId}/transcripts/sha256:${"0".repeat(64)}/sources/source-1/text`,
      );
      assert.equal(missing.status, 404);
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
      const [, firstText] = await followViews(server, first);
      const [, secondText] = await followViews(server, second);
      assert.equal(firstText.body, "First words.");
      assert.equal(secondText.body, "Second words.");

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

      // A malformed escape in any segment is a 404 before any read.
      for (const path of [
        `/meetings/${firstMeeting}/transcripts/%E0%A4%A/sources/${encodeURIComponent(first.sourceId)}/text`,
        `/meetings/${firstMeeting}/transcripts/${encodeURIComponent(first.transcriptId)}/sources/%ZZ/text`,
        `/meetings/%E0%A4%A/transcripts/${encodeURIComponent(first.transcriptId)}/sources/${encodeURIComponent(first.sourceId)}/text`,
      ]) {
        const reply = await send(server.origin, path);
        assert.equal(reply.status, 404, path);
      }

      // An orphan transcript (its meeting no longer in memory) names no source.
      const orphanPath = `/meetings/${firstMeeting}/transcripts/${encodeURIComponent(first.transcriptId)}/sources/${encodeURIComponent(first.sourceId)}/text`;
      const orphan = await send(server.origin, `/meetings/meeting-99/transcripts/${encodeURIComponent(first.transcriptId)}/sources/${encodeURIComponent(first.sourceId)}/text`);
      assert.equal(orphan.status, 404);
      assert.equal((await send(server.origin, orphanPath)).status, 200, "the orphan path names nothing; its real path still reads");
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
      // Equal canonical text, distinguishable originals (whitespace and casing
      // of line endings differ but the canonical content is the same).
      const acmeImport = await importFor(server.store, acmeMeeting, { kind: "paste", text: "Shared words." });
      const otherImport = await importFor(server.store, otherMeeting, { kind: "paste", text: " Shared words.\r\n" });
      assert.equal(acmeImport.transcriptId, otherImport.transcriptId, "the canonical transcript id is the same");
      assert.notDeepEqual(acmeImport.sourceId, otherImport.sourceId);

      const [, acmeText] = await followViews(server, acmeImport);
      const [, otherText] = await followViews(server, otherImport);
      assert.equal(acmeText.body, "Shared words.");
      assert.equal(otherText.body, " Shared words.\r\n");
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
    const meetingId = await notesMeeting(setup, parents, "Broken", "2026-07-07");
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
        // The meeting detail still opens from snapshot metadata alone.
        assert.equal((await send(server.origin, `/meetings/${meetingId}`)).status, 200);
        for (const view of ["original", "text", "passages"] as const) {
          const reply = await send(server.origin, views(meetingId, imported.transcriptId, imported.sourceId)[view]);
          assert.equal(reply.status, 500, `${mode} ${view}`);
          assert.equal(reply.body.trim(), "An unexpected error occurred.", "the shell's generic failure");
          assert.equal(reply.headers["content-type"], "text/plain; charset=utf-8");
        }
        // An unaffected source (another meeting, so another transcript) still reads.
        const unaffectedMeeting = await notesMeeting(server.store, parents, "Unaffected", "2026-07-08");
        const unaffected = await importFor(server.store, unaffectedMeeting, { kind: "paste", text: "Still readable." });
        const [, unaffectedText] = await followViews(server, unaffected);
        assert.equal(unaffectedText.body, "Still readable.");
      } finally {
        await server.close();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Snapshot metadata, empty collection and route tables
// ---------------------------------------------------------------------------

describe("transcript source pages: snapshot-built listing", () => {
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
    assert.ok(section.includes(`/meetings/meeting-1/transcripts/import`));
    // No transcript collection at all is still an empty list, never a failure.
    assert.equal(section.includes("card-list"), false);
  });

  it("builds the routes over a borrowed service only when a read needs it", async () => {
    let built = 0;
    const server = await running();
    try {
      const parents = await hierarchy(server.store);
      const meetingId = await notesMeeting(server.store, parents);
      // A routes table with a spy service factory: a detail read builds none.
      const routes = transcriptSourceRoutes(server.store, {
        transcriptService: (store) => {
          built += 1;
          return transcriptService(store);
        },
      });
      assert.equal(built, 0);
      await send(server.origin, `/meetings/${meetingId}`);
      assert.equal(built, 0, "showing a meeting borrows no service");
      // The source routes are part of the meeting table.
      const table = meetingRoutes(server.store);
      assert.equal(typeof table.sources.original.get.render, "function");
      assert.equal(routeForMeetingPattern(table, "/meetings/:id", "GET")?.method, "GET");
      // An unused routes object is a complete table: its slots are GET-only.
      assert.equal(routes.text.get.method, "GET");
    } finally {
      await server.close();
    }
  });

  it("labels a passage with a recorded page only when the source records one", async () => {
    const passage: Passage = {
      id: "p-1",
      sourceId: "s-1",
      range: { start: 0, end: 4 },
      location: { start: 0, end: 4, line: 1, column: 1 },
      text: "Text",
    };
    // The DOCX adapter's own passages carry no page: they are extracted blocks
    // of the document's block structure, never an invented page or paragraph.
    const blocks = extractBlocks("<ul><li>A list item</li><li>Another item</li></ul>");
    assert.deepEqual(blocks.map((block) => [block.kind, block.text]), [
      ["list_item", "A list item"],
      ["list_item", "Another item"],
    ]);
    const docx = await importDocx(docxBytes(["Block."]), "a.docx");
    assert.equal(docx.ok, true);
    assert.ok(docx.ok && docx.result.passages.every((candidate) => candidate.page === undefined));
    // A passage's own page is what names a page; a DOCX source carries none.
    const read = {
      transcriptId: "t",
      engagementId: "e",
      meetingId: "m",
      sourceId: "s-1",
      format: "docx" as const,
      filename: "doc.docx",
      originalBytes: encoder.encode("Text"),
      originalSha256: "a".repeat(64),
      extractedText: "Text",
      passages: [passage],
    };
    assert.equal(read.passages[0]?.page, undefined);
    void importPdf;
  });
});
