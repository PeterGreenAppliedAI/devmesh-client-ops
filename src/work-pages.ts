/**
 * Manual work pages: tasks and work items under an engagement, with an
 * optional project inside that engagement. Every page is server-rendered HTML
 * built from the store's snapshot; every write goes through the validated
 * store methods, so an invalid submission, a tampered parent link or a
 * cross-engagement project is refused by the store and never reaches disk.
 *
 * The client and engagement a work record belongs to are derived from the
 * selected parent in the route path, never taken from the submitted form. The
 * only link a form chooses is the optional project, and the choices offered are
 * exactly the projects of the engagement the record belongs to.
 */
import {
  escapeHtml,
  fieldErrorsFor,
  FormError,
  redirect,
  renderForm,
  renderPage,
  renderFormSummary,
  type DisplayValue,
  type FieldSpec,
  type FieldPresentation,
  type Page,
  type Redirect,
} from "./html.ts";
import { isEffectivelyArchived } from "./archive.ts";
import { archiveControl, archiveNotice } from "./archive-pages.ts";
import {
  ITEM_KINDS,
  ITEM_STATES,
  MissingRecordError,
  TASK_PRIORITIES,
  TASK_STATUSES,
  ValidationError,
} from "./model.ts";
import type {
  Client,
  Engagement,
  Project,
  Snapshot,
  Store,
  Task,
  TaskCreate,
  TaskEdit,
  WorkItem,
  WorkItemCreate,
  WorkItemEdit,
} from "./store.ts";

/** The result of rendering one work page: a page, or a fixed redirect. */
export type WorkPage = Page | Redirect;

/** What a work route may read from an accepted request. */
export interface WorkRequest {
  readonly method: "GET" | "POST";
  /** The request path including any query string. */
  readonly path: string;
  /** The form fields of an accepted POST; empty for a GET. */
  readonly form: Readonly<Record<string, string>>;
}

/** A guarded work route; `render` runs only after the request checks pass. */
export interface WorkRoute {
  readonly method: "GET" | "POST";
  render(request: WorkRequest): Promise<WorkPage> | WorkPage;
}

/** The route shapes registered under one fixed work path. */
export interface WorkPathRoute {
  readonly get?: WorkRoute;
  readonly post?: WorkRoute;
}

/**
 * The work route table. Detail pages are GET-only; edit pages offer a GET form
 * and take its POST; creation forms are GET-only and POST to the engagement or
 * project they belong to.
 */
export interface WorkRoutes {
  readonly tasksRecord: WorkPathRoute;
  readonly tasksEdit: WorkPathRoute;
  readonly tasksNew: WorkPathRoute;
  readonly itemsRecord: WorkPathRoute;
  readonly itemsEdit: WorkPathRoute;
  readonly itemsNew: WorkPathRoute;
}

/** The fixed paths the work table registers, used for matching. */
export type WorkPath =
  | "/tasks/:id"
  | "/tasks/:id/edit"
  | "/engagements/:id/tasks/new"
  | "/projects/:id/tasks/new"
  | "/items/:id"
  | "/items/:id/edit"
  | "/engagements/:id/items/new"
  | "/projects/:id/items/new";

/**
 * Match a request path against the fixed work patterns and return the matched
 * pattern and the id in its path, or null for any other path so an
 * unregistered path is refused before any handler runs. The id is not
 * decoded here: a malformed escape names no record.
 */
export function matchWorkPath(
  path: string,
): { readonly pattern: WorkPath; readonly id: string } | null {
  const pathname = path.split("?")[0];
  const parts = pathname.split("/").slice(1);
  if (parts.some((part) => part === "")) return null;
  const family = parts[0];
  if (family === "tasks" || family === "items") {
    if (parts.length !== 2 && parts.length !== 3) return null;
    if (parts.length === 2 && parts[1] !== "new") {
      return { pattern: `/${family}/:id` as WorkPath, id: parts[1] };
    }
    if (parts.length === 3 && parts[2] === "edit") {
      return { pattern: `/${family}/:id/edit` as WorkPath, id: parts[1] };
    }
    return null;
  }
  if (family === "engagements" || family === "projects") {
    // The child creation routes: a parent id, then the work family's new form.
    if (
      parts.length === 4 &&
      (parts[2] === "tasks" || parts[2] === "items") &&
      parts[3] === "new" &&
      parts[1] !== "new"
    ) {
      return { pattern: `/${family}/:id/${parts[2]}/new` as WorkPath, id: parts[1] };
    }
  }
  return null;
}

/** Pick the registered route for a matched pattern from the table. */
export function routeForWorkPattern(
  routes: WorkRoutes,
  pattern: WorkPath,
  method: "GET" | "POST",
): WorkRoute | undefined {
  const slot = slotFor(routes, pattern);
  return method === "POST" ? slot.post : slot.get;
}

function slotFor(routes: WorkRoutes, pattern: WorkPath): WorkPathRoute {
  switch (pattern) {
    case "/tasks/:id":
      return routes.tasksRecord;
    case "/tasks/:id/edit":
      return routes.tasksEdit;
    case "/engagements/:id/tasks/new":
    case "/projects/:id/tasks/new":
      return routes.tasksNew;
    case "/items/:id":
      return routes.itemsRecord;
    case "/items/:id/edit":
      return routes.itemsEdit;
    case "/engagements/:id/items/new":
    case "/projects/:id/items/new":
      return routes.itemsNew;
  }
}

