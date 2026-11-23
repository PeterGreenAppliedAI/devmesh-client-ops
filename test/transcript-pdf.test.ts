import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { canonicalize, MAX_CONTENT_BYTES } from "../src/transcript.ts";
import {
  importPdf,
  pageText,
  PDF_SUPPORTED_EXPORTS,
  type ExtractedPage,
  type PassagePage,
  type PdfImportOutcome,
  type PdfImportResult,
  type PdfLoadingTask,
  type PdfParser,
} from "../src/transcript-pdf.ts";
import {
  corruptBytes,
  passwordProtected,
  pdfBytes,
  pdfOfLength,
  truncatedBytes,
} from "./fixtures/transcript-pdf.ts";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Assert an outcome is a successful PDF import and return it. */
function imported(outcome: PdfImportOutcome): {
  result: PdfImportResult;
  pages: readonly ExtractedPage[];
  passagePages: readonly PassagePage[];
} {
  assert.equal(outcome.ok, true, `expected success, got ${JSON.stringify(outcome)}`);
  if (!outcome.ok) throw new Error("unreachable");
  return { result: outcome.result, pages: outcome.pages, passagePages: outcome.passagePages };
}

/** Assert an outcome is a refusal with `code`, guidance and no usable import. */
function refused(outcome: PdfImportOutcome, code: string, messagePattern: RegExp): void {
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.refusal.code, code);
    assert.match(outcome.refusal.message, messagePattern);
    assert.deepEqual(outcome.refusal.supportedExports, PDF_SUPPORTED_EXPORTS);
  }
  const record = outcome as unknown as Record<string, unknown>;
  assert.equal(record.result, undefined);
  assert.equal(record.pages, undefined);
  assert.equal(record.passagePages, undefined);
}

/** A loading task that never resolves, for a document that will not open. */
function unresolvedTask(destroyed: { value: boolean }): PdfLoadingTask {
  return {
    promise: new Promise(() => {}),
    destroy: () => {
      destroyed.value = true;
      return Promise.resolve();
    },
  };
}

