import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  canonicalize,
  importFileBytes,
  importPastedText,
  MAX_CONTENT_BYTES,
  MissingPassageError,
  resolveCitation,
  SUPPORTED_EXPORTS,
  validateImportResult,
  validatePassage,
  validatePassageReference,
  WrongSourceError,
  type ImportOutcome,
  type ImportResult,
} from "../src/transcript.ts";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Assert an outcome is a successful import and return its result. */
function imported(outcome: ImportOutcome): ImportResult {
  assert.equal(outcome.ok, true, `expected success, got ${JSON.stringify(outcome)}`);
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.result;
}

/**
 * Assert an outcome is a refusal with `code`, the supported-export guidance and
 * no usable import. `guided` says whether the message itself names the exports,
 * which the three content refusals must and a size refusal need not.
 */
function refused(outcome: ImportOutcome, code: string, guided = true): void {
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("unreachable");
  assert.equal(outcome.refusal.code, code);
  if (guided) assert.match(outcome.refusal.message, /pasted text/i);
  assert.deepEqual(outcome.refusal.supportedExports, SUPPORTED_EXPORTS);
  assert.equal((outcome as unknown as Record<string, unknown>).result, undefined);
}

describe("pasted text import", () => {
  it("preserves the pasted text exactly and keeps extracted text separate", () => {
    const text = "  First line\r\n\r\nSecond paragraph.  \n\n\nThird.  ";
    const result = imported(importPastedText(text));
    assert.equal(result.format, "paste");
    assert.equal(result.filename, "Pasted text");
    assert.equal(result.originalText, text);
    assert.equal(result.extractedText, text);
    assert.deepEqual(result.originalBytes, new TextEncoder().encode(text));
    assert.equal(result.originalSha256, sha256(new TextEncoder().encode(text)));
    // The canonical content is the normalized text, not the original text.
    assert.equal(result.canonicalText, "First line Second paragraph. Third.");
    assert.notEqual(result.extractedText, result.canonicalText);
  });

  it("keeps a byte-order mark in the extracted text and trims it only canonically", () => {
    const text = "\uFEFFHeading\nbody";
    const result = imported(importPastedText(text));
    assert.equal(result.extractedText, text);
    assert.equal(result.canonicalText, "Heading body");
  });

  it("does not mutate the caller's value and returns a frozen result", () => {
    const text = "Hello  world";
    const result = imported(importPastedText(text));
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.passages));
    assert.equal(result.originalText, text);
  });
});

describe("TXT and MD files", () => {
  it("imports UTF-8 TXT bytes with exact preservation and display filename", () => {
    const bytes = new TextEncoder().encode("A.txt body\r\nwith CRLF\r\n");
    const snapshot = Uint8Array.from(bytes);
    const result = imported(importFileBytes(bytes, "notes.txt"));
    assert.equal(result.format, "txt");
    assert.equal(result.filename, "notes.txt");
    assert.equal(result.originalText, "A.txt body\r\nwith CRLF\r\n");
    assert.equal(result.extractedText, result.originalText);
    assert.deepEqual(result.originalBytes, snapshot);
    assert.equal(result.originalSha256, sha256(snapshot));
    // The input buffer is never mutated.
    assert.deepEqual(bytes, snapshot);
  });

  it("imports UTF-8 MD bytes and accepts common case and extensions", () => {
    const md = "# Title\n\n- item";
    const result = imported(importFileBytes(new TextEncoder().encode(md), "README.MD"));
    assert.equal(result.format, "markdown");
    assert.equal(result.filename, "README.MD");
    assert.equal(result.extractedText, md);
    assert.equal(result.canonicalText, "# Title - item");
    // Only the authorized `.txt` and `.md` extensions are accepted; other
    // extensions, including `.markdown`, are refused.
    refused(importFileBytes(new TextEncoder().encode(md), "notes.markdown"), "unsupported_format");
  });

  it("copies the input buffer so later mutation cannot change the result", () => {
    const bytes = new TextEncoder().encode("original");
    const result = imported(importFileBytes(bytes, "a.txt"));
    bytes.fill(0);
    assert.equal(result.extractedText, "original");
    assert.equal(result.originalSha256, sha256(new TextEncoder().encode("original")));
  });
});