// ---------------------------------------------------------------------------
// Shared rendering helpers, reused by the client overview
// ---------------------------------------------------------------------------

/** A link to one of this server's own routes, escaped. */
export function link(path: string, label: string): string {
  return `<a href="${escapeHtml(path)}">${escapeHtml(label)}</a>`;
}

/**
 * A piece of stored text shown as a badge. The label is escaped, so a stored
 * status or state can never bring markup into the page; an unexpected value is
 * still shown as text, never hidden.
 */
export function badge(text: string): string {
  return `<span class="badge">${escapeHtml(text)}</span>`;
}

/** One page section: a heading and a body, so sections can be composed. */
export interface PageSection {
  readonly title: string;
  readonly body: string;
}

/** One labelled group inside a section, with its own heading and body. */
export interface PageGroup {
  readonly title: string;
  readonly body: string;
}

/**
 * Render labelled groups under a heading: each group gets its own lower-level
 * heading and body, so sections with several lists stay readable instead of
 * running together. The headings are escaped.
 */
export function groupedSections(groups: readonly PageGroup[], headingLevel: 3 | 4 = 3): string {
  const tag = `h${headingLevel}`;
  return groups
    .map((group) => `<${tag}>${escapeHtml(group.title)}</${tag}>${group.body}`)
    .join("\n");
}

/**
 * A page's primary action: the one link for the most likely next step in the
 * page's own scope. The destination and label are escaped; it is only rendered
 * where the scope is known, never to guess a parent.
 */
export function primaryAction(href: string, label: string): string {
  return `<p class="primary-action">${link(href, label)}</p>`;
}

/**
 * A page's empty state: a sentence that says what is missing and, when the
 * scope offers one, the valid next step that fills it. Without a next step the
 * sentence stands alone, so an empty state never guesses a parent.
 */
export function emptyState(
  message: string,
  next?: { readonly href: string; readonly label: string },
): string {
  const parts = [`<p>${escapeHtml(message)}</p>`];
  if (next !== undefined) parts.push(`<p>${link(next.href, next.label)}</p>`);
  return parts.join("\n");
}

/**
 * Client-level guidance: a client overview cannot create work directly, so it
 * asks the user to choose an engagement first. The link is offered only when
 * the client has an engagement to open; without one the sentence stands alone.
 */
export function clientGuidance(
  engagements: readonly { readonly href: string; readonly label: string }[],
): string {
  const guidance =
    "<p>Tasks, work items and meetings are created under an engagement. Choose an engagement to add them from its page.</p>";
  if (engagements.length === 0) return guidance;
  return `${guidance}\n<p>${engagements
    .map((engagement) => link(engagement.href, engagement.label))
    .join(" ")}</p>`;
}

/** Render a page from its title, fixed navigation links and section list. */
export function pageWith(
  title: string,
  links: readonly { readonly label: string; readonly href: string }[],
  sections: readonly PageSection[],
): Page {
  const nav = links
    .map((entry) => `<a href="${escapeHtml(entry.href)}">${escapeHtml(entry.label)}</a>`)
    .join("");
  const body = sections
    .map(
      (section) =>
        `<section><h2>${escapeHtml(section.title)}</h2>${section.body}</section>`,
    )
    .join("\n");
  return renderPage(title, `<nav>${nav}</nav>\n${body}`);
}

/** A stored value shown as escaped text, with a placeholder when blank. */
export function showValue(value: string): string {
  return value === "" ? "<em>(none)</em>" : escapeHtml(value);
}

/**
 * The display values of a record's fields. A field marked as a badge in its
 * presentation metadata is shown as a text badge; every other field is plain
 * text. Identity and parent fields are left out: they are shown separately, as
 * links or read-only text, never as editable values.
 */
export function displayValues(
  fields: readonly FieldSpec[],
  record: object,
): readonly DisplayValue[] {
  const values = record as Readonly<Record<string, string | undefined>>;
  return fields
    .filter((field) => field.presentation?.identity !== true)
    .map((field) => ({
      label: field.label,
      value: values[field.name] ?? "",
      badge: field.presentation?.badge === true,
    }));
}

/** Render display values as a description list, escaped, badges as badges. */
export function displayList(values: readonly DisplayValue[]): string {
  const rows = values.map(
    (value) =>
      `<dt>${escapeHtml(value.label)}</dt><dd>${value.badge ? badge(value.value) : showValue(value.value)}</dd>`,
  );
  return `<dl>${rows.join("")}</dl>`;
}

/** Render every profile field of a record, escaped; badges stay badges. */
export function profileFields(fields: readonly FieldSpec[], record: object): string {
  return displayList(displayValues(fields, record));
}

/** One linked list entry: where it links, what it says and its text badges. */
export interface ListEntry {
  readonly href: string;
  readonly label: string;
  /** Stored text shown as escaped text badges beside the link. */
  readonly badges?: readonly string[];
  /** Already-escaped markup shown after the badges, such as a parent link. */
  readonly trailing?: string;
}

