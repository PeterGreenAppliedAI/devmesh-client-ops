import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeMultipart,
  FILE_CONTROL,
  PASTE_CONTROL,
  type MultipartForm,
  type MultipartOutcome,
} from "../src/transcript-multipart.ts";
import { ValidationError } from "../src/model.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const BOUNDARY = "----TestBoundary123";

/** Concatenate strings (encoded as UTF-8) and byte chunks into one body. */
function concat(chunks: readonly (string | Uint8Array)[]): Uint8Array {
  const arrays = chunks.map((chunk) => (typeof chunk === "string" ? encoder.encode(chunk) : chunk));
  const total = arrays.reduce((sum, array) => sum + array.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.length;
  }
  return out;
}

function text(value: string): Uint8Array {
  return encoder.encode(value);
}

/** A description of one part, rendered as header lines and a payload. */
interface PartSpec {
  /** The name parameter; omitted when undefined. */
  readonly name?: string;
  /** Include a plain filename parameter (an empty string is a real value). */
  readonly filename?: string;
  /** Include a filename* parameter; its value is never decoded or used. */
  readonly filenameStar?: string;
  /** The whole Content-Disposition value, overriding name/filename. */
  readonly rawDisposition?: string;
  /** Leave out the Content-Disposition header entirely. */
  readonly omitDisposition?: boolean;
  /** Add a second Content-Disposition header line. */
  readonly duplicateDisposition?: boolean;
  /** The payload: a string (UTF-8) or exact bytes. */
  readonly value?: string | Uint8Array;
  /** Raw header lines placed after Content-Disposition (may contain CRLF). */
  readonly extraHeaders?: readonly string[];
}

/** Render the header block plus payload for one part. */
function partBlock(spec: PartSpec): Uint8Array {
  const lines: string[] = [];
  if (!spec.omitDisposition) {
    let disposition = spec.rawDisposition;
    if (disposition === undefined) {
      const params = [`name=${quoteOrToken(spec.name ?? "")}`];
      if (spec.filename !== undefined) params.push(`filename=${quote(spec.filename)}`);
      if (spec.filenameStar !== undefined) params.push(`filename*=${quote(spec.filenameStar)}`);
      disposition = `form-data; ${params.join("; ")}`;
    }
    lines.push(`Content-Disposition: ${disposition}`);
    if (spec.duplicateDisposition) lines.push(`Content-Disposition: ${disposition}`);
  }
  if (spec.extraHeaders !== undefined) lines.push(...spec.extraHeaders);
  const payload = typeof spec.value === "string" ? text(spec.value) : (spec.value ?? new Uint8Array());
  return concat([lines.join("\r\n"), "\r\n\r\n", payload]);
}

function quote(value: string): string {
  return `"${value}"`;
}

/** A name that is a token is left unquoted; anything else is quoted. */
function quoteOrToken(value: string): string {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value) ? value : quote(value);
}

/** How the body ends after the last part's payload. */
type CloseStyle = "crlf" | "eof" | "none";

/**
 * Build a body from parts. Each part delimiter carries its own CRLF after the
 * boundary, each payload is followed by the CRLF that frames the next
 * delimiter, and the close is `--boundary--` (with CRLF, at EOF, or absent).
 * `epilogue` bytes follow a CRLF close and must be ignored.
 */
function buildBody(
  boundary: string,
  parts: readonly PartSpec[],
  options: { close?: CloseStyle; epilogue?: string | Uint8Array } = {},
): Uint8Array {
  const close = options.close ?? "crlf";
  const chunks: (string | Uint8Array)[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    chunks.push(`${index === 0 ? "" : "\r\n"}--${boundary}\r\n`);
    chunks.push(partBlock(parts[index]));
  }
  if (parts.length > 0) chunks.push("\r\n");
  if (close === "crlf") {
    chunks.push(`--${boundary}--\r\n`);
    if (options.epilogue !== undefined) chunks.push(options.epilogue);
  } else if (close === "eof") {
    chunks.push(`--${boundary}--`);
  }
  return concat(chunks);
}

/** Assert a successful decode and return the form. */
function accepted(outcome: MultipartOutcome): MultipartForm {
  if (!outcome.ok) {
    // Serialize only the small refusal object, never a form's byte arrays.
    assert.fail(`expected success, got ${JSON.stringify(outcome.refusal)}`);
  }
  return outcome;
}

/**
 * Assert a refusal with a code and status, and that no partial form or file was
 * returned. Optional patterns check the message and the resubmission guidance.
 */
