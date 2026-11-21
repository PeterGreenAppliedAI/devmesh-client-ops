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

/** A rendered page: the document and the response headers it must carry. */
export interface Page {
  readonly html: string;
  readonly headers: Readonly<Record<string, string>>;
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

/** Render a complete document around a body, escaped title included. */
export function renderPage(title: string, body: string): Page {
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
  return { html, headers: PAGE_HEADERS };
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
export function renderFormError(error: FormError, title = "Check the form"): Page {
  const body = renderForm({
    action: error.action,
    fields: error.fields,
    values: error.values,
    errors: error.fieldErrors,
    summary: error.message,
    submitLabel: "Try again",
  });
  return renderPage(title, body);
}

/** Definition of one form control. */
export interface FieldSpec {
  readonly name: string;
  readonly label: string;
  readonly type?: "text" | "textarea" | "select" | "date";
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
 * Render a form that posts to a fixed internal destination. The action is an
 * escaped route, the method is POST, and every control shows the submitted
 * value (or the initial value) escaped. Field errors appear next to their
 * control with `aria-invalid` set, so the user can correct them.
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
    parts.push(`<p role="alert">${escapeHtml(options.summary)}</p>`);
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
    const id = `field-${escapeHtml(field.name)}`;
    parts.push(`<div>`);
    parts.push(`<label for="${id}">${escapeHtml(field.label)}</label>`);
    const invalid = error === undefined ? "" : ' aria-invalid="true"';
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
      // A re-rendered form shows exactly what was submitted. When the value is
      // not one of the known choices it is kept as a visible marked option
      // rather than silently showing a different choice, so the user can see
      // the rejected value and correct it.
      const known = options.some((option) => option.value === value);
      if (value !== "" && !known) {
        choices.push(
          `<option value="${escapeHtml(value)}" selected>${escapeHtml(value)} (not a valid choice)</option>`,
        );
      }
      parts.push(
        `<select id="${id}" name="${escapeHtml(field.name)}"${required}${invalid}>${choices.join("")}</select>`,
      );
    } else {
      parts.push(
        `<input type="${field.type ?? "text"}" id="${id}" name="${escapeHtml(field.name)}" value="${escapeHtml(value)}"${required}${invalid}>`,
      );
    }
    if (error !== undefined) {
      parts.push(`<p role="alert">${escapeHtml(error.message)}</p>`);
    }
    parts.push(`</div>`);
  }
  parts.push(`<button type="submit">${escapeHtml(options.submitLabel ?? "Save")}</button>`);
  parts.push("</form>");
  return parts.join("\n");
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
