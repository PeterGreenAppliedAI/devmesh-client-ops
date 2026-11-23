/**
 * Unexposed local DOCX import: the transcript core result for a `.docx` file.
 *
 * The adapter accepts the original bytes and the display filename, runs the
 * installed `mammoth` parser in-process (offline, no external resources, no
 * disk writes) to produce the document's word-processing markup as HTML, then
 * reads the plain text out of that markup itself. The original bytes are
 * copied and preserved exactly; they are never mutated, persisted or sent
 * anywhere.
 *
 * Text extraction follows the document's block structure. A block is one
 * paragraph, a heading or a table cell, and the text of a block is its runs
 * joined in document order, a line break inside a run becoming `\n`. Consecutive
 * nonempty blocks are separated by a blank line, which is the separator the
 * transcript core's passages subdivide at, so each passage is exactly one
 * extracted block. A passage therefore names its original (through the core
 * identities) and a block that was extracted from it; it does not claim to be
 * an original paragraph of the DOCX, because a table cell is also a block and
 * a paragraph's runs may be flattened. Locations are the honest UTF-16 range,
 * line and column of the block in the extracted text, as the core defines them.
 *
 * Refusals carry guidance and no usable import: unreadable, corrupt or
 * text-empty documents are refused with the advice to re-export as DOCX or
 * UTF-8 text, and an original or extracted text above the core's inclusive
 * 10 MiB limit is refused without truncation or a partial result.
 */
import mammoth from "mammoth";
import {
  canonicalize,
  MAX_CONTENT_BYTES,
  SUPPORTED_EXPORTS,
  type ImportRefusal,
  type ImportRefusalCode,
  type ImportResult,
  type ImportOutcome,
  type Passage,
  type PassageLocation,
  type PassageRange,
} from "./transcript.ts";
import { createHash } from "node:crypto";
import { ValidationError } from "./model.ts";

/** The format this adapter accepts. */
export const DOCX_FORMAT = "docx" as const;

/** Guidance returned with every refusal: the exports the adapter supports. */
export const DOCX_SUPPORTED_EXPORTS: readonly string[] = Object.freeze([
  ...SUPPORTED_EXPORTS,
  "DOCX files re-exported from a word processor",
]);

/** Guidance for a document that could not be read or carried no text. */
export const RE_EXPORT_GUIDANCE = "Re-export the document as DOCX (Word, .docx) or as UTF-8 text (.txt).";

/**
 * One extracted block: a paragraph, heading or table cell of the DOCX, with
 * the plain text extracted from it and the kind of block it is. `kind` is
 * honest about the extraction: a table cell's text is not an original
 * paragraph, and the transcript result's passages carry the extracted text,
 * not this descriptor.
 */
export interface ExtractedBlock {
  readonly kind: "paragraph" | "heading" | "table_cell";
  readonly text: string;
}

/** The outcome of a DOCX import: a core import result, or a classified refusal. */
export type DocxImportOutcome =
  | { readonly ok: true; readonly result: ImportResult; readonly blocks: readonly ExtractedBlock[] }
  | ImportRefusal;

/**
 * The mammoth dependency the adapter uses. Injecting it lets a test exercise a
 * failing parser without mocking modules or changing the environment; the
 * default is the installed `mammoth`.
 */
export interface DocxParser {
  convertToHtml(input: { buffer: Buffer }): Promise<{ value: string }>;
}

const REAL_PARSER: DocxParser = Object.freeze({
  convertToHtml: (input: { buffer: Buffer }) => mammoth.convertToHtml(input),
});

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** True when the text carries at least one non-whitespace character. */
function hasContent(text: string): boolean {
  return /\S/u.test(text);
}

/** True for the `.docx` extension, in any case. */
function isDocxFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith(".docx");
}

/** Build a refusal outcome with the adapter's guidance and no usable import. */
function refuse(code: ImportRefusalCode, message: string): ImportRefusal {
  return Object.freeze({
    ok: false,
    refusal: Object.freeze({
      code,
      message,
      supportedExports: DOCX_SUPPORTED_EXPORTS,
    }),
  });
}

function tooLarge(what: string, length: number): ImportRefusal {
  return refuse(
    "too_large",
    `The ${what} content is ${length} bytes; it must be at most ${MAX_CONTENT_BYTES} bytes. Nothing was truncated.`,
  );
}

/** The named entities mammoth's HTML writer emits, plus the numeric forms. */
const ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00A0",
});

