import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";
import {
  canonicalize,
  MAX_CONTENT_BYTES,
  resolveCitation,
  validateImportResult,
  type ImportResult,
} from "../src/transcript.ts";
import {
  DOCX_SUPPORTED_EXPORTS,
  extractBlocks,
  importDocx,
  type DocxImportOutcome,
  type DocxParser,
  type ExtractedBlock,
} from "../src/transcript-docx.ts";
import {
  buildDocx,
  buildDocxWithExtraEntries,
  buildZipDetailed,
  crc32,
  docxBytes,
  docxOfExpandedLength,
  docxOfLength,
  docxWithExactRatioEntry,
  pseudoRandomBytes,
  type TestTable,
} from "./fixtures/transcript-docx.ts";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The re-export guidance every unreadable-container refusal must carry. */
const reExportGuidance = /re-export .* as DOCX .* or .* UTF-8 text/i;

/** Assert an outcome is a successful DOCX import and return it. */
function imported(outcome: DocxImportOutcome): { result: ImportResult; blocks: readonly ExtractedBlock[] } {
  assert.equal(outcome.ok, true, `expected success, got ${JSON.stringify(outcome)}`);
  if (!outcome.ok) throw new Error("unreachable");
  return { result: outcome.result, blocks: outcome.blocks };
}

/** Assert an outcome is a refusal with `code`, guidance and no usable import. */
function refused(outcome: DocxImportOutcome, code: string, messagePattern: RegExp): void {
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("unreachable");
  assert.equal(outcome.refusal.code, code);
  assert.match(outcome.refusal.message, messagePattern);
  assert.deepEqual(outcome.refusal.supportedExports, DOCX_SUPPORTED_EXPORTS);
  assert.equal((outcome as unknown as Record<string, unknown>).result, undefined);
  assert.equal((outcome as unknown as Record<string, unknown>).blocks, undefined);
}

/** A parser that counts calls, so a preflight refusal can be shown to skip it. */
function countingParser(value = "<p>unexpected parser output</p>"): { parser: DocxParser; calls: () => number } {
  let calls = 0;
  return {
    parser: {
      convertToHtml: () => {
        calls += 1;
        return Promise.resolve({ value });
      },
    },
    calls: () => calls,
  };
}

/** A copy of archive bytes with one little-endian field replaced. */
function patched(bytes: Uint8Array, offset: number, value: number, width: 2 | 4): Uint8Array {
  const copy = Uint8Array.from(bytes);
  const view = new DataView(copy.buffer);
  if (width === 2) view.setUint16(offset, value, true);
  else view.setUint32(offset, value, true);
  return copy;
}

/** An Info-ZIP Unicode Path extra field that names an alternate member path. */
function unicodePathExtra(path: string, originalName: Uint8Array): Uint8Array {
  const encoded = new TextEncoder().encode(path);
  const extra = new Uint8Array(4 + 1 + 4 + encoded.length);
  const view = new DataView(extra.buffer);
  view.setUint16(0, 0x7075, true);
  view.setUint16(2, 1 + 4 + encoded.length, true);
  extra[4] = 1;
  view.setUint32(5, crc32(originalName), true);
  extra.set(encoded, 9);
  return extra;
}