describe("PDF import", () => {
  it("extracts readable text page by page, with one-based pages and exact originals", async () => {
    const bytes = pdfBytes([
      ["Agenda for the review.", "Second line of page one."],
      ["Page two holds the decisions."],
      ["Page three closes the minutes."],
    ]);
    const snapshot = Uint8Array.from(bytes);
    const { result, pages, passagePages } = imported(await importPdf(bytes, "minutes.pdf"));

    assert.equal(result.format, "pdf");
    assert.equal(result.filename, "minutes.pdf");
    assert.deepEqual(
      pages.map((page) => [page.page, page.text]),
      [
        [1, "Agenda for the review. Second line of page one."],
        [2, "Page two holds the decisions."],
        [3, "Page three closes the minutes."],
      ],
    );
    // One passage per page, each identifying its 1-based page.
    assert.deepEqual(result.passages.map((p) => p.text), pages.map((p) => p.text));
    assert.deepEqual(passagePages, [{ page: 1 }, { page: 2 }, { page: 3 }]);

    // Every passage names its retained original and an exact valid range.
    for (const [index, passage] of result.passages.entries()) {
      assert.equal(passage.sourceId, result.id);
      assert.equal(passage.id, `${result.id}/p${index + 1}`);
      assert.equal(result.extractedText.slice(passage.range.start, passage.range.end), passage.text);
      assert.ok(passage.range.start >= 0);
      assert.ok(passage.range.end <= result.extractedText.length);
      assert.ok(passage.range.start < passage.range.end);
      assert.equal(passage.location.start, passage.range.start);
      assert.equal(passage.location.end, passage.range.end);
      assert.ok(passage.location.line >= 1 && passage.location.column >= 1);
      assert.equal(passagePages[index].page, index + 1);
    }
    assert.deepEqual(
      result.passages.map((p) => [p.location.line, p.location.column]),
      [
        [1, 1],
        [3, 1],
        [5, 1],
      ],
    );

    // The original bytes are preserved exactly and are never mutated.
    assert.equal(result.originalBytes.length, bytes.length);
    assert.deepEqual(result.originalBytes, snapshot);
    assert.equal(result.originalSha256, sha256(snapshot));
    assert.deepEqual(bytes, snapshot);

    assert.equal(result.canonicalText, canonicalize(result.extractedText));
    assert.equal(result.id, result.canonicalIdentity);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.passages));
  });

  it("copies the input buffer so later mutation cannot change the result", async () => {
    const bytes = pdfBytes([["Original text."]]);
    const expected = sha256(bytes);
    const { result } = imported(await importPdf(bytes, "a.pdf"));
    bytes.fill(0);
    assert.equal(result.extractedText, "Original text.");
    assert.equal(result.originalSha256, expected);
  });

  it("keeps the caller's bytes intact even though the parser takes its copy", async () => {
    // The installed parser transfers the working buffer to its worker, so the
    // adapter must hand it a copy. This parser models that transfer exactly.
    const bytes = pdfBytes([["Transferred buffer."]]);
    const snapshot = Uint8Array.from(bytes);
    let supplied: Uint8Array | null = null;
    const transferringParser: PdfParser = {
      load: (data: Uint8Array) => {
        supplied = data;
        // Detach the buffer the adapter supplied, as the real parser does.
        structuredClone(data.buffer, { transfer: [data.buffer] });
        assert.equal(data.byteLength, 0, "the supplied buffer is transferred");
        return {
          promise: Promise.resolve({
            numPages: 1,
            getPage: () =>
              Promise.resolve({
                getTextContent: () => Promise.resolve({ items: [{ str: "Transferred buffer." }] }),
              }),
          }),
          destroy: () => Promise.resolve(),
        };
      },
    };
    const { result } = imported(await importPdf(bytes, "copy.pdf", transferringParser));
    assert.ok(supplied !== null);
    assert.notEqual(supplied, bytes, "the parser is given a copy, not the caller's buffer");
    assert.deepEqual(bytes, snapshot);
    assert.equal(result.originalSha256, sha256(snapshot));
    assert.deepEqual(result.originalBytes, snapshot);
    assert.equal(result.extractedText, "Transferred buffer.");
  });

  it("skips blank pages but keeps the real page numbers of the others", async () => {
    const bytes = pdfBytes([["First page."], [], ["Third page."], "image-only", ["Fifth page."]]);
    const { result, pages, passagePages } = imported(await importPdf(bytes, "sparse.pdf"));
    assert.deepEqual(pages.map((page) => page.text), [
      "First page.",
      "",
      "Third page.",
      "",
      "Fifth page.",
    ]);
    assert.deepEqual(result.passages.map((p) => p.text), ["First page.", "Third page.", "Fifth page."]);
    assert.deepEqual(passagePages, [{ page: 1 }, { page: 3 }, { page: 5 }]);
    for (const passage of result.passages) {
      assert.equal(result.extractedText.slice(passage.range.start, passage.range.end), passage.text);
    }
  });

  it("gives each passage its source and page, and citations resolve to it", async () => {
    const bytes = pdfBytes([["Alpha."], ["Beta on page two."]]);
    const { result, passagePages } = imported(await importPdf(bytes, "cite.pdf"));
    const passage = result.passages[1];
    assert.equal(passagePages[1].page, 2);
    // The citation core's source validator predates the PDF format, so this
    // adapter's own passages are checked here directly against the result.
    const quote = result.extractedText.slice(passage.range.start, passage.range.end);
    assert.equal(quote, "Beta on page two.");
    assert.equal(passage.text, quote);
    assert.equal(passage.sourceId, result.id);
    assert.equal(passage.id, `${result.id}/p2`);
  });
});