/**
 * Render a list of links, or a sentence when there are none. A list entry's
 * badges (a stored status, for example) are shown as escaped text badges beside
 * its link, so a state is readable at a glance without markup of its own. Any
 * trailing markup the entry carries (a parent link, for example) follows the
 * badges; the caller escaped it.
 */
export function childList(items: readonly ListEntry[]): string {
  if (items.length === 0) return "<p>None yet.</p>";
  return `<ul>${items
    .map((item) => {
      const badges = (item.badges ?? []).map((text) => ` ${badge(text)}`).join("");
      const trailing = item.trailing === undefined ? "" : ` · ${item.trailing}`;
      return `<li>${link(item.href, item.label)}${badges}${trailing}</li>`;
    })
    .join("")}</ul>`;
}

/**
 * A work record shown in a card: its title, the text badges that state its
 * status and priority (or kind and state) and the rest of its detail, escaped.
 */
export interface WorkEntry {
  readonly id: string;
  readonly title: string;
  /** The badges shown beside the title, in a fixed order. */
  readonly badges: readonly string[];
  /** The plain detail text, escaped when shown. */
  readonly detail: string;
  /** The detail's own text badges, after the entry's badges. */
  readonly detailBadges?: readonly string[];
}

/**
 * Render a list of work records as cards. Every card links to its detail page
 * and, separately, offers its edit workflow, so a closed or completed record is
 * just as reachable as an open one. The title, badges and detail are escaped.
 */
export function workList(base: "/tasks" | "/items", entries: readonly WorkEntry[]): string {
  if (entries.length === 0) return "<p>None yet.</p>";
  return `<ul class="card-list">${entries
    .map((entry) => {
      const href = `${base}/${encodeURIComponent(entry.id)}`;
      const badges = entry.badges.map(badge).join(" ");
      const detailBadges = (entry.detailBadges ?? []).map((text) => ` ${badge(text)}`).join("");
      const detail = entry.detail === "" ? "" : ` <span class="detail">${escapeHtml(entry.detail)}</span>`;
      return `<li class="card">${link(href, entry.title)} ${badges}${detailBadges}${detail} ${link(`${href}/edit`, "Edit")}</li>`;
    })
    .join("")}</ul>`;
}

/** The plain detail text of a task: owner and due date, when present. */
export function describeTask(task: Task): string {
  const parts: string[] = [];
  if (task.owner.trim() !== "") parts.push(`owner ${task.owner}`);
  if (task.dueDate !== undefined) parts.push(`due ${task.dueDate}`);
  return parts.join(", ");
}

/** The text badges of a task: its status and its priority. */
export function taskBadges(task: Task): readonly string[] {
  return [task.status, task.priority];
}

/** The plain detail text of a work item: none beyond its kind and state badges. */
export function describeItem(item: WorkItem): string {
  return "";
}

/** The text badges of a work item: its kind and its state. */
export function itemBadges(item: WorkItem): readonly string[] {
  return [item.kind, item.state];
}

/** One row of a tally. */
export interface CountRow {
  readonly label: string;
  readonly count: number;
}

/** Render a tally as a list; a zero count is shown, not hidden. */
export function countList(rows: readonly CountRow[]): string {
  return `<ul>${rows
    .map((row) => `<li>${escapeHtml(row.label)}: ${escapeHtml(String(row.count))}</li>`)
    .join("")}</ul>`;
}

/** A work selection: one engagement, or one project inside it. */
type WorkScope =
  | { readonly engagementId: string }
  | { readonly engagementId: string; readonly projectId: string };

/**
 * Task counts by status for the selected engagement or project. Each scope is
 * selected explicitly through the store's filter, so a sibling's records are
 * never folded into another's tally. A task is in exactly one scope (its
 * engagement, or a project of it), so the counts of the engagement's
 * engagement-only work and of each project add up without counting a task
 * twice.
 */
export function taskStatusCounts(
  store: Store,
  clientId: string,
  scope: WorkScope,
): readonly CountRow[] {
  const snapshot = store.snapshot();
  // Effectively archived tasks are hidden from the tally, exactly as they are
  // hidden from the lists beside it, so the counts and the lists agree.
  const tasks = store
    .listTasks({ clientId, ...scope })
    .filter((task) => !isEffectivelyArchived(snapshot, task));
  return TASK_STATUSES.map((status) => ({
    label: status,
    count: tasks.filter((task) => task.status === status).length,
  }));
}

/** Open work-item counts for the selected engagement or project. */
export function openItemCount(
  store: Store,
  clientId: string,
  scope: WorkScope,
): number {
  const snapshot = store.snapshot();
  return store
    .listItems({ clientId, ...scope })
    .filter((item) => item.state === "open" && !isEffectivelyArchived(snapshot, item)).length;
}

/** The tasks and items that belong to an engagement but to no project. */
export function engagementOnlyWork(
  store: Store,
  clientId: string,
  engagementId: string,
): { readonly tasks: readonly Task[]; readonly items: readonly WorkItem[] } {
  const snapshot = store.snapshot();
  const tasks = store
    .listTasks({ clientId, engagementId })
    .filter((task) => task.projectId === undefined && !isEffectivelyArchived(snapshot, task));
  const items = store
    .listItems({ clientId, engagementId })
    .filter((item) => item.projectId === undefined && !isEffectivelyArchived(snapshot, item));
  return { tasks, items };
}