describe("DOCX import", () => {
  it("extracts paragraphs in order, preserving original bytes exactly", async () => {
    const bytes = docxBytes(["First paragraph.", "Second paragraph."]);
    const snapshot = Uint8Array.from(bytes);
    const { result, blocks } = imported(await importDocx(bytes, "meeting.docx"));

    assert.equal(result.format, "docx");
    assert.equal(result.filename, "meeting.docx");
    assert.equal(result.extractedText, "First paragraph.\n\nSecond paragraph.");
    assert.deepEqual(result.passages.map((p) => p.text), ["First paragraph.", "Second paragraph."]);
    assert.deepEqual(blocks.map((b) => b.kind), ["paragraph", "paragraph"]);

    // The original bytes are preserved exactly and are never mutated.
    assert.equal(result.originalBytes.length, bytes.length);
    assert.deepEqual(result.originalBytes, snapshot);
    assert.equal(result.originalSha256, sha256(snapshot));
    assert.deepEqual(bytes, snapshot);

    // The result is a valid transcript core result.
    assert.equal(validateImportResult(result), result);
    assert.equal(result.canonicalText, canonicalize(result.extractedText));
    assert.equal(result.id, result.canonicalIdentity);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.passages));
  });

  it("copies the input buffer so later mutation cannot change the result", async () => {
    const bytes = docxBytes(["Original text."]);
    const expected = sha256(bytes);
    const { result } = imported(await importDocx(bytes, "a.docx"));
    bytes.fill(0);
    assert.equal(result.extractedText, "Original text.");
    assert.equal(result.originalSha256, expected);
  });

  it("extracts table cell text as blocks, without calling a cell a paragraph", async () => {
    // A cell written without a paragraph is a cell block, not a paragraph;
    // a cell holding paragraphs contributes the paragraphs.
    const table: TestTable = [
      [{ text: "Cell A1" }, { text: "Cell B1" }],
      [{ text: "Cell C1" }, [{ runs: ["Cell D1 para 1"] }, { runs: ["Cell D1 para 2"] }]],
    ];
    const { result, blocks } = imported(await importDocx(docxBytes(["Intro."], table), "table.docx"));
    assert.deepEqual(
      blocks.map((b) => [b.kind, b.text]),
      [
        ["paragraph", "Intro."],
        ["table_cell", "Cell A1"],
        ["table_cell", "Cell B1"],
        ["table_cell", "Cell C1"],
        ["paragraph", "Cell D1 para 1"],
        ["paragraph", "Cell D1 para 2"],
      ],
    );
    assert.deepEqual(result.passages.map((p) => p.text), blocks.map((b) => b.text));
    assert.equal(result.extractedText, blocks.map((b) => b.text).join("\n\n"));
  });

  it("preserves Unicode text exactly, with exact ranges and honest locations", async () => {
    const text = "Grüße 👩‍👩‍👧 e\u0301";
    const { result } = imported(await importDocx(docxBytes([text, "\u{1F600} second"], [
      [[{ runs: ["Ünïcode 🎯 cell"] }]],
    ]), "unicode.docx"));
    assert.deepEqual(result.passages.map((p) => p.text), [text, "\u{1F600} second", "Ünïcode 🎯 cell"]);
    for (const passage of result.passages) {
      assert.equal(result.extractedText.slice(passage.range.start, passage.range.end), passage.text);
      assert.equal(passage.location.start, passage.range.start);
      assert.equal(passage.location.end, passage.range.end);
      assert.ok(passage.location.line >= 1 && passage.location.column >= 1);
    }
    // Blocks are separated by a blank line, so block n starts on line 2n - 1.
    assert.deepEqual(result.passages.map((p) => [p.location.line, p.location.column]), [
      [1, 1],
      [3, 1],
      [5, 1],
    ]);
    assert.equal(validateImportResult(result), result);
  });

  it("gives each passage its source and location, and cites resolve to it", async () => {
    const { result } = imported(await importDocx(docxBytes(["Alpha.", "Beta 🎯."]), "cite.docx"));
    const passage = result.passages[0];
    const resolved = resolveCitation(
      { sourceId: passage.sourceId, passageId: passage.id, range: { ...passage.range } },
      result,
      passage,
    );
    assert.equal(resolved.quote, "Alpha.");
    assert.equal(passage.sourceId, result.id);
    assert.equal(passage.id, `${result.id}/p1`);
  });
});

describe("DOCX blocks with line breaks", () => {
  it("keeps a line break inside a paragraph as a new line of the same block", async () => {
    // Mammoth writes an in-paragraph line break as `<br />` inside the run.
    const bytes = buildDocx([{ runs: ["First\nsecond"] }, { runs: ["Next"] }]);
    const { result, blocks } = imported(await importDocx(bytes, "breaks.docx"));
    assert.deepEqual(blocks.map((b) => b.text), ["First\nsecond", "Next"]);
    assert.equal(result.passages[0].text, "First\nsecond");
    assert.equal(result.passages[0].location.line, 1);
    assert.equal(result.passages[0].location.column, 1);
    assert.equal(result.passages[1].location.line, 4);
    assert.equal(result.passages[1].location.column, 1);
    assert.equal(validateImportResult(result), result);
  });

  it("reads escaped characters mammoth emits from document text", async () => {
    const text = 'A < B & C > "quoted"';
    const { result } = imported(await importDocx(docxBytes([text]), "markup.docx"));
    assert.equal(result.extractedText, text);
  });

  it("extracts blocks from mammoth markup with headings and nested cells", () => {
    const html =
      "<h1>Title &amp; Co</h1><p>Body<br />line</p><table><tr><td><p>Cell</p></td></tr></table>";
    assert.deepEqual(
      extractBlocks(html).map((b) => [b.kind, b.text]),
      [
        ["heading", "Title & Co"],
        ["paragraph", "Body\nline"],
        ["paragraph", "Cell"],
      ],
    );
    // A cell holding paragraphs contributes the paragraphs, not the cell again.
    assert.deepEqual(
      extractBlocks("<table><tr><td><p>Only</p></td></tr></table>").map((b) => [b.kind, b.text]),
      [["paragraph", "Only"]],
    );
  });
});