/** Decode the character data of mammoth's HTML: escape references only. */
function decodeText(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/gu, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body] ?? match;
  });
}

/** Trim the whitespace at the ends of an extracted block. */
function trimBlock(text: string): string {
  return text.replace(/^\s+/u, "").replace(/\s+$/u, "");
}

/**
 * Read the plain text of mammoth's word-processing markup, one entry per
 * block. This is a small linear scan over the HTML: text is accumulated into
 * the current block, a `<p>`, `<h1>`-`<h6>` or `<td>`/`<th>` starts a new
 * block (closing any block still open), `</p>`, `</h>`, `</td>`, `</th>` and
 * `</tr>` close the current block, `<br>` is a line break inside the current
 * block, and every other tag is structure only. A cell that contains
 * paragraphs contributes each of its paragraphs, not the cell again.
 */
export function extractBlocks(html: string): readonly ExtractedBlock[] {
  const blocks: ExtractedBlock[] = [];
  let kind: ExtractedBlock["kind"] = "paragraph";
  let current = "";
  let hasCurrent = false;
  // A block inside a cell (a paragraph or heading) supersedes the cell's own
  // block, so a cell holding paragraphs contributes the paragraphs once.
  let cellDepth = 0;
  let cellSuperseded = false;

  const close = (): void => {
    if (hasCurrent) {
      const text = trimBlock(current);
      if (text !== "" && !(kind === "table_cell" && cellSuperseded)) {
        blocks.push(Object.freeze({ kind, text }));
      }
    }
    current = "";
    hasCurrent = false;
  };

  let index = 0;
  while (index < html.length) {
    const next = html.indexOf("<", index);
    const textEnd = next === -1 ? html.length : next;
    if (textEnd > index) {
      if (!hasCurrent) hasCurrent = true;
      current += decodeText(html.slice(index, textEnd));
    }
    if (next === -1) break;
    const closeIndex = html.indexOf(">", next + 1);
    if (closeIndex === -1) {
      // A truncated tag is not markup; keep the remainder as text.
      if (!hasCurrent) hasCurrent = true;
      current += decodeText(html.slice(next));
      break;
    }
    const tagBody = html.slice(next + 1, closeIndex).trim();
    index = closeIndex + 1;
    if (tagBody === "" || tagBody.startsWith("!")) continue;
    const closing = tagBody.startsWith("/");
    const name = (closing ? tagBody.slice(1) : tagBody).split(/[\s/]/, 1)[0].toLowerCase();

    if (closing) {
      if (name === "td" || name === "th") {
        close();
        cellDepth -= 1;
        if (cellDepth === 0) cellSuperseded = false;
      } else if (name === "p" || name === "tr" || /^h[1-6]$/.test(name)) {
        close();
      }
      continue;
    }
    if (name === "p") {
      close();
      if (cellDepth > 0) cellSuperseded = true;
      kind = "paragraph";
      hasCurrent = true;
    } else if (/^h[1-6]$/.test(name)) {
      close();
      if (cellDepth > 0) cellSuperseded = true;
      kind = "heading";
      hasCurrent = true;
    } else if (name === "td" || name === "th") {
      close();
      cellDepth += 1;
      kind = "table_cell";
      hasCurrent = true;
    } else if (name === "tr") {
      close();
    } else if (name === "br") {
      if (!hasCurrent) hasCurrent = true;
      current += "\n";
    }
  }
  close();
  return Object.freeze(blocks);
}

/**
 * The line breaks in `text`, as UTF-16 offsets: a `\r\n` counts once at its
 * `\r`, and a lone `\r` or `\n` counts once. Linear in the text.
 */
function lineBreakOffsets(text: string): readonly number[] {
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

/** The line and column of an offset, found by binary search in the breaks. */
function locate(text: string, offset: number, breaks: readonly number[]): { line: number; column: number } {
  let low = 0;
  let high = breaks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (breaks[middle] < offset) low = middle + 1;
    else high = middle;
  }
  const line = low + 1;
  let lineStart = 0;
  if (low > 0) {
    const previous = breaks[low - 1];
    lineStart =
      text.charCodeAt(previous) === 13 && text.charCodeAt(previous + 1) === 10 ? previous + 2 : previous + 1;
  }
  return { line, column: offset - lineStart + 1 };
}

