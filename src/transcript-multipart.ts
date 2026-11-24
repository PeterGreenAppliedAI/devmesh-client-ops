/**
 * Unexposed in-memory decoder for a complete `multipart/form-data` submission.
 *
 * The decoder reads the whole body and its `Content-Type` header in memory and
 * never touches the filesystem, a network or any other module: it turns one
 * accepted submission into text controls plus, separately, the submitted file.
 * Nothing here is persisted or exposed; a route (which is not part of this
 * module) decides what happens to the decoded values.
 *
 * Framing is strict:
 *
 * - A delimiter line is recognised only as a whole line: at the very start of
 *   the body, or immediately after a CRLF. It must carry the full boundary of
 *   the `Content-Type` header, and right after the boundary it must be either
 *   `--` (a closing delimiter, allowed at end of body) or CRLF (a part
 *   delimiter). A `--boundary` that is not a whole line, or whose suffix is
 *   anything else, is payload bytes and is preserved exactly.
 * - The first delimiter must be at the start of the body; there is no preamble.
 * - The part delimiter ends with CRLF; header lines end with CRLF; the header
 *   block ends with CRLF CRLF before the payload. Bare LF, lone CR and folded
 *   header lines are refused, so mixed and LF-only framing is refused.
 * - The first real closing delimiter ends the body: the submission is complete
 *   there, and everything after it (the epilogue) is ignored. Apparent parts
 *   after the close are never read. A body that reaches its end without a
 *   closing delimiter is refused: no partial form or file is ever returned.
 *
 * Controls are strict:
 *
 * - Each part needs exactly one `Content-Disposition: form-data` header with a
 *   nonempty `name` parameter. Header and parameter names are tokens, unquoted
 *   parameter values are tokens and quoted values run through the closing
 *   quote; malformed lines, folding, control characters, duplicate (ambiguous)
 *   parameters and trailing junk are refused. Well-formed unknown part headers
 *   are validated and then ignored.
 * - A control name may appear at most once, whatever its value and even when
 *   that value is empty: a repeated text control, a repeated file control, a
 *   repeated empty control or a repeated unknown control refuses the entire
 *   submission. The refusal says that each control must be submitted once, and
 *   no duplicate value is ever selected.
 * - Text controls are decoded as strict UTF-8 with the byte-order mark and the
 *   payload's own line endings preserved. Invalid UTF-8 refuses the whole
 *   submission.
 * - Only the `file` control may carry a file part (a part with a `filename` or
 *   `filename*` parameter). The `file` control requires its plain `filename`
 *   parameter; `filename*` is ignored entirely, never decoded and never used as
 *   a fallback. Literal backslashes in a filename are preserved as they are.
 *   An empty filename with zero bytes means no file was selected; a nonempty
 *   filename with zero bytes is a selected empty file; an empty filename with
 *   bytes is an unnamed payload and is refused.
 * - Text controls are returned as own properties of `fields` (built without a
 *   prototype, so names such as `__proto__` and `constructor` are plain own
 *   properties), and the file is returned separately with its display filename
 *   and an exact copy of its bytes.
 *
 * Size limits are inclusive: the whole body may be at most 15 MiB, and the
 * `paste` text control and the file may each be at most 10 MiB. Every other
 * text control is counted only through the body total. Any excess refuses the
 * whole submission rather than truncating it.
 *
 * A refusal carries its HTTP status: a wrong media type is 415, an invalid
 * multipart body (framing, headers, parameters or UTF-8) and a duplicate
 * control are 400, and an excess is 413. Whether a submission has both a paste
 * and a file, or neither, is left to the handler; this decoder only reports
 * what was submitted.
 */
import { ValidationError } from "./model.ts";

/** The inclusive limit, in bytes, for the whole multipart body. */
export const MAX_MULTIPART_BYTES = 15 * 1024 * 1024;

/** The inclusive limit, in bytes, for the `paste` text control. */
export const MAX_PASTE_BYTES = 10 * 1024 * 1024;

