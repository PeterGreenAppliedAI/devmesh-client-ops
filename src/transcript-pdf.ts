/**
 * Unexposed local text-based PDF import: the transcript core result for a
 * `.pdf` file.
 *
 * The adapter accepts the original bytes and the display filename, parses them
 * in-process with the installed `pdfjs-dist` legacy build (offline, no remote
 * assets, no rendering, no disk writes), and reads each page's text items in
 * document order. The original bytes are copied and preserved exactly; they are
 * never mutated, persisted or sent anywhere. The parser normally transfers the
 * working buffer it is given to its worker, so it only ever receives a copy:
 * the caller's bytes and the preserved original stay intact.
 *
 * Extraction is page by page. A page contributes its text items joined with
 * single spaces, whitespace runs collapsed and the ends trimmed; blank pages
 * contribute no text, so a page with no text has no passage (its 1-based page
 * is still skipped, not renumbered). The pages are joined with a blank line, which is the separator the
 * transcript core's passages subdivide at, so each passage is exactly one
 * page's extracted text. Every passage therefore identifies its retained
 * original (through the core identities) and the 1-based page it came from.
 * A page whose extraction fails fails the whole import: no partial extraction
 * is ever published as a complete result.
 *
 * Refusals carry guidance and no usable import: a document whose pages carry
 * no text (for example an image-only scan) is refused because OCR is
 * unavailable, advising a text-based export; corrupt, password-protected or
 * unreadable documents are refused with re-export guidance; and an original or
 * extracted text above the core's inclusive 10 MiB limit is refused without
 * truncation or a partial result. Parser resources are released whether the
 * import succeeds or fails.
 */
