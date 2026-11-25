/**
 * Transcript import pages: the native GET forms and the marked multipart POSTs
 * that bring a transcript into an engagement, a project or a manual meeting.
 *
 * Three URL scopes are offered, each with its own fixed, server-built path:
 *
 * - `/engagements/:id/transcripts/import` creates a meeting in the engagement,
 *   optionally attached to one of the engagement's own projects.
 * - `/projects/:id/transcripts/import` creates a meeting in the URL project's
 *   engagement, with the URL project preselected.
 * - `/meetings/:id/transcripts/import` attaches a transcript to an existing
 *   manual meeting; its only input is the transcript source.
 *
 * The URL record is authoritative. The POST hands the matched kind and raw id
 * to `submitTranscript` first, so the record is resolved inside the store's own
 * queue turn (a missing record is a `MissingRecordError`, a 404 for the shell).
 * The GET forms resolve the record from the snapshot for presentation. Every
 * other decision (the submitted title, date, notes, project and source) is
 * validated by the transcript service inside that same store turn.
 *
 * The import form is a native `multipart/form-data` form (the shell accepts that
 * body only on the three opted-in POST slots). Pasted text and a file are two
 * alternatives: exactly one must be submitted. The form states its limits, the
 * 15 MiB total and the 10 MiB per input, and names the supported formats.
 *
 * Every displayed value is escaped; every link and form action is built from a
 * stored record id through `encodeURIComponent`.
 */
import { isEffectivelyArchived } from "./archive.ts";
import { archiveNotice } from "./archive-pages.ts";
import {
  escapeHtml,
  fieldErrorsFor,
  FormError,
  renderForm,
  renderPage,
  type FieldError,
  type FieldSpec,
  type Page,
} from "./html.ts";
import { engagementImportHref, meetingImportHref, projectImportHref } from "./meeting-pages.ts";
import { MissingRecordError, ValidationError } from "./model.ts";
import type { Client, Engagement, Meeting, Project, Snapshot, Store } from "./store.ts";
import { transcriptService as buildTranscriptService, type TranscriptImportResult, type TranscriptStore } from "./transcript-store.ts";
import { submitTranscript } from "./transcript-import.ts";
import {
  FILE_CONTROL,
  MAX_FILE_BYTES,
  MAX_MULTIPART_BYTES,
  MAX_PASTE_BYTES,
  PASTE_CONTROL,
  type MultipartFile,
} from "./transcript-multipart.ts";
import { link, pageWith, showValue } from "./work-pages.ts";

/** What a transcript import route may read from an accepted request. */
export interface TranscriptImportRequest {
  readonly method: "GET" | "POST";
  /** The request path including any query string. */
  readonly path: string;
  /** The decoded text controls of an accepted multipart POST; empty for a GET. */
  readonly form: Readonly<Record<string, string>>;
  /** The separately submitted file of an accepted multipart POST, or null. */
  readonly file: MultipartFile | null;
}

/** A guarded transcript import route; `render` runs only after the checks pass. */
export interface TranscriptImportRoute {
  readonly method: "GET" | "POST";
  /**
   * The opt-in multipart POST policy. Only the three transcript import POST
   * slots declare it; every other route keeps the url-encoded form behaviour.
   */
  readonly bodyPolicy?: "Multipart";
  render(request: TranscriptImportRequest): Promise<Page> | Page;
}

/** The route shapes registered under one fixed transcript import path. */
export interface TranscriptImportPathRoute {
  readonly get?: TranscriptImportRoute;
  readonly post?: TranscriptImportRoute;
}

/** The transcript import route table: the three scoped GET forms and POSTs. */
export interface TranscriptImportRoutes {
  readonly engagementImport: TranscriptImportPathRoute;
  readonly projectImport: TranscriptImportPathRoute;
  readonly meetingImport: TranscriptImportPathRoute;
}

/** The fixed paths the transcript import table registers, used for matching. */
export type TranscriptImportPath =
  | "/engagements/:id/transcripts/import"
  | "/projects/:id/transcripts/import"
  | "/meetings/:id/transcripts/import";

