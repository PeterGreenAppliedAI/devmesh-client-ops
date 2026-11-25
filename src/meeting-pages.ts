/**
 * Manual meeting pages: a meeting under an engagement, with an optional project
 * inside that engagement, plus the linked meeting histories shown on the
 * engagement and project pages. Every page is server-rendered HTML built from
 * the store's snapshot; every write goes through the validated store methods,
 * so an invalid submission, a tampered parent link or a cross-engagement
 * project is refused before it reaches disk.
 *
 * The client and engagement a meeting belongs to are derived from the parent in
 * the route path, never taken from the submitted form; a submitted parent id
 * that differs from the path's parent is refused. The only link a form chooses
 * is the optional project, and the choices offered are exactly the projects of
 * the engagement the meeting belongs to.
 */
import { isEffectivelyArchived } from "./archive.ts";
import { archiveNotice } from "./archive-pages.ts";
import {
  escapeHtml,
  fieldErrorsFor,
  FormError,
  redirect,
  renderForm,
  renderPage,
  type FieldSpec,
  type Page,
  type Redirect,
} from "./html.ts";
import { MissingRecordError, ValidationError } from "./model.ts";
import type {
  Client,
  Engagement,
  Meeting,
  MeetingCreate,
  MeetingEdit,
  Project,
  Snapshot,
  Store,
} from "./store.ts";
import {
  displayList,
  displayValues,
  emptyState,
  link,
  pageWith,
  primaryAction,
  showValue,
  type PageSection,
} from "./work-pages.ts";
import {
  meetingSourceSection,
  transcriptSourceRoutes,
  type SourceView,
  type TranscriptSourceRoute,
  type TranscriptSourceRoutes,
} from "./transcript-source-pages.ts";

/** The result of rendering one meeting page: a page, or a fixed redirect. */
export type MeetingPage = Page | Redirect;

/**
 * The transcript import path of one engagement, with its id encoded. The meeting
 * pages link their scopes' histories to it; it is declared here so the meeting
 * and import pages share one spelling of the fixed route.
 */
export function engagementImportHref(engagementId: string): string {
  return `/engagements/${encodeURIComponent(engagementId)}/transcripts/import`;
}