describe("DOCX list items", () => {
  it("keeps consecutive list items as separate blocks, not joined as a paragraph", () => {
    // Mammoth writes a list as `<ul><li>First</li><li>Second</li></ul>`.
    assert.deepEqual(
      extractBlocks("<ul><li>First</li><li>Second</li></ul>").map((b) => [b.kind, b.text]),
      [
        ["list_item", "First"],
        ["list_item", "Second"],
      ],
    );
  });

  it("does not describe an extracted block as a paragraph unless the markup is one", async () => {
    const html =
      "<p>Intro.</p><ul><li>One</li><li>Two</li></ul><h2>Head</h2><table><tr><td>Cell</td></tr></table>";
    const parser: DocxParser = { convertToHtml: () => Promise.resolve({ value: html }) };
    const { result, blocks } = imported(await importDocx(docxBytes(["marker"]), "kinds.docx", parser));
    assert.deepEqual(
      blocks.map((b) => [b.kind, b.text]),
      [
        ["paragraph", "Intro."],
        ["list_item", "One"],
        ["list_item", "Two"],
        ["heading", "Head"],
        ["table_cell", "Cell"],
      ],
    );
    assert.deepEqual(result.passages.map((p) => p.text), ["Intro.", "One", "Two", "Head", "Cell"]);
    assert.deepEqual(
      result.passages.map((p) => [p.location.line, p.location.column]),
      [
        [1, 1],
        [3, 1],
        [5, 1],
        [7, 1],
        [9, 1],
      ],
    );
    for (const passage of result.passages) {
      assert.equal(result.extractedText.slice(passage.range.start, passage.range.end), passage.text);
    }
    assert.equal(validateImportResult(result), result);
  });
});

describe("DOCX refusals", () => {
  const reExport = /re-export .* as DOCX .* or .* UTF-8 text/i;

  it("refuses corrupt and unreadable documents with re-export guidance", async () => {
    const { parser, calls } = countingParser();
    refused(await importDocx(new Uint8Array([1, 2, 3, 4]), "corrupt.docx", parser), "unreadable_document", reExport);
    refused(await importDocx(new Uint8Array(), "empty-bytes.docx", parser), "unreadable_document", reExport);
    refused(
      await importDocx(new TextEncoder().encode("plain text, not a zip"), "fake.docx", parser),
      "unreadable_document",
      reExport,
    );
    refused(
      await importDocx(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), "truncated.docx", parser),
      "unreadable_document",
      reExport,
    );
    assert.equal(calls(), 0, "no corrupt container is handed to the parser");
  });

  it("refuses a document with no visible text with re-export guidance", async () => {
    refused(await importDocx(docxBytes(["   "]), "blank.docx"), "whitespace_only", reExport);
    refused(await importDocx(docxBytes([]), "no-paragraphs.docx"), "whitespace_only", reExport);

  });

  it("refuses a non-.docx filename with guidance", async () => {
    refused(await importDocx(docxBytes(["Text"]), "legacy.doc"), "unsupported_format", /\.docx file/i);
    refused(await importDocx(docxBytes(["Text"]), "notes.txt"), "unsupported_format", /\.docx file/i);
  });

  it("reports a parser failure as an unreadable document, never a partial success", async () => {
    const failing: DocxParser = {
      convertToHtml: () => Promise.reject(new Error("parser exploded")),
    };
    refused(await importDocx(docxBytes(["Text"]), "fails.docx", failing), "unreadable_document", reExport);
    const malformed: DocxParser = {
      convertToHtml: () => Promise.resolve({ value: undefined as unknown as string }),
    };
    refused(await importDocx(docxBytes(["Text"]), "malformed.docx", malformed), "unreadable_document", reExport);
  });

  it("throws on misused types instead of guessing", async () => {
    await assert.rejects(() => importDocx("bytes", "a.docx"), /must be a Uint8Array/);
    await assert.rejects(() => importDocx(new Uint8Array([1]), "  "), /nonblank/);
  });
});