/** The inclusive limit, in bytes, for the submitted file. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** The name of the text control that carries pasted transcript text. */
export const PASTE_CONTROL = "paste";

/** The name of the control that carries a file part; no other control may. */
export const FILE_CONTROL = "file";

/** The media type this decoder accepts. */
export const FORM_DATA_MEDIA_TYPE = "multipart/form-data";

/**
 * Why a submission was refused. `wrong_media_type` is 415, `invalid_multipart`,
 * `invalid_utf8` and `duplicate_control` are 400, and `too_large` is 413.
 */
export type MultipartRefusalCode =
  | "wrong_media_type"
  | "invalid_multipart"
  | "invalid_utf8"
  | "duplicate_control"
  | "too_large";

/** The HTTP status a refusal maps to: 400 invalid input, 413 excess, 415 media. */
export type MultipartRefusalStatus = 400 | 413 | 415;

/** A refused submission: no partial form or file is returned. */
export interface MultipartRefusal {
  readonly ok: false;
  readonly refusal: {
    readonly code: MultipartRefusalCode;
    readonly status: MultipartRefusalStatus;
    /** What was wrong, naming the problem as observed. */
    readonly message: string;
    /** How to submit the form so the next attempt succeeds. */
    readonly guidance: string;
  };
}

/** The file part of a submission: its display filename and exact bytes. */
export interface MultipartFile {
  /** The plain `filename` parameter exactly as submitted, backslashes included. */
  readonly filename: string;
  /** A detached copy of the file payload's exact bytes. */
  readonly bytes: Uint8Array;
}

/** An accepted submission: its text controls and, separately, its file. */
export interface MultipartForm {
  readonly ok: true;
  /** Text controls as own properties; `file` is never a property here. */
  readonly fields: Readonly<Record<string, string>>;
  /** The selected file, or null when none was selected. */
  readonly file: MultipartFile | null;
}

/** The outcome of decoding a submission: an accepted form or a refusal. */
export type MultipartOutcome = MultipartForm | MultipartRefusal;

//
// Refusal messages and guidance. These are the actual words a refusal carries;
// tests assert them, so they are named here rather than spelled out at call
// sites.
//

const WRONG_MEDIA_MESSAGE = `The request is not a ${FORM_DATA_MEDIA_TYPE} body with exactly one boundary parameter.`;
const WRONG_MEDIA_GUIDANCE = `Submit the form as ${FORM_DATA_MEDIA_TYPE} with a single boundary parameter and try again.`;

const INVALID_MULTIPART_GUIDANCE =
  "Submit the form once as a well-formed multipart/form-data body: CRLF line endings, a single closing boundary, and one form-data part per control.";

const INVALID_UTF8_GUIDANCE = "Submit text controls as valid UTF-8 and try again.";

const DUPLICATE_GUIDANCE =
  "Each control must be submitted once: send each text field and the file exactly once, with a single value.";

const TOO_LARGE_GUIDANCE = `Keep the whole submission at most ${MAX_MULTIPART_BYTES} bytes, with the ${PASTE_CONTROL} control and the file each at most ${MAX_PASTE_BYTES} bytes; nothing was truncated.`;

/** Build a refusal outcome. */
function refuse(
  code: MultipartRefusalCode,
  status: MultipartRefusalStatus,
  message: string,
  guidance: string,
): MultipartRefusal {
  return Object.freeze({
    ok: false,
    refusal: Object.freeze({ code, status, message, guidance }),
  });
}

/** A refusal for a wrong or absent media type (415). */
function wrongMedia(): MultipartRefusal {
  return refuse("wrong_media_type", 415, WRONG_MEDIA_MESSAGE, WRONG_MEDIA_GUIDANCE);
}

/** A refusal for a framing, header or parameter problem (400). */
function invalidMultipart(detail: string): MultipartRefusal {
  return refuse(
    "invalid_multipart",
    400,
    `The multipart body is not valid: ${detail}.`,
    INVALID_MULTIPART_GUIDANCE,
  );
}