function refused(
  outcome: MultipartOutcome,
  code: string,
  status: number,
  message?: RegExp,
  guidance?: RegExp,
): void {
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("unreachable");
  assert.equal(outcome.refusal.code, code);
  assert.equal(outcome.refusal.status, status);
  if (message !== undefined) assert.match(outcome.refusal.message, message);
  if (guidance !== undefined) assert.match(outcome.refusal.guidance, guidance);
  assert.equal(outcome.refusal.message.length > 0, true);
  assert.equal(outcome.refusal.guidance.length > 0, true);
  const record = outcome as unknown as Record<string, unknown>;
  assert.equal(record.fields, undefined);
  assert.equal(record.file, undefined);
}

function contentType(boundary: string, quoted = false): string {
  return `multipart/form-data; boundary=${quoted ? quote(boundary) : boundary}`;
}

describe("decoding a valid multipart body", () => {
  it("returns text controls as own properties and the file separately", () => {
    const fileBytes = new Uint8Array([0, 1, 2, 255, 13, 10]);
    const body = buildBody(BOUNDARY, [
      { name: PASTE_CONTROL, value: "Hello from the paste control." },
      { name: "meeting", value: "Weekly sync" },
      { name: FILE_CONTROL, filename: "notes.txt", value: fileBytes },
    ]);
    const form = accepted(decodeMultipart(body, contentType(BOUNDARY)));
    assert.deepEqual(Object.keys(form.fields), [PASTE_CONTROL, "meeting"]);
    assert.equal(form.fields[PASTE_CONTROL], "Hello from the paste control.");
    assert.equal(form.fields.meeting, "Weekly sync");
    assert.notEqual(form.file, null);
    assert.equal(form.file?.filename, "notes.txt");
    assert.deepEqual(form.file?.bytes, fileBytes);
    assert.equal(Object.hasOwn(form.fields, FILE_CONTROL), false);
  });

  it("accepts a quoted boundary and an unquoted boundary for the same bytes", () => {
    const body = buildBody(BOUNDARY, [{ name: "a", value: "one" }]);
    assert.equal(accepted(decodeMultipart(body, contentType(BOUNDARY))).fields.a, "one");
    assert.equal(accepted(decodeMultipart(body, contentType(BOUNDARY, true))).fields.a, "one");
  });

  it("accepts a boundary containing a space when it is quoted", () => {
    const boundary = "abc def";
    const body = buildBody(boundary, [{ name: "a", value: "one" }]);
    assert.equal(accepted(decodeMultipart(body, contentType(boundary, true))).fields.a, "one");
  });

  it("accepts a body that is only a closing delimiter (no parts)", () => {
    const body = buildBody(BOUNDARY, []);
    const form = accepted(decodeMultipart(body, contentType(BOUNDARY)));
    assert.deepEqual(Object.keys(form.fields), []);
    assert.equal(form.file, null);
  });

  it("accepts a closing delimiter at EOF with no trailing CRLF", () => {
    const body = buildBody(BOUNDARY, [{ name: "a", value: "one" }], { close: "eof" });
    assert.equal(accepted(decodeMultipart(body, contentType(BOUNDARY))).fields.a, "one");
  });

  it("accepts both a paste and a file, and neither, leaving correction to the handler", () => {
    const both = buildBody(BOUNDARY, [
      { name: PASTE_CONTROL, value: "text" },
      { name: FILE_CONTROL, filename: "a.txt", value: "bytes" },
    ]);
    const bothForm = accepted(decodeMultipart(both, contentType(BOUNDARY)));
    assert.equal(bothForm.fields[PASTE_CONTROL], "text");
    assert.equal(bothForm.file?.filename, "a.txt");

    const neither = buildBody(BOUNDARY, [{ name: "meeting", value: "x" }]);
    const neitherForm = accepted(decodeMultipart(neither, contentType(BOUNDARY)));
    assert.equal(neitherForm.fields.meeting, "x");
    assert.equal(neitherForm.file, null);
  });

  it("does not mutate the caller's body bytes", () => {
    const body = buildBody(BOUNDARY, [
      { name: "a", value: "one" },
      { name: FILE_CONTROL, filename: "a.bin", value: new Uint8Array([9, 8, 7]) },
    ]);
    const snapshot = new Uint8Array(body);
    const form = accepted(decodeMultipart(body, contentType(BOUNDARY)));
    assert.deepEqual(body, snapshot);
    // The returned file bytes are a detached copy, not a view of the body.
    (form.file?.bytes as Uint8Array)[0] = 0;
    assert.deepEqual(body, snapshot);
  });
});

