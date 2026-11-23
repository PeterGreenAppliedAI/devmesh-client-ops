/**
 * Unexposed text import and provenance core.
 *
 * The core accepts pasted text or UTF-8 `.txt`/`.md` bytes and keeps the
 * original content (text and exact bytes) separate from the text extracted
 * from it. For these three formats extraction is the identity: the extracted
 * text is the decoded text unchanged. Nothing here is persisted, exposed over
 * HTTP or sent anywhere.
 *
 * Two identities are derived from an import:
 *
 * - `originalSha256` is the SHA-256 of the original bytes, so the original
 *   content can be recognised byte-for-byte.
 * - `canonicalIdentity` is the SHA-256 of the canonical content (the extracted
 *   text with whitespace runs collapsed to one space and the ends trimmed).
 *   Case and punctuation remain significant, so content equivalence follows
 *   the canonical content, not the original bytes.
 *
 * Passages subdivide the extracted text at blank-line separators (two line
 * breaks, `\r\n`, `\r` or `\n`, with nothing but spaces and tabs between
 * them), each range trimmed to exact non-whitespace bounds. Ranges are UTF-16
 * code-unit offsets into the extracted text: `start` inclusive, `end`
 * exclusive, so `extractedText.slice(start, end)` is exactly the passage text,
 * whatever the Unicode content. A passage identity is stable for an import: it
 * is the canonical-content identity plus the passage's ordinal. Subdivision
 * and location are single linear passes, so a text at the inclusive limit with
 * very many passages is handled in proportion to its size.
 *
 * A refusal carries guidance naming the supported exports and no usable
 * import: the outcome has no result field at all.
 */
import { createHash } from "node:crypto";
import { ValidationError } from "./model.ts";

/** The inclusive limit, in bytes, for original and extracted UTF-8 content. */
export const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

/** Guidance returned with every refusal: the exports the core supports. */
export const SUPPORTED_EXPORTS: readonly string[] = Object.freeze([
  "Pasted plain text",
  "UTF-8 .txt files",
  "UTF-8 .md files",
]);

/**
 * The formats the core accepts. `docx` is imported by the DOCX adapter
 * (`transcript-docx.ts`) and `pdf` by the PDF adapter (`transcript-pdf.ts`):
 * for both, the original content is the file's bytes, preserved exactly, and
 * the extracted text is read from the document.
 */
export type ImportFormat = "paste" | "txt" | "markdown" | "docx" | "pdf";

/** The formats the core accepts, in guidance order. */
export const IMPORT_FORMATS: readonly ImportFormat[] = Object.freeze([
  "paste",
  "txt",
  "markdown",
  "docx",
  "pdf",
]);

/** Why an import was refused. */
export type ImportRefusalCode =
  | "unsupported_format"
  | "invalid_utf8"
  | "invalid_text"
  | "whitespace_only"
  | "too_large"
  | "unreadable_document";

/** A refused import: no usable import is returned. */
export interface ImportRefusal {
  readonly ok: false;
  readonly refusal: {
    readonly code: ImportRefusalCode;
    readonly message: string;
    /** Guidance naming the supported exports. */
    readonly supportedExports: readonly string[];
  };
}

/** A half-open range of UTF-16 code-unit offsets into the extracted text. */
export interface PassageRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Where a passage sits in the extracted text: the same offsets as its range,
 * plus the 1-based line and column of the range start. A line break is `\n`;
 * a `\r\n`, `\r` or `\n` all advance the line count by one for `\r\n` and `\r`
 * when counting, so locations are honest for every newline style.
 */