/** A refusal for a text control payload that is not valid UTF-8 (400). */
function invalidUtf8(name: string): MultipartRefusal {
  return refuse(
    "invalid_utf8",
    400,
    `The text control ${JSON.stringify(name)} is not valid UTF-8.`,
    INVALID_UTF8_GUIDANCE,
  );
}

/** A refusal for a control name submitted more than once (400). */
function duplicateControl(name: string): MultipartRefusal {
  return refuse(
    "duplicate_control",
    400,
    `The control ${JSON.stringify(name)} was submitted more than once; each control must be submitted once.`,
    DUPLICATE_GUIDANCE,
  );
}

/** A refusal for an excess, naming the part and its measured length (413). */
function tooLarge(what: string, length: number, limit: number): MultipartRefusal {
  return refuse(
    "too_large",
    413,
    `The ${what} is ${length} bytes; it must be at most ${limit} bytes. Nothing was truncated.`,
    TOO_LARGE_GUIDANCE,
  );
}

//
// Character classes. A token is the RFC 9110 `token`: one or more tchars.
//

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const TOKEN_CHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/;
const BOUNDARY_CHAR = /[0-9A-Za-z'()+_,\-./:=? ]/;

function isTokenChar(ch: string): boolean {
  return TOKEN_CHAR.test(ch);
}

/**
 * True when a boundary is valid per RFC 2046: 1 to 70 characters drawn from the
 * bchars set, with no trailing space. The boundary may be quoted or unquoted in
 * the Content-Type header; either way its value is matched literally.
 */
function isValidBoundary(value: string): boolean {
  if (value.length < 1 || value.length > 70) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!BOUNDARY_CHAR.test(value[index])) return false;
  }
  return value[value.length - 1] !== " ";
}

//
// Content-Type parsing. The type must be `multipart/form-data`, with exactly one
// well-formed `boundary` parameter. A duplicate parameter name is ambiguous and
// refused; other well-formed parameters are ignored.
//

interface ParsedParameter {
  readonly name: string;
  readonly value: string;
}

/**
 * Parse a `;`-separated parameter list starting at `start`. Names and unquoted
 * values must be tokens, quoted values run to their closing quote (a backslash
 * is a literal character, not an escape), and nothing but optional whitespace
 * may follow a value before the next `;` or the end. Returns null on anything
 * malformed, including controls, an unterminated quote or trailing junk.
 */
function parseParameters(text: string, start: number): ParsedParameter[] | null {
  const params: ParsedParameter[] = [];
  let index = start;
  const skipWhitespace = (): void => {
    while (index < text.length && (text[index] === " " || text[index] === "\t")) index += 1;
  };
  skipWhitespace();
  while (index < text.length) {
    if (text[index] !== ";") return null;
    index += 1;
    skipWhitespace();
    const nameStart = index;
    while (index < text.length && isTokenChar(text[index])) index += 1;
    if (index === nameStart) return null;
    const name = text.slice(nameStart, index);
    skipWhitespace();
    if (text[index] !== "=") return null;
    index += 1;
    skipWhitespace();
    let value: string;
    if (text[index] === "\"") {
      index += 1;
      const valueStart = index;
      while (index < text.length && text[index] !== "\"") {
        const code = text.charCodeAt(index);
        // C0 controls (CR and LF included) and DEL are refused inside a quote.
        if (code < 0x20 || code === 0x7f) return null;
        index += 1;
      }
      if (index >= text.length) return null;
      value = text.slice(valueStart, index);
      index += 1;
      skipWhitespace();
      if (index < text.length && text[index] !== ";") return null;
    } else {
      const valueStart = index;
      while (index < text.length && isTokenChar(text[index])) index += 1;
      if (index === valueStart) return null;
      value = text.slice(valueStart, index);
      skipWhitespace();
      if (index < text.length && text[index] !== ";") return null;
    }
    params.push({ name, value });
  }
  return params;
}

/** Reject a parameter list that names the same parameter twice (case-insensitively). */
function hasAmbiguousParameter(params: readonly ParsedParameter[]): boolean {
  const seen = new Set<string>();
  for (const param of params) {
    const name = param.name.toLowerCase();
    if (seen.has(name)) return true;
    seen.add(name);
  }
  return false;
}