describe("delimiter recognition and payload preservation", () => {
  it("preserves boundary-like payload bytes and ignores false close prefixes", () => {
    // `--B` not at a line start, a longer boundary prefix, and a close-like
    // sequence followed by junk are all payload, never delimiters.
    const payload = `intro --${BOUNDARY} inline\nnext\r\n--${BOUNDARY}X\r\n--${BOUNDARY}-- trailing\r\nend`;
    const expected = text(payload);
    const body = buildBody(BOUNDARY, [
      { name: "text", value: payload },
      { name: FILE_CONTROL, filename: "a.bin", value: expected },
    ]);
    const form = accepted(decodeMultipart(body, contentType(BOUNDARY)));
    assert.equal(form.fields.text, payload);
    assert.deepEqual(form.file?.bytes, expected);
  });

  it("preserves false opening and closing prefixes alongside non-text binary bytes", () => {
    // A false opening prefix is not at a line start; a false close prefix is
    // followed by junk. Both sit among bytes that are not valid UTF-8, and the
    // whole array is returned exactly.
    const payload = concat([
      new Uint8Array([0x00, 0xff, 0xfe, 0x80]),
      `--${BOUNDARY}`,
      new Uint8Array([0xc3, 0x28]),
      `\r\n--${BOUNDARY}--x\r\n`,
      new Uint8Array([0xed, 0xa0, 0x80, 0x01]),
    ]);
    const body = buildBody(BOUNDARY, [{ name: FILE_CONTROL, filename: "a.bin", value: payload }]);
    const form = accepted(decodeMultipart(body, contentType(BOUNDARY)));
    assert.deepEqual(form.file?.bytes, payload);
  });

  it("finds the first whole delimiter after a preamble", () => {
    const body = concat(["preamble\r\n", buildBody(BOUNDARY, [{ name: "a", value: "one" }])]);
    assert.equal(accepted(decodeMultipart(body, contentType(BOUNDARY))).fields.a, "one");
  });

  it("finds the first whole delimiter after a binary preamble", () => {
    const body = concat([
      new Uint8Array([0x00, 0xff, 0xfe]),
      `--${BOUNDARY}X\r\n`,
      buildBody(BOUNDARY, [{ name: "a", value: "one" }]),
    ]);
    assert.equal(accepted(decodeMultipart(body, contentType(BOUNDARY))).fields.a, "one");
  });

  it("ignores a false opening prefix before the real delimiter", () => {
    const body = concat([`--${BOUNDARY}X\r\n`, buildBody(BOUNDARY, [{ name: "a", value: "one" }])]);
    assert.equal(accepted(decodeMultipart(body, contentType(BOUNDARY))).fields.a, "one");
  });

  it("stops at the first real close and ignores the epilogue", () => {
    const epilogue = concat([
      `\r\n--${BOUNDARY}\r\n`,
      "Content-Disposition: form-data; name=\"late\"\r\n\r\nignored\r\n",
      `--${BOUNDARY}--\r\n`,
    ]);
    const body = buildBody(BOUNDARY, [{ name: "a", value: "one" }], { epilogue });
    const form = accepted(decodeMultipart(body, contentType(BOUNDARY)));
    assert.deepEqual(Object.keys(form.fields), ["a"]);
    assert.equal(Object.hasOwn(form.fields, "late"), false);
    assert.equal(form.file, null);
  });

  it("refuses a body with no closing delimiter", () => {
    const body = buildBody(BOUNDARY, [{ name: "a", value: "one" }], { close: "none" });
    refused(
      decodeMultipart(body, contentType(BOUNDARY)),
      "invalid_multipart",
      400,
      /closing boundary/,
      /multipart\/form-data/,
    );
  });

  it("refuses a body whose only delimiter-like bytes are not whole lines", () => {
    // Every candidate carries a suffix that is neither CRLF nor `--` at EOF, so
    // none of them is a whole delimiter line and the body never opens.
    const body = concat([
      `--${BOUNDARY}X\r\n`,
      `--${BOUNDARY}--x\r\n`,
      `--${BOUNDARY}`,
      " trailing",
    ]);
    refused(decodeMultipart(body, contentType(BOUNDARY)), "invalid_multipart", 400, /opening boundary/);
  });

  it("requires CRLF framing, refusing bare LF and mixed framing", () => {
    const bareLf = text(
      `--${BOUNDARY}\nContent-Disposition: form-data; name="a"\n\none\n--${BOUNDARY}--\n`,
    );
    refused(decodeMultipart(bareLf, contentType(BOUNDARY)), "invalid_multipart", 400);

    const mixed = concat([
      `--${BOUNDARY}\r\n`,
      `Content-Disposition: form-data; name="a"\n\none\r\n`,
      `--${BOUNDARY}--\r\n`,
    ]);
    refused(decodeMultipart(mixed, contentType(BOUNDARY)), "invalid_multipart", 400, /malformed/);

    // A header block whose lines end with bare LF instead of CRLF is refused
    // as a malformed header line.
    const bareLfHeaders = concat([
      `--${BOUNDARY}\r\n`,
      `Content-Disposition: form-data; name="a"\r\n\r\none`,
      `\n--${BOUNDARY}--\r\n`,
    ]);
    refused(
      decodeMultipart(bareLfHeaders, contentType(BOUNDARY)),
      "invalid_multipart",
      400,
      /closing boundary/,
    );
  });
});