export interface PassageLocation {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

/** One passage of the extracted text, with exact bounds and a stable identity. */
export interface Passage {
  /** Stable identity: the source identity plus the passage ordinal. */
  readonly id: string;
  /** The source identity this passage belongs to. */
  readonly sourceId: string;
  readonly range: PassageRange;
  readonly location: PassageLocation;
  /** Exactly `extractedText.slice(range.start, range.end)`. */
  readonly text: string;
  /**
   * For a page-based source (a PDF), the 1-based page the passage's text was
   * extracted from. Absent for sources that are not paginated, whose
   * passages do not claim a page.
   */
  readonly page?: number;
}

/** A successfully imported source. */
export interface ImportResult {
  /** The source identity: equal to `canonicalIdentity`. */
  readonly id: string;
  readonly format: ImportFormat;
  /** The filename shown to the user. */
  readonly filename: string;
  /** The original text exactly as pasted or decoded, before any extraction. */
  readonly originalText: string;
  /** The original bytes exactly as supplied (a copy; never the caller's buffer). */
  readonly originalBytes: Uint8Array;
  /** SHA-256 hex digest of `originalBytes`. */
  readonly originalSha256: string;
  /** The text extracted from the original content. */
  readonly extractedText: string;
  /** The extracted text with whitespace runs collapsed and ends trimmed. */
  readonly canonicalText: string;
  /** `sha256:` plus the SHA-256 hex digest of `canonicalText` in UTF-8. */
  readonly canonicalIdentity: string;
  readonly passages: readonly Passage[];
}

/** The outcome of an import: either a successful result or a refusal. */
export type ImportOutcome =
  | { readonly ok: true; readonly result: ImportResult }
  | ImportRefusal;

/** A citation reference: it names a source, a passage and the passage's range. */
export interface PassageReference {
  readonly sourceId: string;
  readonly passageId: string;
  readonly range: PassageRange;
}

/** A citation resolved against the authoritative source and passage. */
export interface ResolvedCitation {
  readonly sourceId: string;
  readonly passageId: string;
  readonly range: PassageRange;
  readonly location: PassageLocation;
  /** The authoritative passage text, never a caller's quotation. */
  readonly quote: string;
}

/** Error raised when a reference names a different source than the authoritative one. */
export class WrongSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WrongSourceError";
  }
}

/** Error raised when a reference names a passage the authoritative source does not have. */
export class MissingPassageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingPassageError";
  }
}

/** True for a value a text decoder or encoder accepts as a UTF-8 byte view. */
function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * The canonical content: whitespace runs collapsed to one space and the ends
 * trimmed. Case and punctuation are untouched.
 */
export function canonicalize(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** The canonical-content identity for a text. */
export function canonicalIdentityOf(text: string): string {
  return `sha256:${sha256Hex(utf8Bytes(canonicalize(text)))}`;
}

/** True when `value` is whitespace or a line terminator per JavaScript `\s`. */
const WHITESPACE = /\s/;

/** True when the text carries at least one non-whitespace character. */
function hasContent(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (!WHITESPACE.test(text[index])) return true;
  }
  return false;
}

/** Trim a half-open range to its exact non-whitespace bounds. */
function trimRange(text: string, start: number, end: number): PassageRange {
  while (start < end && WHITESPACE.test(text[start])) start += 1;
  while (end > start && WHITESPACE.test(text[end - 1])) end -= 1;
  return { start, end };
}

/**
 * The line breaks in `text`, in order, as UTF-16 offsets: each `\r\n` counts
 * once (at its `\r`), and a `\r` or `\n` not part of `\r\n` counts once. The
 * scan is linear and independent of the text's newline style, so it stays
 * practical at the inclusive limit even for text made only of `\r` breaks.
 */
function lineBreakOffsets(text: string): number[] {
  const offsets: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 13) {
      offsets.push(index);
      if (text.charCodeAt(index + 1) === 10) index += 1;
    } else if (code === 10) {
      offsets.push(index);
    }
  }
  return offsets;
}

/**
 * The line and column of the first line break at or after `offset`, found in
 * the sorted `breaks` list by binary search, so checking many passages never
 * rescans the text. A line break ends a line: the line starts after its last
 * code unit.
 */