/**
 * Parse the media type and its boundary: only `multipart/form-data` with exactly
 * one well-formed boundary. Returns null on any wrong or ambiguous media type.
 */
function parseContentType(header: string): { boundary: string } | null {
  const text = header.trim();
  let index = 0;
  while (index < text.length && text[index] !== ";") index += 1;
  if (text.slice(0, index).trim().toLowerCase() !== FORM_DATA_MEDIA_TYPE) return null;
  const params = parseParameters(text, index);
  if (params === null) return null;
  if (hasAmbiguousParameter(params)) return null;
  let boundary: string | undefined;
  for (const param of params) {
    if (param.name.toLowerCase() !== "boundary") continue;
    // A second boundary parameter is ambiguous; exactly one is required.
    if (boundary !== undefined) return null;
    if (!isValidBoundary(param.value)) return null;
    boundary = param.value;
  }
  return boundary === undefined ? null : { boundary };
}

//
// Content-Disposition parsing.
//

interface Disposition {
  /** The plain, nonempty control name. */
  readonly name: string;
  /** The plain `filename` parameter, exactly as submitted, or undefined. */
  readonly filename: string | undefined;
  /** True when the part carries a `filename` or `filename*` parameter. */
  readonly hasFileParameter: boolean;
}

/**
 * Parse a part's `Content-Disposition` value: `form-data` with exactly one
 * nonempty `name` parameter, plus optional parameters. A duplicated parameter
 * name is ambiguous and refused. `filename*` is recognised only as evidence
 * that the part is a file part: its value is never decoded and never used.
 */
function parseDisposition(value: string): Disposition | null {
  const text = value.trim();
  let index = 0;
  while (index < text.length && isTokenChar(text[index])) index += 1;
  if (text.slice(0, index).toLowerCase() !== "form-data") return null;
  const params = parseParameters(text, index);
  if (params === null) return null;
  if (hasAmbiguousParameter(params)) return null;
  let name: string | undefined;
  let filename: string | undefined;
  let hasFileParameter = false;
  for (const param of params) {
    const lower = param.name.toLowerCase();
    if (lower === "name") name = param.value;
    else if (lower === "filename") filename = param.value;
    else if (lower === "filename*") hasFileParameter = true;
  }
  if (name === undefined || name.length === 0) return null;
  if (filename !== undefined) hasFileParameter = true;
  return { name, filename, hasFileParameter };
}

//
// Header-line parsing.
//

interface PartHeader {
  readonly name: string;
  readonly value: string;
}

/**
 * Parse one header line. A header name must be a token and the value must carry
 * no control character except horizontal tab. A line that starts with a space
 * or tab is a folded continuation and is refused.
 */
function parseHeaderLine(line: string): PartHeader | null {
  if (line.length > 0 && (line[0] === " " || line[0] === "\t")) return null;
  const colon = line.indexOf(":");
  if (colon <= 0) return null;
  const name = line.slice(0, colon);
  if (!TOKEN.test(name)) return null;
  const rawValue = line.slice(colon + 1);
  for (let index = 0; index < rawValue.length; index += 1) {
    const code = rawValue.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return null;
  }
  const value = rawValue.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
  return { name, value };
}

//
// Byte-level framing.
//

const CR = 0x0d;
const LF = 0x0a;
const HYPHEN = 0x2d;

/** True when `needle` appears in `body` starting exactly at `start`. */
function matchesAt(body: Uint8Array, start: number, needle: Uint8Array): boolean {
  if (start + needle.length > body.length) return false;
  for (let index = 0; index < needle.length; index += 1) {
    if (body[start + index] !== needle[index]) return false;
  }
  return true;
}

/**
 * Classify the delimiter line beginning at `offset` (the first `--`): `part`
 * when `--boundary` is followed by CRLF, `close` when it is followed by `--`
 * then end of body or CRLF, and null otherwise (so boundary-like bytes are
 * payload). `--boundary--` followed by anything else is not a real close.
 */