/** The tasks and items of one project. */
export function projectWork(
  store: Store,
  clientId: string,
  engagementId: string,
  projectId: string,
): { readonly tasks: readonly Task[]; readonly items: readonly WorkItem[] } {
  const snapshot = store.snapshot();
  return {
    tasks: store
      .listTasks({ clientId, engagementId, projectId })
      .filter((task) => !isEffectivelyArchived(snapshot, task)),
    items: store
      .listItems({ clientId, engagementId, projectId })
      .filter((item) => !isEffectivelyArchived(snapshot, item)),
  };
}

/** The card entries for a set of tasks. */
export function taskEntries(tasks: readonly Task[]): readonly WorkEntry[] {
  return tasks.map((task) => ({
    id: task.id,
    title: task.title,
    badges: taskBadges(task),
    detail: describeTask(task),
  }));
}

/** The card entries for a set of work items. */
export function itemEntries(items: readonly WorkItem[]): readonly WorkEntry[] {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    badges: itemBadges(item),
    detail: describeItem(item),
  }));
}

/** One linked work section: a heading, a creation link and the list. */
export function workSection(
  title: string,
  base: "/tasks" | "/items",
  newHref: string,
  entries: readonly WorkEntry[],
): PageSection {
  return {
    title,
    body: [
      `<p>${link(newHref, base === "/tasks" ? "New task" : "New item")}</p>`,
      workList(base, entries),
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Form controls and values
// ---------------------------------------------------------------------------

const STATUS_OPTIONS = TASK_STATUSES.map((status) => ({ value: status, label: status }));
const PRIORITY_OPTIONS = TASK_PRIORITIES.map((priority) => ({ value: priority, label: priority }));
const KIND_OPTIONS = ITEM_KINDS.map((kind) => ({ value: kind, label: kind }));
const STATE_OPTIONS = ITEM_STATES.map((state) => ({ value: state, label: state }));

// The presentation metadata that makes status, state, priority and kind
// values show as text badges on a record page or in a list.
const BADGE: FieldPresentation = Object.freeze({ badge: true });

/**
 * The optional no-project choice, offered first so it is the default, and every
 * project of the engagement. A project that is effectively archived stays
 * offered but is labelled as archived, so an existing link can be kept or
 * chosen rather than silently dropped; the label is text, escaped on render.
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

const TASK_FIELDS: readonly FieldSpec[] = [
  { name: "title", label: "Title", required: true },
  { name: "status", label: "Status", type: "select", options: STATUS_OPTIONS, presentation: BADGE },
  { name: "priority", label: "Priority", type: "select", options: PRIORITY_OPTIONS, presentation: BADGE },
  { name: "owner", label: "Owner" },
  { name: "dueDate", label: "Due date", type: "date" },
  { name: "context", label: "Context", type: "textarea" },
];

const ITEM_FIELDS: readonly FieldSpec[] = [
  { name: "kind", label: "Kind", type: "select", options: KIND_OPTIONS, presentation: BADGE },
  { name: "title", label: "Title", required: true },
  { name: "context", label: "Context", type: "textarea" },
  { name: "state", label: "State", type: "select", options: STATE_OPTIONS, presentation: BADGE },
];

const TASK_PROFILE_FIELDS: readonly FieldSpec[] = [
  { name: "title", label: "Title" },
  { name: "status", label: "Status", presentation: BADGE },
  { name: "priority", label: "Priority", presentation: BADGE },
  { name: "owner", label: "Owner" },
  { name: "dueDate", label: "Due date" },
  { name: "context", label: "Context" },
];

const ITEM_PROFILE_FIELDS: readonly FieldSpec[] = [
  { name: "kind", label: "Kind", presentation: BADGE },
  { name: "title", label: "Title" },
  { name: "context", label: "Context" },
  { name: "state", label: "State", presentation: BADGE },
];

/** The form values of a stored task, plus the id its edit posts back. */
function taskFormValues(task: Task): Record<string, string> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    owner: task.owner,
    dueDate: task.dueDate ?? "",
    context: task.context,
    projectId: task.projectId ?? "",
  };
}

/** The form values of a stored work item, plus the id its edit posts back. */
function itemFormValues(item: WorkItem): Record<string, string> {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    context: item.context,
    state: item.state,
    projectId: item.projectId ?? "",
  };
}

/**
 * The controls of a task form: the record id and parent engagement (hidden,
 * server-chosen, so a corrected resubmission names the same record and parent),
 * the base fields and the project select. The optional `clientId` control is
 * hidden too; it is only added for an edit, whose submitted client is checked
 * against the stored record.
 */
function taskFields(
  projects: readonly Project[],
  snapshot: Snapshot,
  id = "",
  engagementId = "",
  clientId?: string,
): readonly FieldSpec[] {
  return [
    { name: "id", label: "Id", hidden: true, value: id },
    { name: "engagementId", label: "Engagement", hidden: true, value: engagementId },
    ...(clientId === undefined
      ? []
      : [{ name: "clientId", label: "Client", hidden: true, value: clientId }]),
    ...TASK_FIELDS,
    { name: "projectId", label: "Project", type: "select", options: projectOptions(projects, snapshot) },
  ];
}