describe("DOCX size limits", () => {
  it("accepts an original of exactly 10 MiB and refuses one byte more without truncation", async () => {
    assert.equal(MAX_CONTENT_BYTES, 10 * 1024 * 1024);
    const exactly = docxOfLength(MAX_CONTENT_BYTES);
    assert.equal(exactly.length, MAX_CONTENT_BYTES);
    const { result } = imported(await importDocx(exactly, "exact.docx"));
    assert.equal(result.originalBytes.length, MAX_CONTENT_BYTES);
    assert.equal(result.originalSha256, sha256(exactly));
    assert.equal(result.extractedText, "Padded document.");

    const pastLimit = docxOfLength(MAX_CONTENT_BYTES + 1);
    assert.equal(pastLimit.length, MAX_CONTENT_BYTES + 1);
    refused(await importDocx(pastLimit, "past.docx"), "too_large", /at most .* bytes\. Nothing was truncated/);
  });

  it("refuses an original above the limit before parsing", async () => {
    const huge = new Uint8Array(MAX_CONTENT_BYTES + 1024).fill(0x61);
    let called = false;
    const parser: DocxParser = {
      convertToHtml: () => {
        called = true;
        return Promise.resolve({ value: "" });
      },
    };
    refused(await importDocx(huge, "huge.docx", parser), "too_large", /at most .* bytes\. Nothing was truncated/);
    assert.equal(called, false);
  });

  it("accepts extracted text of exactly 10 MiB and refuses one byte more without truncation", async () => {
    // The original DOCX stays small (under the original limit) while the
    // parser returns extracted markup over the extracted-text limit; the
    // injected parser is the interface under test, not a mocked module.
    const half = MAX_CONTENT_BYTES / 2;
    const block = "a".repeat(half - 1);
    const atLimit = `<p>${block}</p><p>${block}</p>`;
    const parser: DocxParser = { convertToHtml: () => Promise.resolve({ value: atLimit }) };
    const { result } = imported(await importDocx(docxBytes(["marker"]), "limit.docx", parser));
    assert.equal(Buffer.byteLength(result.extractedText, "utf8"), MAX_CONTENT_BYTES);
    assert.equal(result.passages.length, 2);
    assert.equal(validateImportResult(result), result);

    const over = "a".repeat(half);
    const overParser: DocxParser = {
      convertToHtml: () => Promise.resolve({ value: `<p>${over}</p><p>${over}</p>` }),
    };
    refused(
      await importDocx(docxBytes(["marker"]), "over.docx", overParser),
      "too_large",
      /at most .* bytes\. Nothing was truncated/,
    );
  });

  it("measures the extracted limit in UTF-8 bytes, not UTF-16 code units", async () => {
    // U+00E4 is two UTF-8 bytes; this text has MAX_CONTENT_BYTES code units,
    // which is more than MAX_CONTENT_BYTES UTF-8 bytes.
    const text = "\u00E4".repeat(MAX_CONTENT_BYTES / 2 + 1);
    assert.ok(text.length <= MAX_CONTENT_BYTES);
    const parser: DocxParser = { convertToHtml: () => Promise.resolve({ value: `<p>${text}</p>` }) };
    refused(await importDocx(docxBytes(["marker"]), "bytes.docx", parser), "too_large", /at most .* bytes/);
  });

  it("does not report an empty document when the limit is the reason", async () => {
    const text = "a".repeat(MAX_CONTENT_BYTES + 1);
    const parser: DocxParser = { convertToHtml: () => Promise.resolve({ value: `<p>${text}</p>` }) };
    refused(await importDocx(docxBytes(["marker"]), "big.docx", parser), "too_large", /at most .* bytes/);
  });
});


