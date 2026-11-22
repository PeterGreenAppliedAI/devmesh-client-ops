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
  return renderPage(title, body, layout);
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
 * The input type a control is rendered with. A date control shows a value that
 * is not a well-formed `YYYY-MM-DD` date as plain text, so a browser that
 * sanitises an invalid date input to empty still shows exactly what was
 * submitted and a resubmission carries it back for correction. An empty or well
 * formed value keeps the date control; a well formed but impossible date such
 * as `2026-02-30` is still shown in a date control, where a browser displays it
 * unchanged.
 */
function inputType(field: FieldSpec, value: string): string {
  if (field.type !== "date") return field.type ?? "text";
  return value === "" || /^\d{4}-\d{2}-\d{2}$/.test(value) ? "date" : "text";
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
const INTERNAL_REDIRECT_PATHS: readonly string[] = Object.freeze(["/", "/health"]);
const INTERNAL_REDIRECT_PATTERNS: readonly RegExp[] = Object.freeze([
  /^\/clients\/[A-Za-z0-9_-]+$/,
  /^\/engagements\/[A-Za-z0-9_-]+$/,
  /^\/projects\/[A-Za-z0-9_-]+$/,
  /^\/tasks\/[A-Za-z0-9_-]+$/,
  /^\/items\/[A-Za-z0-9_-]+$/,
  /^\/meetings\/[A-Za-z0-9_-]+$/,
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
