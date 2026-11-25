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
 * a segment that is not the exact encoding, a missing record or a reference
 * that does not belong to the resolved meeting is a 404 and no read is
 * attempted. The original bytes
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
 * Every displayed value is escaped. Every id in a link is encoded as one path
 * segment through `encodeSegment`: a fixed prefix plus the base64url of the
 * id's code-unit hex spelling. The encoding is lossless and collision-free for
 * every stored string (lone surrogates and an initial U+FEFF included),
 * contains only URL, path and HTML-safe characters, and never reads as `.` or
 * `..`, so no browser URL resolution can drop or re-split a segment. The
 * handler decodes it exactly once, and a segment that is not exactly that
 * encoding is refused as a missing record.
 */
import { escapeHtml, renderPage, type Page } from "./html.ts";
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

/** The three exact view literals a source path may end with. */
const SOURCE_VIEWS: readonly SourceView[] = Object.freeze(["original", "text", "passages"]);

/**
 * Match a request path against the fixed source patterns and return the
 * matched shape, the view and the still-encoded segment ids, or null for any
 * other path so an unregistered path is refused before any handler runs. Only
 * the three exact view literals match (an ordinary object's inherited
 * property names such as `constructor` name no view), and the path must be
 * root-relative with no empty segment. The ids are not decoded here: a segment
 * that is not the exact encoding names no record, which the handler answers as
 * a 404.
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
  // A path must start with the separator; `split` then yields an empty first
  // element, so every segment after it is checked and no leading component is
  // silently discarded.
  if (!pathname.startsWith("/")) return null;
  const parts = pathname.split("/");
  if (parts[0] !== "" || parts.length !== 8) return null;
  if (parts.slice(1).some((part) => part === "")) return null;
  // `/meetings/:id/transcripts/:transcriptId/sources/:sourceId/:view`
  if (parts[1] !== "meetings" || parts[3] !== "transcripts" || parts[5] !== "sources") return null;
  const last = parts[7];
  if (!(SOURCE_VIEWS as readonly string[]).includes(last)) return null;
  const view = last as SourceView;
  return {
    pattern: `/meetings/:id/transcripts/:transcriptId/sources/:sourceId/${view}`,
    view,
    meetingId: parts[2],
    transcriptId: parts[4],
    sourceId: parts[6],
  };
}

/** The fixed prefix of every encoded segment: never part of base64url. */
const SEGMENT_PREFIX = "~";

/**
 * The code-unit hex spelling of a JavaScript string: every UTF-16 code unit of
 * the string as exactly four lowercase hex digits. It is lossless for every
 * string JavaScript can hold, including lone surrogate halves (which UTF-8
 * cannot round-trip) and an initial U+FEFF (which a UTF-8 decoder otherwise
 * strips), and it is collision-free because each string has exactly one
 * spelling.
 */
function unitHex(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    out += value.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return out;
}

/** Decode a code-unit hex spelling exactly; anything else names no record. */
function fromUnitHex(hex: string): string {
  if (hex.length % 4 !== 0 || !/^[0-9a-f]*$/.test(hex)) throw new MissingRecordError("No record for that path");
  let out = "";
  for (let index = 0; index < hex.length; index += 4) {
    out += String.fromCharCode(parseInt(hex.slice(index, index + 4), 16));
  }
  return out;
}

/**
 * The single-segment encoding of one record id: the fixed prefix `~` and the
 * base64url of the code-unit hex spelling above. It is reversible and
 * collision-free for every stored string, its alphabet (letters, digits, `-`,
 * `_`) is safe in a path segment, a query and an HTML attribute, and no value
 * starts with a dot, so a browser's URL resolution never drops or re-reads it.
 */
function encodeSegment(value: string): string {
  const hex = unitHex(value);
  return `${SEGMENT_PREFIX}${hex === "" ? "" : Buffer.from(hex, "utf8").toString("base64url")}`;
}

/**
 * The single-segment encoding of a stored record id for a link. A record id is
 * never empty (the store refuses a blank one), so a blank value names no record
 * and is refused here rather than encoded into a link; every other value is the
 * reversible encoding above.
 */
function recordSegment(value: string): string {
  if (value === "") {
    throw new MissingRecordError("No record for that path");
  }
  return encodeSegment(value);
}