describe("Unicode", () => {
  it("preserves astral and combining characters with exact range encoding", () => {
    const text = "Grüße 👩‍👩‍👧 e\u0301\n\n😀 second \u00A0paragraph";
    const result = imported(importPastedText(text));
    assert.equal(result.extractedText, text);
    const [first, second] = result.passages;
    assert.equal(first.text, "Grüße 👩‍👩‍👧 e\u0301");
    assert.equal(second.text, "😀 second \u00A0paragraph");
    // Ranges are UTF-16 code-unit offsets into the extracted text, exactly.
    for (const passage of result.passages) {
      assert.equal(result.extractedText.slice(passage.range.start, passage.range.end), passage.text);
    }
    assert.equal(first.range.start, 0);
    assert.equal(first.range.end, first.text.length);
    assert.equal(second.range.start, text.indexOf("😀"));
    assert.equal(second.range.end, text.length);
    // Astral characters count as two code units, as the exact range does.
    assert.ok(second.range.end - second.range.start > second.text.length - 4);
  });

  it("gives non-BMP passages honest line and column locations", () => {
    const text = "😀😀 one\nline\n\nlast";
    const result = imported(importPastedText(text));
    assert.deepEqual(result.passages[0].location, { start: 0, end: text.indexOf("\n\n"), line: 1, column: 1 });
    assert.deepEqual(result.passages[1].location, {
      start: text.indexOf("last"),
      end: text.length,
      line: 4,
      column: 1,
    });
  });
});

describe("refusals", () => {
  it("refuses invalid UTF-8 with guidance", () => {
    refused(importFileBytes(new Uint8Array([0x41, 0xff, 0x42]), "broken.txt"), "invalid_utf8");
    // A truncated multi-byte sequence is invalid UTF-8 too.
    refused(importFileBytes(new Uint8Array([0xe2, 0x82]), "truncated.md"), "invalid_utf8");
  });

  it("refuses empty and whitespace-only input with guidance", () => {
    refused(importPastedText(""), "whitespace_only");
    refused(importPastedText("   \r\n\t\n\u00A0\uFEFF"), "whitespace_only");
    refused(importFileBytes(new Uint8Array(), "empty.txt"), "whitespace_only");
    refused(importFileBytes(new TextEncoder().encode(" \n\n\t "), "blank.md"), "whitespace_only");
  });

  it("refuses unsupported formats with supported-export guidance", () => {
    refused(importFileBytes(new TextEncoder().encode("text"), "doc.pdf"), "unsupported_format");
    refused(importFileBytes(new TextEncoder().encode("text"), "notes.docx"), "unsupported_format");
    refused(importFileBytes(new TextEncoder().encode("text"), "noextension"), "unsupported_format");
  });

  it("throws on misused types instead of guessing", () => {
    assert.throws(() => importPastedText(new Uint8Array([65])), /must be a string/);
    assert.throws(() => importFileBytes("text", "a.txt"), /must be a Uint8Array/);
    assert.throws(() => importFileBytes(new Uint8Array([65]), "  "), /nonblank/);
  });

  it("refuses ill-formed pasted Unicode with guidance before lossy encoding", () => {
    // A lone high or low surrogate cannot be encoded as UTF-8 without being
    // replaced, so it is refused rather than stored inconsistently.
    refused(importPastedText("bad \uD800 text"), "invalid_text");
    refused(importPastedText("\uDC00 lone low"), "invalid_text");
    refused(importPastedText("\uD800"), "invalid_text");
    // A refusal carries no usable import and cannot masquerade as one.
    assert.equal((importPastedText("\uD800") as unknown as Record<string, unknown>).result, undefined);
    // A well-formed surrogate pair is accepted and preserved exactly.
    const pair = "\uD83D\uDE00 emoji";
    const result = imported(importPastedText(pair));
    assert.equal(result.originalText, pair);
    assert.equal(result.extractedText, pair);
    assert.deepEqual(result.originalBytes, new TextEncoder().encode(pair));
    assert.equal(validateImportResult(result), result);
    // The replacement character as literal text is a different source from the
    // lone surrogate, which is refused rather than conflated with it.
    const replacement = imported(importPastedText(`${String.fromCharCode(0xfffd)} emoji`));
    assert.notEqual(result.canonicalIdentity, replacement.canonicalIdentity);
    assert.notEqual(result.canonicalText, replacement.canonicalText);
  });
});

