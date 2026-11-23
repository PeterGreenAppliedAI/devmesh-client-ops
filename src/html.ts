/**
 * Server-rendered HTML helpers shared by every page: escaping, page and form
 * rendering, correctable form errors and fixed internal redirects.
 *
 * Every value that comes from a user (stored records or submitted form data)
 * passes through `escapeHtml` before it reaches the document. Redirects never
 * accept a destination from a request: they take a route name from the fixed
 * route table built by the server.
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escape text for HTML text nodes and quoted attribute values. The five
 * characters that can change markup or leave a quoted attribute are replaced;
 * everything else is left as is, so the stored text reads back unchanged.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

import { renderLayoutDocument, type LayoutContext } from "./layout.ts";

/**
 * A rendered page: the document and the response headers it must carry.
 *
 * `title` and `body` are the structured parts `renderPage` built from. The
 * server response boundary reads them to wrap the page in the shared layout
 * when the page was rendered without explicit context; a page that already
 * carries `layout` is sent as it was rendered. Both are optional so a caller
 * that supplies its own raw `html` is never re-wrapped.
 */
export interface Page {
  readonly html: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly title?: string;
  readonly body?: string;
  readonly layout?: LayoutContext;
}

/**
 * Headers every rendered response carries: HTML with a fixed charset, and a
 * content security policy that forbids scripts, external assets and framing.
 * No caching anywhere: the pages are read-only views of the current store.
 */
export const PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
});

/**
 * Render a complete document around a body, escaped title included.
 *
 * With an explicit layout context the document is the shared application
 * shell (skip link, navigation, location header, one main landmark). Without
 * context the page is still a complete, usable document, so existing callers
 * and tests keep working; the server fills in the layout at the response
 * boundary from the accepted route and the authoritative snapshot and keeps
 * the page's own headers, which are always `PAGE_HEADERS`.
 */
export function renderPage(title: string, body: string, layout?: LayoutContext): Page {
  if (layout !== undefined) {
    return {
      html: renderLayoutDocument(layout, title, body),
      headers: PAGE_HEADERS,
      title,
      body,
      layout,
    };
  }
  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    "<style>body{font-family:system-ui,sans-serif;margin:2rem;line-height:1.5}nav{margin-bottom:1.5rem}nav a{margin-right:1rem}label{display:block;margin-top:.75rem}input,textarea{width:100%;max-width:32rem}button{margin-top:1rem}[role=alert]{color:#a40000}</style>",
    "</head>",
    "<body>",
    `<h1>${escapeHtml(title)}</h1>`,
    body,
    "</body>",
    "</html>",
  ].join("\n");
  return { html, headers: PAGE_HEADERS, title, body };
}

/** One correctable field problem: the field, its message and the submitted value. */
export interface FieldError {
  readonly field: string;
  readonly message: string;
  readonly value?: string;
}

/**
 * A form problem that the user can correct. It carries the submitted values so
 * the form can be shown again with them filled in. `message` is a summary for
 * the whole form; when it is absent the field messages stand alone.
 */
export class FormError extends Error {
  readonly values: Readonly<Record<string, string>>;
  readonly fieldErrors: readonly FieldError[];
  /** The controls the form was rendered with, so it can be shown again as it was. */
  readonly fields: readonly FieldSpec[];
  /** The fixed internal destination the form posted to. */
  readonly action: string;
  /**
   * An escaped notice shown above the corrected form, such as a record's
   * archive notice. A route sets it only when the record it corrects is
   * effectively archived, so a refused submission on an archived record's
   * edit or create page keeps its page marked and usable. Empty by default.
   */
  notice: string;

  constructor(
    message: string,
    values: Readonly<Record<string, string>>,
    fieldErrors: readonly FieldError[] = [],
    fields: readonly FieldSpec[] = [],
    action = "/",
  ) {
    super(message);
    this.name = "FormError";
    this.values = { ...values };
    this.fieldErrors = fieldErrors.map((error) => ({ ...error }));
    this.fields = [...fields];
    this.action = action;
    this.notice = "";
  }
  /**
   * Attach the escaped notice to show above the corrected form and return the
   * same error, so a route can add it in one expression. The validation message,
   * field messages and values are untouched.
   */
  withNotice(notice: string): this {
    this.notice = notice;
    return this;
  }
}

/**
 * Render a form problem again: the same controls, the submitted values and
 * the field messages, so every error can be corrected in place. The result is
 * a complete page. It is only rendered by the server, after a route reported a
 * `FormError`; every value in it is escaped.
 */
