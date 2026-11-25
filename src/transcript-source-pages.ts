/**
 * Committed transcript sources on a meeting's detail page, and the three
 * read-only GETs that serve one source.
 *
 * The meeting detail lists every source of every transcript that belongs to
 * the meeting, by its stored filename and format. The list is built from the
 * snapshot's transcript metadata (read-only, never from the original files),
 * so a missing or corrupt original cannot break the page: the source still
 * appears with its three links, and a read of it fails on its own request. An
 * absent transcript collection is an empty list, exactly like a meeting that
 * has no transcript yet.
 *
 * Each source is read at `/meetings/:id/transcripts/:transcriptId/sources/:sourceId/{original,text,passages}`,
 * a fixed, exact route shape whose three ids are single path segments. A read
 * first resolves the decoded meeting, the transcript and the source together:
 * a malformed escape, a missing record or a reference that does not belong to
 * the resolved meeting is a 404 and no read is attempted. The original bytes
 * are read only then, through the borrowed transcript service's `readSource`,
 * scoped to the meeting's engagement. A referenced original that cannot be
 * read or verified is a `PersistenceError`, which the shell answers with its
 * generic 500; that holds for the original, the text and the passages alike,
 * so no response ever shows text or passages whose original could not be
 * verified.
 *
 * The three answers are read-only: they write no record, file, counter or
 * activity event. The original is a binary `RouteResult` with an exact
 * Content-Length and a header-safe attachment name; the text is the exact
 * extracted text as UTF-8 with no added newline; the passages are rendered in
 * stored order with escaped quotes, source-scoped fragment links keyed by the
 * stored passage id, half-open UTF-16 offsets and the stored 1-based line and
 * column. A recorded PDF page is shown as such; a DOCX passage names an
 * extracted block, because a DOCX has no recorded page.
 *
 * Every displayed value is escaped; every link is built from a stored record
 * id through `encodeURIComponent`.
 */
import { escapeHtml } from "./html.ts";
import { MissingRecordError } from "./model.ts";
import type { Snapshot, Store, Transcript, TranscriptSource } from "./store.ts";
import { transcriptService, type TranscriptSourceRead, type TranscriptStore } from "./transcript-store.ts";
import type { Passage } from "./transcript.ts";

/** The three read-only actions a source route serves. */
export type SourceView = "original" | "text" | "passages";

/** The fixed source path shapes, used for matching. */
export type TranscriptSourcePath =
  | "/meetings/:id/transcripts/:transcriptId/sources/:sourceId/original"
  | "/meetings/:id/transcripts/:transcriptId/sources/:sourceId/text"
  | "/meetings/:id/transcripts/:transcriptId/sources/:sourceId/passages";

/** The view a matched source path names. */
const VIEW_FOR_SEGMENT: Readonly<Record<string, SourceView>> = Object.freeze({
  original: "original",
  text: "text",
  passages: "passages",
});

/**
 * Match a request path against the fixed source patterns and return the
 * matched shape, the view and the still-encoded segment ids, or null for any
 * other path so an unregistered path is refused before any handler runs. The
 * ids are not decoded here: a malformed escape names no record, which the
 * handler answers as a 404.
 */
export function matchTranscriptSourcePath(
  path: string,
): {
  readonly pattern: TranscriptSourcePath;
  readonly view: SourceView;
  readonly meetingId: string;
  readonly transcriptId: string;
  readonly sourceId: string;
} | null {
  const pathname = path.split("?")[0];
  const parts = pathname.split("/").slice(1);
  if (parts.some((part) => part === "")) return null;
  // `/meetings/:id/transcripts/:transcriptId/sources/:sourceId/:view`
  if (parts.length !== 7 || parts[0] !== "meetings") return null;
  if (parts[2] !== "transcripts" || parts[4] !== "sources") return null;
  const view = VIEW_FOR_SEGMENT[parts[6]];
  if (view === undefined) return null;
  return {
    pattern: `/meetings/:id/transcripts/:transcriptId/sources/:sourceId/${view}`,
    view,
    meetingId: parts[1],
    transcriptId: parts[3],
    sourceId: parts[5],
  };
}

/**
 * The transcript import path of one meeting, the fixed route the listing links
 * to. Declared here as well so the listing and the import pages share one
 * spelling; it equals `meetingImportHref` in `meeting-pages.ts`.
 */