describe("size limits", () => {
  it("accepts content of exactly 10 MiB and refuses one byte more without truncating", () => {
    assert.equal(MAX_CONTENT_BYTES, 10 * 1024 * 1024);
    const exactly = new Uint8Array(MAX_CONTENT_BYTES).fill(0x61);
    const result = imported(importFileBytes(exactly, "exact.txt"));
    assert.equal(result.originalBytes.length, MAX_CONTENT_BYTES);
    assert.equal(result.extractedText.length, MAX_CONTENT_BYTES);
    assert.equal(result.originalSha256, sha256(exactly));

    const pastLimit = new Uint8Array(MAX_CONTENT_BYTES + 1).fill(0x61);
    refused(importFileBytes(pastLimit, "past.txt"), "too_large", false);
    refused(importPastedText("a".repeat(MAX_CONTENT_BYTES + 1)), "too_large", false);
  });

  it("accepts pasted text of exactly 10 MiB", () => {
    const text = "a".repeat(MAX_CONTENT_BYTES);
    const result = imported(importPastedText(text));
    assert.equal(result.extractedText.length, MAX_CONTENT_BYTES);
    assert.equal(result.originalText.length, MAX_CONTENT_BYTES);
  });

  it("measures the limit in UTF-8 bytes, not UTF-16 code units", () => {
    // U+00E4 is two UTF-8 bytes; half the code units exceed the byte limit.
    const text = "\u00E4".repeat(MAX_CONTENT_BYTES / 2 + 1);
    assert.ok(text.length <= MAX_CONTENT_BYTES);
    refused(importPastedText(text), "too_large", false);
  });
});

describe("normalization", () => {
  it("collapses whitespace runs to one space and trims the ends only in canonical content", () => {
    const extracted = "  The  Quick\t\tFox\n\nJumps \r\n over.  ";
    const result = imported(importPastedText(extracted));
    assert.equal(result.extractedText, extracted);
    assert.equal(result.canonicalText, "The Quick Fox Jumps over.");
    assert.equal(canonicalize(extracted), result.canonicalText);
  });

  it("keeps case and punctuation significant", () => {
    const a = imported(importPastedText("Hello, World."));
    const b = imported(importPastedText("hello world"));
    assert.equal(a.canonicalText, "Hello, World.");
    assert.notEqual(a.canonicalIdentity, b.canonicalIdentity);
  });

  it("gives whitespace variants the same canonical identity but distinct originals", () => {
    const a = imported(importPastedText("one   two\nthree"));
    const b = imported(importPastedText("one two three"));
    assert.equal(a.canonicalIdentity, b.canonicalIdentity);
    assert.equal(a.id, a.canonicalIdentity);
    assert.notEqual(a.originalSha256, b.originalSha256);
    // Original and extracted content stay unchanged by normalization.
    assert.equal(a.extractedText, "one   two\nthree");
    assert.equal(a.originalText, "one   two\nthree");
  });

  it("gives identical bytes the identical identities and passage identities", () => {
    const bytes = new TextEncoder().encode("Stable\n\ncontent");
    const first = imported(importFileBytes(bytes, "stable.txt"));
    const second = imported(importFileBytes(bytes, "renamed.txt"));
    assert.equal(first.id, second.id);
    assert.deepEqual(
      first.passages.map((p) => [p.id, p.range.start, p.range.end]),
      second.passages.map((p) => [p.id, p.range.start, p.range.end]),
    );
  });
});

describe("passages", () => {
  it("subdivides at blank lines with exact bounds and stable identities", () => {
    const text = "One.\n\nTwo.\n\n\n\nThree,  \nstill three.";
    const result = imported(importPastedText(text));
    assert.deepEqual(result.passages.map((p) => p.text), ["One.", "Two.", "Three,  \nstill three."]);
    for (const [index, passage] of result.passages.entries()) {
      assert.equal(passage.id, `${result.id}/p${index + 1}`);
      assert.equal(passage.sourceId, result.id);
      assert.equal(text.slice(passage.range.start, passage.range.end), passage.text);
      assert.equal(passage.location.start, passage.range.start);
      assert.equal(passage.location.end, passage.range.end);
    }
    assert.equal(result.passages[2].text, "Three,  \nstill three.");
  });

  it("makes a single passage of text without a blank line", () => {
    const result = imported(importPastedText("single line\nstill one paragraph"));
    assert.equal(result.passages.length, 1);
    assert.equal(result.passages[0].text, "single line\nstill one paragraph");
  });
});