function itemFields(
  projects: readonly Project[],
  snapshot: Snapshot,
  id = "",
  engagementId = "",
  clientId?: string,
): readonly FieldSpec[] {
  return [
    { name: "id", label: "Id", hidden: true, value: id },
    { name: "engagementId", label: "Engagement", hidden: true, value: engagementId },
    ...(clientId === undefined
      ? []
      : [{ name: "clientId", label: "Client", hidden: true, value: clientId }]),
    ...ITEM_FIELDS,
    { name: "projectId", label: "Project", type: "select", options: projectOptions(projects, snapshot) },
  ];
}

/** Initial values for a create form: selects at their first choice. */
function createTaskValues(): Record<string, string> {
  return {
    title: "",
    status: TASK_STATUSES[0],
    priority: TASK_PRIORITIES[1],
    owner: "",
    dueDate: "",
    context: "",
    projectId: "",
  };
}

function createItemValues(): Record<string, string> {
  return {
    kind: ITEM_KINDS[0],
    title: "",
    context: "",
    state: ITEM_STATES[0],
    projectId: "",
  };
}

/**
 * The values a work form actually supplied, for a correction form or for the
 * store. The parent links are never taken from the form. An edit changes only
 * the fields it was given and keeps the others. The project select always has
 * a value (empty for no project): on an edit an empty value clears the link,
 * and on a create it is an absent link.
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

/** The store's task edit for the supplied values; a blank project clears it. */
function taskEdit(values: Readonly<Record<string, string>>, create: boolean): TaskEdit {
  const edit: TaskEdit = {};
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

/** The store's work-item edit for the supplied values. */
function itemEdit(values: Readonly<Record<string, string>>, create: boolean): WorkItemEdit {
  const edit: WorkItemEdit = {};
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
 * The controls of a form the submission omitted: the record's current value
 * when the edit has a record, otherwise the control's own initial value (a
 * create's select starts at its first choice). This is the value the rendered
 * form shows for an omitted control, so a supplied value is compared fairly
 * with it.
 */
function omittedControlValue(field: FieldSpec, record: object): string | undefined {
  const stored = record as Readonly<Record<string, unknown>>;
  const value = stored[field.name];
  if (typeof value === "string") return value;
  if (field.value !== undefined) return field.value;
  if (field.type === "select") return field.options?.[0]?.value ?? "";
  return undefined;
}

/**
 * Build a correctable form error from a refusal. The submitted values are kept
 * exactly as posted; every control the submission omitted is filled from the
 * stored record, so a corrected form carries the current record rather than
 * blank controls and an edit never blanks what it did not touch. A hidden
 * control keeps the server-chosen value. The refusal's message names the form's
 * problems in the summary and, for every visible control it names, associates
 * the message with that control.
 *
 * A validation refusal and a missing record named by the submission (a
 * nonexistent project selected on the form) are both problems the user can
 * correct, so both become form errors. A missing URL parent or edit target is
 * resolved before the write and never reaches here.
 *
 * `selected` is the project the submission chose on the form, when it chose
 * one. A refusal about that visible choice (an unknown project, on a create or
 * an edit) is associated with the project select; a refusal about the parent
 * chain or identity links names no visible control and stays in the summary.
 *
 * A create form always checks its submitted project itself: an unknown project
 * is refused with a message about `projectId`, associated with the project
 * select. An edit form's save goes to the store, which refuses a project that
 * does not exist with a missing-record message (`No project with id "..."`)
 * naming no control of its own; the presentation boundary associates such an
 * unknown project with the project select, as on the create path. A parent-chain
 * refusal (which needs a submitted parent link) names the hidden engagement
 * link and stays in the summary alone, and an existing identity conflict keeps
 * its precedence in the summary.
 */
function formFailure(
  error: unknown,
  values: Readonly<Record<string, string>>,
  fields: readonly FieldSpec[],
  action: string,
  record?: Readonly<Record<string, string>>,
  selected?: string,
): FormError | null {
  if (!(error instanceof ValidationError) && !(error instanceof MissingRecordError)) {
    return null;
  }
  const base = record ?? {};
  const filled: Record<string, string> = {};
  for (const field of fields) {
    // A hidden control keeps the server-chosen value; a visible one shows the
    // submitted value, else the stored value (or the control's initial value
    // for a create), else nothing.
    if (field.hidden) {
      filled[field.name] = field.value ?? "";
    } else if (Object.hasOwn(values, field.name)) {
      filled[field.name] = values[field.name];
    } else {
      filled[field.name] = omittedControlValue(field, base) ?? "";
    }
  }
  const errors = fieldErrorsFor(error.message, filled, fields, associateSelected(selected));
  return new FormError(error.message, filled, errors, fields, action);
}

/**
 * The project control a refusal may be associated with on either work form
 * path: the project select by its field identity, with the value the
 * submission gave it, when it gave one. `fieldErrorsFor` then associates the
 * refusal with that select only if the message quotes exactly that value and
 * names no hidden link, so an unknown project (on a create or an edit) points
 * at the select while a parent-chain or identity refusal stays in the summary
 * alone.
 */
function associateSelected(selected: string | undefined): { field: string; value: string } | undefined {
  if (selected === undefined || selected === "") return undefined;
  return { field: "projectId", value: selected };
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

/** The breadcrumb links for a work record, with its project when it has one. */
function workBreadcrumbs(
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

/** Build the work routes for a store. */
export function workRoutes(store: Store): WorkRoutes {
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
   * The parent a creation POST names: the client and engagement derived from
   * the URL alone, never from the submitted form. The URL parent is
   * authoritative; a supplied parent id that differs from it, a blank one
   * included, is a refused submission and is reported as a correctable error
   * before any write or any submitted-project lookup. An omitted or matching
   * parent id is valid and the URL parent decides. This resolves only the
   * parent; the optional selected project is resolved separately, inside the
   * correction boundary, so an unknown or cross-engagement project becomes a
   * correctable form error. A nonexistent URL parent (or URL project) is a
   * missing record and stays a 404.
   */
  function postedParent(
    snap: Snapshot,
    path: string,
    form: Readonly<Record<string, string>>,
  ): {
    readonly scope: CreateScope;
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
      // is the parent only; it does not preselect the submitted project.
      const projectId = decodeId(parts[1] ?? "", "project");
      const scope = projectScope(snap, projectId);
      return {
        scope: { client: scope.client, engagement: scope.engagement },
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
   * and so is a present blank value (the client and engagement are never
   * chosen by a blank parent) or a submitted client id that names a different
   * client. The URL parent stays authoritative either way. The problem is
   * reported as invalid input on the correction form.
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

  /**
   * The action a creation POST writes to: the parent engagement's new endpoint.
   * A project form posts to that endpoint too, with the engagement as parent.
   */
  function createAction(scope: CreateScope, family: "tasks" | "items"): string {
    return `/engagements/${encodeURIComponent(scope.engagement.id)}/${family}/new`;
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
    return { ...scope, project };
  }

  function newPage(
    title: string,
    action: string,
    fields: readonly FieldSpec[],
    values: Readonly<Record<string, string>>,
    cancelHref: string,
    notice = "",
  ): Page {
    return renderPage(
      title,
      [
        `<nav>${link("/", "Home")}${link(cancelHref, "Cancel")}</nav>`,
        notice,
        renderForm({ action, fields, values, submitLabel: "Create" }),
      ].join("\n"),
    );
  }

  /**
   * The controls and initial values of a creation form. A form opened under a
   * project preselects that project; the form posts to the engagement's new
   * endpoint with the engagement id as its hidden parent.
   */
  function createForm(
    title: string,
    snap: Snapshot,
    scope: CreateScope,
    base: "tasks" | "items",
  ): Page {
    const all = base === "tasks"
      ? taskFields(projectChoices(snap, scope.engagement.id), snap, "", scope.engagement.id)
      : itemFields(projectChoices(snap, scope.engagement.id), snap, "", scope.engagement.id);
    const fields: readonly FieldSpec[] = all.filter((field) => field.name !== "id");
    const values = base === "tasks" ? createTaskValues() : createItemValues();
    if (scope.project !== undefined) values.projectId = scope.project.id;
    const cancelHref = scope.project !== undefined
      ? `/projects/${encodeURIComponent(scope.project.id)}`
      : `/engagements/${encodeURIComponent(scope.engagement.id)}`;
    // A creation form under an archived scope stays usable; the notice names
    // the archived parent so the user knows the new record inherits its hiding.
    const hiddenParent = scope.project !== undefined
      ? archiveNotice(snap, scope.project)
      : archiveNotice(snap, scope.engagement);
    return newPage(title, createAction(scope, base), fields, values, cancelHref, hiddenParent);
  }

  /**
   * The controls of a create refusal: the URL parent as the hidden, fixed
   * engagement id and the submitted values. The hidden controls are filled
   * from their fixed values, never from the submission, so a corrected
   * resubmission names the same URL parent.
   */
  function createFields(snap: Snapshot, scope: CreateScope, base: "tasks" | "items"): readonly FieldSpec[] {
    const all = base === "tasks"
      ? taskFields(projectChoices(snap, scope.engagement.id), snap, "", scope.engagement.id)
      : itemFields(projectChoices(snap, scope.engagement.id), snap, "", scope.engagement.id);
    return all.filter((field) => field.name !== "id");
  }

  async function createTask(request: WorkRequest): Promise<WorkPage> {
    const snap = snapshot();
    // The URL parent is resolved first and stays a 404 when it is missing.
    const { scope, parent, conflict } = postedParent(snap, request.path, request.form);
    const action = createAction(scope, "tasks");
    const fields = createFields(snap, scope, "tasks");
    const values = suppliedValues(request.form, fields);
    try {
      // A supplied parent that differs from the URL parent is settled before any
      // submitted project is read, so a tampered request is refused without
      // resolving it and nothing is written.
      if (conflict !== null) throw conflict;
      // The optional selected project is resolved inside the boundary: an
      // unknown project is a correctable error, a blank one creates
      // engagement-only work.
      const selected = withSelectedProject(snap, scope, text(request.form, "projectId"));
      const input = {
        ...taskEdit(values, true),
        clientId: scope.client.id,
        engagementId: scope.engagement.id,
      };
      if (selected.project !== undefined) input.projectId = selected.project.id;
      const task = await store.createTask(input as TaskCreate);
      return redirect(`/tasks/${encodeURIComponent(task.id)}`);
    } catch (error) {
      const failure = formFailure(error, values, fields, action, undefined, values["projectId"]);
      if (failure !== null) throw failure;
      throw error;
    }
  }

  async function createItem(request: WorkRequest): Promise<WorkPage> {
    const snap = snapshot();
    // The URL parent is resolved first and stays a 404 when it is missing.
    const { scope, parent, conflict } = postedParent(snap, request.path, request.form);
    const action = createAction(scope, "items");
    const fields = createFields(snap, scope, "items");
    const values = suppliedValues(request.form, fields);
    try {
      // A supplied parent that differs from the URL parent is settled before any
      // submitted project is read, so a tampered request is refused without
      // resolving it and nothing is written.
      if (conflict !== null) throw conflict;
      // The optional selected project is resolved inside the boundary: an
      // unknown project is a correctable error, a blank one creates
      // engagement-only work.
      const selected = withSelectedProject(snap, scope, text(request.form, "projectId"));
      const input = {
        ...itemEdit(values, true),
        clientId: scope.client.id,
        engagementId: scope.engagement.id,
      };
      if (selected.project !== undefined) input.projectId = selected.project.id;
      const item = await store.createItem(input as WorkItemCreate);
      return redirect(`/items/${encodeURIComponent(item.id)}`);
    } catch (error) {
      const failure = formFailure(error, values, fields, action, undefined, values["projectId"]);
      if (failure !== null) throw failure;
      throw error;
    }
  }

  /** The stored record an edit names, and its immutable parents. */
  function editTarget(
    request: WorkRequest,
    family: "tasks" | "items",
  ): {
    readonly snap: Snapshot;
    readonly record: Task | WorkItem;
    readonly engagement: Engagement;
    readonly fields: readonly FieldSpec[];
    readonly action: string;
    readonly conflict: ValidationError | null;
    readonly id: string;
  } {
    const snap = snapshot();
    const id = decodeId(idFromPath(request.path), family === "tasks" ? "task" : "item");
    const record =
      family === "tasks"
        ? findRecord(snap.tasks, id, "task")
        : findRecord(snap.items, id, "item");
    const engagement = findRecord(snap.engagements, record.engagementId, "engagement");
    const client = findRecord(snap.clients, engagement.clientId, "client");
    const fields = family === "tasks"
      ? taskFields(projectChoices(snap, engagement.id), snap, id, engagement.id, client.id)
      : itemFields(projectChoices(snap, engagement.id), snap, id, engagement.id, client.id);
    // An existing identity conflict takes precedence: a submitted id that
    // differs from the URL record is refused before any parent is compared.
    const submitted = request.form["id"];
    let conflict: ValidationError | null =
      submitted !== undefined && submitted !== "" && submitted !== record.id
        ? new ValidationError(`The submitted ${family === "tasks" ? "task" : "item"} id does not match this URL`)
        : null;
    if (conflict === null) {
      // The record's own parents are immutable, so a supplied client or
      // engagement id that differs from them (a blank one included) is refused
      // before the store sees the edit; the rest of the submission is not
      // saved.
      const scope = { client, engagement };
      conflict = submittedParentConflict(request.form, scope);
    }
    return {
      snap,
      record,
      engagement,
      fields,
      action: `/${family}/${encodeURIComponent(record.id)}/edit`,
      id: record.id,
      conflict,
    };
  }

  async function updateTask(request: WorkRequest): Promise<WorkPage> {
    const target = editTarget(request, "tasks");
    const task = target.record as Task;
    const values = suppliedValues(request.form, target.fields);
    const stored = taskFormValues(task);
    try {
      if (target.conflict !== null) throw target.conflict;
      await store.updateTask(task.id, taskEdit(values, false));
      return redirect(`/tasks/${encodeURIComponent(task.id)}`);
    } catch (error) {
      const failure = formFailure(error, values, target.fields, target.action, stored, values["projectId"]);
      if (failure !== null) throw failure;
      throw error;
    }
  }

  async function updateItem(request: WorkRequest): Promise<WorkPage> {
    const target = editTarget(request, "items");
    const item = target.record as WorkItem;
    const values = suppliedValues(request.form, target.fields);
    const stored = itemFormValues(item);
    try {
      if (target.conflict !== null) throw target.conflict;
      await store.updateItem(item.id, itemEdit(values, false));
      return redirect(`/items/${encodeURIComponent(item.id)}`);
    } catch (error) {
      const failure = formFailure(error, values, target.fields, target.action, stored, values["projectId"]);
      if (failure !== null) throw failure;
      throw error;
    }
  }

  /** Edit a task: the GET form starts from the stored record, the POST saves. */
  function editTaskForm(request: WorkRequest): Page {
    const target = editTarget(request, "tasks");
    const task = target.record as Task;
    const engagement = target.engagement;
    const client = findRecord(target.snap.clients, engagement.clientId, "client");
    return renderPage(
      "Edit task",
      [
        `<nav>${link("/", "Home")}${link(`/tasks/${encodeURIComponent(task.id)}`, "Cancel")}</nav>`,
        archiveNotice(snapshot(), task, { family: "tasks" }),
        renderForm({
          action: target.action,
          fields: target.fields,
          values: taskFormValues(task),
          submitLabel: "Save",
        }),
        `<p>${link(`/clients/${encodeURIComponent(client.id)}`, client.name)} · ${link(`/engagements/${encodeURIComponent(engagement.id)}`, engagement.name)}</p>`,
      ].join("\n"),
    );
  }

  function editItemForm(request: WorkRequest): Page {
    const target = editTarget(request, "items");
    const item = target.record as WorkItem;
    const engagement = target.engagement;
    const client = findRecord(target.snap.clients, engagement.clientId, "client");
    return renderPage(
      "Edit work item",
      [
        `<nav>${link("/", "Home")}${link(`/items/${encodeURIComponent(item.id)}`, "Cancel")}</nav>`,
        archiveNotice(snapshot(), item, { family: "items" }),
        renderForm({
          action: target.action,
          fields: target.fields,
          values: itemFormValues(item),
          submitLabel: "Save",
        }),
        `<p>${link(`/clients/${encodeURIComponent(client.id)}`, client.name)} · ${link(`/engagements/${encodeURIComponent(engagement.id)}`, engagement.name)}</p>`,
      ].join("\n"),
    );
  }

  function showTask(request: WorkRequest): Page {
    const snap = snapshot();
    const id = decodeId(idFromPath(request.path), "task");
    const task = findRecord(snap.tasks, id, "task");
    const engagement = findRecord(snap.engagements, task.engagementId, "engagement");
    const client = findRecord(snap.clients, engagement.clientId, "client");
    const project =
      task.projectId === undefined
        ? undefined
        : findRecord(snap.projects, task.projectId, "project");
    const profile: Record<string, string> = {
      title: task.title,
      status: task.status,
      priority: task.priority,
      owner: task.owner,
      dueDate: task.dueDate ?? "",
      context: task.context,
    };
    return pageWith(
      task.title,
      [
        ...workBreadcrumbs(client, engagement, task.projectId, snap),
        { label: "Edit task", href: `/tasks/${encodeURIComponent(task.id)}/edit` },
      ],
      [
        {
          title: "Archive",
          body: [archiveNotice(snap, task, { family: "tasks" }), archiveControl("tasks", task.id, task.archived === true)].join("\n"),
        },
        {
          title: "Task",
          body: displayList(displayValues(TASK_PROFILE_FIELDS, profile)),
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

  function showItem(request: WorkRequest): Page {
    const snap = snapshot();
    const id = decodeId(idFromPath(request.path), "item");
    const item = findRecord(snap.items, id, "item");
    const engagement = findRecord(snap.engagements, item.engagementId, "engagement");
    const client = findRecord(snap.clients, engagement.clientId, "client");
    const project =
      item.projectId === undefined
        ? undefined
        : findRecord(snap.projects, item.projectId, "project");
    const profile: Record<string, string> = {
      kind: item.kind,
      title: item.title,
      context: item.context,
      state: item.state,
    };
    return pageWith(
      item.title,
      [
        ...workBreadcrumbs(client, engagement, item.projectId, snap),
        { label: "Edit item", href: `/items/${encodeURIComponent(item.id)}/edit` },
      ],
      [
        {
          title: "Archive",
          body: [archiveNotice(snap, item, { family: "items" }), archiveControl("items", item.id, item.archived === true)].join("\n"),
        },
        {
          title: "Work item",
          body: displayList(displayValues(ITEM_PROFILE_FIELDS, profile)),
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
    tasksRecord: {
      get: { method: "GET", render: (request) => showTask(request) },
    },
    tasksEdit: {
      get: { method: "GET", render: (request) => editTaskForm(request) },
      post: {
        method: "POST",
        async render(request) {
          // A refused write throws a FormError, which the shell renders as a
          // correctable 400 page with the submitted values kept.
          return await updateTask(request);
        },
      },
    },
    tasksNew: {
      get: {
        method: "GET",
        render: (request) => {
          const snap = snapshot();
          const parts = request.path.split("?")[0].split("/").slice(1);
          const scope =
            parts[0] === "engagements"
              ? engagementScope(snap, decodeId(parts[1] ?? "", "engagement"))
              : projectScope(snap, decodeId(parts[1] ?? "", "project"));
          return createForm("New task", snap, scope, "tasks");
        },
      },
      post: {
        method: "POST",
        async render(request) {
          return await createTask(request);
        },
      },
    },
    itemsRecord: {
      get: { method: "GET", render: (request) => showItem(request) },
    },
    itemsEdit: {
      get: { method: "GET", render: (request) => editItemForm(request) },
      post: {
        method: "POST",
        async render(request) {
          return await updateItem(request);
        },
      },
    },
    itemsNew: {
      get: {
        method: "GET",
        render: (request) => {
          const snap = snapshot();
          const parts = request.path.split("?")[0].split("/").slice(1);
          const scope =
            parts[0] === "engagements"
              ? engagementScope(snap, decodeId(parts[1] ?? "", "engagement"))
              : projectScope(snap, decodeId(parts[1] ?? "", "project"));
          return createForm("New work item", snap, scope, "items");
        },
      },
      post: {
        method: "POST",
        async render(request) {
          return await createItem(request);
        },
      },
    },
  };
}