export function meetingImportPath(meetingId: string): string {
  return `/meetings/${encodeURIComponent(meetingId)}/transcripts/import`;
}

/** The path of one source's view, from the stored ids of its records. */
export function sourceHref(
  meetingId: string,
  transcriptId: string,
  sourceId: string,
  view: SourceView,
): string {
  return (
    `/meetings/${encodeURIComponent(meetingId)}` +
    `/transcripts/${encodeURIComponent(transcriptId)}` +
    `/sources/${encodeURIComponent(sourceId)}/${view}`
  );
}

/**
 * The transcripts that belong to one meeting, in stored order. The snapshot's
 * transcript collection is optional: an absent collection is empty, so a
 * meeting with no transcripts (or a snapshot from before transcripts existed)
 * has an empty list rather than a failure.
 */
export function meetingTranscripts(snapshot: Snapshot, meetingId: string): readonly Transcript[] {
  const transcripts = snapshot.transcripts ?? [];
  return transcripts.filter((transcript) => transcript.meetingId === meetingId);
}

/**
 * The source list of a meeting's detail page: one entry for each committed
 * source of each of the meeting's transcripts, in stored order, with its stored
 * filename and format and the three read-only links. An empty list says so and
 * offers the meeting's import form; it never claims a source that is missing.
 */
export function meetingSourceSection(snapshot: Snapshot, meetingId: string): string {
  const transcripts = meetingTranscripts(snapshot, meetingId);
  const items: string[] = [];
  for (const transcript of transcripts) {
    for (const source of transcript.sources) {
      items.push(sourceListItem(meetingId, transcript.id, source));
    }
  }
  if (items.length === 0) {
    return [
      `<p>No transcript sources recorded yet.</p>`,
      `<p>${escapeHtml("A source appears here once a transcript is imported for this meeting.")}</p>`,
      `<p><a href="${escapeHtml(meetingImportPath(meetingId))}">Import transcript</a></p>`,
    ].join("\n");
  }
  return `<ul class="card-list">${items.join("")}</ul>`;
}

/** One listed source: its stored filename, its format and its three views. */
function sourceListItem(meetingId: string, transcriptId: string, source: TranscriptSource): string {
  const views = (["original", "text", "passages"] as const)
    .map((view) => {
      const href = sourceHref(meetingId, transcriptId, source.id, view);
      const label = view === "original" ? "Download original" : view === "text" ? "Extracted text" : "Passages";
      return `<a href="${escapeHtml(href)}">${label}</a>`;
    })
    .join(" ");
  return (
    `<li class="card"><span class="source-filename">${escapeHtml(source.filename)}</span> ` +
    `<span class="source-format">${escapeHtml(source.format)}</span> ${views}</li>`
  );
}

/** The decoded ids a source read resolves. */
interface SourceTarget {
  readonly meetingId: string;
  readonly transcriptId: string;
  readonly sourceId: string;
  /** The meeting's engagement, which scopes the source read. */
  readonly engagementId: string;
}

/** Decode a raw path segment; a malformed escape names no record. */
function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new MissingRecordError("No record for that path");
  }
}

function findRecord<T extends { readonly id: string }>(
  items: readonly T[],
  id: string,
  kind: string,
): T {
  const found = items.find((item) => item.id === id);
  if (found === undefined) throw new MissingRecordError(`No ${kind} with id ${JSON.stringify(id)}`);
  return found;
}

/**
 * Resolve the decoded meeting, transcript and source together before any
 * original is read. The meeting must exist; the transcript must belong to that
 * meeting; the source must belong to that transcript. A reference that names a
 * source of another meeting or transcript is a missing record (a 404), never a
 * read of the wrong source.
 */
export function resolveSourceTarget(
  snapshot: Snapshot,
  rawMeetingId: string,
  rawTranscriptId: string,
  rawSourceId: string,
): SourceTarget {
  const meetingId = decodeSegment(rawMeetingId);
  const transcriptId = decodeSegment(rawTranscriptId);
  const sourceId = decodeSegment(rawSourceId);
  const meeting = findRecord(snapshot.meetings, meetingId, "meeting");
  const transcript = findRecord(meetingTranscripts(snapshot, meeting.id), transcriptId, "transcript");
  const source = findRecord(transcript.sources, sourceId, "source");
  return { meetingId: meeting.id, transcriptId: transcript.id, sourceId: source.id, engagementId: meeting.engagementId };
}