/** The record kind a transcript import path names. */
export type TranscriptImportKind = "engagement" | "project" | "meeting";

/**
 * Match a request path against the three fixed transcript import patterns and
 * return the matched pattern, the record kind and the raw (still encoded) id in
 * its path, or null for any other path so an unregistered path is refused
 * before any handler runs. The id is not decoded here: a malformed escape names
 * no record.
 */
export function matchTranscriptImportPath(
  path: string,
): { readonly pattern: TranscriptImportPath; readonly kind: TranscriptImportKind; readonly id: string } | null {
  const pathname = path.split("?")[0];
  const parts = pathname.split("/").slice(1);
  if (parts.some((part) => part === "")) return null;
  if (parts.length !== 4 || parts[2] !== "transcripts" || parts[3] !== "import") return null;
  const family = parts[0];
  if (family !== "engagements" && family !== "projects" && family !== "meetings") return null;
  const kind: TranscriptImportKind = family === "engagements" ? "engagement" : family === "projects" ? "project" : "meeting";
  return { pattern: `/${family}/:id/transcripts/import` as TranscriptImportPath, kind, id: parts[1] };
}

/** Pick the registered route for a matched pattern from the table. */
export function routeForTranscriptImportPattern(
  routes: TranscriptImportRoutes,
  pattern: TranscriptImportPath,
  method: "GET" | "POST",
): TranscriptImportRoute | undefined {
  const slot = slotFor(routes, pattern);
  return method === "POST" ? slot.post : slot.get;
}

function slotFor(routes: TranscriptImportRoutes, pattern: TranscriptImportPath): TranscriptImportPathRoute {
  switch (pattern) {
    case "/engagements/:id/transcripts/import":
      return routes.engagementImport;
    case "/projects/:id/transcripts/import":
      return routes.projectImport;
    case "/meetings/:id/transcripts/import":
      return routes.meetingImport;
  }
}

// ---------------------------------------------------------------------------
// Links from the histories and the meeting page
// ---------------------------------------------------------------------------

// The import paths are built once, in `meeting-pages.ts`, so every page that
// links an import shares one spelling of the fixed routes.
export { engagementImportHref, meetingImportHref, projectImportHref } from "./meeting-pages.ts";

// ---------------------------------------------------------------------------
// The shared import form
// ---------------------------------------------------------------------------

/** The inclusive limit in MiB (a decimal count of bytes, as a form states it). */
const MIB = 1024 * 1024;

/** The encoding every import form states: the marked multipart body. */
const MULTIPART_FORM_ENCTYPE = "multipart/form-data";

/** The formats the import accepts, named for the user. */
const SUPPORTED_FORMATS = "pasted plain text; UTF-8 .txt and .md files; .docx documents; text-based .pdf files";

/** The size limits the form states: the whole body, and each input. */
export function importLimitsText(): string {
  return (
    `Keep the whole submission at most ${MAX_MULTIPART_BYTES / MIB} MiB, ` +
    `with the pasted text at most ${MAX_PASTE_BYTES / MIB} MiB ` +
    `and the file at most ${MAX_FILE_BYTES / MIB} MiB. ` +
    `The extracted text must also be at most ${MAX_PASTE_BYTES / MIB} MiB.`
  );
}

/** The sentence naming the formats an import accepts. */
export function supportedFormatsText(): string {
  return `Supported formats: ${SUPPORTED_FORMATS}.`;
}

/**
 * The guidance shown above the import form: the formats it accepts and the
 * limits that apply, escaped on render.
 */
function importGuidance(): string {
  return `<p>${escapeHtml(supportedFormatsText())}</p>\n<p>${escapeHtml(importLimitsText())}</p>`;
}

/**
 * The transcript source controls. Pasted text and a file are alternatives:
 * exactly one must be submitted, and the labels say so. Both carry the
 * multipart decoder's control names, so the decoded submission is passed on
 * unchanged.
 */