export function renderFormError(
  error: FormError,
  title = "Check the form",
  layout?: LayoutContext,
): Page {
  const body = renderForm({
    action: error.action,
    fields: error.fields,
    values: error.values,
    errors: error.fieldErrors,
    summary: error.message,
    submitLabel: "Try again",
  });
  // A notice a route attached to the refusal is shown above the form; it is
  // already escaped HTML, and it never replaces the form or its messages.
  return renderPage(title, error.notice === "" ? body : `${error.notice}\n${body}`, layout);
}

/**
 * Presentation metadata for a stored field: whether it is an identity or
 * parent link (shown from the record, never submitted for change) and, for a
 * status, state or enum value, whether it is shown as a text badge.
 *
 * The metadata is deliberately optional. A field without it is an ordinary
 * editable value; a field with `identity` is rendered as read-only text beside
 * the record and never as a control.
 */
export interface FieldPresentation {
  /** True for an id or a parent link: identity and parent fields. */
  readonly identity?: boolean;
  /** True for a value that is useful to show as a text badge. */
  readonly badge?: boolean;
}

/**
 * One typed value read from a stored record for display: its label, the
 * stored text and whether it is shown as a badge. Rendering escapes the text.
 */
export interface DisplayValue {
  readonly label: string;
  readonly value: string;
  readonly badge?: boolean;
}

/** Definition of one form control. */
export interface FieldSpec {
  readonly name: string;
  readonly label: string;
  readonly type?: "text" | "textarea" | "select" | "date";
  /** Presentation metadata; absent for an ordinary editable value. */
  readonly presentation?: FieldPresentation;
  /** Options for a select control. */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  /** Value shown when the form is first displayed. */
  readonly value?: string;
  readonly required?: boolean;
  /**
   * True for a fixed, server-chosen field that must still appear in the
   * submitted values (for example a record id an edit posts back) but is not
   * shown as a control. Its value travels in a hidden input, always escaped.
   */
  readonly hidden?: boolean;
}

/**
 * The problem summary of a form: one alert for the whole form. It names every
 * reported field problem, including one attached to a visible control, and the
 * identity or parent problems that have no control of their own. When the form
 * has no field problems it carries the form's own message.
 */
export function renderFormSummary(summary: string, errors: readonly FieldError[] = []): string {
  const parts: string[] = [summary];
  for (const error of errors) parts.push(error.message);
  return `<div role="alert"><p>${escapeHtml(summary)}</p>${
    errors.length === 0
      ? ""
      : `<ul>${errors.map((error) => `<li>${escapeHtml(error.message)}</li>`).join("")}</ul>`
  }</div>`;
}

/**
 * The visible control a refusal message names, when the message names one.
 *
 * A message names a field only by its actual identity: the qualified form the
 * store uses (`task.title`, `meeting.date`, `engagement.status`) or a bare
 * word that is exactly one of the visible controls' names (`projectId`). A
 * word inside a quoted submitted value, and an incidental word that merely
 * reads like a field name, is not a field reference. A parent link
 * (`engagementId`, `clientId`) and any other hidden control is never matched,
 * so an identity or parent problem stays in the summary alone.
 *
 * The message is read as the text outside every complete quoted value: a
 * quoted value may itself contain spaces, field-like words and even an escaped
 * quote (`\"`), and none of it is ever a field reference. So a parent value
 * that quotes a field name (such as `engagementId "title"`) never marks that
 * visible control. A name outside the quotes may still introduce a quoted
 * value (`projectId: "..."`) and is named as usual.
 *
 * A message that names one of the form's hidden controls (an identity or
 * parent link) in text that the user did not submit is about that link, so it
 * reports no visible control and stays in the summary alone: an unassignable
 * project message (`projectId "p" does not belong to engagementId "e"`)
 * names the hidden engagement link, not the project select. A hidden control is
 * named only by its qualified form (`task.id`): an identity link is never
 * named by a bare message word, because an incidental word such as `id` in
 * `No project with id "p"` is ordinary text, not a field reference. A parent
 * link may still be named bare, as its refusals do (`engagementId "e"`).
 */