function delimiterKind(
  body: Uint8Array,
  offset: number,
  boundary: Uint8Array,
): "part" | "close" | null {
  if (body[offset] !== HYPHEN || body[offset + 1] !== HYPHEN) return null;
  const afterBoundary = offset + 2 + boundary.length;
  if (!matchesAt(body, offset + 2, boundary)) return null;
  if (body[afterBoundary] === HYPHEN && body[afterBoundary + 1] === HYPHEN) {
    const end = afterBoundary + 2;
    if (end === body.length) return "close";
    if (body[end] === CR && body[end + 1] === LF) return "close";
    return null;
  }
  if (body[afterBoundary] === CR && body[afterBoundary + 1] === LF) return "part";
  return null;
}

/**
 * Find the next real delimiter at or after `from`, which must be the CRLF that
 * frames the payload before it (or, for the first part, the body start). Returns
 * the CRLF offset, the kind and the offset just past the delimiter line.
 */
function findDelimiter(
  body: Uint8Array,
  boundary: Uint8Array,
  from: number,
  atBodyStart: boolean,
): { crlfIndex: number; kind: "part" | "close"; after: number } | null {
  if (atBodyStart) {
    const kind = delimiterKind(body, 0, boundary);
    if (kind === null) return null;
    // The part delimiter ends with CRLF, so the headers start after it. A close
    // at the body start has no parts and its `after` is never used.
    const after = kind === "part" ? 2 + boundary.length + 2 : body.length;
    return { crlfIndex: 0, kind, after };
  }
  for (let index = from; index + 1 < body.length; index += 1) {
    if (body[index] !== CR || body[index + 1] !== LF) continue;
    const kind = delimiterKind(body, index + 2, boundary);
    if (kind === null) continue;
    // The next headers start just past the delimiter's own CRLF; a close has no
    // next part, so `after` is never used.
    const after = kind === "part" ? index + 2 + 2 + boundary.length + 2 : body.length;
    return { crlfIndex: index, kind, after };
  }
  return null;
}

/**
 * Find the CRLF that ends the header line starting at `from`, or -1 when there
 * is none before the end of the body. A bare LF is not a line ending here: it is
 * left inside the line, where the header check refuses it as a control.
 */
function findHeaderLineEnd(body: Uint8Array, from: number): number {
  for (let index = from; index + 1 < body.length; index += 1) {
    if (body[index] === CR && body[index + 1] === LF) return index;
  }
  return -1;
}

//
// Header-block parsing for one part.
//

interface ReadHeadersResult {
  /** Where the payload starts (just past the CRLF CRLF that ends the headers). */
  readonly payloadStart: number;
  readonly disposition: Disposition;
}

/** Read and validate a part's header block up to its terminating CRLF. */
function readHeaders(
  body: Uint8Array,
  start: number,
  decoder: TextDecoder,
): ReadHeadersResult | MultipartRefusal {
  let cursor = start;
  let disposition: Disposition | null = null;
  while (true) {
    const lineEnd = findHeaderLineEnd(body, cursor);
    if (lineEnd === -1) return invalidMultipart("the part headers are not terminated by CRLF CRLF");
    if (lineEnd === cursor) {
      // The blank line is the end of the header block.
      if (disposition === null) return invalidMultipart("the part has no Content-Disposition header");
      return { payloadStart: lineEnd + 2, disposition };
    }
    let line: string;
    try {
      line = decoder.decode(body.subarray(cursor, lineEnd));
    } catch {
      return invalidMultipart("a part header is not valid UTF-8");
    }
    const header = parseHeaderLine(line);
    if (header === null) return invalidMultipart("a part header line is malformed");
    if (header.name.toLowerCase() === "content-disposition") {
      if (disposition !== null) {
        return invalidMultipart("the part has more than one Content-Disposition header");
      }
      const parsed = parseDisposition(header.value);
      if (parsed === null) {
        return invalidMultipart(
          "the part's Content-Disposition is not a form-data control with one name",
        );
      }
      disposition = parsed;
    }
    cursor = lineEnd + 2;
  }
}