describe("text controls: encoding, BOM and line endings", () => {
  it("keeps a byte-order mark and the payload's own line endings", () => {
    const value = "\uFEFFline one\nline two\r\nline three\rend";
    const body = buildBody(BOUNDARY, [{ name: "a", value }]);
    const form = accepted(decodeMultipart(body, contentType(BOUNDARY)));
    assert.equal(form.fields.a, value);
    assert.equal(form.fields.a.charCodeAt(0), 0xfeff);
  });

  it("decodes Unicode text exactly", () => {
    const value = "héllo 😀 日本語";
    const body = buildBody(BOUNDARY, [{ name: "a", value }]);
    assert.equal(accepted(decodeMultipart(body, contentType(BOUNDARY))).fields.a, value);
  });

  it("refuses a text control that is not valid UTF-8", () => {
    const body = buildBody(BOUNDARY, [{ name: "a", value: new Uint8Array([0x61, 0xff, 0xfe]) }]);
    refused(
      decodeMultipart(body, contentType(BOUNDARY)),
      "invalid_utf8",
      400,
      /not valid UTF-8/,
      /UTF-8/,
    );
  });

  it("accepts empty text controls and returns them as empty strings", () => {
    const body = buildBody(BOUNDARY, [
      { name: "a", value: "" },
      { name: "b", value: "kept" },
    ]);
    const form = accepted(decodeMultipart(body, contentType(BOUNDARY)));
    assert.equal(Object.hasOwn(form.fields, "a"), true);
    assert.equal(form.fields.a, "");
    assert.equal(form.fields.b, "kept");
  });
});