describe("PDF page text", () => {
  it("joins text items in parser order with single spaces and trims them", () => {
    assert.equal(
      pageText({ items: [{ str: "  Hello  " }, { str: "world\t" }, { str: "" }, { str: "again" }] }),
      "Hello world again",
    );
    assert.equal(pageText({ items: [] }), "");
    assert.equal(pageText({ items: [{ str: "   " }, { str: "\n" }] }), "");
    assert.equal(pageText({ items: [{ str: "Line one\nLine two" }] }), "Line one Line two");
  });

  it("refuses a parser that returns no text items for a page", async () => {
    const parser: PdfParser = {
      load: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: () =>
            Promise.resolve({
              getTextContent: () => Promise.resolve({ items: undefined as unknown as [] }),
            }),
        }),
        destroy: () => Promise.resolve(),
      }),
    };
    refused(await importPdf(pdfBytes([["Text"]]), "bad.pdf", parser), "unreadable_document", /Page extraction failed/);
  });

  it("never publishes partial extraction as a complete result", async () => {
    // Page one yields text, page two fails: nothing is returned.
    let destroyed = false;
    const parser: PdfParser = {
      load: () => ({
        promise: Promise.resolve({
          numPages: 2,
          getPage: (pageNumber: number) =>
            Promise.resolve({
              getTextContent: () =>
                pageNumber === 1
                  ? Promise.resolve({ items: [{ str: "Usable first page" }] })
                  : Promise.reject(new Error("glyph mapping failed")),
            }),
        }),
        destroy: () => {
          destroyed = true;
          return Promise.resolve();
        },
      }),
    };
    refused(await importPdf(pdfBytes([["First"], ["Second"]]), "partial.pdf", parser), "unreadable_document", /whole import was refused/);
    assert.equal(destroyed, true);
  });
});

describe("PDF refusals", () => {
  const reExport = /re-export .* text-based PDF .* or .* UTF-8 text/i;

  it("refuses image-only and text-empty documents explaining that OCR is unavailable", async () => {
    const ocr = /OCR is unavailable.*text-based copy/i;
    refused(await importPdf(pdfBytes(["image-only"]), "scan.pdf"), "whitespace_only", ocr);
    refused(await importPdf(pdfBytes([[]]), "blank.pdf"), "whitespace_only", ocr);
    refused(await importPdf(pdfBytes(["image-only", []]), "all-blank.pdf"), "whitespace_only", ocr);
    // The refusal also carries the supported exports, including a text-based PDF.
    const outcome = await importPdf(pdfBytes(["image-only"]), "scan.pdf");
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.ok(outcome.refusal.supportedExports.some((e) => /text-based PDF/i.test(e)));
  });

  it("refuses a password-protected document with re-export guidance", async () => {
    refused(await importPdf(passwordProtected(), "locked.pdf"), "unreadable_document", reExport);
  });

  it("refuses corrupt, truncated and unreadable input with re-export guidance", async () => {
    refused(await importPdf(corruptBytes(), "corrupt.pdf"), "unreadable_document", reExport);
    refused(await importPdf(truncatedBytes(), "truncated.pdf"), "unreadable_document", reExport);
    refused(await importPdf(new Uint8Array(), "empty.pdf"), "unreadable_document", reExport);
    refused(await importPdf(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "header.pdf"), "unreadable_document", reExport);
  });

  it("refuses a document that will not open and releases the parser", async () => {
    const destroyed = { value: false };
    const rejecting: PdfParser = {
      load: () => ({
        promise: Promise.reject(new Error("document setup failed")),
        destroy: () => {
          destroyed.value = true;
          return Promise.resolve();
        },
      }),
    };
    refused(await importPdf(pdfBytes([["Text"]]), "unopenable.pdf", rejecting), "unreadable_document", reExport);
    assert.equal(destroyed.value, true);
  });

  it("refuses a non-.pdf filename with guidance", async () => {
    refused(await importPdf(pdfBytes([["Text"]]), "notes.txt"), "unsupported_format", /\.pdf file/i);
    refused(await importPdf(pdfBytes([["Text"]]), "document"), "unsupported_format", /\.pdf file/i);
  });

  it("classifies a parser that throws on load as corrupt, without a partial result", async () => {
    const parser: PdfParser = {
      load: () => {
        throw new Error("cannot start worker");
      },
    };
    refused(await importPdf(pdfBytes([["Text"]]), "throws.pdf", parser), "unreadable_document", reExport);
  });

  it("throws on misused types instead of guessing", async () => {
    await assert.rejects(() => importPdf("bytes", "a.pdf"), /must be a Uint8Array/);
    await assert.rejects(() => importPdf(new Uint8Array([1]), "  "), /nonblank/);
  });
});