describe("DOCX container size declarations", () => {
  const atMost = /at most .* bytes\. Nothing was truncated/;

  it("refuses a declared total over the content limit by one byte before parsing", async () => {
    const half = Math.floor(MAX_CONTENT_BYTES / 2);
    const bytes = buildZipDetailed([
      { name: "first", bytes: new Uint8Array(0), method: 8, declaredUncompressedSize: half },
      { name: "second", bytes: new Uint8Array(0), method: 8, declaredUncompressedSize: MAX_CONTENT_BYTES - half + 1 },
    ]).bytes;
    const { parser, calls } = countingParser();
    refused(await importDocx(bytes, "total.docx", parser), "too_large", atMost);
    assert.equal(calls(), 0, "the parser is not called for a declared-total refusal");
  });

  it("refuses one entry declaring more than the content limit before parsing", async () => {
    const bytes = buildZipDetailed([
      { name: "one", bytes: new Uint8Array(0), method: 8, declaredUncompressedSize: MAX_CONTENT_BYTES + 1 },
    ]).bytes;
    const { parser, calls } = countingParser();
    refused(await importDocx(bytes, "entry.docx", parser), "too_large", atMost);
    assert.equal(calls(), 0, "the parser is not called for a declared-entry refusal");
  });

  it("refuses a valid, size-consistent member whose actual ratio exceeds 100:1 before parsing", async () => {
    // The deflate stream is complete and its declared length and CRC match the
    // content, so only the ratio declaration itself can refuse it. Removing the
    // ratio guard would let bounded verification pass and reach the parser.
    const content = new Uint8Array(1_000_000);
    const stream = deflateRawSync(content);
    assert.ok(stream.length * 100 < content.length, "the member actually exceeds the 100:1 ratio");
    const over = buildDocxWithExtraEntries(
      [{ name: "customXml/ratio.bin", bytes: content, method: 8 }],
      [{ runs: ["Ratio document."] }],
    );
    const first = countingParser();
    const ratioOutcome = await importDocx(over, "ratio.docx", first.parser);
    refused(ratioOutcome, "unreadable_document", /over the 100:1 limit/);
    if (ratioOutcome.ok) throw new Error("unreachable");
    assert.match(ratioOutcome.refusal.message, reExportGuidance, "the ratio refusal carries re-export guidance");
    assert.equal(first.calls(), 0, "the parser is not called for a ratio refusal");
  });

  it("refuses positive output declared against zero compressed bytes before parsing", async () => {
    const zero = buildZipDetailed([
      {
        name: "zero",
        method: 8,
        compressedData: new Uint8Array(0),
        declaredCompressedSize: 0,
        declaredUncompressedSize: 1,
        crc: 0,
      },
    ]).bytes;
    const second = countingParser();
    const zeroOutcome = await importDocx(zero, "zero.docx", second.parser);
    refused(zeroOutcome, "unreadable_document", /against zero compressed bytes/);
    if (zeroOutcome.ok) throw new Error("unreachable");
    assert.match(zeroOutcome.refusal.message, reExportGuidance, "the zero-compressed refusal carries re-export guidance");
    assert.equal(second.calls(), 0, "the parser is not called when positive output is declared against zero compressed bytes");
  });

  it("imports a valid DOCX at exactly 100:1 and with a valid empty entry", async () => {
    const ratio = imported(await importDocx(docxWithExactRatioEntry(), "ratio-ok.docx"));
    assert.equal(ratio.result.extractedText, "Ratio document.");

    const empty = buildDocxWithExtraEntries(
      [{ name: "customXml/empty.bin", bytes: new Uint8Array(0) }],
      [{ runs: ["Empty entry document."] }],
    );
    const emptyResult = imported(await importDocx(empty, "empty-ok.docx"));
    assert.equal(emptyResult.result.extractedText, "Empty entry document.");
  });

  it("accepts ordinary stored and deflated entries with valid data descriptors", async () => {
    const bytes = buildDocxWithExtraEntries(
      [
        { name: "customXml/stored-descriptor.bin", bytes: new Uint8Array([1, 2, 3]), dataDescriptor: true },
        {
          name: "customXml/deflated-descriptor.bin",
          bytes: new TextEncoder().encode("descriptor text"),
          method: 8,
          dataDescriptor: true,
          descriptorSignature: false,
        },
      ],
      [{ runs: ["Descriptor document."] }],
    );
    const { result } = imported(await importDocx(bytes, "descriptor.docx"));
    assert.equal(result.extractedText, "Descriptor document.");
    assert.equal(result.originalBytes.length, bytes.length);
    assert.deepEqual(result.originalBytes, bytes);
  });
});

describe("DOCX container verification", () => {
  it("refuses an entry whose actual expansion length or data does not match its declaration before Mammoth", async () => {
    const content = new TextEncoder().encode("abc");
    const mismatch = buildDocxWithExtraEntries(
      [
        {
          name: "customXml/mismatch.bin",
          bytes: content,
          method: 8,
          declaredUncompressedSize: 10,
          crc: crc32(content),
        },
      ],
      [{ runs: ["Mismatch document."] }],
    );
    const first = countingParser();
    refused(
      await importDocx(mismatch, "mismatch.docx", first.parser),
      "unreadable_document",
      /expands to 3 bytes but declares 10 bytes/,
    );
    assert.equal(first.calls(), 0, "Mammoth is not called when the actual expansion length disagrees");

    const unreadableData = buildDocxWithExtraEntries(
      [
        {
          name: "customXml/bad.bin",
          method: 8,
          compressedData: new Uint8Array([0xff]),
          declaredCompressedSize: 1,
          declaredUncompressedSize: 1,
          crc: 0,
        },
      ],
      [{ runs: ["Bad document."] }],
    );
    const second = countingParser();
    refused(
      await importDocx(unreadableData, "bad.docx", second.parser),
      "unreadable_document",
      /cannot be expanded within its declared size|does not match its declared CRC/,
    );
    assert.equal(second.calls(), 0, "Mammoth is not called when member data cannot be verified");
  });

  it("requires bounded expansion to consume the exact declared compressed extent", async () => {
    // The complete deflate stream expands to the declared length with the
    // declared CRC, but trailing bytes inside the declared compressed extent
    // make the declaration look like exactly 100:1. The inflater must consume
    // only the stream, so the unaccounted trailing bytes are refused.
    const content = new Uint8Array(1_000_000);
    const stream = deflateRawSync(content);
    const padded = new Uint8Array(content.length / 100);
    assert.ok(stream.length < padded.length, "the real stream leaves room for trailing bytes");
    padded.set(stream);
    const bytes = buildDocxWithExtraEntries(
      [
        {
          name: "customXml/trailing.bin",
          bytes: content,
          method: 8,
          compressedData: padded,
          declaredCompressedSize: padded.length,
          declaredUncompressedSize: content.length,
          crc: crc32(content),
        },
      ],
      [{ runs: ["Trailing document."] }],
    );
    const { parser, calls } = countingParser();
    refused(
      await importDocx(bytes, "trailing.docx", parser),
      "unreadable_document",
      /consumes .* compressed bytes/,
    );
    assert.equal(calls(), 0, "Mammoth is not called when the compressed extent is not fully consumed");
  });
});