function locate(
  text: string,
  offset: number,
  breaks: readonly number[],
): { line: number; column: number } {
  let low = 0;
  let high = breaks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (breaks[middle] < offset) low = middle + 1;
    else high = middle;
  }
  const index = low;
  const line = index + 1;
  let lineStart = 0;
  if (index > 0) {
    const previous = breaks[index - 1];
    lineStart = text.charCodeAt(previous) === 13 && text.charCodeAt(previous + 1) === 10 ? previous + 2 : previous + 1;
  }
  return { line, column: offset - lineStart + 1 };
}

/** True when `text` at `index` starts a line break (`\r\n`, `\r` or `\n`). */
function isLineBreak(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code === 13 || code === 10;
}

/** The offset just past the line break starting at `index`. */
function afterLineBreak(text: string, index: number): number {
  return text.charCodeAt(index) === 13 && text.charCodeAt(index + 1) === 10 ? index + 2 : index + 1;
}

/**
 * Subdivide the extracted text into passages at blank-line separators: two line
 * breaks with nothing but spaces and tabs between them. Each passage is
 * trimmed to exact bounds and carries its range, location and identity. A
 * single linear scan finds every separator, so the whole text is visited once
 * however many passages it holds.
 */
function subdivide(text: string, sourceId: string): readonly Passage[] {
  const breaks = lineBreakOffsets(text);
  const spans: PassageRange[] = [];
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    if (!isLineBreak(text, index)) {
      index += 1;
      continue;
    }
    const afterFirst = afterLineBreak(text, index);
    let scan = afterFirst;
    while (scan < text.length && (text.charCodeAt(scan) === 32 || text.charCodeAt(scan) === 9)) scan += 1;
    if (scan < text.length && isLineBreak(text, scan)) {
      // The separator runs from the first line break through the second.
      const end = afterLineBreak(text, scan);
      spans.push(trimRange(text, cursor, index));
      cursor = end;
      index = end;
    } else {
      index = afterFirst;
    }
  }
  spans.push(trimRange(text, cursor, text.length));

  const passages: Passage[] = [];
  for (const span of spans) {
    if (span.start >= span.end) continue;
    const { line, column } = locate(text, span.start, breaks);
    passages.push(
      Object.freeze({
        id: `${sourceId}/p${passages.length + 1}`,
        sourceId,
        range: Object.freeze({ start: span.start, end: span.end }),
        location: Object.freeze({ start: span.start, end: span.end, line, column }),
        text: text.slice(span.start, span.end),
      }),
    );
  }
  return Object.freeze(passages);
}

/** Build a refusal outcome. */
function refuse(code: ImportRefusalCode, message: string): ImportRefusal {
  return Object.freeze({
    ok: false,
    refusal: Object.freeze({
      code,
      message,
      supportedExports: SUPPORTED_EXPORTS,
    }),
  });
}

function tooLarge(what: string, length: number): ImportRefusal {
  return refuse(
    "too_large",
    `The ${what} content is ${length} bytes; it must be at most ${MAX_CONTENT_BYTES} bytes. Nothing was truncated.`,
  );
}

/**
 * Shared assembly: check the original and extracted content, then build the
 * successful outcome. The original content is preserved separately from the
 * extracted text; for these formats they hold the same text.
 */
function assemble(
  format: ImportFormat,
  filename: string,
  originalText: string,
  originalBytes: Uint8Array,
): ImportOutcome {
  if (originalBytes.length > MAX_CONTENT_BYTES) {
    return tooLarge("original", originalBytes.length);
  }
  const extractedText = originalText;
  const extractedLength = utf8Length(extractedText);
  if (extractedLength > MAX_CONTENT_BYTES) {
    return tooLarge("extracted", extractedLength);
  }
  if (!hasContent(extractedText)) {
    return refuse(
      "whitespace_only",
      `The content is empty or only whitespace; import pasted text, or a UTF-8 .txt or .md file with visible text.`,
    );
  }

  const canonicalText = canonicalize(extractedText);
  const canonicalIdentity = `sha256:${sha256Hex(utf8Bytes(canonicalText))}`;
  const passages = subdivide(extractedText, canonicalIdentity);
  if (passages.length === 0) {
    // Unreachable for content that passed the whitespace check, but refuse
    // rather than return a source with no passages.
    return refuse(
      "whitespace_only",
      `The content is empty or only whitespace; import pasted text, or a UTF-8 .txt or .md file with visible text.`,
    );
  }

  const originalCopy = new Uint8Array(originalBytes);
  const result: ImportResult = Object.freeze({
    id: canonicalIdentity,
    format,
    filename,
    originalText,
    originalBytes: originalCopy,
    originalSha256: sha256Hex(originalCopy),
    extractedText,
    canonicalText,
    canonicalIdentity,
    passages,
  });
  return Object.freeze({ ok: true, result });
}