/**
 * Build the passages for the extracted text from its blocks. Blocks are joined
 * with a blank line, so each block's text starts at a paragraph boundary and
 * its exact trimmed range is the block's range in the extracted text. Because
 * a block's text was trimmed before joining, and the separator is a blank
 * line, each passage is exactly one block.
 */
function buildPassages(blocks: readonly ExtractedBlock[], extractedText: string, sourceId: string): readonly Passage[] {
  const breaks = lineBreakOffsets(extractedText);
  const passages: Passage[] = [];
  let cursor = 0;
  for (const block of blocks) {
    const range: PassageRange = { start: cursor, end: cursor + block.text.length };
    const { line, column } = locate(extractedText, range.start, breaks);
    const location: PassageLocation = { start: range.start, end: range.end, line, column };
    passages.push(
      Object.freeze({
        id: `${sourceId}/p${passages.length + 1}`,
        sourceId,
        range: Object.freeze(range),
        location: Object.freeze(location),
        text: block.text,
      }),
    );
    // The next block starts after the block's text and the "\n\n" separator.
    cursor = range.end + 2;
  }
  return Object.freeze(passages);
}

/**
 * Import a DOCX file's bytes. The bytes are copied and preserved exactly; the
 * extracted text is the plain text of the document's blocks, joined with blank
 * lines. The result is the transcript core result, with its identities,
 * canonical content and passages.
 *
 * Refusals, all with guidance: a non-`.docx` filename, an original above the
 * inclusive 10 MiB limit, bytes mammoth cannot read (corrupt or unreadable),
 * extracted text above the inclusive limit, or a document with no visible text.
 * A refused import has no usable result.
 *
 * `bytes` must be a `Uint8Array` (a `Buffer` qualifies) and `filename` a
 * nonblank string; anything else is a programming error and throws
 * `ValidationError`.
 */
export async function importDocx(
  bytes: unknown,
  filename: unknown,
  parser: DocxParser = REAL_PARSER,
): Promise<DocxImportOutcome> {
  if (!(bytes instanceof Uint8Array)) {
    throw new ValidationError("file bytes must be a Uint8Array");
  }
  if (typeof filename !== "string" || filename.trim() === "") {
    throw new ValidationError("filename must be a nonblank string");
  }
  const originalBytes = new Uint8Array(bytes);
  if (!isDocxFilename(filename)) {
    return refuse(
      "unsupported_format",
      `The file ${JSON.stringify(filename)} is not a .docx file; ${RE_EXPORT_GUIDANCE}`,
    );
  }
  if (originalBytes.length > MAX_CONTENT_BYTES) {
    return tooLarge("original", originalBytes.length);
  }

  let html: string;
  try {
    const converted = await parser.convertToHtml({ buffer: Buffer.from(originalBytes) });
    if (typeof converted.value !== "string") {
      throw new TypeError("the parser returned no markup");
    }
    html = converted.value;
  } catch {
    return refuse(
      "unreadable_document",
      `The file ${JSON.stringify(filename)} could not be read as a DOCX document (it may be corrupt or not a DOCX file); ${RE_EXPORT_GUIDANCE}`,
    );
  }

  const blocks = extractBlocks(html);
  const extractedText = blocks.map((block) => block.text).join("\n\n");
  const extractedLength = utf8Length(extractedText);
  if (extractedLength > MAX_CONTENT_BYTES) {
    return tooLarge("extracted", extractedLength);
  }
  if (!hasContent(extractedText) || blocks.length === 0) {
    return refuse(
      "whitespace_only",
      `The document ${JSON.stringify(filename)} carries no visible text; ${RE_EXPORT_GUIDANCE}`,
    );
  }

  const canonicalText = canonicalize(extractedText);
  const canonicalIdentity = `sha256:${sha256Hex(utf8Bytes(canonicalText))}`;
  const passages = buildPassages(blocks, extractedText, canonicalIdentity);
  const result: ImportResult = Object.freeze({
    id: canonicalIdentity,
    format: DOCX_FORMAT,
    filename,
    // A DOCX has no plain-text original; the original content is its bytes,
    // preserved exactly. `originalText` is the extracted plain text so that
    // the result satisfies the core's structural validator, and the exact
    // original bytes remain the authority for the original.
    originalText: extractedText,
    originalBytes,
    originalSha256: sha256Hex(originalBytes),
    extractedText,
    canonicalText,
    canonicalIdentity,
    passages,
  });
  return Object.freeze({ ok: true, result, blocks });
}