const SOURCE_FIELDS: readonly FieldSpec[] = [
  {
    name: PASTE_CONTROL,
    label: "Paste transcript text (an alternative to the file below)",
    type: "textarea",
  },
  { name: FILE_CONTROL, label: "Or choose a transcript file (an alternative to the text above)", type: "file" },
];

const CREATE_FIELDS: readonly FieldSpec[] = [
  { name: "title", label: "Title", required: true },
  { name: "date", label: "Date", type: "date", required: true },
  { name: "notes", label: "Notes", type: "textarea" },
];

/** The controls of the create forms: the metadata, the project select and the source. */
function createFields(projects: readonly Project[], snapshot: Snapshot): readonly FieldSpec[] {
  return [
    ...CREATE_FIELDS,
    { name: "projectId", label: "Project (inside this engagement)", type: "select", options: projectOptions(projects, snapshot) },
    ...SOURCE_FIELDS,
  ];
}

/**
 * The optional no-project choice, offered first so it is the default, and every
 * project of the engagement. An effectively archived project stays offered but
 * is labelled as archived, so a record is never silently linked there; the
 * label is text, escaped on render.
 */
function projectOptions(
  projects: readonly Project[],
  snapshot: Snapshot,
): readonly { readonly value: string; readonly label: string }[] {
  return [
    { value: "", label: "(no project)" },
    ...projects.map((project) => ({
      value: project.id,
      label: isEffectivelyArchived(snapshot, project) ? `${project.name} (archived)` : project.name,
    })),
  ];
}

/** The projects of one engagement, ordered by name then id for a select. */
function projectChoices(snapshot: Snapshot, engagementId: string): readonly Project[] {
  return snapshot.projects
    .filter((project) => project.engagementId === engagementId)
    .sort((a, b) => (a.name === b.name ? a.id.localeCompare(b.id) : a.name.localeCompare(b.name)));
}

/** Initial values for a create form: nothing entered, no project. */
function createValues(urlProject?: Project): Record<string, string> {
  return {
    title: "",
    date: "",
    notes: "",
    projectId: urlProject === undefined ? "" : urlProject.id,
    [PASTE_CONTROL]: "",
    [FILE_CONTROL]: "",
  };
}

/**
 * The controls a browser submits for a form: a text control carries its text,
 * a file control carries the selected file's name (or the empty name a browser
 * sends when nothing was chosen). These are the values a corrected form shows.
 */
function submittedControls(form: Readonly<Record<string, string>>, file: MultipartFile | null): Record<string, string> {
  const controls: Record<string, string> = {};
  for (const name of ["title", "date", "notes", "projectId", PASTE_CONTROL]) {
    if (Object.hasOwn(form, name)) controls[name] = form[name];
  }
  controls[FILE_CONTROL] = file === null ? "" : file.filename;
  return controls;
}

/**
 * The page body of an import form: the guidance, then the native multipart
 * form. A form with a file control is submitted by the browser as
 * `multipart/form-data` without a script, which is the marked body the shell
 * accepts on these routes; the encoding is stated on both the initial and the
 * corrected form.
 */