export function namedVisibleField(
  message: string,
  fields: readonly FieldSpec[],
): string | undefined {
  const visible = new Set<string>();
  const hidden = new Set<string>();
  for (const field of fields) {
    if (field.hidden === true) hidden.add(field.name);
    else visible.add(field.name);
  }
  const unquotedWords = wordsOutsideQuotes(message);
  // The hidden controls named in the message's own text (never a quoted value).
  // A hidden control whose qualified name is named (`task.id`) is about that
  // control; the message then reports no visible control and stays in the
  // summary alone.
  const namesHidden = unquotedWords.some((word) => {
    const name = hiddenName(word);
    return name !== undefined && hidden.has(name);
  });
  for (const word of unquotedWords) {
    const name = fieldName(word);
    // A hidden control has no visible field of its own, and a message about
    // one stays in the summary alone rather than marking a visible control.
    if (name === "" || hidden.has(name) || namesHidden) continue;
    if (visible.has(name)) return name;
  }
  return undefined;
}

/** The field a message word names, if it names one: a qualified name
 * (`task.title`, `task.dueDate:`) names the part after its record prefix, and
 * a bare word must be a control's exact name. Padded indexes are ignored. */
function fieldName(word: string): string {
  const unquoted = word.replace(/[[][0-9]+[]]/g, "").replace(/[:;,]$/, "");
  if (unquoted === "") return "";
  return unquoted.includes(".") ? unquoted.slice(unquoted.lastIndexOf(".") + 1) : unquoted;
}

/** The hidden control a message word names, if it names one: a qualified name
 * (`task.id`) names it, and so does a bare parent link (`engagementId`), as the
 * parent refusals name it. A bare `id` is not a reference: it is an incidental
 * word of ordinary text (`No project with id "p"`). */
function hiddenName(word: string): string | undefined {
  const cleaned = word.replace(/[[][0-9]+[]]/g, "").replace(/[:;,]$/, "");
  if (cleaned === "") return undefined;
  if (cleaned.includes(".")) return fieldName(cleaned);
  return cleaned === "id" ? undefined : cleaned;
}

/**
 * The text words of a message that lie outside every complete quoted value.
 * A quoted value opens at a quote character that begins a word (`"`, `'` or a
 * backtick) and runs until the next same quote that closes it; an escaped
 * quote (`\"`, `\'`) is part of the value it does not close. An unclosed quote
 * runs to the end of the message, so the rest of the message stays treated as
 * value text rather than as field references. A quote inside a word (such as
 * an apostrophe) is not a value opener.
 */