describe("PDF parser resources", () => {
  it("releases the parser on success and on refusal", async () => {
    const destroyed: boolean[] = [];
    const textParser: PdfParser = {
      load: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: () =>
            Promise.resolve({
              getTextContent: () => Promise.resolve({ items: [{ str: "Released text." }] }),
            }),
        }),
        destroy: () => {
          destroyed.push(true);
          return Promise.resolve();
        },
      }),
    };
    imported(await importPdf(pdfBytes([["x"]]), "ok.pdf", textParser));
    assert.deepEqual(destroyed, [true]);

    const emptyParser: PdfParser = {
      load: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: () => Promise.resolve({ getTextContent: () => Promise.resolve({ items: [] }) }),
        }),
        destroy: () => {
          destroyed.push(true);
          return Promise.resolve();
        },
      }),
    };
    refused(await importPdf(pdfBytes([["x"]]), "empty.pdf", emptyParser), "whitespace_only", /OCR is unavailable/);
    assert.deepEqual(destroyed, [true, true]);
  });

  it("cleans up each page whether its text was read or not", async () => {
    const cleaned: number[] = [];
    const parser: PdfParser = {
      load: () => ({
        promise: Promise.resolve({
          numPages: 2,
          getPage: (pageNumber: number) =>
            Promise.resolve({
              getTextContent: () =>
                pageNumber === 1
                  ? Promise.resolve({ items: [{ str: "Clean first" }] })
                  : Promise.reject(new Error("page exploded")),
              cleanup: () => {
                cleaned.push(pageNumber);
                return true;
              },
            }),
        }),
        destroy: () => Promise.resolve(),
      }),
    };
    // The failing page's `finally` cleanup must still run before the refusal.
    const outcome = await importPdf(pdfBytes([["First"], ["Second"]]), "cleanup.pdf", parser);
    assert.equal(outcome.ok, false);
    assert.deepEqual(cleaned, [1, 2]);
  });

  it("a release failure does not change a decided outcome", async () => {
    const parser: PdfParser = {
      load: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: () =>
            Promise.resolve({
              getTextContent: () => Promise.resolve({ items: [{ str: "Still usable." }] }),
            }),
        }),
        destroy: () => Promise.reject(new Error("worker already gone")),
      }),
    };
    const { result } = imported(await importPdf(pdfBytes([["x"]]), "release.pdf", parser));
    assert.equal(result.extractedText, "Still usable.");
  });
});