/** The display filename for pasted text. */
const PASTE_FILENAME = "Pasted text";

/**
 * True when `text` is well formed Unicode: every UTF-16 code unit is a code
 * point on its own except a high surrogate, which must be followed by a low
 * surrogate. Text with a lone surrogate cannot be encoded as UTF-8 without
 * replacing it, which would make the original text and the original bytes
 * disagree, so it is refused rather than silently changed.
 */
function isWellFormed(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * Import pasted text. The text is preserved exactly as given (including its
 * whitespace, line endings and BOM) as the original content; the extracted text
 * is the same text. Ill-formed text carrying a lone surrogate is refused with
 * guidance before it could be encoded lossily. A non-string argument is a
 * programming error and is refused with `ValidationError`; content problems
 * return a refusal.
 */
export function importPastedText(text: unknown): ImportOutcome {
  if (typeof text !== "string") {
    throw new ValidationError("pasted text must be a string");
  }
  if (!isWellFormed(text)) {
    return refuse(
      "invalid_text",
      `The pasted text is not well-formed Unicode (it contains a lone surrogate); import pasted text, or a UTF-8 .txt or .md file.`,
    );
  }
  return assemble("paste", PASTE_FILENAME, text, utf8Bytes(text));
}

/** The format named by a filename's extension, or null when unsupported. */
function formatOfFilename(filename: string): ImportFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".txt")) return "txt";
  if (lower.endsWith(".md")) return "markdown";
  return null;
}

/**
 * Import a UTF-8 `.txt` or `.md` file's bytes. The bytes are copied, never
 * mutated, and preserved exactly; the extracted text is the strict UTF-8
 * decoding of them, which keeps a byte-order mark. Invalid UTF-8 and an
 * unsupported extension are refused with guidance.
 *
 * `bytes` must be a `Uint8Array` (a `Buffer` qualifies) and `filename` a
 * nonblank string; anything else is a programming error and throws
 * `ValidationError`.
 */
export function importFileBytes(bytes: unknown, filename: unknown): ImportOutcome {
  if (!isBytes(bytes)) {
    throw new ValidationError("file bytes must be a Uint8Array");
  }
  if (typeof filename !== "string" || filename.trim() === "") {
    throw new ValidationError("filename must be a nonblank string");
  }
  const format = formatOfFilename(filename);
  if (format === null) {
    return refuse(
      "unsupported_format",
      `The file ${JSON.stringify(filename)} is not a supported format; import pasted text, or a UTF-8 .txt or .md file.`,
    );
  }

  const copy = new Uint8Array(bytes);
  if (copy.length > MAX_CONTENT_BYTES) {
    return tooLarge("original", copy.length);
  }

  let extractedText: string;
  try {
    // `ignoreBOM: true` keeps a byte-order mark in the text, so the extracted
    // text preserves the file's content rather than silently dropping it.
    extractedText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(copy);
  } catch {
    return refuse(
      "invalid_utf8",
      `The file ${JSON.stringify(filename)} is not valid UTF-8; import pasted text, or a UTF-8 .txt or .md file.`,
    );
  }
  return assemble(format, filename, extractedText, copy);
}