//
// Decoder.
//

/**
 * Decode one complete `multipart/form-data` byte body and its `Content-Type`
 * header in memory. Returns the text controls as own properties of `fields` and
 * the selected file separately, or a classified refusal that carries no partial
 * form or file.
 *
 * `body` must be a `Uint8Array` (a `Buffer` qualifies); `contentType` must be the
 * `Content-Type` header string, or `undefined`/`null` when the header is absent
 * (which is a wrong media type, refused with 415). Any other argument type is a
 * programming error and throws `ValidationError`.
 */
export function decodeMultipart(body: unknown, contentType: unknown): MultipartOutcome {
  if (!(body instanceof Uint8Array)) {
    throw new ValidationError("multipart body must be a Uint8Array");
  }
  if (contentType !== undefined && contentType !== null && typeof contentType !== "string") {
    throw new ValidationError("multipart content type must be a string");
  }
  const header = typeof contentType === "string" ? contentType : "";
  const media = parseContentType(header);
  if (media === null) return wrongMedia();

  // The whole body, framing included, is bounded inclusively before parsing.
  if (body.length > MAX_MULTIPART_BYTES) {
    return tooLarge("submission", body.length, MAX_MULTIPART_BYTES);
  }

  const boundary = new TextEncoder().encode(media.boundary);
  const headerDecoder = new TextDecoder("utf-8", { fatal: true });
  const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  const seen = new Set<string>();
  let file: MultipartFile | null = null;

  const opening = findDelimiter(body, boundary, 0, true);
  if (opening === null) return invalidMultipart("the body does not start with the boundary delimiter");
  if (opening.kind === "close") {
    // A closing delimiter at the body start: a complete submission with no parts.
    return Object.freeze({ ok: true, fields: Object.freeze(fields), file });
  }

  let cursor = opening.after;
  while (true) {
    const headers = readHeaders(body, cursor, headerDecoder);
    if (!("payloadStart" in headers)) return headers;
    const found = findDelimiter(body, boundary, headers.payloadStart, false);
    if (found === null) return invalidMultipart("the body has no closing boundary");
    const payload = body.subarray(headers.payloadStart, found.crlfIndex);
    const disposition = headers.disposition;

    if (seen.has(disposition.name)) return duplicateControl(disposition.name);
    seen.add(disposition.name);

    if (disposition.name === FILE_CONTROL) {
      // The file control requires its plain filename; `filename*` alone is not
      // a filename and is never decoded or used as a fallback.
      if (disposition.filename === undefined) {
        return invalidMultipart(
          `the ${JSON.stringify(FILE_CONTROL)} control requires a plain filename parameter`,
        );
      }
      if (payload.length > MAX_FILE_BYTES) {
        return tooLarge("file", payload.length, MAX_FILE_BYTES);
      }
      if (disposition.filename === "") {
        // An empty filename with no bytes means no file was selected.
        if (payload.length !== 0) {
          return invalidMultipart("the file control carries bytes but has no filename");
        }
        file = null;
      } else {
        // A named file, even one with zero bytes, is a selected file.
        file = Object.freeze({ filename: disposition.filename, bytes: new Uint8Array(payload) });
      }
    } else {
      // Only the file control may carry a file part.
      if (disposition.hasFileParameter) {
        return invalidMultipart(
          `only the ${JSON.stringify(FILE_CONTROL)} control accepts a file part`,
        );
      }
      if (disposition.name === PASTE_CONTROL && payload.length > MAX_PASTE_BYTES) {
        return tooLarge(PASTE_CONTROL, payload.length, MAX_PASTE_BYTES);
      }
      let text: string;
      try {
        text = textDecoder.decode(payload);
      } catch {
        return invalidUtf8(disposition.name);
      }
      fields[disposition.name] = text;
    }

    if (found.kind === "close") break;
    cursor = found.after;
  }

  return Object.freeze({ ok: true, fields: Object.freeze(fields), file });
}