describe("PDF size limits", () => {
  const tooLarge = /at most .* bytes\. Nothing was truncated/;

  it("accepts an original of exactly 10 MiB and refuses one byte more without truncation", async () => {
    assert.equal(MAX_CONTENT_BYTES, 10 * 1024 * 1024);
    const exactly = pdfOfLength([["Padded document."]], MAX_CONTENT_BYTES);
    assert.equal(exactly.length, MAX_CONTENT_BYTES);
    const { result } = imported(await importPdf(exactly, "exact.pdf"));
    assert.equal(result.originalBytes.length, MAX_CONTENT_BYTES);
    assert.equal(result.originalSha256, sha256(exactly));
    assert.equal(result.extractedText, "Padded document.");

    const pastLimit = pdfOfLength([["Padded document."]], MAX_CONTENT_BYTES + 1);
    assert.equal(pastLimit.length, MAX_CONTENT_BYTES + 1);
    refused(await importPdf(pastLimit, "past.pdf"), "too_large", tooLarge);
  });

  it("refuses an original above the limit before parsing", async () => {
    const huge = new Uint8Array(MAX_CONTENT_BYTES + 1024).fill(0x61);
    let called = false;
    const parser: PdfParser = {
      load: () => {
        called = true;
        return unresolvedTask({ value: false });
      },
    };
    refused(await importPdf(huge, "huge.pdf", parser), "too_large", tooLarge);
    assert.equal(called, false);
  });

  it("accepts extracted text of exactly 10 MiB and refuses one byte more without truncation", async () => {
    // The original PDF stays small while the parser returns pages whose text
    // is over the extracted-text limit; the parser is the injection interface.
    // Two pages joined with "\n\n" reach exactly the limit when each page's
    // text is half of it minus one byte for the separator.
    const half = MAX_CONTENT_BYTES / 2;
    const pageText = "a".repeat(half - 1);
    const atLimitParser: PdfParser = {
      load: () => ({
        promise: Promise.resolve({
          numPages: 2,
          getPage: () =>
            Promise.resolve({
              getTextContent: () => Promise.resolve({ items: [{ str: pageText }] }),
            }),
        }),
        destroy: () => Promise.resolve(),
      }),
    };
    const { result } = imported(await importPdf(pdfBytes([["marker"]]), "limit.pdf", atLimitParser));
    assert.equal(Buffer.byteLength(result.extractedText, "utf8"), MAX_CONTENT_BYTES);
    assert.equal(result.passages.length, 2);

    const overParser: PdfParser = {
      load: () => ({
        promise: Promise.resolve({
          numPages: 2,
          getPage: () =>
            Promise.resolve({
              getTextContent: () => Promise.resolve({ items: [{ str: "a".repeat(half) }] }),
            }),
        }),
        destroy: () => Promise.resolve(),
      }),
    };
    refused(await importPdf(pdfBytes([["marker"]]), "over.pdf", overParser), "too_large", tooLarge);
  });

  it("measures the extracted limit in UTF-8 bytes, not UTF-16 code units", async () => {
    // U+00E4 is two UTF-8 bytes; this page has more UTF-8 bytes than the limit.
    // Half the limit in code units is exactly the limit in UTF-8 bytes; one
    // more code unit would exceed it.
    const text = "\u00E4".repeat(MAX_CONTENT_BYTES / 2 + 1);
    const parser: PdfParser = {
      load: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: () =>
            Promise.resolve({
              getTextContent: () => Promise.resolve({ items: [{ str: text }] }),
            }),
        }),
        destroy: () => Promise.resolve(),
      }),
    };
    refused(await importPdf(pdfBytes([["marker"]]), "bytes.pdf", parser), "too_large", tooLarge);
  });
});

describe("PDF parser is exercised offline", () => {
  it("parses synthetic PDF bytes with the installed parser and no extra assets", async () => {
    // The fixture builds its own PDF bytes; nothing is read from disk, fetched
    // or rendered.
    const bytes = pdfBytes([["Offline parsing works."], ["A second page."]]);
    const snapshot = Uint8Array.from(bytes);
    const outcome = await importPdf(bytes, "offline.pdf");
    assert.equal(outcome.ok, true);
    assert.deepEqual(bytes, snapshot);
    const { result, passagePages } = imported(outcome);
    assert.deepEqual(result.passages.map((p) => p.text), ["Offline parsing works.", "A second page."]);
    assert.deepEqual(passagePages, [{ page: 1 }, { page: 2 }]);
  });

  it("parses the fixture's image-only, password-protected and corrupt bytes itself", async () => {
    refused(await importPdf(pdfBytes(["image-only"]), "self-image.pdf"), "whitespace_only", /OCR is unavailable/);
    refused(await importPdf(passwordProtected(), "self-locked.pdf"), "unreadable_document", /password-protected/);
    refused(await importPdf(corruptBytes(), "self-corrupt.pdf"), "unreadable_document", /could not be read as a PDF/);
  });
});
