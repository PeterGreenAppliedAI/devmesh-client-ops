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
  FormError,
  redirect,
  renderForm,
  renderPage,
  type FieldSpec,
  type Page,
  type Redirect,
} from "./html.ts";
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

/** One page section: a heading and a body, so sections can be composed. */
export interface PageSection {
  readonly title: string;
  readonly body: string;
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

/** Render every profile field of a record, escaped. */
export function profileFields(fields: readonly FieldSpec[], record: object): string {
  const values = record as Readonly<Record<string, string | undefined>>;
  const rows = fields.map(
    (field) => `<dt>${escapeHtml(field.label)}</dt><dd>${showValue(values[field.name] ?? "")}</dd>`,
  );
  return `<dl>${rows.join("")}</dl>`;
}

/** One linked list entry: where it links and what it says. */
export interface ListEntry {
  readonly href: string;
  readonly label: string;
  readonly note?: string;
}

/** Render a list of links, or a sentence when there are none. */
export function childList(items: readonly ListEntry[]): string {
  if (items.length === 0) return "<p>None yet.</p>";
  return `<ul>${items
    .map(
      (item) =>
        `<li>${link(item.href, item.label)}${item.note === undefined ? "" : ` (${escapeHtml(item.note)})`}</li>`,
    )
    .join("")}</ul>`;
}

/** A work record shown in a list: its title, its state and where it links. */
export interface WorkEntry {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
}

/**
 * Render a list of work records. Every entry links to its detail page and,
 * separately, offers its edit workflow, so a closed or completed record is
 * just as reachable as an open one.
 */
export function workList(base: "/tasks" | "/items", entries: readonly WorkEntry[]): string {
  if (entries.length === 0) return "<p>None yet.</p>";
  return `<ul>${entries
    .map((entry) => {
      const href = `${base}/${encodeURIComponent(entry.id)}`;
      return `<li>${link(href, entry.title)} (${escapeHtml(entry.detail)}) ${link(`${href}/edit`, "Edit")}</li>`;
    })
    .join("")}</ul>`;
}

/** The detail text of a task: status, priority, owner and due date. */
export function describeTask(task: Task): string {
  const parts = [`status ${task.status}`, `priority ${task.priority}`];
  if (task.owner.trim() !== "") parts.push(`owner ${task.owner}`);
  if (task.dueDate !== undefined) parts.push(`due ${task.dueDate}`);
  return parts.join(", ");
}

/** The detail text of a work item: kind and state. */
export function describeItem(item: WorkItem): string {
  return `kind ${item.kind}, ${item.state}`;
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
  return TASK_STATUSES.map((status) => ({
    label: status,
    count: store
      .listTasks({ clientId, ...scope })
      .filter((task) => task.status === status).length,
  }));
}

/** Open work-item counts for the selected engagement or project. */
export function openItemCount(
  store: Store,
  clientId: string,
  scope: WorkScope,
): number {
  return store
    .listItems({ clientId, ...scope })
    .filter((item) => item.state === "open").length;
}

/** The tasks and items that belong to an engagement but to no project. */
export function engagementOnlyWork(
  store: Store,
  clientId: string,
  engagementId: string,
): { readonly tasks: readonly Task[]; readonly items: readonly WorkItem[] } {
  const tasks = store
    .listTasks({ clientId, engagementId })
    .filter((task) => task.projectId === undefined);
  const items = store
    .listItems({ clientId, engagementId })
    .filter((item) => item.projectId === undefined);
  return { tasks, items };
}

/** The tasks and items of one project. */
export function projectWork(
  store: Store,
  clientId: string,
  engagementId: string,
  projectId: string,
): { readonly tasks: readonly Task[]; readonly items: readonly WorkItem[] } {
  return {
    tasks: store.listTasks({ clientId, engagementId, projectId }),
    items: store.listItems({ clientId, engagementId, projectId }),
  };
}

/** The linked list entries for a set of tasks. */
export function taskEntries(tasks: readonly Task[]): readonly ListEntry[] {
  return tasks.map((task) => ({
    href: `/tasks/${encodeURIComponent(task.id)}`,
    label: task.title,
    note: describeTask(task),
  }));
}

/** The linked list entries for a set of work items. */
export function itemEntries(items: readonly WorkItem[]): readonly ListEntry[] {
  return items.map((item) => ({
    href: `/items/${encodeURIComponent(item.id)}`,
    label: item.title,
    note: describeItem(item),
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

/** The optional no-project choice, offered first so it is the default. */
function projectOptions(
  projects: readonly Project[],
): readonly { readonly value: string; readonly label: string }[] {
  return [
    { value: "", label: "(no project)" },
    ...projects.map((project) => ({ value: project.id, label: project.name })),
  ];
}

const TASK_FIELDS: readonly FieldSpec[] = [
  { name: "title", label: "Title", required: true },
  { name: "status", label: "Status", type: "select", options: STATUS_OPTIONS },
  { name: "priority", label: "Priority", type: "select", options: PRIORITY_OPTIONS },
  { name: "owner", label: "Owner" },
  { name: "dueDate", label: "Due date", type: "date" },
  { name: "context", label: "Context", type: "textarea" },
];

const ITEM_FIELDS: readonly FieldSpec[] = [
  { name: "kind", label: "Kind", type: "select", options: KIND_OPTIONS },
  { name: "title", label: "Title", required: true },
  { name: "context", label: "Context", type: "textarea" },
  { name: "state", label: "State", type: "select", options: STATE_OPTIONS },
];

const TASK_PROFILE_FIELDS: readonly FieldSpec[] = [
  { name: "title", label: "Title" },
  { name: "status", label: "Status" },
  { name: "priority", label: "Priority" },
  { name: "owner", label: "Owner" },
  { name: "dueDate", label: "Due date" },
  { name: "context", label: "Context" },
];

const ITEM_PROFILE_FIELDS: readonly FieldSpec[] = [
  { name: "kind", label: "Kind" },
  { name: "title", label: "Title" },
  { name: "context", label: "Context" },
  { name: "state", label: "State" },
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

/** The controls of a task form: the base fields, the project select, the id. */
function taskFields(projects: readonly Project[], id = ""): readonly FieldSpec[] {
  return [
    { name: "id", label: "Id", hidden: true, value: id },
    ...TASK_FIELDS,
    { name: "projectId", label: "Project", type: "select", options: projectOptions(projects) },
  ];
}

function itemFields(projects: readonly Project[], id = ""): readonly FieldSpec[] {
  return [
    { name: "id", label: "Id", hidden: true, value: id },
    ...ITEM_FIELDS,
    { name: "projectId", label: "Project", type: "select", options: projectOptions(projects) },
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
 * Build a correctable form error from a store refusal. The submitted values are
 * kept exactly as posted; every control the submission omitted is filled from
 * the stored record, so a corrected form carries the current record rather than
 * blank controls and an edit never blanks what it did not touch. A hidden
 * control keeps its server-chosen value.
 *
 * A validation refusal and a missing record named by the submission (a
 * nonexistent project selected on the form) are both problems the user can
 * correct, so both become form errors. A missing URL parent or edit target is
 * resolved before the write and never reaches here.
 */
function formFailure(
  error: unknown,
  values: Readonly<Record<string, string>>,
  fields: readonly FieldSpec[],
  action: string,
  record?: Readonly<Record<string, string>>,
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
  return new FormError(error.message, filled, [], fields, action);
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

  /** The scope a creation POST selects: a parent in the path, or a hidden parent. */
  function postedScope(
    snap: Snapshot,
    path: string,
    form: Readonly<Record<string, string>>,
  ): { readonly scope: CreateScope; readonly parent: { name: string; id: string } } {
    const pathname = path.split("?")[0];
    const parts = pathname.split("/").slice(1);
    if (parts[0] === "engagements") {
      const engagementId = decodeId(parts[1] ?? "", "engagement");
      return {
        scope: engagementScope(snap, engagementId),
        parent: { name: "engagementId", id: engagementId },
      };
    }
    if (parts[0] === "projects") {
      // The project is the parent the path names: it is resolved from the URL,
      // never from the submitted form, so a tampered parent id is ignored. The
      // project form posts to the engagement's new endpoint, with the
      // engagement derived from the URL project as its parent. A project
      // selected by the submission must be one of that engagement's projects.
      const projectId = decodeId(parts[1] ?? "", "project");
      const scope = projectScope(snap, projectId);
      return {
        scope: withSelectedProject(snap, scope, text(form, "projectId")),
        parent: { name: "engagementId", id: scope.engagement.id },
      };
    }
    throw new MissingRecordError("No parent for that path");
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
    const project = findRecord(snap.projects, projectId, "project");
    return { ...scope, project };
  }

  function newPage(
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
      ? taskFields(projectChoices(snap, scope.engagement.id))
      : itemFields(projectChoices(snap, scope.engagement.id));
    const fields: readonly FieldSpec[] = [
      { name: "engagementId", label: "Engagement", hidden: true, value: scope.engagement.id },
      ...all.filter((field) => field.name !== "id"),
    ];
    const values = base === "tasks" ? createTaskValues() : createItemValues();
    if (scope.project !== undefined) values.projectId = scope.project.id;
    const cancelHref = scope.project !== undefined
      ? `/projects/${encodeURIComponent(scope.project.id)}`
      : `/engagements/${encodeURIComponent(scope.engagement.id)}`;
    return newPage(title, createAction(scope, base), fields, values, cancelHref);
  }

  async function createTask(request: WorkRequest): Promise<WorkPage> {
    const snap = snapshot();
    const { scope, parent } = postedScope(snap, request.path, request.form);
    const action = createAction(scope, "tasks");
    const fields: readonly FieldSpec[] = [
      { name: parent.name, label: parent.name, hidden: true, value: parent.id },
      ...taskFields(projectChoices(snap, scope.engagement.id)).filter((field) => field.name !== "id"),
    ];
    const values = suppliedValues(request.form, fields);
    const input = {
      ...taskEdit(values, true),
      clientId: scope.client.id,
      engagementId: scope.engagement.id,
    };
    if (scope.project !== undefined) input.projectId = scope.project.id;
    try {
      const task = await store.createTask(input as TaskCreate);
      return redirect(`/tasks/${encodeURIComponent(task.id)}`);
    } catch (error) {
      const failure = formFailure(error, values, fields, action);
      if (failure !== null) throw failure;
      throw error;
    }
  }

  async function createItem(request: WorkRequest): Promise<WorkPage> {
    const snap = snapshot();
    const { scope, parent } = postedScope(snap, request.path, request.form);
    const action = createAction(scope, "items");
    const fields: readonly FieldSpec[] = [
      { name: parent.name, label: parent.name, hidden: true, value: parent.id },
      ...itemFields(projectChoices(snap, scope.engagement.id)).filter((field) => field.name !== "id"),
    ];
    const values = suppliedValues(request.form, fields);
    const input = {
      ...itemEdit(values, true),
      clientId: scope.client.id,
      engagementId: scope.engagement.id,
    };
    if (scope.project !== undefined) input.projectId = scope.project.id;
    try {
      const item = await store.createItem(input as WorkItemCreate);
      return redirect(`/items/${encodeURIComponent(item.id)}`);
    } catch (error) {
      const failure = formFailure(error, values, fields, action);
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
    const fields = family === "tasks"
      ? taskFields(projectChoices(snap, engagement.id), id)
      : itemFields(projectChoices(snap, engagement.id), id);
    const submitted = request.form["id"];
    return {
      snap,
      record,
      engagement,
      fields,
      action: `/${family}/${encodeURIComponent(record.id)}/edit`,
      id: record.id,
      conflict:
        submitted !== undefined && submitted !== "" && submitted !== record.id
          ? new ValidationError(`The submitted ${family === "tasks" ? "task" : "item"} id does not match this URL`)
          : null,
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
      const failure = formFailure(error, values, target.fields, target.action, stored);
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
      const failure = formFailure(error, values, target.fields, target.action, stored);
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
          title: "Task",
          body: [
            profileFields(TASK_PROFILE_FIELDS, profile),
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
          title: "Work item",
          body: [
            profileFields(ITEM_PROFILE_FIELDS, profile),
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