describe("DOCX container structure", () => {
  it("refuses malformed, truncated, ambiguous, inconsistent and unsupported ZIP directories before parsing", async () => {
    const valid = docxBytes(["Container text."]);
    const one = buildZipDetailed([{ name: "only", bytes: new TextEncoder().encode("only") }]);
    const two = buildZipDetailed([
      { name: "same", bytes: new TextEncoder().encode("first") },
      { name: "same", bytes: new TextEncoder().encode("second") },
    ]);
    const cases: readonly { readonly name: string; readonly bytes: Uint8Array }[] = [
      { name: "truncated", bytes: valid.subarray(0, valid.length - 10) },
      { name: "entry count", bytes: patched(one.bytes, one.eocdOffset + 10, 2, 2) },
      { name: "central signature", bytes: patched(one.bytes, one.centralOffsets[0], 0, 4) },
      { name: "local signature", bytes: patched(one.bytes, one.localOffsets[0], 0, 4) },
      { name: "central size", bytes: patched(one.bytes, one.eocdOffset + 12, 1, 4) },
      { name: "central offset", bytes: patched(one.bytes, one.eocdOffset + 16, 1, 4) },
      { name: "duplicate name", bytes: two.bytes },
      { name: "unsupported method", bytes: buildZipDetailed([{ name: "method", bytes: new Uint8Array([1]), method: 99 }]).bytes },
      { name: "ZIP64", bytes: buildZipDetailed([{ name: "zip64", bytes: new Uint8Array([1]), declaredCompressedSize: 0xffffffff }]).bytes },
      { name: "local size", bytes: patched(one.bytes, one.localOffsets[0] + 22, 2, 4) },
    ];
    const { parser, calls } = countingParser();
    for (const candidate of cases) {
      refused(
        await importDocx(candidate.bytes, `${candidate.name}.docx`, parser),
        "unreadable_document",
        reExportGuidance,
      );
    }
    assert.equal(calls(), 0, "no malformed or unsupported container reaches the parser");
  });

  it("refuses unsupported extraction versions, header disagreement and method-invalid flags", async () => {
    const base = buildZipDetailed([{ name: "only", bytes: new TextEncoder().encode("versioned") }]);
    let unsupported = patched(base.bytes, base.centralOffsets[0] + 6, 45, 2);
    unsupported = patched(unsupported, base.localOffsets[0] + 4, 45, 2);
    const disagreement = patched(base.bytes, base.centralOffsets[0] + 6, 10, 2);
    let invalidStoredFlags = patched(base.bytes, base.centralOffsets[0] + 8, 0x0806, 2);
    invalidStoredFlags = patched(invalidStoredFlags, base.localOffsets[0] + 6, 0x0806, 2);
    const cases = [
      { name: "unsupported version", bytes: unsupported, message: /unsupported extraction version/ },
      { name: "version disagreement", bytes: disagreement, message: /disagrees .* extraction versions/ },
      { name: "invalid stored flags", bytes: invalidStoredFlags, message: /unsupported ZIP flags for its compression method/ },
    ];
    const { parser, calls } = countingParser();
    for (const candidate of cases) {
      refused(
        await importDocx(candidate.bytes, `${candidate.name}.docx`, parser),
        "unreadable_document",
        candidate.message,
      );
    }
    assert.equal(calls(), 0, "no unsupported header reaches the parser");
  });

  it("refuses data-area gaps, trailing local bytes and bytes no entry accounts for", async () => {
    const firstBytes = new TextEncoder().encode("first!");
    const secondBytes = new TextEncoder().encode("second!");
    const built = buildZipDetailed([
      { name: "first", bytes: firstBytes },
      { name: "second", bytes: secondBytes },
    ]);
    const { parser, calls } = countingParser();

    // Shorten the first member's declarations in both headers: the byte before
    // the next local header is then a gap no member accounts for.
    let gap = patched(built.bytes, built.centralOffsets[0] + 20, firstBytes.length - 1, 4);
    gap = patched(gap, built.centralOffsets[0] + 24, firstBytes.length - 1, 4);
    gap = patched(gap, built.localOffsets[0] + 18, firstBytes.length - 1, 4);
    gap = patched(gap, built.localOffsets[0] + 22, firstBytes.length - 1, 4);
    refused(await importDocx(gap, "gap.docx", parser), "unreadable_document", /gap that no entry accounts for/);

    // Shorten the last member so its extent ends before the central directory.
    let trailing = patched(built.bytes, built.centralOffsets[1] + 20, secondBytes.length - 1, 4);
    trailing = patched(trailing, built.centralOffsets[1] + 24, secondBytes.length - 1, 4);
    trailing = patched(trailing, built.localOffsets[1] + 18, secondBytes.length - 1, 4);
    trailing = patched(trailing, built.localOffsets[1] + 22, secondBytes.length - 1, 4);
    refused(
      await importDocx(trailing, "trailing.docx", parser),
      "unreadable_document",
      /does not end at the central directory/,
    );

    // An archive declaring no entries but carrying bytes before the central
    // directory must not leave those bytes unaccounted for.
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint32(16, 4, true);
    const emptyWithData = new Uint8Array(26);
    emptyWithData.set([0x61, 0x62, 0x63, 0x64], 0);
    emptyWithData.set(eocd, 4);
    refused(
      await importDocx(emptyWithData, "zero-area.docx", parser),
      "unreadable_document",
      /bytes that no entry accounts for/,
    );

    assert.equal(calls(), 0, "no unaccounted data area reaches the parser");
  });

  it("refuses an alternate Unicode Path name that could make member names ambiguous", async () => {
    const first = new TextEncoder().encode("first");
    const secondContent = new TextEncoder().encode("second");
    // The raw name is legacy bytes, so the Unicode Path alternate carries its
    // CRC over those raw bytes; the alternate names the same path as part-one.
    const secondRawName = new TextEncoder().encode("part-two");
    const built = buildZipDetailed([
      { name: "part-one", bytes: first },
      {
        name: "part-two",
        bytes: secondContent,
        flags: 0,
        centralExtra: unicodePathExtra("part-one", secondRawName),
      },
    ]);
    const { parser, calls } = countingParser();
    refused(
      await importDocx(built.bytes, "unicode-path.docx", parser),
      "unreadable_document",
      reExportGuidance,
    );
    assert.equal(calls(), 0, "an alternate-name extra field is not handed to the parser");
  });

  it("refuses ambiguous dot-segment member paths but keeps ordinary nested part paths", async () => {
    const encoder = new TextEncoder();
    const ambiguous = buildZipDetailed([
      { name: "word/document.xml", bytes: encoder.encode("document") },
      { name: "word/./document.xml", bytes: encoder.encode("dot alternate") },
    ]).bytes;
    const { parser, calls } = countingParser();
    const outcome = await importDocx(ambiguous, "dot-segment.docx", parser);
    refused(outcome, "unreadable_document", /ambiguous dot-segment name/);
    if (outcome.ok) throw new Error("unreachable");
    assert.match(outcome.refusal.message, reExportGuidance, "the dot-segment refusal carries re-export guidance");
    assert.equal(calls(), 0, "an ambiguous dot-segment path is not handed to the parser");

    const nested = buildDocxWithExtraEntries(
      [{ name: "customXml/nested/part.bin", bytes: encoder.encode("nested part") }],
      [{ runs: ["Nested parts document."] }],
    );
    const { result } = imported(await importDocx(nested, "nested.docx"));
    assert.equal(result.extractedText, "Nested parts document.");
  });

  it("refuses empty interior path segments and backslashes before the parser", async () => {
    const encoder = new TextEncoder();
    const doubled = buildZipDetailed([
      { name: "word/document.xml", bytes: encoder.encode("document") },
      { name: "word//document.xml", bytes: encoder.encode("doubled separator") },
    ]).bytes;
    const emptySegment = countingParser();
    const emptyOutcome = await importDocx(doubled, "empty-segment.docx", emptySegment.parser);
    refused(emptyOutcome, "unreadable_document", /empty interior path segment/);
    if (emptyOutcome.ok) throw new Error("unreachable");
    assert.match(
      emptyOutcome.refusal.message,
      reExportGuidance,
      "the empty-segment refusal carries re-export guidance",
    );
    assert.equal(emptySegment.calls(), 0, "an empty interior path segment is not handed to the parser");

    const backslash = buildZipDetailed([
      { name: "word\\document.xml", bytes: encoder.encode("backslash separator") },
    ]).bytes;
    const backslashParser = countingParser();
    const backslashOutcome = await importDocx(backslash, "backslash.docx", backslashParser.parser);
    refused(backslashOutcome, "unreadable_document", /backslash/);
    if (backslashOutcome.ok) throw new Error("unreachable");
    assert.match(
      backslashOutcome.refusal.message,
      reExportGuidance,
      "the backslash refusal carries re-export guidance",
    );
    assert.equal(backslashParser.calls(), 0, "a backslash path is not handed to the parser");
  });

  it("refuses a directory entry that declares content but imports an empty directory entry", async () => {
    const encoder = new TextEncoder();
    const directoryWithContent = buildDocxWithExtraEntries(
      [{ name: "customXml/folder/", bytes: encoder.encode("not an empty directory") }],
      [{ runs: ["Directory document."] }],
    );
    const { parser, calls } = countingParser();
    const outcome = await importDocx(directoryWithContent, "directory.docx", parser);
    refused(outcome, "unreadable_document", /marks a directory name but declares .* uncompressed bytes/);
    if (outcome.ok) throw new Error("unreachable");
    assert.match(
      outcome.refusal.message,
      reExportGuidance,
      "the nonempty-directory refusal carries re-export guidance",
    );
    assert.equal(calls(), 0, "a directory entry that declares content is not handed to the parser");

    const emptyDirectory = buildDocxWithExtraEntries(
      [{ name: "customXml/folder/", bytes: new Uint8Array(0) }],
      [{ runs: ["Empty directory document."] }],
    );
    const { result } = imported(await importDocx(emptyDirectory, "empty-directory.docx"));
    assert.equal(result.extractedText, "Empty directory document.");
  });

  it("refuses part names that differ only by ASCII letter case before the parser", async () => {
    const encoder = new TextEncoder();
    const caseEquivalent = buildZipDetailed([
      { name: "word/document.xml", bytes: encoder.encode("lower-case content") },
      { name: "Word/Document.xml", bytes: encoder.encode("upper-case content") },
    ]).bytes;
    const { parser, calls } = countingParser();
    const outcome = await importDocx(caseEquivalent, "case-equivalent.docx", parser);
    refused(outcome, "unreadable_document", /repeats another entry's name/);
    if (outcome.ok) throw new Error("unreachable");
    assert.match(
      outcome.refusal.message,
      reExportGuidance,
      "the case-equivalent-name refusal carries re-export guidance",
    );
    assert.equal(calls(), 0, "two case-equivalent part names are not handed to the parser");
  });

  it("reports central offsets that identify each central header in a multi-entry archive", async () => {
    const names = ["first", "second", "third"];
    const built = buildZipDetailed(
      names.map((name) => ({ name, bytes: new TextEncoder().encode(name) })),
    );
    const view = new DataView(built.bytes.buffer, built.bytes.byteOffset, built.bytes.byteLength);
    for (let index = 0; index < names.length; index += 1) {
      const offset = built.centralOffsets[index];
      assert.equal(view.getUint32(offset, true), 0x02014b50, `central offset ${index} points at a central header`);
      const nameLength = view.getUint16(offset + 28, true);
      const name = new TextDecoder().decode(built.bytes.subarray(offset + 46, offset + 46 + nameLength));
      assert.equal(name, names[index], `central offset ${index} names the corresponding entry`);
    }
    const damaged = patched(built.bytes, built.centralOffsets[1], 0, 4);
    const { parser, calls } = countingParser();
    refused(
      await importDocx(damaged, "multi-central.docx", parser),
      "unreadable_document",
      /central-directory entry 2 has no entry signature/,
    );
    assert.equal(calls(), 0, "the damaged central header is not handed to the parser");
  });

  it("imports an archive whose declared parts total exactly the content limit", async () => {
    const bytes = docxOfExpandedLength(MAX_CONTENT_BYTES);
    const { result } = imported(await importDocx(bytes, "expanded.docx"));
    assert.equal(result.extractedText, "Expanded document.");
    assert.ok(bytes.length < MAX_CONTENT_BYTES, "the original stays below its own byte limit");
  });

  it("builds a one-megabyte upload that declares about 300 MiB without expanding it", async () => {
    const filler = pseudoRandomBytes(1024 * 1024);
    const bytes = buildDocxWithExtraEntries(
      [
        {
          name: "customXml/large.bin",
          bytes: filler,
          method: 8,
          declaredUncompressedSize: 300 * 1024 * 1024,
        },
      ],
      [{ runs: ["Large declaration."] }],
    );
    assert.ok(bytes.length >= 1024 * 1024, "the upload carries about a megabyte of compressed data");
    const { parser, calls } = countingParser();
    refused(await importDocx(bytes, "large.docx", parser), "too_large", /at most .* bytes\. Nothing was truncated/);
    assert.equal(calls(), 0, "the parser is not called for the inert large declaration");
  });
});

describe("DOCX parser is exercised offline", () => {
  it("imports synthetic DOCX bytes with the installed parser and no extra assets", async () => {
    // The fixture builds its own ZIP; nothing is read from disk.
    const bytes = docxBytes(["Offline parsing works.", "Ünïcode."]);
    const snapshot = Uint8Array.from(bytes);
    const outcome = await importDocx(bytes, "offline.docx");
    assert.equal(outcome.ok, true);
    assert.deepEqual(bytes, snapshot);
    const { result } = imported(outcome);
    assert.deepEqual(result.passages.map((p) => p.text), ["Offline parsing works.", "Ünïcode."]);
  });
});