import {
  getDocument,
  InvalidPDFException,
  PasswordException,
  VerbosityLevel,
  version as PDFJS_VERSION,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { createHash } from "node:crypto";
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
import { ValidationError } from "./model.ts";

/** The format this adapter accepts. */
export const PDF_FORMAT = "pdf" as const;

/** Guidance returned with every refusal: the exports the adapter supports. */
export const PDF_SUPPORTED_EXPORTS: readonly string[] = Object.freeze([
  ...SUPPORTED_EXPORTS,
  "Text-based PDF files exported with selectable text",
]);

/** Guidance for a corrupt, password-protected or unreadable document. */
export const RE_EXPORT_GUIDANCE =
  "Re-export the document as a text-based PDF with selectable text, or as UTF-8 text (.txt).";

/** Guidance for a document with no extractable text. */
export const OCR_UNAVAILABLE_GUIDANCE =
  "OCR is unavailable, so a scanned or image-only PDF cannot be imported; export a text-based copy of the document with selectable text, or export it as UTF-8 text (.txt).";

/** The 1-based page number a passage's text was extracted from. */
export interface PassagePage {
  readonly page: number;
}

/** One extracted page: its 1-based number and the text extracted from it. */
export interface ExtractedPage {
  /** The page's 1-based position in the document. */
  readonly page: number;
  /** The page's text, or the empty string when the page carries no text. */
  readonly text: string;
}

/**
 * The PDF adapter's import result: the core result, with the `pdf` format. The
 * core result's field set is otherwise unchanged; the core validator's format
 * list predates the PDF adapter, so it is not applied through the core here.
 */
export type PdfImportResult = Omit<ImportResult, "format"> & { readonly format: typeof PDF_FORMAT };

/** The outcome of a PDF import: a core result, or a classified refusal. */
export type PdfImportOutcome =
  | {
      readonly ok: true;
      readonly result: PdfImportResult;
      readonly pages: readonly ExtractedPage[];
      /** The 1-based page of each passage, in passage order. */
      readonly passagePages: readonly PassagePage[];
    }
  | ImportRefusal;

/** The text items of one page, as the parser returns them. */
export interface PdfTextContent {
  readonly items: readonly { readonly str?: unknown }[];
}

/** One page of a loaded document, as the parser returns it. */
export interface PdfPage {
  getTextContent(): Promise<PdfTextContent>;
}

/** A loaded document, as the parser returns it. */
export interface PdfDocument {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
}

/** A document loading task, as the parser returns it. */
export interface PdfLoadingTask {
  readonly promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

/**
 * The parser the adapter uses. Injecting it lets a test exercise parser
 * failures (a corrupt file, a document that will not open, one page failing or
 * resources not releasing) without mocking modules or changing the
 * environment; the default is the installed `pdfjs-dist`.
 */
export interface PdfParser {
  /** Parse the bytes into a loading task; the bytes are the adapter's copy. */
  load(data: Uint8Array): PdfLoadingTask;
}

/** Options the adapter passes to the parser: no rendering, local assets only. */
export const PDF_LOAD_OPTIONS = Object.freeze({
  verbosity: VerbosityLevel.ERRORS,
  // No remote or install-script-generated assets: the installed package
  // resolves its own local CMap, standard font and wasm files, and nothing is
  // fetched over the network. Extraction needs no rendering worker.
  disableRange: true,
  disableStream: true,
  disableAutoFetch: true,
  disableWorkerRendering: true,
  useWorkerFetch: false,
  useSystemFonts: false,
});

/** The installed `pdfjs-dist` parser. */
const REAL_PARSER: PdfParser = Object.freeze({
  load: (data: Uint8Array): PdfLoadingTask => {
    const task = getDocument({ ...PDF_LOAD_OPTIONS, data });
    return Object.freeze({
      promise: task.promise as unknown as Promise<PdfDocument>,
      destroy: () => task.destroy(),
    });
  },
});

/** The parser's error name, for classifying a refusal. */
function errorName(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "";
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

/** True when the text carries at least one non-whitespace character. */
function hasContent(text: string): boolean {
  return /\S/u.test(text);
}

/** True for the `.pdf` extension, in any case. */
function isPdfFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith(".pdf");
}

/** Build a refusal outcome with the adapter's guidance and no usable import. */
function refuse(code: ImportRefusalCode, message: string): ImportRefusal {
  return Object.freeze({
    ok: false,
    refusal: Object.freeze({
      code,
      message,
      supportedExports: PDF_SUPPORTED_EXPORTS,
    }),
  });
}

function tooLarge(what: string, length: number): ImportRefusal {
  return refuse(
    "too_large",
    `The ${what} content is ${length} bytes; it must be at most ${MAX_CONTENT_BYTES} bytes. Nothing was truncated.`,
  );
}

function corrupt(filename: string): ImportRefusal {
  return refuse(
    "unreadable_document",
    `The file ${JSON.stringify(filename)} could not be read as a PDF document (it may be corrupt or not a PDF file); ${RE_EXPORT_GUIDANCE}`,
  );
}

function passwordProtected(filename: string): ImportRefusal {
  return refuse(
    "unreadable_document",
    `The file ${JSON.stringify(filename)} is password-protected, so its text cannot be read without the password; ${RE_EXPORT_GUIDANCE}`,
  );
}

/**
 * The text of one page: its items joined with single spaces, with whitespace
 * runs collapsed and the ends trimmed. The parser may place one item per row,
 * so line breaks are kept as spaces rather than guessed at. A page with no
 * non-whitespace text yields the empty string.
 */
export function pageText(content: PdfTextContent): string {
  if (!Array.isArray(content.items)) {
    throw new TypeError("the parser returned no text items");
  }
  const parts: string[] = [];
  for (const item of content.items) {
    const str = item?.str;
    if (typeof str === "string" && hasContent(str)) parts.push(str);
  }
  return parts.join(" ").replace(/\s+/gu, " ").trim();
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
 * Build the passages and the page attribution from the pages with text. Pages
 * are joined with a blank line, so each page's text starts at a paragraph
 * boundary and its exact range is the page's range in the extracted text. A
 * page with no text contributes no passage but keeps its place in the
 * document.
 */
function buildPassages(
  pages: readonly ExtractedPage[],
  extractedText: string,
  sourceId: string,
): { passages: readonly Passage[]; passagePages: readonly PassagePage[] } {
  const breaks = lineBreakOffsets(extractedText);
  const passages: Passage[] = [];
  const passagePages: PassagePage[] = [];
  let cursor = 0;
  for (const page of pages) {
    if (page.text === "") continue;
    const range: PassageRange = { start: cursor, end: cursor + page.text.length };
    const { line, column } = locate(extractedText, range.start, breaks);
    const location: PassageLocation = { start: range.start, end: range.end, line, column };
    passages.push(
      Object.freeze({
        id: `${sourceId}/p${passages.length + 1}`,
        sourceId,
        range: Object.freeze(range),
        location: Object.freeze(location),
        text: page.text,
      }),
    );
    passagePages.push(Object.freeze({ page: page.page }));
    // The next page starts after this page's text and the "\n\n" separator.
    cursor = range.end + 2;
  }
  return { passages: Object.freeze(passages), passagePages: Object.freeze(passagePages) };
}

/**
 * Import a text-based PDF file's bytes. The bytes are copied and preserved
 * exactly; the extracted text is the text of each page, joined with blank
 * lines, and each passage names the 1-based page it came from.
 *
 * Refusals, all with guidance and no usable result: a non-`.pdf` filename, an
 * original above the inclusive 10 MiB limit, a corrupt or unreadable document,
 * a password-protected document, a page whose extraction fails (the whole
 * import fails rather than publishing partial extraction), extracted text
 * above the inclusive limit, or a document with no extractable text (OCR is
 * unavailable). Parser resources are released on success and on failure.
 *
 * `bytes` must be a `Uint8Array` (a `Buffer` qualifies) and `filename` a
 * nonblank string; anything else is a programming error and throws
 * `ValidationError`.
 */
export async function importPdf(
  bytes: unknown,
  filename: unknown,
  parser: PdfParser = REAL_PARSER,
): Promise<PdfImportOutcome> {
  if (!(bytes instanceof Uint8Array)) {
    throw new ValidationError("file bytes must be a Uint8Array");
  }
  if (typeof filename !== "string" || filename.trim() === "") {
    throw new ValidationError("filename must be a nonblank string");
  }
  const originalBytes = new Uint8Array(bytes);
  if (!isPdfFilename(filename)) {
    return refuse(
      "unsupported_format",
      `The file ${JSON.stringify(filename)} is not a .pdf file; ${RE_EXPORT_GUIDANCE}`,
    );
  }
  if (originalBytes.length > MAX_CONTENT_BYTES) {
    return tooLarge("original", originalBytes.length);
  }

  // The parser may take ownership of the buffer it is given, so hand it a
  // separate copy: the preserved original and the caller's bytes stay intact.
  let task: PdfLoadingTask;
  try {
    task = parser.load(new Uint8Array(originalBytes));
  } catch {
    return corrupt(filename);
  }

  try {
    let document: PdfDocument;
    try {
      document = await task.promise;
    } catch (error) {
      if (errorName(error) === "PasswordException" || error instanceof PasswordException) {
        return passwordProtected(filename);
      }
      return corrupt(filename);
    }

    const pages: ExtractedPage[] = [];
    try {
      const count = document.numPages;
      if (!Number.isSafeInteger(count) || count < 1) throw new TypeError("the document has no pages");
      for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
        const page: PdfPage = await document.getPage(pageNumber);
        let content: PdfTextContent;
        try {
          content = await page.getTextContent();
        } finally {
          // Release the page's resources whether its text was read or not.
          const cleanup = (page as unknown as { cleanup?: () => unknown }).cleanup;
          if (typeof cleanup === "function") {
            try {
              await cleanup.call(page);
            } catch {
              // Cleanup after extraction does not change the outcome.
            }
          }
        }
        pages.push(Object.freeze({ page: pageNumber, text: pageText(content) }));
      }
    } catch (error) {
      // A page that will not yield text fails the whole import; never publish
      // partial extraction as complete.
      if (error instanceof InvalidPDFException || errorName(error) === "InvalidPDFException") {
        return corrupt(filename);
      }
      return refuse(
        "unreadable_document",
        `Page extraction failed for the file ${JSON.stringify(filename)}, so the whole import was refused rather than returning a partial result; ${RE_EXPORT_GUIDANCE}`,
      );
    }

    const extractedText = pages
      .filter((page) => page.text !== "")
      .map((page) => page.text)
      .join("\n\n");
    const extractedLength = utf8Length(extractedText);
    if (extractedLength > MAX_CONTENT_BYTES) {
      return tooLarge("extracted", extractedLength);
    }
    if (!hasContent(extractedText)) {
      return refuse(
        "whitespace_only",
        `The document ${JSON.stringify(filename)} carries no extractable text. ${OCR_UNAVAILABLE_GUIDANCE}`,
      );
    }

    const canonicalText = canonicalize(extractedText);
    const canonicalIdentity = `sha256:${sha256Hex(utf8Bytes(canonicalText))}`;
    const { passages, passagePages } = buildPassages(pages, extractedText, canonicalIdentity);
    const result: PdfImportResult = Object.freeze({
      id: canonicalIdentity,
      format: PDF_FORMAT,
      filename,
      // A PDF has no plain-text original; the original content is its bytes,
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
    return Object.freeze({
      ok: true,
      result,
      pages: Object.freeze(pages),
      passagePages,
    });
  } finally {
    // Release the parser's worker and resources whether the import succeeded
    // or failed; a release failure does not change a decided outcome.
    try {
      await task.destroy();
    } catch {
      // The outcome is already decided; the resources are released as far as
      // the parser allows.
    }
  }
}

/** The installed parser's version, for diagnostics; never used for routing. */
export const INSTALLED_PARSER_VERSION = PDFJS_VERSION;

// Re-export the parser's document type names so callers need only this module.
export type { PDFDocumentProxy, PDFPageProxy };