/**
 * Decode exactly one segment id, once. Only the exact spelling `encodeSegment`
 * produces is accepted; anything else (a bare id, a percent-escaped spelling, a
 * padded base64, a non-canonical tail, an invalid code-unit spelling or the
 * blank encoding) names no record and is a `MissingRecordError`. The result is
 * the exact stored string, so two ids differing in one code unit never decode
 * alike.
 */
function decodeSegment(raw: string): string {
  if (!raw.startsWith(SEGMENT_PREFIX)) throw new MissingRecordError("No record for that path");
  const body = raw.slice(SEGMENT_PREFIX.length);
  if (body === "" || !/^[A-Za-z0-9_-]+$/.test(body)) throw new MissingRecordError("No record for that path");
  let hex: string;
  try {
    hex = Buffer.from(body, "base64url").toString("utf8");
  } catch {
    throw new MissingRecordError("No record for that path");
  }
  const decoded = fromUnitHex(hex);
  // Re-encoding is the canonical-form check: it rejects padding, unused tail
  // bits (whose bits spill into the decoded bytes) and any other spelling.
  if (encodeSegment(decoded) !== raw) throw new MissingRecordError("No record for that path");
  return decoded;
}

/** The path of one source's view, from the stored ids of its records. */
export function sourceHref(
  meetingId: string,
  transcriptId: string,
  sourceId: string,
  view: SourceView,
): string {
  return (
    `/meetings/${recordSegment(meetingId)}` +
    `/transcripts/${recordSegment(transcriptId)}` +
    `/sources/${recordSegment(sourceId)}/${view}`
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
 * filename and format and the three read-only links. An empty list says so; the
 * meeting's own import action is already offered on the page, so the section
 * adds no second one. It never claims a source that is missing.
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
    // An empty list says so; the meeting detail already offers the import form
    // in its header, so the section repeats no second import action.
    return [
      `<p>No transcript sources recorded yet.</p>`,
      `<p>${escapeHtml("A source appears here once a transcript is imported for this meeting.")}</p>`,
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

/**
 * The location label a passage row shows, chosen by the source format, never by
 * the presence of a recorded page alone: a PDF names the page it recorded, and
 * a DOCX names the extracted block it came from (it has no page). A pasted or
 * plain-text source records no page, so it names none.
 */
function passageLocationText(passage: Passage, format: TranscriptSource["format"]): string {
  if (format === "pdf") return passage.page === undefined ? "" : `PDF page ${passage.page}`;
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
 * transcript cannot collide. Each id's exact code units are written as four
 * lowercase hex digits each (`unitHex`), which is lossless and collision-free:
 * no two distinct stored passage ids, including `p.1`/`p_1` and supplementary
 * characters, share an anchor, and every character round-trips. The result is
 * a safe HTML `id` value.
 */
export function passageAnchorId(sourceId: string, passageId: string): string {
  return `passage-${unitHex(sourceId)}-${unitHex(passageId)}`;
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
  ): Promise<
    | OriginalBytesResponse
    | { readonly status: number; readonly body: string; readonly headers?: Readonly<Record<string, string>> }
    | Page
  >;
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
 *
 * The text answer and the passages page are the shell's own shapes: a plain
 * text result keeps the shell's text Content-Type and no-store policy, and the
 * passages page is the existing `renderPage` helper's result, which the shell
 * wraps in its shared layout exactly like every other page.
 */
export function transcriptSourceRoutes(store: Store): TranscriptSourceRoutes {
  const snapshot = (): Snapshot => store.snapshot();
  let service: TranscriptStore | null = null;
  const borrow = (): TranscriptStore => (service ??= transcriptService(store));

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
        // The exact extracted text as UTF-8, with no added newline; the shell
        // sends it as plain text with its own Content-Type and no-store policy.
        return { status: 200, body: read.extractedText };
      }
      const section = passagesSection(read, read.meetingId);
      // The existing `renderPage` helper's page and its own headers, with
      // `nosniff` added on this page only; the shell forwards page headers and
      // sets Content-Type and no-store itself.
      const page = renderPage(section.title, section.body);
      return { ...page, headers: { ...page.headers, "X-Content-Type-Options": "nosniff" } };
    },
  });

  return {
    original: { get: get("original") },
    text: { get: get("text") },
    passages: { get: get("passages") },
  };
}
