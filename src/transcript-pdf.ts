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
 * number is skipped, not renumbered). The pages with text are joined with a
 * blank line, which is the separator the transcript core's passages subdivide
 * at, so each passage is exactly one page's extracted text. Every passage
 * therefore carries its retained original (through the core identities) and,
 * in its own `page` field, the 1-based page it was extracted from. A page
 * whose extraction fails fails the whole import: no partial extraction is ever
 * published as a complete result.
 *
 * Refusals carry guidance and no usable import: a document whose pages carry
 * no text (for example an image-only scan) is refused because OCR is
 * unavailable, advising a text-based export; corrupt, password-protected or
 * unreadable documents are refused with re-export guidance; and an original or
 * extracted text above the core's inclusive 10 MiB limit is refused without
 * truncation or a partial result.
 *
 * Parser resources are released whether the import succeeds or fails: every
 * page is released after its text is read, and the document loading task is
 * destroyed on every path. A release failure is reported, never swallowed: the
 * import is refused with a classified failure, and an outcome already decided
 * is re-decided rather than returned as if nothing had happened. All release
 * attempts are made even when one of them fails.
 */
import {
  getDocument,
  PasswordException,
  VerbosityLevel,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { createHash } from "node:crypto";
import {
  canonicalize,
  MAX_CONTENT_BYTES,
  SUPPORTED_EXPORTS,
  validateImportResult,
  type ImportRefusal,
  type ImportRefusalCode,
  type ImportResult,
  type Passage,
  type PassageLocation,
  type PassageRange,
} from "./transcript.ts";
import { ValidationError } from "./model.ts";

/**
 * The format this adapter accepts. The core accepts no `pdf` format yet (its
 * format list predates this adapter), so the result is checked and converted
 * to the core's format type at the boundary.
 */
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

/**
 * One passage of a PDF import: the core passage with its 1-based page made
 * required. The core `Passage` allows an optional `page` for page-based
 * sources; a PDF passage always carries one, so this narrows the same shape.
 */
export interface PdfPassage extends Passage {
  /** The 1-based page of the document the passage's text was extracted from. */
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
 * The PDF adapter's import result: the core result, whose passages are
 * `PdfPassage`s carrying their page, with the `pdf` format. It validates
 * through the core (`validateImportResult` and `resolveCitation`) because the
 * core accepts the `pdf` format; the extra `page` field on each passage is
 * this adapter's page attribution.
 */
export type PdfImportResult = Omit<ImportResult, "format" | "passages"> & {
  readonly format: typeof PDF_FORMAT;
  readonly passages: readonly PdfPassage[];
};

/**
 * The outcome of a PDF import: the core import result (with the page-carrying
 * passages and the `pdf` format) plus the extracted pages, or a classified
 * refusal. There is no usable partial result on refusal.
 */
export type PdfImportOutcome =
  | {
      readonly ok: true;
      readonly result: PdfImportResult;
      readonly pages: readonly ExtractedPage[];
    }
  | ImportRefusal;

/** The text items of one page, as the parser returns them. */
export interface PdfTextContent {
  readonly items: readonly { readonly str?: unknown }[];
}

/** One page of a loaded document, as the parser returns it. */
export interface PdfPage {
  getTextContent(): Promise<PdfTextContent>;
  /** Release the page's resources; the parser's pages implement it. */
  cleanup?(): unknown;
}

/** A loaded document, as the parser returns it. */
export interface PdfDocument {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
}

/** A document loading task, as the parser returns it. */
export interface PdfLoadingTask {
  readonly promise: Promise<PdfDocument>;
  /** Release the loading task's worker and resources. */
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
  // fetched over the network. Extraction needs no rendering.
  disableRange: true,
  disableStream: true,
  disableAutoFetch: true,
  disableWorkerRendering: true,
  useWorkerFetch: false,
  useSystemFonts: false,
  disableFontFace: true,
  fontExtraProperties: false,
  enableXfa: false,
  useWasm: false,
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false,
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

/** A classified failure for a release that did not succeed. */
function releaseFailed(filename: string, stage: string, error: unknown): ImportRefusal {
  const detail = error instanceof Error && error.message !== "" ? `: ${error.message}` : "";
  return refuse(
    "unreadable_document",
    `The file ${JSON.stringify(filename)} could not be imported because parser resources were not released (${stage})${detail}; ${RE_EXPORT_GUIDANCE}`,
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
 * Build the passages from the pages with text. Pages are joined with a blank
 * line, so each page's text starts at a paragraph boundary and its exact range
 * is the page's range in the extracted text. A page with no text contributes no
 * passage but keeps its place in the document, so every passage carries the
 * real 1-based page number it came from.
 */
function buildPassages(pages: readonly ExtractedPage[], extractedText: string, sourceId: string): readonly PdfPassage[] {
  const breaks = lineBreakOffsets(extractedText);
  const passages: PdfPassage[] = [];
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
        page: page.page,
      }),
    );
    // The next page starts after this page's text and the "\n\n" separator.
    cursor = range.end + 2;
  }
  return Object.freeze(passages);
}

/**
 * Present the adapter's result as the core result, checking it first: the
 * format must be `pdf`, and every passage must carry its 1-based page and
 * match the result's extracted text exactly at its range. The core's
 * `validateImportResult` accepts the format and the other fields, but does not
 * know about the adapter's `page` field, so that is checked here and the
 * passages are converted to the core's passage shape.
 */
function toCoreResult(pdfResult: PdfImportResult): ImportResult {
  if (pdfResult.format !== PDF_FORMAT) {
    throw new ValidationError(`the PDF adapter's result must have the ${PDF_FORMAT} format`);
  }
  for (const [index, passage] of pdfResult.passages.entries()) {
    if (!Number.isSafeInteger(passage.page) || passage.page < 1) {
      throw new ValidationError(`passage ${index} must carry a 1-based page`);
    }
    if (pdfResult.extractedText.slice(passage.range.start, passage.range.end) !== passage.text) {
      throw new ValidationError(`passage ${index} text does not match its exact range`);
    }
  }
  const corePassages = pdfResult.passages.map(({ page: _page, ...passage }) => Object.freeze(passage));
  const { passages: _passages, ...rest } = pdfResult;
  const coreResult: ImportResult = Object.freeze({
    ...rest,
    format: pdfResult.format,
    passages: Object.freeze(corePassages),
  });
  return validateImportResult(coreResult);
}

/** Release one page, reporting a failure instead of swallowing it. */
async function releasePage(page: PdfPage, pageNumber: number, fail: (error: unknown) => void): Promise<void> {
  const cleanup = page.cleanup;
  if (typeof cleanup !== "function") return;
  try {
    await cleanup.call(page);
  } catch (error) {
    fail(error);
  }
}

/** A release failure: which release failed and the value it threw or rejected. */
interface ReleaseFailure {
  readonly stage: "page" | "destroy";
  readonly error: unknown;
}

/**
 * Run one release operation, recording a failure however the operation fails.
 * Whether it failed is tracked separately from the thrown value, so throwing
 * or rejecting `null` or `undefined` is still a failure, not a success.
 */
async function attemptRelease(
  stage: ReleaseFailure["stage"],
  release: () => unknown,
  failures: ReleaseFailure[],
): Promise<void> {
  try {
    await release();
  } catch (error) {
    failures.push(Object.freeze({ stage, error }));
  }
}

/**
 * Import a text-based PDF file's bytes and return the core import result. The
 * bytes are copied and preserved exactly; the extracted text is the text of
 * each page, joined with blank lines, and each passage names its retained
 * original and the 1-based page it came from.
 *
 * Refusals, all with guidance and no usable result: a non-`.pdf` filename, an
 * original above the inclusive 10 MiB limit, a corrupt or unreadable document,
 * a password-protected document, a page whose extraction fails (the whole
 * import fails rather than publishing partial extraction), extracted text
 * above the inclusive limit, a document with no extractable text (OCR is
 * unavailable), or a page or task whose resources cannot be released.
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

  // The outcome decided by extraction. A release failure, or a failure while
  // deciding the outcome, replaces it with a classified refusal, so no outcome
  // is ever returned with resources left unreleased or an unexpected failure
  // swallowed. The failures list records that a release failed separately from
  // the thrown value, so a `null` or `undefined` rejection is still a failure.
  let outcome: PdfImportOutcome;
  const failures: ReleaseFailure[] = [];
  try {
    outcome = await extract(filename, originalBytes, task, failures);
  } catch (error) {
    outcome = refuse(
      "unreadable_document",
      `The file ${JSON.stringify(filename)} could not be imported because reading it failed unexpectedly${
        error instanceof Error && error.message !== "" ? `: ${error.message}` : ""
      }; ${RE_EXPORT_GUIDANCE}`,
    );
  } finally {
    await attemptRelease("destroy", () => task.destroy(), failures);
  }
  const destroyFailure = failures.find((failure) => failure.stage === "destroy");
  if (destroyFailure !== undefined) {
    return releaseFailed(filename, "destroying the document loading task", destroyFailure.error);
  }
  return outcome;
}

/**
 * Read every page of the loaded document and decide the outcome, before the
 * loading task is destroyed. A page that fails to yield text, or fails to
 * release, decides the whole import as a refusal.
 */
async function extract(
  filename: string,
  originalBytes: Uint8Array,
  task: PdfLoadingTask,
  failures: ReleaseFailure[],
): Promise<PdfImportOutcome> {
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
  // Every page release failure is recorded; the first one refuses the import.
  const fail = (error: unknown): void => {
    failures.push(Object.freeze({ stage: "page", error }));
  };
  try {
    const count = document.numPages;
    if (!Number.isSafeInteger(count) || count < 1) throw new TypeError("the document has no pages");
    for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
      const page: PdfPage = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        pages.push(Object.freeze({ page: pageNumber, text: pageText(content) }));
      } finally {
        await releasePage(page, pageNumber, fail);
      }
    }
  } catch {
    // A page that will not yield text fails the whole import; never publish
    // partial extraction as complete. Every page released so far was released,
    // and the failed page was released in its `finally`.
    const pageFailure = failures.find((failure) => failure.stage === "page");
    if (pageFailure !== undefined) return releaseFailed(filename, "cleaning up a document page", pageFailure.error);
    // The core's `unreadable_document` code names a document that cannot be
    // read; a page that failed to extract is one.
    return refuse(
      "unreadable_document",
      `Page extraction failed for the file ${JSON.stringify(filename)}, so the whole import was refused rather than returning a partial result; ${RE_EXPORT_GUIDANCE}`,
    );
  }
  const releaseFailure = failures.find((failure) => failure.stage === "page");
  if (releaseFailure !== undefined) {
    return releaseFailed(filename, "cleaning up a document page", releaseFailure.error);
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
  const passages = buildPassages(pages, extractedText, canonicalIdentity);
  const result: PdfImportResult = Object.freeze({
    id: canonicalIdentity,
    format: PDF_FORMAT,
    filename,
    // A PDF has no plain-text original; the original content is its bytes,
    // preserved exactly. `originalText` is the extracted plain text, and the
    // exact original bytes remain the authority for the original.
    originalText: extractedText,
    originalBytes,
    originalSha256: sha256Hex(originalBytes),
    extractedText,
    canonicalText,
    canonicalIdentity,
    passages,
  });
  // The adapter's result is the core import result: it is handed to the core
  // and validated as one, so the core's citation resolution applies to it.
  toCoreResult(result);
  return Object.freeze({ ok: true, result, pages: Object.freeze(pages) });
}