describe("strict validators", () => {
  it("accepts a genuine result and returns it unchanged", () => {
    const result = imported(importPastedText("Valid\n\ncontent."));
    assert.equal(validateImportResult(result), result);
    assert.equal(validatePassage(result.passages[0]), result.passages[0]);
  });

  it("refuses a result with a wrong hash, tampered text, or extra fields", () => {
    const result = imported(importPastedText("Some text."));
    assert.throws(() => validateImportResult({ ...result, originalSha256: "0".repeat(64) }), /originalSha256/);
    assert.throws(() => validateImportResult({ ...result, extractedText: "Some  text." }), /extractedText/);
    assert.throws(() => validateImportResult({ ...result, canonicalText: "Some  text." }), /canonicalText/);
    assert.throws(() => validateImportResult({ ...result, extra: true }), /unsupported field/);
    assert.throws(() => validateImportResult({ ...result, id: "sha256:" + "1".repeat(64) }), /id/);
    const { passages: _omit, ...missing } = result;
    assert.throws(() => validateImportResult(missing), /missing field/);
  });

  it("refuses a result with altered passage ranges, text or identities", () => {
    const result = imported(importPastedText("First.\n\nSecond."));
    const [first, second] = result.passages;
    assert.throws(
      () => validateImportResult({
        ...result,
        passages: [{ ...first, range: { start: 0, end: 3 }, location: { start: 0, end: 3, line: 1, column: 1 }, text: "F" }, second],
      }),
      /passage|range|text/,
    );
    assert.throws(
      () => validateImportResult({ ...result, passages: [{ ...first, text: "FirsT." }, second] }),
      /text does not match|must not carry/,
    );
    assert.throws(
      () => validateImportResult({ ...result, passages: [{ ...first, id: "other/p1" }, second] }),
      /id must be/,
    );
  });

  it("refuses malformed passages and references", () => {
    assert.throws(() => validatePassage({ id: "x" }), /missing field/);
    assert.throws(
      () => validatePassage({
        id: "s/p1",
        sourceId: "s",
        range: { start: 5, end: 3 },
        location: { start: 5, end: 3, line: 1, column: 1 },
        text: "abc",
      }),
      /start before end/,
    );
    assert.throws(
      () => validatePassage({
        id: "s/p1",
        sourceId: "s",
        range: { start: 0, end: 3 },
        location: { start: 0, end: 3, line: 1, column: 1 },
        text: " abc",
      }),
      /leading or trailing/,
    );
    assert.throws(
      () => validatePassageReference({ sourceId: "s", passageId: "p", range: { start: 0, end: 3 }, quote: "caller" }),
      /unsupported field/,
    );
    assert.throws(
      () => validatePassageReference({ sourceId: "s", passageId: "p", range: { start: 3, end: 0 } }),
      /start before end/,
    );
    assert.throws(() => validatePassageReference({ sourceId: "s", passageId: "p" }), /missing field/);
  });
});

describe("citation resolution", () => {
  const text = "Alpha beta.\n\nGamma 🎯 delta.";
  const source = imported(importPastedText(text));

  function referenceFor(passageIndex: number) {
    const passage = source.passages[passageIndex];
    return { sourceId: passage.sourceId, passageId: passage.id, range: { ...passage.range } };
  }

  it("resolves a matching reference and quotes the authoritative text", () => {
    const resolved = resolveCitation(referenceFor(1), source, source.passages[1]);
    assert.equal(resolved.sourceId, source.id);
    assert.equal(resolved.passageId, source.passages[1].id);
    assert.deepEqual(resolved.range, source.passages[1].range);
    assert.equal(resolved.quote, "Gamma 🎯 delta.");
    assert.equal(resolved.quote, text.slice(resolved.range.start, resolved.range.end));
    assert.ok(Object.isFrozen(resolved));
  });

  it("refuses a reference to a wrong source", () => {
    const other = imported(importPastedText("Unrelated content."));
    assert.throws(
      () => resolveCitation({ ...referenceFor(0), sourceId: other.id }, source, source.passages[0]),
      WrongSourceError,
    );
    // A passage from another source is refused even if the reference names ours.
    assert.throws(
      () => resolveCitation(referenceFor(0), source, other.passages[0]),
      WrongSourceError,
    );
  });

  it("refuses a reference to a nonexistent passage", () => {
    const passage = source.passages[0];
    assert.throws(
      () => resolveCitation({ ...referenceFor(0), passageId: `${source.id}/p99` }, source, passage),
      MissingPassageError,
    );
    const foreign = imported(importPastedText("Different.")).passages[0];
    assert.throws(
      () => resolveCitation({ ...referenceFor(0), passageId: foreign.id }, source, passage),
      MissingPassageError,
    );
  });

  it("refuses invalid or mismatched ranges", () => {
    const passage = source.passages[0];
    assert.throws(
      () => resolveCitation({ ...referenceFor(0), range: { start: 0, end: passage.range.end + 5 } }, source, passage),
      /does not match/,
    );
    assert.throws(
      () => resolveCitation({ ...referenceFor(0), range: { start: passage.range.start + 1, end: passage.range.end } }, source, passage),
      /does not match/,
    );
    assert.throws(
      () => resolveCitation({ ...referenceFor(0), range: { start: 4, end: 2 } }, source, passage),
      /start before end/,
    );
  });

  it("refuses a supplied passage that the source does not hold", () => {
    const passage = source.passages[0];
    assert.throws(
      () => resolveCitation(referenceFor(0), source, { ...passage, text: "Alpha  beta." }),
      /does not match the passage/,
    );
  });
});