function formPageBody(
  action: string,
  fields: readonly FieldSpec[],
  values: Readonly<Record<string, string>>,
  submitLabel: string,
  notice: string,
  errors: readonly FieldError[] = [],
  summary?: string,
  extraAbove = "",
  extraBelow = "",
): string {
  return [
    notice,
    extraAbove,
    importGuidance(),
    renderForm({
      action,
      fields,
      values,
      errors,
      ...(summary === undefined ? {} : { summary }),
      submitLabel,
      enctype: MULTIPART_FORM_ENCTYPE,
    }),
    extraBelow,
  ]
    .filter((part) => part !== "" && part !== undefined)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Records and notices
// ---------------------------------------------------------------------------

/** Decode a raw path id; a malformed escape names no record. */
function decodeId(rawId: string, kind: string): string {
  try {
    return decodeURIComponent(rawId);
  } catch {
    throw new MissingRecordError(`No ${kind} for that path`);
  }
}

function findRecord<T extends { readonly id: string }>(items: readonly T[], id: string, kind: string): T {
  const found = items.find((item) => item.id === id);
  if (found === undefined) throw new MissingRecordError(`No ${kind} with id ${JSON.stringify(id)}`);
  return found;
}

/** The raw id in a transcript import path: the second segment. */
function rawIdFromPath(path: string): string {
  const parts = path.split("?")[0].split("/").slice(1);
  if (parts.length < 2) throw new MissingRecordError("No record for that path");
  return parts[1];
}

/** The client, engagement and optional project or meeting an import path names. */
interface ImportScope {
  readonly kind: TranscriptImportKind;
  readonly client: Client;
  readonly engagement: Engagement;
  readonly project?: Project;
  readonly meeting?: Meeting;
}

function engagementScope(snapshot: Snapshot, id: string): ImportScope {
  const engagement = findRecord(snapshot.engagements, id, "engagement");
  const client = findRecord(snapshot.clients, engagement.clientId, "client");
  return { kind: "engagement", client, engagement };
}

function projectScope(snapshot: Snapshot, id: string): ImportScope {
  const project = findRecord(snapshot.projects, id, "project");
  const engagement = findRecord(snapshot.engagements, project.engagementId, "engagement");
  const client = findRecord(snapshot.clients, engagement.clientId, "client");
  return { kind: "project", client, engagement, project };
}

function meetingScope(snapshot: Snapshot, id: string): ImportScope {
  const meeting = findRecord(snapshot.meetings, id, "meeting");
  const engagement = findRecord(snapshot.engagements, meeting.engagementId, "engagement");
  const client = findRecord(snapshot.clients, engagement.clientId, "client");
  return { kind: "meeting", client, engagement, meeting };
}

/** The scope the raw path id and its matched kind name, resolved from the snapshot. */
function scopeFromPath(snapshot: Snapshot, kind: TranscriptImportKind, rawId: string): ImportScope {
  const id = decodeId(rawId, kind);
  if (kind === "engagement") return engagementScope(snapshot, id);
  if (kind === "project") return projectScope(snapshot, id);
  return meetingScope(snapshot, id);
}

/**
 * The archive notice shown on an import page, so an archived engagement,
 * project or meeting keeps a usable import page with its notice. The URL scope
 * is always noticed; on a create form a selected project of the engagement adds
 * that project's notice. The URL scope's notice never depends on the submitted
 * selection: on an archived project's URL, selecting an active sibling still
 * shows the archived URL project's notice, and an invalid selection (a foreign
 * or unknown project) notices the URL scope too.
 */
function scopeNotice(snapshot: Snapshot, scope: ImportScope, fields: readonly FieldSpec[]): string {
  const direct = scope.project !== undefined ? scope.project : scope.meeting !== undefined ? scope.meeting : scope.engagement;
  const notices = [archiveNotice(snapshot, direct)];
  if (scope.kind !== "meeting") {
    const selected = fields.find((field) => field.name === "projectId")?.value ?? "";
    const project = snapshot.projects.find((candidate) => candidate.id === selected);
    if (project !== undefined && project.engagementId === scope.engagement.id && project.id !== direct.id) {
      notices.push(archiveNotice(snapshot, project));
    }
  }
  return notices.filter((notice) => notice !== "").join("\n");
}

/** The breadcrumb links for a transcript import page. */
function breadcrumbs(scope: ImportScope): readonly { readonly label: string; readonly href: string }[] {
  const links = [
    { label: "Home", href: "/" },
    { label: "Clients", href: "/clients" },
    { label: scope.client.name, href: `/clients/${encodeURIComponent(scope.client.id)}` },
    { label: scope.engagement.name, href: `/engagements/${encodeURIComponent(scope.engagement.id)}` },
  ];
  if (scope.project !== undefined) {
    links.push({ label: scope.project.name, href: `/projects/${encodeURIComponent(scope.project.id)}` });
  }
  if (scope.meeting !== undefined) {
    links.push({ label: scope.meeting.title, href: `/meetings/${encodeURIComponent(scope.meeting.id)}` });
  }
  return links;
}

/** The action of a scope's import form: the URL it was opened under. */
function importAction(scope: ImportScope): string {
  if (scope.kind === "engagement") return engagementImportHref(scope.engagement.id);
  if (scope.kind === "project") return projectImportHref(scope.project!.id);
  return meetingImportHref(scope.meeting!.id);
}

/** Where a scope returns to when the import form is cancelled. */
function cancelHref(scope: ImportScope): string {
  if (scope.kind === "meeting") return `/meetings/${encodeURIComponent(scope.meeting!.id)}`;
  if (scope.project !== undefined) return `/projects/${encodeURIComponent(scope.project.id)}`;
  return `/engagements/${encodeURIComponent(scope.engagement.id)}`;
}

/**
 * The controls of the create forms for a scope. A project-scoped form preselects
 * the URL project; an engagement-scoped form starts with a blank select. The
 * attachment form takes only the source: the meeting's own metadata is kept.
 */
function fieldsForScope(scope: ImportScope, snapshot: Snapshot): readonly FieldSpec[] {
  if (scope.kind === "meeting") return SOURCE_FIELDS;
  return createFields(projectChoices(snapshot, scope.engagement.id), snapshot);
}

/**
 * The project select of a form as it is shown: the same choices, with the
 * value a (possibly refused) submission holds marked as selected. The initial
 * values put the URL project or a blank choice in `values.projectId`.
 */
function fieldsWithValues(
  fields: readonly FieldSpec[],
  values: Readonly<Record<string, string>>,
): readonly FieldSpec[] {
  return fields.map((field) =>
    Object.hasOwn(values, field.name) ? { ...field, value: values[field.name] } : field,
  );
}

// ---------------------------------------------------------------------------
// The transient result page
// ---------------------------------------------------------------------------

/**
 * The stored records a result names, resolved for display from the returned
 * result (never from a snapshot read before the commit's turn): the meeting
 * the commit names, and the project stored on it.
 */
function resultLines(result: TranscriptImportResult, snapshot: Snapshot): string[] {
  const meeting = result.meeting;
  const lines: string[] = [];
  lines.push(
    `<p>Meeting: ${link(`/meetings/${encodeURIComponent(meeting.id)}`, `${meeting.date} — ${meeting.title}`)}</p>`,
  );
  const project =
    meeting.projectId === undefined ? undefined : snapshot.projects.find((candidate) => candidate.id === meeting.projectId);
  lines.push(`<p>Project: ${project === undefined ? showValue("") : link(`/projects/${encodeURIComponent(project.id)}`, project.name)}</p>`);
  if (result.explanation !== undefined) {
    lines.push(`<p role="status">${escapeHtml(result.explanation.message)}</p>`);
  }
  if (result.canonicalMeetingId !== undefined) {
    lines.push(
      `<p>Canonical meeting: ${link(`/meetings/${encodeURIComponent(result.canonicalMeetingId)}`, "open the canonical meeting")}</p>`,
    );
  }
  if (result.conflicts.length > 0) {
    const items = result.conflicts
      .map(
        (conflict) =>
          `<li>${escapeHtml(conflict.field)}: submitted ${escapeHtml(conflict.supplied)}, ` +
          `kept ${escapeHtml(conflict.preserved)}</li>`,
      )
      .join("");
    lines.push(`<div role="status"><p>The stored meeting keeps these values; the submitted ones were not written.</p><ul>${items}</ul></div>`);
  }
  return lines;
}

/** The breadcrumbs of a result page, from the scope's stored records. */
function resultBreadcrumbs(scope: ImportScope | null): readonly { readonly label: string; readonly href: string }[] {
  if (scope === null) return [{ label: "Home", href: "/" }];
  return [
    { label: "Home", href: "/" },
    { label: scope.client.name, href: `/clients/${encodeURIComponent(scope.client.id)}` },
    { label: scope.engagement.name, href: `/engagements/${encodeURIComponent(scope.engagement.id)}` },
  ];
}

/**
 * The result page shown after an import commits. It is transient: it is built
 * from the commit's own result, so a repeat can explain itself and name the
 * canonical meeting without a stored receipt, a session or a query parameter.
 */
function resultPage(result: TranscriptImportResult, snapshot: Snapshot, scope: ImportScope | null): Page {
  const title = "Transcript imported";
  const lines = resultLines(result, snapshot);
  const back = [
    `<p>${link(`/meetings/${encodeURIComponent(result.meeting.id)}`, "Open the meeting")}</p>`,
    ...(scope === null
      ? []
      : [`<p>${link(`/engagements/${encodeURIComponent(scope.engagement.id)}`, "Return to the engagement")}</p>`]),
  ].join("\n");
  return pageWith(title, resultBreadcrumbs(scope), [
    { title: "Result", body: lines.join("\n") },
    { title: "Where to go next", body: back },
  ]);
}

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

/**
 * The refusal a submission produced, shown as a correctable multipart form.
 * The submitted controls are kept as posted; every control the submission
 * omitted is filled from the initial values, so a corrected form carries the
 * URL project and a blank select stays blank. The refusal's message names the
 * problem in the summary and, for a visible control it names, beside that
 * control. The notice is the URL scope's archive notice, so a refusal on an
 * archived scope stays marked. The same guidance the initial form states (the
 * supported formats and the size limits) is kept above the corrected form, so
 * a user correcting a refused submission still sees what the import accepts.
 */
function formFailure(
  error: unknown,
  values: Readonly<Record<string, string>>,
  fields: readonly FieldSpec[],
  action: string,
  notice: string,
): FormError | null {
  if (!(error instanceof ValidationError) && !(error instanceof MissingRecordError)) return null;
  const filled: Record<string, string> = {};
  for (const field of fields) {
    if (!field.hidden && Object.hasOwn(values, field.name)) filled[field.name] = values[field.name];
  }
  const errors = fieldErrorsFor(error.message, filled, fields);
  const shownNotice = notice === "" ? importGuidance() : `${notice}\n${importGuidance()}`;
  return new FormError(error.message, filled, errors, fields, action)
    .withNotice(shownNotice)
    .withEnctype(MULTIPART_FORM_ENCTYPE);
}

/**
 * The file a submission supplied, as a selected file (a named file, even one
 * with zero bytes) or none. Only the multipart decoder's file part is used; no
 * path or filename ever reaches the filesystem here.
 */
function selectedFile(file: MultipartFile | null): { filename: string; bytes: Uint8Array } | null {
  return file === null ? null : { filename: file.filename, bytes: new Uint8Array(file.bytes) };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Build the transcript import routes over the application's single owned store.
 * The borrowed transcript service is built inside this factory over that same
 * store (`transcriptService(store)`) and only when an import POST first needs
 * it, so a page read and a startup that never imports need nothing beyond the
 * store every page already reads; a GET and a POST can never read one workspace
 * and write another. The GET forms render from the snapshot; the POSTs hand the
 * matched kind and raw id to `submitTranscript` first, so the URL record is
 * resolved inside the store's own queue turn, and answer with the transient
 * result page. A refusal writes nothing and is shown as a correctable form.
 */
export function transcriptImportRoutes(store: Store): TranscriptImportRoutes {
  const snapshot = (): Snapshot => store.snapshot();

  // The service borrows the one store this factory was given, so displaying and
  // committing always name the same workspace. It is built on first use.
  let service: TranscriptStore | null = null;
  const transcriptService = (): TranscriptStore => (service ??= buildTranscriptService(store));

  /** The scope the request path names, or null when it is missing or malformed. */
  function resolvedScope(request: TranscriptImportRequest, expected: TranscriptImportKind): ImportScope | null {
    const rawId = rawIdFromPath(request.path);
    try {
      const scope = scopeFromPath(snapshot(), expected, rawId);
      return scope.kind === expected ? scope : null;
    } catch (error) {
      if (error instanceof MissingRecordError) return null;
      throw error;
    }
  }

  /**
   * The refusal a submission produced on a scope that exists, shown as a
   * correctable multipart form. A failure that is not a refusal of the
   * submission's input (a persistence failure, a programming error) is reported
   * unchanged, never as a form.
   */
  function refuse(error: unknown, scope: ImportScope, request: TranscriptImportRequest): FormError {
    const snap = snapshot();
    const fields = fieldsForScope(scope, snap);
    const values = { ...createValues(scope.project), ...submittedControls(request.form, request.file) };
    const shown = fieldsWithValues(fields, values);
    const failure = formFailure(error, values, shown, importAction(scope), scopeNotice(snap, scope, shown));
    if (failure === null) throw error;
    return failure;
  }

  function createForm(scope: ImportScope): Page {
    const snap = snapshot();
    const fields = fieldsForScope(scope, snap);
    const values = createValues(scope.project);
    const shown = fieldsWithValues(fields, values);
    const notice = scopeNotice(snap, scope, shown);
    return renderPage(
      "Import transcript",
      [
        `<nav>${link("/", "Home")}${link(cancelHref(scope), "Cancel")}</nav>`,
        formPageBody(importAction(scope), shown, values, "Import transcript", notice),
      ].join("\n"),
    );
  }

  function attachForm(scope: ImportScope): Page {
    const snap = snapshot();
    const values: Record<string, string> = { [PASTE_CONTROL]: "", [FILE_CONTROL]: "" };
    const shown = fieldsWithValues(SOURCE_FIELDS, values);
    const notice = archiveNotice(snap, scope.meeting!);
    return renderPage(
      "Import transcript",
      [
        `<nav>${link("/", "Home")}${link(cancelHref(scope), "Cancel")}</nav>`,
        formPageBody(
          importAction(scope),
          shown,
          values,
          "Attach transcript",
          notice,
          [],
          undefined,
          `<p>This attaches one transcript to the meeting ${link(cancelHref(scope), `${scope.meeting!.date} — ${scope.meeting!.title}`)}. Its title, date, notes and project are kept.</p>`,
        ),
      ].join("\n"),
    );
  }

  /** The GET form of the scope an import path names: attachment or create. */
  function renderGet(scope: ImportScope): Page {
    return scope.kind === "meeting" ? attachForm(scope) : createForm(scope);
  }

  async function handlePost(request: TranscriptImportRequest, expected: TranscriptImportKind): Promise<Page> {
    // The matched kind and raw id are handed to the scoped handler first: it
    // resolves the URL record, validates the submission and commits inside one
    // store queue turn, so the page never decides a scope from an older snapshot.
    let result: TranscriptImportResult;
    try {
      result = await submitTranscript(transcriptService(), {
        kind: expected,
        rawId: rawIdFromPath(request.path),
        fields: request.form,
        file: selectedFile(request.file),
      });
    } catch (error) {
      if (error instanceof MissingRecordError) throw error;
      // Only a refusal of the submission's input (a `ValidationError`) names a
      // correctable form, so only then is presentation data resolved. A missing
      // record keeps the handler's 404. Every other failure (a persistence
      // failure, a programming error) is reported unchanged before any snapshot
      // read, so a later store read can never replace the failure that the
      // submission raised.
      if (!(error instanceof ValidationError)) throw error;
      const scope = resolvedScope(request, expected);
      if (scope === null) throw error;
      throw refuse(error, scope, request);
    }
    return resultPage(result, snapshot(), resolvedScope(request, expected));
  }

  const get: TranscriptImportRoute = {
    method: "GET",
    render(request) {
      const matched = matchTranscriptImportPath(request.path);
      if (matched === null) throw new MissingRecordError("No record for that path");
      return renderGet(scopeFromPath(snapshot(), matched.kind, matched.id));
    },
  };

  /** The marked multipart POST for one scope kind; it never renders a GET. */
  const post = (expected: TranscriptImportKind): TranscriptImportRoute => ({
    method: "POST",
    bodyPolicy: "Multipart",
    render: (request) => handlePost(request, expected),
  });

  return {
    engagementImport: { get, post: post("engagement") },
    projectImport: { get, post: post("project") },
    meetingImport: { get, post: post("meeting") },
  };
}