function wordsOutsideQuotes(message: string): readonly string[] {
  const words: string[] = [];
  let word = "";
  let quote: string | null = null;
  for (let index = 0; index < message.length; index += 1) {
    const char = message[index];
    if (quote !== null) {
      if (char === "\\" && message[index + 1] === quote) {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      // A quote inside a word (such as an apostrophe) is not a value opener.
      if (word === "") quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (word !== "") words.push(word);
      word = "";
      continue;
    }
    word += char;
  }
  if (word !== "") words.push(word);
  return words;
}

/**
 * The field problems a refusal message reports: the visible control it names,
 * with the submitted value the form holds. A message that names no visible
 * control (a hidden identity or parent link, or a record the form cannot
 * name) reports nothing and stays in the summary alone.
 *
 * `selected` names the control a form boundary already knows the refusal is
 * about, by its field identity (the project select), together with the value
 * the submission gave it. It is used only when the message names no visible
 * control of its own and its own text (outside every quoted value) quotes
 * exactly that submitted value as a complete reference (`No project with id
 * "project-99"`). The value is compared as the text the message carries, so
 * the store's JSON-encoded form (`\"`, `\\`, `\n`, `\t`) matches a value
 * that contains a quote, a backslash or a newline. Then the problem is
 * associated with that control, whatever other control happens to hold the
 * same text, so an unknown value the user selected points at the choice that
 * has to be corrected. It never overrides a message that names a visible
 * control, and a message about a hidden identity or parent link (a submitted
 * parent mismatch, an unassignable parent chain) names a different value or a
 * hidden link, so it stays in the summary alone.
 */
export function fieldErrorsFor(
  message: string,
  values: Readonly<Record<string, string>>,
  fields: readonly FieldSpec[],
  selected?: { readonly field: string; readonly value: string },
): readonly FieldError[] {
  const named = namedVisibleField(message, fields);
  if (named !== undefined) return [fieldErrorFor(named, message, values, fields)];
  if (selected === undefined || selected.value === "") return [];
  // A selected control that is not a visible control of this form (a hidden
  // link, or a name the form does not carry) has no control to associate.
  const field = fields.find((candidate) => candidate.name === selected.field && candidate.hidden !== true);
  if (field === undefined) return [];
  if (!quotesSubmittedValue(message, selected.value)) return [];
  return [fieldErrorFor(field.name, message, values, fields)];
}

/** One field problem for a visible control, with the value the form holds. */
function fieldErrorFor(
  name: string,
  message: string,
  values: Readonly<Record<string, string>>,
  fields: readonly FieldSpec[],
): FieldError {
  const field = fields.find((candidate) => candidate.name === name && candidate.hidden !== true);
  const value = values[name] ?? field?.value;
  return value === undefined ? { field: name, message } : { field: name, message, value };
}

/**
 * True when a refusal message quotes the submitted value of the selected
 * control as the value it cannot find or match, outside any field reference:
 * the message's own text quotes exactly that value as one complete quoted
 * value (`No project with id "project-99"`) and names no hidden parent link.
 * The quoted text is decoded the way the message wrote it (the store writes
 * it with `JSON.stringify`), so an invalid value holding a double quote, a
 * backslash, a newline or a tab still matches its own serialized message.
 * Then the value the user selected is the problem, so the presentation
 * boundary associates the message with that control. A message about a hidden
 * parent link (a parent chain that needs a submitted parent) names that link
 * and stays in the summary alone.
 */
function quotesSubmittedValue(message: string, value: string): boolean {
  if (quotedReference(message, value) === undefined) return false;
  const parents = new Set(["clientId", "engagementId"]);
  const linked = wordsOutsideQuotes(message).some((word) => {
    const name = hiddenName(word);
    return name !== undefined && parents.has(name);
  });
  return !linked;
}

/** The quoted reference in a message that carries `value`; undefined when no
 * quoted reference carries it. A quoted reference is a complete quoted value
 * that is delimited as a value in the message: it opens at a quote character
 * that begins a word and closes at the matching quote (escaped quotes belong
 * to the value) before a word boundary, so the value appears as a whole
 * (`"project-99"`, `"project-99" is not a project`) and never as a fragment
 * of a longer value (`"project-99x"`). A reference is not required to be the
 * whole quoted value, so a message that qualifies a value (`"project-99" (not
 * a project)`) still carries it. */
function quotedReference(message: string, value: string): string | undefined {
  if (value === "") return undefined;
  const opens = /("|'|`)/g;
  for (let match = opens.exec(message); match !== null; match = opens.exec(message)) {
    // A quote inside a word (such as an apostrophe) opens no value.
    if (match.index > 0 && !/\s/.test(message[match.index - 1])) continue;
    const quote = match[1];
    let raw = "";
    let closed = false;
    let end = message.length;
    for (let index = match.index + match[0].length; index < message.length; index += 1) {
      const char = message[index];
      if (char === "\\" && quote === "\"" && message[index + 1] === "\\") {
        // A JSON double-quoted value escapes a backslash as `\\`, so a value
        // ending in a backslash carries an escaped pair just before the
        // closing quote; the pair belongs to the value, not to its end.
        raw += char + (message[index + 1] ?? "");
        index += 1;
        continue;
      }
      if (char === "\\" && message[index + 1] === quote) {
        raw += char + quote;
        index += 1;
        continue;
      }
      if (char === quote) {
        closed = true;
        end = index;
        break;
      }
      raw += char;
    }
    if (!closed || (end + 1 !== message.length && !/\s/.test(message[end + 1]))) continue;
    if (decodedQuotedText(raw, quote) === value) return raw;
  }
  return undefined;
}

/**
 * The value a quoted reference carries, decoded the way the message's writer
 * encoded it. A message that carries JSON (the store's `JSON.stringify`)
 * quotes its values with a double quote and escapes `\"`, `\\`, `\/`,
 * `\b`, `\f`, `\n`, `\r`, `\t` and `\uXXXX`; other escapes are left as
 * written. A single-quoted or backtick-quoted reference carries its text as
 * written, escaped quotes included.
 */
function decodedQuotedText(raw: string, quote: string): string {
  if (quote !== "\"") return raw;
  let decoded = "";
  let index = 0;
  while (index < raw.length) {
    const char = raw[index];
    if (char !== "\\") {
      decoded += char;
      index += 1;
      continue;
    }
    const next = raw[index + 1];
    const simple = JSON_ESCAPES[next];
    if (simple !== undefined) {
      decoded += simple;
      index += 2;
      continue;
    }
    if (next === "u" && /^[0-9a-fA-F]{4}$/.test(raw.slice(index + 2, index + 6))) {
      decoded += String.fromCharCode(Number.parseInt(raw.slice(index + 2, index + 6), 16));
      index += 6;
      continue;
    }
    decoded += char + (next ?? "");
    index += next === undefined ? 1 : 2;
  }
  return decoded;
}

/** The JSON escapes a double-quoted reference may carry, decoded. */
const JSON_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
});