describe("the file control", () => {
  it("preserves literal backslashes in a filename", () => {
    const filename = "C:\\Temp\\reports\\a.txt";
    const body = buildBody(BOUNDARY, [{ name: FILE_CONTROL, filename, value: "x" }]);
    assert.equal(accepted(decodeMultipart(body, contentType(BOUNDARY))).file?.filename, filename);
  });

  it("preserves a non-ASCII filename with literal backslashes exactly", () => {
    const filename = "C:\\Temp\\héllo 😀 日本語\\résumé.pdf";
    const body = buildBody(BOUNDARY, [{ name: FILE_CONTROL, filename, value: "x" }]);
    assert.equal(accepted(decodeMultipart(body, contentType(BOUNDARY))).file?.filename, filename);
  });

  it("ignores filename* on a text control instead of treating it as a file part", () => {
    const body = buildBody(BOUNDARY, [
      { name: "note", filenameStar: "UTF-8''starred.txt", value: "kept text" },
    ]);
    const form = accepted(decodeMultipart(body, contentType(BOUNDARY)));
    assert.equal(form.fields.note, "kept text");
    assert.equal(Object.hasOwn(form.fields, "filename*"), false);
    assert.equal(form.file, null);
  });

  it("uses the plain filename and ignores filename* alongside it", () => {
    const body = buildBody(BOUNDARY, [
      { name: FILE_CONTROL, filename: "plain.txt", filenameStar: "UTF-8''starred.txt", value: "x" },
    ]);
    const form = accepted(decodeMultipart(body, contentType(BOUNDARY)));
    assert.equal(form.file?.filename, "plain.txt");
    assert.equal(decoder.decode(form.file?.bytes), "x");
  });

  it("refuses filename* alone because the plain filename parameter is required", () => {
    const body = buildBody(BOUNDARY, [
      { name: FILE_CONTROL, filenameStar: "UTF-8''starred.txt", value: "x" },
    ]);
    refused(
      decodeMultipart(body, contentType(BOUNDARY)),
      "invalid_multipart",
      400,
      /plain filename/,
    );
  });

  it("treats an empty filename with zero bytes as no file selected", () => {
    const body = buildBody(BOUNDARY, [
      { name: FILE_CONTROL, filename: "", value: new Uint8Array() },
      { name: "a", value: "kept" },
    ]);
    const form = accepted(decodeMultipart(body, contentType(BOUNDARY)));
    assert.equal(form.file, null);
    assert.equal(form.fields.a, "kept");
    assert.equal(Object.hasOwn(form.fields, FILE_CONTROL), false);
  });

  it("treats a named zero-byte file as a selected empty file", () => {
    const body = buildBody(BOUNDARY, [
      { name: FILE_CONTROL, filename: "empty.txt", value: new Uint8Array() },
    ]);
    const form = accepted(decodeMultipart(body, contentType(BOUNDARY)));
    assert.equal(form.file?.filename, "empty.txt");
    assert.equal(form.file?.bytes.length, 0);
  });

  it("refuses an unnamed payload: bytes with an empty filename", () => {
    const body = buildBody(BOUNDARY, [{ name: FILE_CONTROL, filename: "", value: "bytes" }]);
    refused(
      decodeMultipart(body, contentType(BOUNDARY)),
      "invalid_multipart",
      400,
      /has no filename/,
    );
  });

  it("refuses a file control that has no plain filename parameter", () => {
    const body = buildBody(BOUNDARY, [{ name: FILE_CONTROL, value: "text" }]);
    refused(
      decodeMultipart(body, contentType(BOUNDARY)),
      "invalid_multipart",
      400,
      /plain filename/,
    );
  });

  it("refuses a file part carried by any control other than file", () => {
    const body = buildBody(BOUNDARY, [{ name: "attachment", filename: "a.txt", value: "x" }]);
    refused(
      decodeMultipart(body, contentType(BOUNDARY)),
      "invalid_multipart",
      400,
      /only the "file" control accepts a file part/,
    );
  });
});