/** The transcript import path of one project, with its id encoded. */
export function projectImportHref(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/transcripts/import`;
}

/** The transcript import path of one meeting, with its id encoded. */
export function meetingImportHref(meetingId: string): string {
  return `/meetings/${encodeURIComponent(meetingId)}/transcripts/import`;
}

/** What a meeting route may read from an accepted request. */
export interface MeetingRequest {
  readonly method: "GET" | "POST";
  /** The request path including any query string. */
  readonly path: string;
  /** The form fields of an accepted POST; empty for a GET. */
  readonly form: Readonly<Record<string, string>>;
}

/** A guarded meeting route; `render` runs only after the request checks pass. */
export interface MeetingRoute {
  readonly method: "GET" | "POST";
  render(request: MeetingRequest): Promise<MeetingPage> | MeetingPage;
}

/** The route shapes registered under one fixed meeting path. */
export interface MeetingPathRoute {
  readonly get?: MeetingRoute;
  readonly post?: MeetingRoute;
}

/**
 * The meeting route table. The detail page is GET-only; the edit page offers a
 * GET form and takes its POST; creation forms are GET-only and POST to the
 * engagement they belong to.
 */
export interface MeetingRoutes {
  readonly meetingsRecord: MeetingPathRoute;
  readonly meetingsEdit: MeetingPathRoute;
  readonly meetingsNew: MeetingPathRoute;
  /**
   * The three read-only source GETs, matched only when the path is one of the
   * fixed source shapes; every other meeting path keeps the routes above.
   */
  readonly sources: TranscriptSourceRoutes;
}

/** The fixed paths the meeting table registers, used for matching. */
export type MeetingPath =
  | "/meetings/:id"
  | "/meetings/:id/edit"
  | "/engagements/:id/meetings/new"
  | "/projects/:id/meetings/new";

/**
 * Match a request path against the fixed meeting patterns and return the
 * matched pattern and the id in its path, or null for any other path so an
 * unregistered path is refused before any handler runs. The id is not decoded
 * here: a malformed escape names no record.
 */
export function matchMeetingPath(
  path: string,
): { readonly pattern: MeetingPath; readonly id: string } | null {
  const pathname = path.split("?")[0];
  const parts = pathname.split("/").slice(1);
  if (parts.some((part) => part === "")) return null;
  const family = parts[0];
  if (family === "meetings") {
    if (parts.length !== 2 && parts.length !== 3) return null;
    if (parts.length === 2 && parts[1] !== "new") {
      return { pattern: "/meetings/:id", id: parts[1] };
    }
    if (parts.length === 3 && parts[2] === "edit") {
      return { pattern: "/meetings/:id/edit", id: parts[1] };
    }
    return null;
  }
  if (family === "engagements" || family === "projects") {
    // The parent-scoped creation routes: a parent id, then the new form.
    if (parts.length === 4 && parts[2] === "meetings" && parts[3] === "new" && parts[1] !== "new") {
      return { pattern: `/${family}/:id/meetings/new` as MeetingPath, id: parts[1] };
    }
  }
  return null;
}

/**
 * Pick the route for a path: when `source` is supplied (the shell matched a
 * fixed source shape) the source view's GET slot; for a POST to that shape there
 * is no slot, so the shell answers 405. Otherwise the ordinary meeting, edit or
 * creation slot for the matched pattern.
 */
export function routeForMeetingRequest(
  routes: MeetingRoutes,
  path: string,
  method: "GET" | "POST",
  source?: { readonly view: SourceView },
): MeetingRoute | TranscriptSourceRoute | undefined {
  if (source !== undefined) {
    const slot = sourceSlot(routes.sources, source.view);
    if (slot === null) return undefined;
    return method === "GET" ? slot.get : undefined;
  }
  const matched = matchMeetingPath(path);
  if (matched === null) return undefined;
  return routeForMeetingPattern(routes, matched.pattern, method);
}

/**
 * The GET slot of one source view, chosen by the three exact view literals. Only
 * a GET is served (a POST finds no slot and the shell answers 405), and no
 * other view name can reach the table, so an inherited property name is never
 * read as a slot.
 */
function sourceSlot(
  sources: TranscriptSourceRoutes,
  view: SourceView,
): { readonly get: TranscriptSourceRoute } | null {
  switch (view) {
    case "original":
      return sources.original;
    case "text":
      return sources.text;
    case "passages":
      return sources.passages;
  }
}

/** Pick the registered route for a matched pattern from the table. */
export function routeForMeetingPattern(
  routes: MeetingRoutes,
  pattern: MeetingPath,
  method: "GET" | "POST",
): MeetingRoute | undefined {
  const slot = slotFor(routes, pattern);
  return method === "POST" ? slot.post : slot.get;
}

function slotFor(routes: MeetingRoutes, pattern: MeetingPath): MeetingPathRoute {
  switch (pattern) {
    case "/meetings/:id":
      return routes.meetingsRecord;
    case "/meetings/:id/edit":
      return routes.meetingsEdit;
    case "/engagements/:id/meetings/new":
    case "/projects/:id/meetings/new":
      return routes.meetingsNew;
  }
}

// ---------------------------------------------------------------------------
// Histories
// ---------------------------------------------------------------------------

/**
 * Order meetings by date descending, breaking ties by id descending so the
 * order is stable and independent of how the store happens to hold them: two
 * meetings on the same date always appear in the same order.
 */
function byDateThenId(a: Meeting, b: Meeting): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/**
 * The client-wide meeting history: every meeting of the client, across all its
 * engagements and projects, ordered by date descending with a stable tie
 * order. The store selects by the client, so no other client's meetings appear.
 */
export function clientMeetings(store: Store, clientId: string): readonly Meeting[] {
  // Effectively archived meetings (hidden through their parents) are left out of
  // the history, exactly like archived work is left out of the lists.
  const snapshot = store.snapshot();
  return [...store.listMeetings({ clientId })]
    .filter((meeting) => !isEffectivelyArchived(snapshot, meeting))
    .sort(byDateThenId);
}

/**
 * The meetings of one engagement's history: every meeting of the engagement,
 * including its project meetings, each exactly once. The store selects by the
 * engagement, so a sibling engagement's meetings never appear.
 */
export function engagementMeetings(store: Store, clientId: string, engagementId: string): readonly Meeting[] {
  const snapshot = store.snapshot();
  return [...store.listMeetings({ clientId, engagementId })]
    .filter((meeting) => !isEffectivelyArchived(snapshot, meeting))
    .sort(byDateThenId);
}

/** The meetings of one project's history: exactly the project's meetings. */
export function projectMeetings(
  store: Store,
  clientId: string,
  engagementId: string,
  projectId: string,
): readonly Meeting[] {
  const snapshot = store.snapshot();
  return [...store.listMeetings({ clientId, engagementId, projectId })]
    .filter((meeting) => !isEffectivelyArchived(snapshot, meeting))
    .sort(byDateThenId);
}

/** Render a list of meetings as cards with detail and edit links, or an empty state. */
export function meetingList(meetings: readonly Meeting[]): string {
  if (meetings.length === 0) return "<p>No meetings recorded yet.</p>";
  return `<ul class="card-list">${meetings
    .map((meeting) => {
      const href = `/meetings/${encodeURIComponent(meeting.id)}`;
      return `<li class="card">${link(href, `${meeting.date} — ${meeting.title}`)} ${link(`${href}/edit`, "Edit")}</li>`;
    })
    .join("")}</ul>`;
}

/**
 * A meeting history section with the primary creation action for the given
 * scope. An empty `newHref` means the section has no single creation scope (a
 * client-wide history): creation happens under a chosen engagement or project,
 * so no direct creation link is offered rather than one that guesses a
 * parent. An empty history names the missing meetings and offers its valid
 * next step: the scope's own creation link when it has one, otherwise the
 * `nextStep` the caller supplies (for a client-wide history, the client's
 * engagement choice). Without either, the sentence stands alone.
 *
 * `importHref` is the optional transcript import action of the same scope. It
 * is offered beside the creation action when the scope has one, and it is the
 * empty history's next step when the scope offers no creation link: a history
 * with no meetings and no creation scope still offers the way to import one.
 */
export function meetingSection(
  title: string,
  newHref: string,
  meetings: readonly Meeting[],
  nextStep?: { readonly href: string; readonly label: string },
  importHref = "",
): PageSection {
  const body: string[] = [];
  if (newHref !== "") body.push(primaryAction(newHref, "New meeting"));
  if (importHref !== "") body.push(primaryAction(importHref, "Import transcript"));
  if (meetings.length === 0) {
    const next =
      newHref !== ""
        ? { href: newHref, label: "New meeting" }
        : importHref !== ""
          ? { href: importHref, label: "Import transcript" }
          : nextStep;
    body.push(emptyState("No meetings recorded yet.", next));
  } else {
    body.push(meetingList(meetings));
  }
  return { title, body: body.join("\n") };
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

const MEETING_FIELDS: readonly FieldSpec[] = [
  { name: "title", label: "Title", required: true },
  { name: "date", label: "Date", type: "date", required: true },
  { name: "notes", label: "Notes", type: "textarea" },
];

const MEETING_PROFILE_FIELDS: readonly FieldSpec[] = [
  { name: "title", label: "Title" },
  { name: "date", label: "Date" },
  { name: "notes", label: "Notes" },
];

/**
 * The optional no-project choice, offered first so it is the default, and every
 * project of the engagement. An effectively archived project stays offered but
 * is labelled as archived, so an existing meeting link is never silently
 * dropped; the label is text, escaped on render.
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

/**
 * The controls of a meeting form: the record id, parent engagement and parent
 * client (all hidden and server-chosen, so a corrected resubmission names the
 * same record and parents) and the base fields with the project select.
 */
function meetingFields(
  projects: readonly Project[],
  snapshot: Snapshot,
  id = "",
  engagementId = "",
  clientId = "",
): readonly FieldSpec[] {
  return [
    { name: "id", label: "Id", hidden: true, value: id },
    { name: "engagementId", label: "Engagement", hidden: true, value: engagementId },
    { name: "clientId", label: "Client", hidden: true, value: clientId },
    ...MEETING_FIELDS,
    { name: "projectId", label: "Project", type: "select", options: projectOptions(projects, snapshot) },
  ];
}

/** The form values of a stored meeting, plus the id its edit posts back. */
function meetingFormValues(meeting: Meeting): Record<string, string> {
  return {
    id: meeting.id,
    title: meeting.title,
    date: meeting.date,
    notes: meeting.notes,
    projectId: meeting.projectId ?? "",
  };
}

/** Initial values for a create form: nothing entered, no project. */
function createMeetingValues(): Record<string, string> {
  return { title: "", date: "", notes: "", projectId: "" };
}

/**
 * The values a meeting form actually supplied. The parent links are never
 * taken from the form. An edit changes only the fields it was given and keeps
 * the others. The project select always has a value (empty for no project): on
 * an edit an empty value clears the link, and on a create it is absent.
 */
function suppliedValues(
  form: Readonly<Record<string, string>>,
  fields: readonly FieldSpec[],
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    if (field.hidden) continue;
    if (Object.hasOwn(form, field.name)) values[field.name] = form[field.name];
  }
  return values;
}

/** The store's meeting edit for the supplied values; a blank project clears it. */
function meetingEdit(values: Readonly<Record<string, string>>, create: boolean): MeetingEdit {
  const edit: MeetingEdit = {};
  for (const [key, value] of Object.entries(values)) {
    if (key === "projectId") continue;
    (edit as Record<string, string>)[key] = value;
  }
  if (Object.hasOwn(values, "projectId")) {
    if (values.projectId === "") {
      if (!create) edit.clearProject = true;
    } else {
      edit.projectId = values.projectId;
    }
  }
  return edit;
}


/**
 * Build a correctable form error from a refusal. The submitted values are kept
 * exactly as posted; every control the submission omitted is filled from the
 * stored record, so a corrected form carries the current record rather than
 * blank controls and an edit never blanks what it did not touch. A hidden
 * control keeps its server-chosen value. The refusal's message names the form's
 * problems in the summary and, for every visible control it names, associates
 * the message with that control.
 */
function formFailure(
  error: unknown,
  values: Readonly<Record<string, string>>,
  fields: readonly FieldSpec[],
  action: string,
  record?: Readonly<Record<string, string>>,
  notice = "",
): FormError | null {
  if (!(error instanceof ValidationError) && !(error instanceof MissingRecordError)) {
    return null;
  }
  const base = record ?? {};
  const filled: Record<string, string> = {};
  for (const field of fields) {
    if (field.hidden) {
      filled[field.name] = field.value ?? "";
    } else if (Object.hasOwn(values, field.name)) {
      filled[field.name] = values[field.name];
    } else if (Object.hasOwn(base, field.name)) {
      filled[field.name] = base[field.name];
    }
  }
  // The meeting's own project choice, when the submission gave one, is the
  // visible project control, named by its field identity: a refusal about that
  // value (an unknown project, on a create or an edit) is associated with it,
  // while a refusal about the meeting's identity or parent chain names a hidden
  // link and stays in the summary alone.
  const selectedProject = values["projectId"];
  const selected = selectedProject === undefined || selectedProject === ""
    ? undefined
    : { field: "projectId", value: selectedProject };
  const errors = fieldErrorsFor(error.message, filled, fields, selected);
  return new FormError(error.message, filled, errors, fields, action).withNotice(notice);
}

/** A record id from a path that names no record: a missing record. */
function decodeId(rawId: string, kind: string): string {
  try {
    return decodeURIComponent(rawId);
  } catch {
    throw new MissingRecordError(`No ${kind} for that path`);
  }
}

function findRecord<T extends { readonly id: string }>(
  items: readonly T[],
  id: string,
  kind: string,
): T {
  const found = items.find((item) => item.id === id);
  if (found === undefined) {
    throw new MissingRecordError(`No ${kind} with id ${JSON.stringify(id)}`);
  }
  return found;
}

/** The record id from a detail, edit or child-new path. */
function idFromPath(path: string): string {
  const parts = path.split("?")[0].split("/").slice(1);
  if (parts.length < 2) throw new MissingRecordError("No record for that path");
  return parts[1];
}

/** The projects of one engagement, ordered by name then id for a select. */
function projectChoices(snapshot: Snapshot, engagementId: string): readonly Project[] {
  return snapshot.projects
    .filter((project) => project.engagementId === engagementId)
    .sort((a, b) => (a.name === b.name ? a.id.localeCompare(b.id) : a.name.localeCompare(b.name)));
}

/** The breadcrumb links for a meeting, with its project when it has one. */
function meetingBreadcrumbs(
  client: Client,
  engagement: Engagement,
  projectId: string | undefined,
  snapshot: Snapshot,
): { readonly label: string; readonly href: string }[] {
  const links = [
    { label: "Home", href: "/" },
    { label: "Clients", href: "/clients" },
    { label: client.name, href: `/clients/${encodeURIComponent(client.id)}` },
    { label: engagement.name, href: `/engagements/${encodeURIComponent(engagement.id)}` },
  ];
  if (projectId !== undefined) {
    const project = snapshot.projects.find((candidate) => candidate.id === projectId);
    if (project !== undefined) {
      links.push({ label: project.name, href: `/projects/${encodeURIComponent(project.id)}` });
    }
  }
  return links;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function text(form: Readonly<Record<string, string>>, name: string): string {
  return form[name] ?? "";
}

/** A creation scope: the parent from the path, and its project when known. */
interface CreateScope {
  readonly client: Client;
  readonly engagement: Engagement;
  /** The project the creation form belongs to, when the path names one. */
  readonly project?: Project;
}

/** Build the meeting routes for a store. */
export function meetingRoutes(store: Store): MeetingRoutes {
  const snapshot = (): Snapshot => store.snapshot();

  /** The engagement and client a creation path names. */
  function engagementScope(snap: Snapshot, engagementId: string): CreateScope {
    const engagement = findRecord(snap.engagements, engagementId, "engagement");
    const client = findRecord(snap.clients, engagement.clientId, "client");
    return { client, engagement };
  }

  /** The project, engagement and client a creation path names. */
  function projectScope(snap: Snapshot, projectId: string): CreateScope {
    const project = findRecord(snap.projects, projectId, "project");
    const engagement = findRecord(snap.engagements, project.engagementId, "engagement");
    const client = findRecord(snap.clients, engagement.clientId, "client");
    return { client, engagement, project };
  }

  /**
   * The parent a creation POST names: the client and engagement are derived
   * from the URL path alone and are authoritative. The submitted form carries
   * hidden parent ids when it was rendered that way, but it may not change
   * them: a submitted engagement id (or client id) that is not the parent in
   * the path is a tampered parent and is refused, leaving the data unchanged.
   * Omitting a parent control is not tampering; the URL parent still decides.
   * This resolves only the parent; the optional selected project is resolved
   * separately, inside the correction boundary, so an unknown or
   * cross-engagement project becomes a correctable form error. A nonexistent
   * URL parent (or URL project) is a missing record and stays a 404.
   */
  function postedParent(
    snap: Snapshot,
    path: string,
    form: Readonly<Record<string, string>>,
  ): {
    readonly scope: CreateScope;
    /** The project the URL path names, when it names one; the parent only. */
    readonly project?: Project;
    readonly parent: { readonly name: "engagementId"; readonly id: string };
    readonly conflict: ValidationError | null;
  } {
    const pathname = path.split("?")[0];
    const parts = pathname.split("/").slice(1);
    if (parts[0] === "engagements") {
      const engagementId = decodeId(parts[1] ?? "", "engagement");
      const scope = engagementScope(snap, engagementId);
      return {
        scope,
        parent: { name: "engagementId", id: engagementId },
        conflict: submittedParentConflict(form, scope),
      };
    }
    if (parts[0] === "projects") {
      // The project form posts to the engagement's new endpoint, with the
      // engagement derived from the URL project as its parent. The URL project
      // stays the parent; the submitted project is resolved separately.
      const projectId = decodeId(parts[1] ?? "", "project");
      const projectScopeResult = projectScope(snap, projectId);
      // The create form's scope is the engagement only (a blank project selector
      // creates engagement-only work); the URL project is reported separately so
      // a refusal still shows its notice.
      const scope = { client: projectScopeResult.client, engagement: projectScopeResult.engagement };
      return {
        scope,
        project: projectScopeResult.project,
        parent: { name: "engagementId", id: scope.engagement.id },
        conflict: submittedParentConflict(form, scope),
      };
    }
    throw new MissingRecordError("No parent for that path");
  }

  /**
   * Check that every submitted parent id, when present, names the parent the
   * URL chose. An omitted control is fine (a client that does not resubmit
   * hidden fields cannot tamper); a present but different value is refused,
   * and so is a submitted client id that names a different client. The URL
   * parent stays authoritative either way. The problem is reported as invalid
   * input on the correction form by `createMeeting`.
   */
  function submittedParentConflict(
    form: Readonly<Record<string, string>>,
    scope: CreateScope,
  ): ValidationError | null {
    if (
      Object.hasOwn(form, "engagementId") &&
      form["engagementId"] !== scope.engagement.id
    ) {
      return new ValidationError(
        `Submitted engagementId ${JSON.stringify(form["engagementId"])} is not the parent engagement of this form`,
      );
    }
    if (Object.hasOwn(form, "clientId") && form["clientId"] !== scope.client.id) {
      return new ValidationError(
        `Submitted clientId ${JSON.stringify(form["clientId"])} is not the client of this engagement`,
      );
    }
    return null;
  }

  /** The action a creation POST writes to: the parent engagement's new endpoint. */
  function createAction(scope: CreateScope): string {
    return `/engagements/${encodeURIComponent(scope.engagement.id)}/meetings/new`;
  }

  /**
   * Attach the project a submission selected, refusing one outside the
   * engagement. This runs before the store so the correction form keeps the
   * submitted project and reports the problem in place.
   */
  function withSelectedProject(
    snap: Snapshot,
    scope: CreateScope,
    projectId: string,
  ): CreateScope {
    if (projectId === "") return scope;
    const project = snap.projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) {
      // The submitted project is the form's own visible choice, so the refusal
      // is associated with that control; the summary carries the same message.
      throw new ValidationError(`projectId: ${JSON.stringify(projectId)} is not a project of this engagement`);
    }
    if (project.engagementId !== scope.engagement.id) {
      // An existing project of another engagement is not this form's choice: the
      // store owns that refusal and its message, so the selection is left
      // unattached and the notice keeps coming from the URL scope instead of
      // the foreign project.
      return scope;
    }
    return { ...scope, project };
  }

  /** The archive notice of the URL scope: the project of a project-scoped
   * create, otherwise the engagement. Each is resolved to its stored record so
   * the notice names the archived parent it is derived from. */
  function noticeText(snap: Snapshot, scope: CreateScope): string {
    const direct = scope.project !== undefined ? scope.project : scope.engagement;
    return archiveNotice(snap, direct);
  }

  /**
   * The archive notice a creation form, and a refused create, shows, chosen
   * from the submission's own project selector. A valid selected project of the
   * authoritative engagement is the record's effective parent, so its notice is
   * the one that matches the record the submission would create. An omitted
   * selector takes the URL scope: a project-scoped create keeps the URL
   * project's notice, otherwise the engagement's. A blank, unknown or
   * cross-engagement selection is not a parent of any record under this
   * engagement, so it keeps the URL scope's notice; the store still owns the
   * refusal of that selection, and existing validation stays unchanged.
   */
  function createFormNotice(
    snap: Snapshot,
    scope: CreateScope,
    selectedId: string,
    urlProject?: Project,
  ): string {
    if (selectedId !== "") {
      const selected = snap.projects.find((candidate) => candidate.id === selectedId);
      if (selected !== undefined && selected.engagementId === scope.engagement.id) {
        return archiveNotice(snap, selected);
      }
    }
    return archiveNotice(snap, urlProject !== undefined ? urlProject : scope.engagement);
  }

  function newPage(
    snap: Snapshot,
    scope: CreateScope,
    title: string,
    action: string,
    fields: readonly FieldSpec[],
    values: Readonly<Record<string, string>>,
    cancelHref: string,
  ): Page {
    return renderPage(
      title,
      [
        `<nav>${link("/", "Home")}${link(cancelHref, "Cancel")}</nav>`,
        noticeText(snap, scope),
        renderForm({ action, fields, values, submitLabel: "Create" }),
      ].join("\n"),
    );
  }

  /**
   * The controls and initial values of a creation form. A form opened under a
   * project preselects that project; the form posts to the engagement's new
   * endpoint with the engagement id as its hidden parent.
   */
  function createForm(title: string, snap: Snapshot, scope: CreateScope): Page {
    const fields = meetingFields(
      projectChoices(snap, scope.engagement.id),
      snap,
      "",
      scope.engagement.id,
      scope.client.id,
    ).filter((field) => field.name !== "id");
    const values = createMeetingValues();
    if (scope.project !== undefined) values.projectId = scope.project.id;
    const cancelHref = scope.project !== undefined
      ? `/projects/${encodeURIComponent(scope.project.id)}`
      : `/engagements/${encodeURIComponent(scope.engagement.id)}`;
    // A creation form under an archived scope still works; its notice names the
    // archived parent so the user knows the new record will inherit its hiding.
    return newPage(snap, scope, title, createAction(scope), fields, values, cancelHref);
  }

  async function createMeeting(request: MeetingRequest): Promise<MeetingPage> {
    const snap = snapshot();
    // The URL parent is resolved first and stays a 404 when it is missing, and
    // a submitted parent that differs from it is refused.
    const { scope, project: urlProject, parent, conflict } = postedParent(snap, request.path, request.form);
    const action = createAction(scope);
    // The creation fields already carry the hidden engagement and client
    // parents, so a refusal keeps every submitted visible value and the form
    // has exactly one control per name.
    const fields = meetingFields(
      projectChoices(snap, scope.engagement.id),
      snap,
      "",
      parent.id,
      scope.client.id,
    ).filter((field) => field.name !== "id");
    const values = suppliedValues(request.form, fields);
    // The selected project, when the submission gave a valid one, is resolved
    // inside the boundary; it stays available to the correction form so a
    // refused create keeps the selected project's archive notice.
    let selected: CreateScope = scope;
    try {
      // The parent conflict is settled before any selector resolves the
      // submitted project, so a tampered request is refused without reading it.
      if (conflict !== null) throw conflict;
      // The optional selected project is resolved inside the boundary: an
      // unknown project is a correctable error, a blank one records an
      // engagement-only meeting.
      selected = withSelectedProject(snap, scope, text(request.form, "projectId"));
      const input = {
        ...meetingEdit(values, true),
        clientId: scope.client.id,
        engagementId: scope.engagement.id,
      };
      if (selected.project !== undefined) input.projectId = selected.project.id;
      const meeting = await store.createMeeting(input as MeetingCreate);
      return redirect(`/meetings/${encodeURIComponent(meeting.id)}`);
    } catch (error) {
      const failure = formFailure(
        error,
        values,
        fields,
        action,
        undefined,
        createFormNotice(snap, scope, text(request.form, "projectId"), urlProject),
      );
      if (failure !== null) throw failure;
      throw error;
    }
  }

  /**
   * The stored record an edit names, and its immutable parents. The client and
   * engagement of the record are authoritative: a submitted parent id that
   * differs from them is a tampered parent and is refused, while an omitted
   * parent control is not tampering. The edit's fields are the meeting form's
   * fields, so a submitted parent id is checked here rather than saved.
   */
  function editTarget(request: MeetingRequest): {
    readonly snap: Snapshot;
    readonly record: Meeting;
    readonly engagement: Engagement;
    readonly fields: readonly FieldSpec[];
    readonly action: string;
    readonly conflict: ValidationError | null;
    readonly id: string;
  } {
    const snap = snapshot();
    const id = decodeId(idFromPath(request.path), "meeting");
    const record = findRecord(snap.meetings, id, "meeting");
    const engagement = findRecord(snap.engagements, record.engagementId, "engagement");
    const client = findRecord(snap.clients, engagement.clientId, "client");
    const fields = meetingFields(projectChoices(snap, engagement.id), snap, id, engagement.id, client.id);
    // An existing identity conflict takes precedence: a submitted id that
    // differs from the URL record is refused before any parent is compared.
    const submitted = request.form["id"];
    let conflict: ValidationError | null =
      submitted !== undefined && submitted !== "" && submitted !== record.id
        ? new ValidationError("The submitted meeting id does not match this URL")
        : null;
    if (conflict === null) {
      // The record's own parents are immutable: a supplied parent that differs
      // from them (a blank one included) is refused, even though the other
      // fields are valid.
      conflict = submittedParentConflict(request.form, { client, engagement });
    }
    return {
      snap,
      record,
      engagement,
      fields,
      action: `/meetings/${encodeURIComponent(record.id)}/edit`,
      id: record.id,
      conflict,
    };
  }

  async function updateMeeting(request: MeetingRequest): Promise<MeetingPage> {
    const target = editTarget(request);
    const meeting = target.record;
    const values = suppliedValues(request.form, target.fields);
    const stored = meetingFormValues(meeting);
    try {
      // The record's own parents are immutable, so a tampered parent is refused
      // before the store sees the edit; the rest of the submission is not saved.
      if (target.conflict !== null) throw target.conflict;
      await store.updateMeeting(meeting.id, meetingEdit(values, false));
      return redirect(`/meetings/${encodeURIComponent(meeting.id)}`);
    } catch (error) {
      const failure = formFailure(
        error,
        values,
        target.fields,
        target.action,
        stored,
        archiveNotice(target.snap, target.record),
      );
      if (failure !== null) throw failure;
      throw error;
    }
  }

  /** Edit a meeting: the GET form starts from the stored record, the POST saves. */
  function editMeetingForm(request: MeetingRequest): Page {
    const target = editTarget(request);
    const meeting = target.record;
    const engagement = target.engagement;
    const client = findRecord(target.snap.clients, engagement.clientId, "client");
    return renderPage(
      "Edit meeting",
      [
        `<nav>${link("/", "Home")}${link(`/meetings/${encodeURIComponent(meeting.id)}`, "Cancel")}</nav>`,
        archiveNotice(target.snap, meeting),
        renderForm({
          action: target.action,
          fields: target.fields,
          values: meetingFormValues(meeting),
          submitLabel: "Save",
        }),
        `<p>${link(`/clients/${encodeURIComponent(client.id)}`, client.name)} · ${link(`/engagements/${encodeURIComponent(engagement.id)}`, engagement.name)}</p>`,
      ].join("\n"),
    );
  }

  function showMeeting(request: MeetingRequest): Page {
    const snap = snapshot();
    const id = decodeId(idFromPath(request.path), "meeting");
    const meeting = findRecord(snap.meetings, id, "meeting");
    const engagement = findRecord(snap.engagements, meeting.engagementId, "engagement");
    const client = findRecord(snap.clients, engagement.clientId, "client");
    const project =
      meeting.projectId === undefined
        ? undefined
        : findRecord(snap.projects, meeting.projectId, "project");
    const profile: Record<string, string> = {
      title: meeting.title,
      date: meeting.date,
      notes: meeting.notes,
    };
    return pageWith(
      meeting.title,
      [
        ...meetingBreadcrumbs(client, engagement, meeting.projectId, snap),
        { label: "Edit meeting", href: `/meetings/${encodeURIComponent(meeting.id)}/edit` },
        { label: "Import transcript", href: meetingImportHref(meeting.id) },
      ],
      [
        { title: "Archive", body: archiveNotice(snap, meeting) },
        {
          title: "Meeting",
          body: displayList(displayValues(MEETING_PROFILE_FIELDS, profile)),
        },
        {
          // The transcript actions of this meeting: the import form the header
          // also offers. This place in the page body is kept beside the source
          // list, exactly as before sources gained their own section.
          title: "Transcript",
          body: link(meetingImportHref(meeting.id), "Import transcript"),
        },
        {
          // Every committed source of this meeting, from the snapshot metadata
          // alone, so a missing original cannot break the page.
          title: "Sources",
          body: meetingSourceSection(snap, meeting.id),
        },
        {
          title: "Identity and parents",
          body: [
            `<p>Client: ${link(`/clients/${encodeURIComponent(client.id)}`, client.name)}</p>`,
            `<p>Engagement: ${link(`/engagements/${encodeURIComponent(engagement.id)}`, engagement.name)}</p>`,
            `<p>Project: ${project === undefined ? showValue("") : link(`/projects/${encodeURIComponent(project.id)}`, project.name)}</p>`,
          ].join("\n"),
        },
      ],
    );
  }

  return {
    meetingsRecord: {
      get: { method: "GET", render: (request) => showMeeting(request) },
    },
    sources: transcriptSourceRoutes(store),
    meetingsEdit: {
      get: { method: "GET", render: (request) => editMeetingForm(request) },
      post: {
        method: "POST",
        async render(request) {
          // A refused write throws a FormError, which the shell renders as a
          // correctable 400 page with the submitted values kept.
          return await updateMeeting(request);
        },
      },
    },
    meetingsNew: {
      get: {
        method: "GET",
        render: (request) => {
          const snap = snapshot();
          const parts = request.path.split("?")[0].split("/").slice(1);
          const scope =
            parts[0] === "engagements"
              ? engagementScope(snap, decodeId(parts[1] ?? "", "engagement"))
              : projectScope(snap, decodeId(parts[1] ?? "", "project"));
          return createForm("New meeting", snap, scope);
        },
      },
      post: {
        method: "POST",
        async render(request) {
          return await createMeeting(request);
        },
      },
    },
  };
}