/** The header-safe basename of a stored filename. */
export function headerSafeBasename(filename: string): string {
  // A header parameter value cannot carry controls, quotes, backslashes or the
  // separator characters a browser might interpret. Take the last path segment
  // a client may have supplied, turn any other character into a space, collapse
  // runs and drop leading and trailing dots and spaces, so the name cannot read
  // as a hidden or parent entry and never splits the quoted parameter.
  const segments = filename.split(/[\\/]/);
  let name = segments[segments.length - 1] ?? "";
  name = name.replace(/[^\x21-\x7e]/g, " ").replace(/["\\;=]/g, " ").replace(/\s+/g, " ");
  name = name.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
  return name === "" ? "download" : name;
}

/**
 * Build the binary answer for a source's original. Content-Length is the exact
 * byte length, and the attachment name is the header-safe basename so a stored
 * filename can never split or extend a response header. The result is the
 * shell's binary `RouteResult` shape (`binary: true`, a byte body).
 */
export function originalBytesResult(read: TranscriptSourceRead): OriginalBytesResponse {
  const bytes = new Uint8Array(read.originalBytes);
  const basename = headerSafeBasename(read.filename);
  return {
    status: 200,
    body: bytes,
    binary: true,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${basename}"`,
      "Content-Length": String(bytes.byteLength),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  };
}

/** The source list link labels a passage row shows; kept in stored order. */
function passageLocationText(passage: Passage, format: TranscriptSource["format"]): string {
  if (passage.page !== undefined) return `PDF page ${passage.page}`;
  if (format === "docx") return "Extracted block";
  return "";
}

/**
 * Render one source's passages in stored order. Each passage is a fragment
 * anchor keyed by its stored passage id, scoped to this source, with its exact
 * text escaped (quotes included), its half-open UTF-16 offsets and its stored
 * 1-based line and column. A recorded PDF page is named as a page; a DOCX
 * passage is labelled an extracted block, never an invented page or paragraph.
 */
export function passagesSection(
  read: TranscriptSourceRead,
  meetingId: string,
): { readonly title: string; readonly body: string } {
  const rows = read.passages.map((passage) => {
    const anchorId = passageAnchorId(read.sourceId, passage.id);
    const base = sourceHref(meetingId, read.transcriptId, read.sourceId, "passages");
    const fragment = `${base}#${encodeURIComponent(anchorId)}`;
    const location = passageLocationText(passage, read.format);
    const meta = [
      `<span class="offsets">offsets ${passage.range.start}–${passage.range.end} (UTF-16, start inclusive, end exclusive)</span>`,
      `<span class="position">line ${passage.location.line}, column ${passage.location.column}</span>`,
      ...(location === "" ? [] : [`<span class="location">${escapeHtml(location)}</span>`]),
      `<a class="passage-link" href="${escapeHtml(fragment)}">link to this passage</a>`,
    ].join(" ");
    return (
      `<li class="passage" id="${escapeHtml(anchorId)}">` +
      `<p class="passage-text">${escapeHtml(passage.text)}</p>` +
      `<p class="passage-meta">${meta}</p></li>`
    );
  });
  const textHref = sourceHref(meetingId, read.transcriptId, read.sourceId, "text");
  const originalHref = sourceHref(meetingId, read.transcriptId, read.sourceId, "original");
  return {
    title: "Passages",
    body: [
      `<p>Source: ${escapeHtml(read.filename)} (${escapeHtml(read.format)})</p>`,
      `<p><a href="${escapeHtml(textHref)}">Extracted text</a> · <a href="${escapeHtml(originalHref)}">Download original</a></p>`,
      `<ol class="passage-list">${rows.join("")}</ol>`,
    ].join("\n"),
  };
}

/**
 * The fragment anchor of one passage. It is built from the source and passage
 * ids only, so an anchor is scoped to its source and two sources of one
 * transcript cannot collide; a non-identifier character is replaced, so the id
 * is a safe HTML `id` value.
 */
export function passageAnchorId(sourceId: string, passageId: string): string {
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, "_");
  return `passage-${safe(sourceId)}-${safe(passageId)}`;
}

/**
 * The source route table: the original, text and passages GETs of the fixed
 * source paths. Every slot is GET-only; the shell refuses a POST before any
 * handler runs. The routes read no request path themselves: the shell matched
 * the exact source shape and passes the raw segment ids, so a path outside the
 * shape never reaches a handler.
 */
export interface TranscriptSourceRoutes {
  readonly original: { readonly get: TranscriptSourceRoute };
  readonly text: { readonly get: TranscriptSourceRoute };
  readonly passages: { readonly get: TranscriptSourceRoute };
}

/** What a source route may read from an accepted request: the matched raw ids. */
export interface TranscriptSourceRequest {
  readonly method: "GET";
  /** The still-encoded meeting id of the matched path. */
  readonly meetingId: string;
  /** The still-encoded transcript id of the matched path. */
  readonly transcriptId: string;
  /** The still-encoded source id of the matched path. */
  readonly sourceId: string;
}

/** The binary original answer: exact bytes and a header-safe attachment name. */
export interface OriginalBytesResponse {
  readonly status: number;
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
  /** Marks the result as the shell's binary body, sent exactly as returned. */
  readonly binary: true;
}

/** A guarded source route; `render` runs only after the request checks pass. */
export interface TranscriptSourceRoute {
  readonly method: "GET";
  render(
    request: TranscriptSourceRequest,
  ): Promise<OriginalBytesResponse | { readonly status: number; readonly body: string; readonly headers: Readonly<Record<string, string>> }
    | { readonly html: string; readonly headers: Readonly<Record<string, string>>; readonly title: string; readonly body: string }>;
}

/**
 * Build the source routes over the application's single owned store. The
 * transcript service is borrowed on demand from the same open store
 * (`transcriptService(store)`) and is built only when a source read first needs
 * it, so registering the routes and showing a meeting needs nothing beyond the
 * snapshot every page already reads. A read resolves all three records from the
 * snapshot first, then reads the original scoped to the meeting's engagement;
 * a referenced original that cannot be read or verified leaves the handler as
 * the service's `PersistenceError`, which the shell answers with its generic
 * 500 for the original, the text and the passages alike.
 */
export function transcriptSourceRoutes(
  store: Store,
  options: { readonly transcriptService?: (store: Store) => TranscriptStore } = {},
): TranscriptSourceRoutes {
  const snapshot = (): Snapshot => store.snapshot();
  const buildService = options.transcriptService ?? ((target: Store) => transcriptService(target));
  let service: TranscriptStore | null = null;
  const borrow = (): TranscriptStore => (service ??= buildService(store));

  /**
   * The resolved reference and its verified read, or a 404 before any read. The
   * three records are resolved together from one snapshot; a reference that
   * matches none of them is a `MissingRecordError` and no original is touched.
   */
  async function readFor(request: TranscriptSourceRequest): Promise<TranscriptSourceRead> {
    // A malformed escape or a mismatched reference names no source; the thrown
    // `MissingRecordError` is the shell's 404 and no read is attempted.
    const target = resolveSourceTarget(snapshot(), request.meetingId, request.transcriptId, request.sourceId);
    return await borrow().readSource(target.transcriptId, target.sourceId, target.engagementId);
  }

  const get = (view: SourceView): TranscriptSourceRoute => ({
    method: "GET",
    async render(request) {
      const read = await readFor(request);
      if (view === "original") return originalBytesResult(read);
      if (view === "text") {
        // The exact extracted text as UTF-8, with no added newline.
        return {
          status: 200,
          body: read.extractedText,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": String(new TextEncoder().encode(read.extractedText).byteLength),
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
          },
        };
      }
      const section = passagesSection(read, read.meetingId);
      return {
        html: renderPassagesDocument(section.title, section.body),
        title: section.title,
        body: section.body,
        headers: PASSAGES_HEADERS,
      };
    },
  });

  return {
    original: { get: get("original") },
    text: { get: get("text") },
    passages: { get: get("passages") },
  };
}

/** The headers a passages page carries: HTML, no scripts, no caching. */
const PASSAGES_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
});

/** The passages page as a complete document: no raw document HTML, only text. */
function renderPassagesDocument(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    "<style>body{font-family:system-ui,sans-serif;margin:2rem;line-height:1.5}ol.passage-list{list-style:none;padding:0}.passage{margin:1rem 0;border-bottom:1px solid #b8b8b8;padding-bottom:1rem}</style>",
    "</head>",
    "<body>",
    `<h1>${escapeHtml(title)}</h1>`,
    body,
    "</body>",
    "</html>",
  ].join("\n");
}