/**
 * Render a form that posts to a fixed internal destination. The action is an
 * escaped route, the method is POST, and every control shows the submitted
 * value (or the initial value) escaped. One alert summarises the form's
 * problems. A reported problem for a visible field also marks that control
 * `aria-invalid="true"` and points it at its own message with
 * `aria-describedby`, so the control and its correction are associated. The
 * error for a name that has no visible control (an identity or parent link
 * that is shown from the record, never submitted) stays in the summary alone.
 */
export function renderForm(options: {
  readonly action: string;
  readonly fields: readonly FieldSpec[];
  readonly values?: Readonly<Record<string, string>>;
  readonly errors?: readonly FieldError[];
  readonly summary?: string;
  readonly submitLabel?: string;
}): string {
  const values = options.values ?? {};
  const errors = options.errors ?? [];
  const parts: string[] = [];
  if (options.summary !== undefined) {
    parts.push(renderFormSummary(options.summary, errors));
  }
  parts.push(`<form method="post" action="${escapeHtml(options.action)}">`);
  for (const field of options.fields) {
    const value = values[field.name] ?? field.value ?? "";
    if (field.hidden) {
      // A hidden control carries the server-chosen value; the submitted value
      // is shown if the form was re-rendered after an error, otherwise the
      // fixed value the server put on the form.
      const hiddenValue = values[field.name] ?? field.value ?? "";
      parts.push(
        `<input type="hidden" name="${escapeHtml(field.name)}" value="${escapeHtml(hiddenValue)}">`,
      );
      continue;
    }
    const error = errors.find((candidate) => candidate.field === field.name);
    // A reported problem names the exact control, so a message that happens
    // to quote another submitted value (or a word that reads like a field
    // name) never marks that other control invalid.
    const id = `field-${escapeHtml(field.name)}`;
    const errorId = `${id}-error`;
    parts.push(`<div>`);
    parts.push(`<label for="${id}">${escapeHtml(field.label)}</label>`);
    const invalid =
      error === undefined ? "" : ` aria-invalid="true" aria-describedby="${errorId}"`;
    const required = field.required ? " required" : "";
    if (field.type === "textarea") {
      parts.push(
        `<textarea id="${id}" name="${escapeHtml(field.name)}"${required}${invalid}>${escapeHtml(value)}</textarea>`,
      );
    } else if (field.type === "select") {
      const options = field.options ?? [];
      const choices = options.map((option) => {
        const selected = option.value === value ? " selected" : "";
        return `<option value="${escapeHtml(option.value)}"${selected}>${escapeHtml(option.label)}</option>`;
      });
      // A re-rendered form shows exactly what was submitted. A value that is
      // not one of the known choices (an explicitly empty one included) is kept
      // as a visible, selected, marked option rather than silently showing a
      // different choice, so the user can see the rejected value and correct it.
      if (!options.some((option) => option.value === value)) {
        choices.push(
          `<option value="${escapeHtml(value)}" selected>${escapeHtml(value === "" ? "(not a valid choice)" : value + " (not a valid choice)")}</option>`,
        );
      }
      parts.push(
        `<select id="${id}" name="${escapeHtml(field.name)}"${required}${invalid}>${choices.join("")}</select>`,
      );
    } else {
      parts.push(
        `<input type="${inputType(field, value)}" id="${id}" name="${escapeHtml(field.name)}" value="${escapeHtml(value)}"${required}${invalid}>`,
      );
    }
    if (error !== undefined) {
      parts.push(`<p id="${errorId}">${escapeHtml(error.message)}</p>`);
    }
    parts.push(`</div>`);
  }
  parts.push(`<button type="submit">${escapeHtml(options.submitLabel ?? "Save")}</button>`);
  parts.push("</form>");
  return parts.join("\n");
}

/**
 * The input type a control is rendered with. A rejected date is shown as plain
 * text, so a browser never sanitises it to empty: the exact submitted text stays
 * visible and a resubmission carries it back for correction. An empty value
 * keeps the date control, and so does a real calendar date, which a browser
 * keeps exactly as written.
 */