describe("duplicate controls refuse the whole submission", () => {
  const cases: readonly { readonly label: string; readonly parts: readonly PartSpec[]; readonly name: string }[] = [
    {
      label: "repeated text control",
      parts: [
        { name: "notes", value: "one" },
        { name: "notes", value: "two" },
      ],
      name: "notes",
    },
    {
      label: "repeated text control with equal values",
      parts: [
        { name: "notes", value: "same" },
        { name: "notes", value: "same" },
      ],
      name: "notes",
    },
    {
      label: "repeated paste control",
      parts: [
        { name: PASTE_CONTROL, value: "one" },
        { name: PASTE_CONTROL, value: "two" },
      ],
      name: PASTE_CONTROL,
    },
    {
      label: "repeated file control",
      parts: [
        { name: FILE_CONTROL, filename: "a.txt", value: "one" },
        { name: FILE_CONTROL, filename: "b.txt", value: "two" },
      ],
      name: FILE_CONTROL,
    },
    {
      label: "repeated empty control",
      parts: [
        { name: "empty", value: "" },
        { name: "empty", value: "" },
      ],
      name: "empty",
    },
    {
      label: "repeated empty file control (unselected)",
      parts: [
        { name: FILE_CONTROL, filename: "", value: new Uint8Array() },
        { name: FILE_CONTROL, filename: "", value: new Uint8Array() },
      ],
      name: FILE_CONTROL,
    },
    {
      label: "repeated unknown control",
      parts: [
        { name: "custom", value: "one" },
        { name: "custom", value: "" },
      ],
      name: "custom",
    },
  ];

  for (const testCase of cases) {
    it(`refuses a ${testCase.label}`, () => {
      const body = buildBody(BOUNDARY, testCase.parts);
      refused(
        decodeMultipart(body, contentType(BOUNDARY)),
        "duplicate_control",
        400,
        new RegExp(`submitted more than once|submitted once`, "i"),
        /each control must be submitted once/i,
      );
      const outcome = decodeMultipart(body, contentType(BOUNDARY));
      if (outcome.ok) throw new Error("unreachable");
      assert.match(outcome.refusal.message, new RegExp(`"${testCase.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    });
  }
});

describe("text controls return as own properties", () => {
  it("returns __proto__ and constructor as plain own properties", () => {
    const body = buildBody(BOUNDARY, [
      { name: "__proto__", value: "proto-value" },
      { name: "constructor", value: "constructor-value" },
      { name: "toString", value: "toString-value" },
      { name: "hasOwnProperty", value: "hasOwn-value" },
    ]);
    const form = accepted(decodeMultipart(body, contentType(BOUNDARY)));
    assert.equal(Object.getPrototypeOf(form.fields), null);
    for (const [name, value] of [
      ["__proto__", "proto-value"],
      ["constructor", "constructor-value"],
      ["toString", "toString-value"],
      ["hasOwnProperty", "hasOwn-value"],
    ] as const) {
      assert.equal(Object.hasOwn(form.fields, name), true, name);
      assert.equal(form.fields[name], value, name);
    }
    assert.deepEqual(Object.keys(form.fields), [
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
    ]);
  });
});

describe("headers and parameters", () => {
  it("ignores well-formed unknown part headers", () => {
    const body = buildBody(BOUNDARY, [
      { name: "a", value: "one", extraHeaders: ["X-Note: value with spaces", "Content-Type: application/octet-stream"] },
      { name: FILE_CONTROL, filename: "a.bin", value: "x", extraHeaders: ["X-Other:  spaced  "] },
    ]);
    const form = accepted(decodeMultipart(body, contentType(BOUNDARY)));
    assert.equal(form.fields.a, "one");
    assert.equal(form.file?.filename, "a.bin");
  });

  it("keeps non-ASCII whitespace in an unknown header value rather than trimming it", () => {
    const body = buildBody(BOUNDARY, [
      { name: "a", value: "one", extraHeaders: ["X-Note: value\u00a0", "X-Tab:\tvalue\t"] },
    ]);
    assert.equal(accepted(decodeMultipart(body, contentType(BOUNDARY))).fields.a, "one");
  });

  it("accepts optional whitespace around a quoted parameter value", () => {
    const body = buildBody(BOUNDARY, [
      { rawDisposition: "form-data ; name=\"a b\" ; X-Unknown = \"v\"", value: "x" },
    ]);
    const form = accepted(decodeMultipart(body, contentType(BOUNDARY)));
    assert.equal(form.fields["a b"], "x");
  });

  it("accepts quoted and unquoted parameter values", () => {
    const body = buildBody(BOUNDARY, [
      { rawDisposition: "form-data; name=tokenName", value: "x" },
      { rawDisposition: "form-data; name=\"quoted name\"", value: "y" },
    ]);
    const form = accepted(decodeMultipart(body, contentType(BOUNDARY)));
    assert.equal(form.fields.tokenName, "x");
    assert.equal(form.fields["quoted name"], "y");
  });

  const malformed: readonly { readonly label: string; readonly spec: PartSpec; readonly message: RegExp }[] = [
    {
      label: "a part with no Content-Disposition",
      spec: { omitDisposition: true, value: "x" },
      message: /no Content-Disposition/,
    },
    {
      label: "a missing name parameter",
      spec: { rawDisposition: "form-data", value: "x" },
      message: /not a form-data control with one name/,
    },
    {
      label: "an empty name parameter",
      spec: { rawDisposition: "form-data; name=\"\"", value: "x" },
      message: /not a form-data control with one name/,
    },
    {
      label: "a disposition that is not form-data",
      spec: { rawDisposition: "attachment; name=\"a\"", value: "x" },
      message: /not a form-data control with one name/,
    },
    {
      label: "a duplicated name parameter",
      spec: { rawDisposition: "form-data; name=\"a\"; name=\"b\"", value: "x" },
      message: /not a form-data control with one name/,
    },
    {
      label: "trailing junk after a quoted value",
      spec: { rawDisposition: "form-data; name=\"a\" junk", value: "x" },
      message: /not a form-data control with one name/,
    },
    {
      label: "an unterminated quoted value",
      spec: { rawDisposition: "form-data; name=\"a", value: "x" },
      message: /not a form-data control with one name/,
    },
    {
      label: "a parameter name that is not a token",
      spec: { rawDisposition: "form-data; na me=\"a\"", value: "x" },
      message: /not a form-data control with one name/,
    },
    {
      label: "an unquoted value that is not a token",
      spec: { rawDisposition: "form-data; name=a,b", value: "x" },
      message: /not a form-data control with one name/,
    },
    {
      label: "a control character in a quoted value",
      spec: { rawDisposition: "form-data; name=\"a\u0001b\"", value: "x" },
      message: /malformed/,
    },
    {
      label: "two Content-Disposition headers",
      spec: { name: "a", duplicateDisposition: true, value: "x" },
      message: /more than one Content-Disposition/,
    },
    {
      label: "a folded header line",
      spec: { name: "a", value: "x", extraHeaders: ["X-Note: one\r\n two"] },
      message: /malformed/,
    },
    {
      label: "a header name that is not a token",
      spec: { name: "a", value: "x", extraHeaders: ["Bad Header: value"] },
      message: /malformed/,
    },
    {
      label: "a header line without a colon",
      spec: { name: "a", value: "x", extraHeaders: ["NoColon"] },
      message: /malformed/,
    },
    {
      label: "a control character in a header value",
      spec: { name: "a", value: "x", extraHeaders: ["X-Note: bad\u0001value"] },
      message: /malformed/,
    },
    {
      label: "non-ASCII whitespace after a quoted value",
      spec: { rawDisposition: "form-data; name=\"a\"\u00a0", value: "x" },
      message: /not a form-data control with one name/,
    },
    {
      label: "a header name prefixed with a byte-order mark",
      spec: { name: "a", value: "x", extraHeaders: ["\ufeffX-Note: value"] },
      message: /malformed/,
    },
    {
      label: "headers not terminated by CRLF CRLF",
      spec: { name: "a", value: "x", extraHeaders: [] },
      message: /terminated by CRLF CRLF/,
    },
  ];

  for (const testCase of malformed) {
    it(`refuses ${testCase.label}`, () => {
      // The last case builds a part whose header block never ends: strip the
      // CRLF CRLF and the close, so the body ends inside the headers.
      const body =
        testCase.label === "headers not terminated by CRLF CRLF"
          ? concat([`--${BOUNDARY}\r\nContent-Disposition: form-data; name="a"`])
          : buildBody(BOUNDARY, [testCase.spec]);
      refused(
        decodeMultipart(body, contentType(BOUNDARY)),
        "invalid_multipart",
        400,
        testCase.message,
        /multipart\/form-data/,
      );
    });
  }
});

describe("wrong media type is 415", () => {
  const headers = [
    "application/json",
    "text/plain",
    "",
    "multipart/mixed; boundary=x",
    "multipart/form-datax; boundary=x",
    "text/multipart/form-data; boundary=x",
    "multipart/form-data\n",
  ];
  for (const header of headers) {
    it(`refuses Content-Type ${JSON.stringify(header)}`, () => {
      const body = buildBody(BOUNDARY, [{ name: "a", value: "one" }]);
      refused(
        decodeMultipart(body, header),
        "wrong_media_type",
        415,
        /not a multipart\/form-data body/,
        /multipart\/form-data/,
      );
    });
  }

  // A right media type with a malformed or ambiguous parameter list is invalid
  // multipart (400), not a wrong media type.
  const invalidBodies: readonly string[] = [
    "multipart/form-data",
    "multipart/form-data; charset=utf-8",
    "multipart/form-data; boundary=x junk",
    "multipart/form-data ", 
    "multipart/form-data; boundary=has*star",
    "multipart/form-data; boundary=x\njunk",
    "multipart/form-data; boundary=",
    "multipart/form-data; boundary=a; boundary=b",
    "multipart/form-data; boundary=\"a b \"",
    `multipart/form-data; boundary=${"a".repeat(71)}`,
    "multipart/form-data; boundary=",
    "multipart/form-data; boundary=a\n",
    "multipart/form-data; boundary=\"unterminated",
    "multipart/form-data; \u00a0boundary=a",
  ];
  for (const header of invalidBodies) {
    it(`refuses malformed boundary parameter in ${JSON.stringify(header)} with 400`, () => {
      const body = buildBody(BOUNDARY, [{ name: "a", value: "one" }]);
      refused(
        decodeMultipart(body, header),
        "invalid_multipart",
        400,
        /boundary parameter/,
        /multipart\/form-data/,
      );
    });
  }

  it("accepts optional whitespace around the media type and before the parameters", () => {
    const body = buildBody(BOUNDARY, [{ name: "a", value: "one" }]);
    for (const header of [
      ` multipart/form-data; boundary=${BOUNDARY}`,
      `multipart/form-data ; boundary=${BOUNDARY}`,
      `multipart/form-data;boundary=${BOUNDARY}`,
      `multipart/form-data\t; boundary=${BOUNDARY}`,
    ]) {
      assert.equal(accepted(decodeMultipart(body, header)).fields.a, "one", header);
    }
  });

  it("refuses an absent Content-Type with 415", () => {
    const body = buildBody(BOUNDARY, [{ name: "a", value: "one" }]);
    refused(decodeMultipart(body, undefined), "wrong_media_type", 415);
    refused(decodeMultipart(body, null), "wrong_media_type", 415);
  });
});

describe("size limits are inclusive", () => {
  // The owner-specified inclusive limits, written out independently of the
  // decoder's constants: 15 MiB whole body, 10 MiB each for paste and file.
  const BODY_LIMIT = 15_728_640;
  const PART_LIMIT = 10_485_760;
  // Framing overhead for a single metadata control with an empty payload.
  const metadataOverhead = buildBody(BOUNDARY, [{ name: "metadata", value: "" }]).length;

  it("accepts a body of exactly 15 MiB and refuses one byte more", () => {
    const exact = buildBody(BOUNDARY, [
      { name: "metadata", value: "a".repeat(BODY_LIMIT - metadataOverhead) },
    ]);
    assert.equal(exact.length, BODY_LIMIT);
    const form = accepted(decodeMultipart(exact, contentType(BOUNDARY)));
    assert.equal(form.fields.metadata.length, BODY_LIMIT - metadataOverhead);

    const over = buildBody(BOUNDARY, [
      { name: "metadata", value: "a".repeat(BODY_LIMIT - metadataOverhead + 1) },
    ]);
    assert.equal(over.length, BODY_LIMIT + 1);
    refused(
      decodeMultipart(over, contentType(BOUNDARY)),
      "too_large",
      413,
      /submission is \d+ bytes; it must be at most \d+ bytes/,
      /at most \d+ bytes/,
    );
  });

  it("accepts a paste control of exactly 10 MiB and refuses one byte more", () => {
    const exact = buildBody(BOUNDARY, [{ name: PASTE_CONTROL, value: "a".repeat(PART_LIMIT) }]);
    const form = accepted(decodeMultipart(exact, contentType(BOUNDARY)));
    assert.equal(form.fields[PASTE_CONTROL].length, PART_LIMIT);

    const over = buildBody(BOUNDARY, [{ name: PASTE_CONTROL, value: "a".repeat(PART_LIMIT + 1) }]);
    refused(
      decodeMultipart(over, contentType(BOUNDARY)),
      "too_large",
      413,
      /paste is \d+ bytes; it must be at most \d+ bytes/,
      /at most \d+ bytes/,
    );
  });

  it("accepts a file of exactly 10 MiB and refuses one byte more", () => {
    const exact = new Uint8Array(PART_LIMIT).fill(0x42);
    const body = buildBody(BOUNDARY, [
      { name: FILE_CONTROL, filename: "big.bin", value: exact },
    ]);
    const form = accepted(decodeMultipart(body, contentType(BOUNDARY)));
    assert.equal(form.file?.bytes.length, PART_LIMIT);
    assert.equal(form.file?.bytes[0], 0x42);

    const over = new Uint8Array(PART_LIMIT + 1);
    const overBody = buildBody(BOUNDARY, [
      { name: FILE_CONTROL, filename: "big.bin", value: over },
    ]);
    refused(
      decodeMultipart(overBody, contentType(BOUNDARY)),
      "too_large",
      413,
      /file is \d+ bytes; it must be at most \d+ bytes/,
      /at most \d+ bytes/,
    );
  });

  it("accepts metadata over 10 MiB inside a valid body", () => {
    const length = PART_LIMIT + 1024;
    const body = buildBody(BOUNDARY, [{ name: "metadata", value: "b".repeat(length) }]);
    assert.equal(body.length <= BODY_LIMIT, true);
    const form = accepted(decodeMultipart(body, contentType(BOUNDARY)));
    assert.equal(form.fields.metadata.length, length);
  });
});

describe("argument validation", () => {
  it("throws ValidationError for a non-byte body", () => {
    assert.throws(() => decodeMultipart("not bytes", contentType(BOUNDARY)), ValidationError);
    assert.throws(() => decodeMultipart([1, 2, 3], contentType(BOUNDARY)), ValidationError);
  });

  it("throws ValidationError for a non-string content type that is present", () => {
    const body = buildBody(BOUNDARY, [{ name: "a", value: "one" }]);
    assert.throws(() => decodeMultipart(body, 42), ValidationError);
    assert.throws(() => decodeMultipart(body, { boundary: "x" }), ValidationError);
  });
});