//
// Strict structural validators. Each accepts an unknown value, refuses anything
// with a missing, extra or mistyped field (and inconsistent content) with
// `ValidationError`, and returns the value unchanged when it is valid.
//

const HASH = /^[0-9a-f]{64}$/;
const IDENTITY = /^sha256:[0-9a-f]{64}$/;

function requireRecord(value: unknown, what: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`${what} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) {
      throw new ValidationError(`${what} has unsupported field ${JSON.stringify(key)}`);
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ValidationError(`${what} is missing field ${JSON.stringify(key)}`);
    }
  }
  return record;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string") throw new ValidationError(`${what} must be a string`);
  return value;
}

function requireNonblank(value: unknown, what: string): string {
  const text = requireString(value, what);
  if (text.trim() === "") throw new ValidationError(`${what} must be a nonblank string`);
  return text;
}

function requireOffset(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`${what} must be a non-negative safe integer`);
  }
  return value;
}

function requireRange(value: unknown, what: string): PassageRange {
  const record = requireRecord(value, what, ["start", "end"]);
  const start = requireOffset(record.start, `${what}.start`);
  const end = requireOffset(record.end, `${what}.end`);
  if (start >= end) throw new ValidationError(`${what} must have start before end`);
  return { start, end };
}

/** Validate the structure of one passage, without checking it against a source. */
export function validatePassage(value: unknown): Passage {
  if (typeof value === "object" && value !== null && "page" in value) {
    return validatePagePassage(value);
  }
  const record = requireRecord(value, "passage", ["id", "sourceId", "range", "location", "text"]);
  const id = requireNonblank(record.id, "passage.id");
  const sourceId = requireNonblank(record.sourceId, "passage.sourceId");
  const range = requireRange(record.range, "passage.range");
  const locationRecord = requireRecord(record.location, "passage.location", [
    "start",
    "end",
    "line",
    "column",
  ]);
  const start = requireOffset(locationRecord.start, "passage.location.start");
  const end = requireOffset(locationRecord.end, "passage.location.end");
  const line = requireOffset(locationRecord.line, "passage.location.line");
  const column = requireOffset(locationRecord.column, "passage.location.column");
  if (start !== range.start || end !== range.end) {
    throw new ValidationError("passage.location must match the passage range");
  }
  if (line < 1 || column < 1) {
    throw new ValidationError("passage.location line and column must be at least 1");
  }
  const text = requireString(record.text, "passage.text");
  if (text !== text.trim()) {
    throw new ValidationError("passage.text must not carry leading or trailing whitespace");
  }
  if (text === "") throw new ValidationError("passage.text must not be empty");
  return value as Passage;
}

/**
 * Validate the structure of one page-based passage: the core passage fields
 * plus its 1-based page. The page must be a positive safe integer.
 */
function validatePagePassage(value: unknown): Passage {
  const record = requireRecord(value, "passage", ["id", "sourceId", "range", "location", "text", "page"]);
  const { page: _page, ...core } = record;
  validatePassage(Object.freeze(core));
  if (!Number.isSafeInteger(record.page) || (record.page as number) < 1) {
    throw new ValidationError("passage.page must be a 1-based safe integer");
  }
  return value as Passage;
}

/** Validate the structure of a citation reference, refusing extra fields. */
export function validatePassageReference(value: unknown): PassageReference {
  const record = requireRecord(value, "citation reference", ["sourceId", "passageId", "range"]);
  const sourceId = requireNonblank(record.sourceId, "citation reference.sourceId");
  const passageId = requireNonblank(record.passageId, "citation reference.passageId");
  const range = requireRange(record.range, "citation reference.range");
  return { sourceId, passageId, range };
}

/** Validate one passage against its source's extracted text. */
function requirePassageInSource(passage: Passage, extractedText: string, index: number): void {
  if (passage.range.end > extractedText.length) {
    throw new ValidationError(`passage ${index} range runs past the extracted text`);
  }
  if (extractedText.slice(passage.range.start, passage.range.end) !== passage.text) {
    throw new ValidationError(`passage ${index} text does not match its exact range`);
  }
  if (passage.text !== passage.text.trim() || passage.text === "") {
    throw new ValidationError(`passage ${index} text must be nonempty and trimmed`);
  }
}

/**
 * Strictly validate a whole import result: exact field set and types, the
 * original bytes and text consistent and within the inclusive limit, extracted
 * text within the limit, canonical content and identities recomputed, and
 * passages in order with exact, non-overlapping ranges and matching identities.
 * Throws `ValidationError` on anything inconsistent.
 */
export function validateImportResult(value: unknown): ImportResult {
  const record = requireRecord(value, "import result", [
    "id",
    "format",
    "filename",
    "originalText",
    "originalBytes",
    "originalSha256",
    "extractedText",
    "canonicalText",
    "canonicalIdentity",
    "passages",
  ]);
  const id = requireString(record.id, "import result.id");
  const format = requireString(record.format, "import result.format");
  if (!(IMPORT_FORMATS as readonly string[]).includes(format)) {
    throw new ValidationError(`import result.format must be one of ${IMPORT_FORMATS.join(", ")}`);
  }
  const filename = requireNonblank(record.filename, "import result.filename");
  const originalText = requireString(record.originalText, "import result.originalText");
  if (!isBytes(record.originalBytes)) {
    throw new ValidationError("import result.originalBytes must be a Uint8Array");
  }
  const originalBytes = record.originalBytes;
  if (originalBytes.length > MAX_CONTENT_BYTES) {
    throw new ValidationError("import result.originalBytes exceeds the content limit");
  }
  const originalSha256 = requireString(record.originalSha256, "import result.originalSha256");
  if (!HASH.test(originalSha256)) {
    throw new ValidationError("import result.originalSha256 must be a lowercase hex SHA-256");
  }
  const extractedText = requireString(record.extractedText, "import result.extractedText");
  if (utf8Length(extractedText) > MAX_CONTENT_BYTES) {
    throw new ValidationError("import result.extractedText exceeds the content limit");
  }
  if (!hasContent(extractedText)) {
    throw new ValidationError("import result.extractedText must carry visible text");
  }
  const canonicalText = requireString(record.canonicalText, "import result.canonicalText");
  const canonicalIdentity = requireString(record.canonicalIdentity, "import result.canonicalIdentity");
  if (!IDENTITY.test(canonicalIdentity)) {
    throw new ValidationError("import result.canonicalIdentity must be sha256: plus lowercase hex");
  }

  // These formats' original content is the text itself, so the original bytes
  // must encode the original text exactly. A DOCX or PDF original is binary
  // content, so its bytes are the authority and are not text.
  const textualOriginal = format !== "docx" && format !== "pdf";
  if (textualOriginal) {
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(originalBytes);
    } catch {
      throw new ValidationError("import result.originalBytes must be valid UTF-8");
    }
    if (decoded !== originalText) {
      throw new ValidationError("import result.originalBytes must encode originalText exactly");
    }
    if (extractedText !== originalText) {
      throw new ValidationError("import result.extractedText must equal the original text for this format");
    }
  }
  // The hash always describes the stored bytes.
  if (sha256Hex(originalBytes) !== originalSha256) {
    throw new ValidationError("import result.originalSha256 does not match originalBytes");
  }

  if (canonicalText !== canonicalize(extractedText)) {
    throw new ValidationError("import result.canonicalText is not the canonical content");
  }
  if (canonicalIdentity !== canonicalIdentityOf(extractedText)) {
    throw new ValidationError("import result.canonicalIdentity does not match the canonical content");
  }
  if (id !== canonicalIdentity) {
    throw new ValidationError("import result.id must equal canonicalIdentity");
  }

  if (!Array.isArray(record.passages)) {
    throw new ValidationError("import result.passages must be an array");
  }
  const passages = record.passages as readonly unknown[];
  if (passages.length === 0) {
    throw new ValidationError("import result.passages must not be empty");
  }
  let previousEnd = 0;
  const seen = new Set<string>();
  const validated: Passage[] = [];
  // The line breaks are found once and every location is looked up in that
  // list, so validating a result with many passages stays linear.
  const breaks = lineBreakOffsets(extractedText);
  for (let index = 0; index < passages.length; index += 1) {
    const passage = validatePassage(passages[index]);
    requirePassageInSource(passage, extractedText, index);
    if (passage.sourceId !== id) {
      throw new ValidationError(`passage ${index} sourceId must equal the result id`);
    }
    if (passage.id !== `${id}/p${index + 1}`) {
      throw new ValidationError(`passage ${index} id must be ${id}/p${index + 1}`);
    }
    if (seen.has(passage.id)) {
      throw new ValidationError(`passage ${index} id is duplicated`);
    }
    seen.add(passage.id);
    if (passage.range.start < previousEnd) {
      throw new ValidationError(`passage ${index} overlaps the previous passage`);
    }
    const { line, column } = locate(extractedText, passage.range.start, breaks);
    if (passage.location.line !== line || passage.location.column !== column) {
      throw new ValidationError(`passage ${index} location is not the real line and column`);
    }
    previousEnd = passage.range.end;
    validated.push(passage);
  }

  return value as ImportResult;
}

/**
 * Resolve a citation reference against the authoritative source and passage.
 * The reference's source and passage identities and range must match the
 * supplied source and passage exactly, and the passage must be one the source
 * actually holds; the quotation is then read from the source's extracted text,
 * never from the caller. A wrong source throws `WrongSourceError`, an unknown
 * passage throws `MissingPassageError`, and an invalid or mismatched reference,
 * passage or source throws `ValidationError`.
 */
export function resolveCitation(
  reference: unknown,
  source: unknown,
  passage: unknown,
): ResolvedCitation {
  const ref = validatePassageReference(reference);
  const authoritative = validateImportResult(source);
  const candidate = validatePassage(passage);

  if (ref.sourceId !== authoritative.id) {
    throw new WrongSourceError(
      `The reference names source ${JSON.stringify(ref.sourceId)} but the authoritative source is ${JSON.stringify(authoritative.id)}`,
    );
  }
  if (candidate.sourceId !== authoritative.id) {
    throw new WrongSourceError(
      `The passage belongs to source ${JSON.stringify(candidate.sourceId)} but the authoritative source is ${JSON.stringify(authoritative.id)}`,
    );
  }
  const stored = authoritative.passages.find((entry) => entry.id === candidate.id);
  if (stored === undefined) {
    throw new MissingPassageError(
      `Source ${JSON.stringify(authoritative.id)} has no passage ${JSON.stringify(candidate.id)}`,
    );
  }
  if (ref.passageId !== candidate.id) {
    throw new MissingPassageError(
      `The reference names passage ${JSON.stringify(ref.passageId)} but the supplied passage is ${JSON.stringify(candidate.id)}`,
    );
  }
  if (
    stored.range.start !== candidate.range.start ||
    stored.range.end !== candidate.range.end ||
    stored.text !== candidate.text ||
    stored.location.line !== candidate.location.line ||
    stored.location.column !== candidate.location.column
  ) {
    throw new ValidationError("The supplied passage does not match the passage the source holds");
  }
  if (ref.range.start !== stored.range.start || ref.range.end !== stored.range.end) {
    throw new ValidationError(
      `The reference range ${ref.range.start}-${ref.range.end} does not match the passage range ${stored.range.start}-${stored.range.end}`,
    );
  }

  const quote = authoritative.extractedText.slice(stored.range.start, stored.range.end);
  if (quote !== stored.text) {
    throw new ValidationError("The authoritative passage text does not match its exact range");
  }
  return Object.freeze({
    sourceId: authoritative.id,
    passageId: stored.id,
    range: stored.range,
    location: stored.location,
    quote,
  });
}