function inputType(field: FieldSpec, value: string): string {
  if (field.type !== "date") return field.type ?? "text";
  // A date control is used only for an empty value or a date that a browser
  // keeps exactly as written: a well-formed `YYYY-MM-DD` day that is also a
  // real calendar date. Any other submitted text uses a text control, so a
  // rejected value such as `2026-02-30`, `2026-13-01` or `not a date` stays
  // visible in its exact form and resubmits unchanged.
  return value === "" || isCalendarDate(value) ? "date" : "text";
}

/** True for a well-formed `YYYY-MM-DD` value naming a real calendar day. */
function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Year zero is not a valid year for an HTML date control, which sanitises
  // `0000-MM-DD` to empty; such a value is shown as text so it is kept.
  if (year < 1) return false;
  if (month < 1 || month > 12) return false;
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const limit = month === 2 && leap ? 29 : daysInMonth;
  return day >= 1 && day <= limit;
}

/** A fixed internal redirect: a status and a destination chosen by the server. */
export interface Redirect {
  readonly location: string;
  readonly headers: Readonly<Record<string, string>>;
}

const REDIRECT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "no-store",
});

/**
 * The fixed route families a redirect may target: the server's own route
 * paths, never a destination taken from a request. The hierarchy detail routes
 * carry a record id in their path, which is always a server-chosen id of a
 * record that exists in the store, escaped through `redirect`, and matched
 * against these exact segment shapes.
 */
const INTERNAL_REDIRECT_PATHS: readonly string[] = Object.freeze(["/", "/health", "/kanban"]);
const INTERNAL_REDIRECT_PATTERNS: readonly RegExp[] = Object.freeze([
  /^\/clients\/[A-Za-z0-9_-]+$/,
  /^\/engagements\/[A-Za-z0-9_-]+$/,
  /^\/projects\/[A-Za-z0-9_-]+$/,
  /^\/tasks\/[A-Za-z0-9_-]+$/,
  /^\/items\/[A-Za-z0-9_-]+$/,
  /^\/meetings\/[A-Za-z0-9_-]+$/,
  // The board scopes: the whole board (fixed, above) and one record's board.
  // A board movement redirects only to these server-built validated scopes.
  /^\/clients\/[A-Za-z0-9_-]+\/kanban$/,
  /^\/engagements\/[A-Za-z0-9_-]+\/kanban$/,
  /^\/projects\/[A-Za-z0-9_-]+\/kanban$/,
]);

function isInternalPath(pathname: string): boolean {
  return (
    INTERNAL_REDIRECT_PATHS.includes(pathname) ||
    INTERNAL_REDIRECT_PATTERNS.some((pattern) => pattern.test(pathname))
  );
}

/**
 * Build a redirect to a server-chosen destination. The destination must be an
 * internal absolute path that names one of this server's own fixed routes;
 * anything else is refused, so a redirect can never send a browser off the
 * canonical origin or to an unregistered destination.
 *
 * The destination is validated against the form browsers actually navigate to:
 * whitespace and control characters are rejected outright, a backslash is
 * normalised by browsers into a slash, a leading `//` names an authority, and a
 * URL parser confirms the resolved target stays on the fixed base with no
 * authority, credentials or host. The path (including any query string) must
 * then be one of the routes in `INTERNAL_REDIRECT_PATHS`.
 */
export function redirect(location: string): Redirect {
  // Whitespace and control characters are rejected outright: a browser strips
  // some of them and then reads the rest as a different destination.
  if (/[\s\u0000-\u001f\u007f]/.test(location)) {
    throw new Error("Redirect destinations must be internal routes");
  }
  // Backslashes are treated as separators by browsers, so `/\evil` and
  // `/\\evil` both become `//evil`. Refuse them as well as a leading `//`.
  if (!location.startsWith("/") || location.startsWith("//") || location.includes("\\")) {
    throw new Error("Redirect destinations must be internal routes");
  }
  // Resolve against a fixed base and require that it stays on that base.
  const base = "http://internal.invalid";
  const target = new URL(location, base);
  if (
    target.origin !== base ||
    target.username !== "" ||
    target.password !== "" ||
    target.host !== "internal.invalid"
  ) {
    throw new Error("Redirect destinations must be internal routes");
  }
  // Only the server's own fixed route paths are valid destinations.
  if (!isInternalPath(target.pathname)) {
    throw new Error("Redirect destinations must be internal routes");
  }
  return {
    location,
    headers: { ...REDIRECT_HEADERS, Location: location },
  };
}
