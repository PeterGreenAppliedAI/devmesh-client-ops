/**
 * Hierarchy pages: clients (list, create, view, edit), engagements and projects
 * (create, view, edit). Each page is server-rendered HTML built from the store's
 * snapshot; every write goes through the validated store methods, so an invalid
 * submission is refused by the store and never reaches disk.
 *
 * Pages are organised into sections so later work and history sections can be
 * added without changing the surrounding navigation, forms or child lists.
 */
import {
  escapeHtml,
  FormError,
  redirect,
  renderForm,
  renderFormError,
  renderPage,
  type FieldSpec,
  type Page,
  type Redirect,
} from "./html.ts";
import { ENGAGEMENT_STATUSES, MissingRecordError, ValidationError } from "./model.ts";
import type {
  Client,
  ClientCreate,
  Engagement,
  EngagementCreate,
  Project,
  ProjectCreate,
  Snapshot,
  Store,
} from "./store.ts";

/** A route's result: a page, or a fixed internal redirect after a write. */
export type HierarchyResult = Page | Redirect;

/** What a hierarchy route may read from an accepted request. */
export interface HierarchyRequest {
  readonly method: "GET" | "POST";
  /** The request path including any query string. */
  readonly path: string;
  /** The form fields of an accepted POST; empty for a GET. */
  readonly form: Readonly<Record<string, string>>;
}

/** A guarded hierarchy route; `render` runs only after the request checks pass. */
export interface HierarchyRoute {
  readonly method: "GET" | "POST";
  render(request: HierarchyRequest): Promise<HierarchyResult> | HierarchyResult;
}

/** The route shape registered under one canonical hierarchy path. */
export interface HierarchyPathRoute {
  readonly get?: HierarchyRoute;
  readonly post?: HierarchyRoute;
}

/**
 * The hierarchy route table. Paths are canonical list/detail routes; new/edit
 * forms are explicit; POST actions are routed to the collection, record or new
 * endpoint they write. Every key is an exact path.
 */
export interface HierarchyRoutes {
  readonly clients: HierarchyPathRoute;
  readonly clientsNew: HierarchyPathRoute;
  readonly clientsRecord: HierarchyPathRoute;
  readonly clientsEdit: HierarchyPathRoute;
  readonly clientEngagementsNew: HierarchyPathRoute;
  readonly engagementsNew: HierarchyPathRoute;
  readonly engagementsRecord: HierarchyPathRoute;
  readonly engagementsEdit: HierarchyPathRoute;
  readonly engagementProjectsNew: HierarchyPathRoute;
  readonly projectsNew: HierarchyPathRoute;
  readonly projectsRecord: HierarchyPathRoute;
  readonly projectsEdit: HierarchyPathRoute;
}

/** The fixed paths the hierarchy table registers, used for matching. */
export type HierarchyPath =
  | "/clients"
  | "/clients/new"
  | "/clients/:id"
  | "/clients/:id/edit"
  | "/clients/:id/engagements/new"
  | "/engagements/new"
  | "/engagements/:id"
  | "/engagements/:id/edit"
  | "/engagements/:id/projects/new"
  | "/projects/new"
  | "/projects/:id"
  | "/projects/:id/edit";

/**
 * Match a request path against the hierarchy route patterns. Returns the
 * matched pattern and its record id (an empty string for list and new routes),
 * or null for a non-hierarchy path, so an unregistered path is refused before
 * any handler runs. A query string is never part of a match: a child form's
 * parent is carried in the path, not in a query.
 */
export function matchHierarchyPath(
  path: string,
): { readonly pattern: HierarchyPath; readonly id: string } | null {
  const pathname = path.split("?")[0];
  if (pathname === "/clients") return { pattern: "/clients", id: "" };
  const parts = pathname.split("/").slice(1);
  // A trailing slash leaves an empty segment, which names no record.
  if (parts.some((part) => part === "")) return null;
  if (parts.length === 2 && parts[0] === "clients" && parts[1] === "new") {
    return { pattern: "/clients/new", id: "" };
  }
  // The new engagement and project endpoints. Their GET forms live under the
  // parent (see below); these paths take the POST that writes the record.
  if (parts.length === 2 && parts[0] === "engagements" && parts[1] === "new") {
    return { pattern: "/engagements/new", id: "" };
  }
  if (parts.length === 2 && parts[0] === "projects" && parts[1] === "new") {
    return { pattern: "/projects/new", id: "" };
  }
  // A client's new-engagement form; the client id is the parent in the path.
  if (parts.length === 4 && parts[0] === "clients" && parts[1] !== "new" && parts[2] === "engagements" && parts[3] === "new") {
    return { pattern: "/clients/:id/engagements/new", id: parts[1] };
  }
  // An engagement's new-project form; the engagement id is the parent.
  if (parts.length === 4 && parts[0] === "engagements" && parts[1] !== "new" && parts[2] === "projects" && parts[3] === "new") {
    return { pattern: "/engagements/:id/projects/new", id: parts[1] };
  }
  if (parts.length === 2 && isFamily(parts[0]) && parts[1] !== "new") {
    return { pattern: `/${parts[0]}/:id` as HierarchyPath, id: parts[1] };
  }
  if (parts.length === 3 && isFamily(parts[0]) && parts[1] !== "new" && parts[2] === "edit") {
    return { pattern: `/${parts[0]}/:id/edit` as HierarchyPath, id: parts[1] };
  }
  return null;
}

function isFamily(segment: string | undefined): segment is "clients" | "engagements" | "projects" {
  return segment === "clients" || segment === "engagements" || segment === "projects";
}

/** Pick the registered route for a matched pattern from the table. */
export function routeForPattern(
  routes: HierarchyRoutes,
  pattern: HierarchyPath,
  method: "GET" | "POST",
): HierarchyRoute | undefined {
  const slot = slotFor(routes, pattern);
  return method === "POST" ? slot.post : slot.get;
}

function slotFor(routes: HierarchyRoutes, pattern: HierarchyPath): HierarchyPathRoute {
  switch (pattern) {
    case "/clients":
      return routes.clients;
    case "/clients/new":
      return routes.clientsNew;
    case "/clients/:id":
      return routes.clientsRecord;
    case "/clients/:id/edit":
      return routes.clientsEdit;
    case "/clients/:id/engagements/new":
      return routes.clientEngagementsNew;
    case "/engagements/new":
      return routes.engagementsNew;
    case "/engagements/:id":
      return routes.engagementsRecord;
    case "/engagements/:id/edit":
      return routes.engagementsEdit;
    case "/engagements/:id/projects/new":
      return routes.engagementProjectsNew;
    case "/projects/new":
      return routes.projectsNew;
    case "/projects/:id":
      return routes.projectsRecord;
    case "/projects/:id/edit":
      return routes.projectsEdit;
  }
}

/** A record id from the path that names no record in the store. */
function findRecord<T extends { readonly id: string }>(
  items: readonly T[],
  rawId: string,
  kind: string,
): T {
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    // A malformed escape names no record: it is a missing record, not a
    // malformed request.
    throw new MissingRecordError(`No ${kind} with id ${JSON.stringify(rawId)}`);
  }
  const found = items.find((item) => item.id === id);
  if (found === undefined) {
    throw new MissingRecordError(`No ${kind} with id ${JSON.stringify(id)}`);
  }
  return found;
}

/**
 * The record id from a detail, edit or child-new path such as
 * `/clients/client-1`, `/clients/client-1/edit` or
 * `/engagements/engagement-1/projects/new`. The path was matched by the server
 * before dispatch, so its shape is one of the fixed patterns.
 */
function idFromPath(path: string): string {
  const parts = path.split("?")[0].split("/").slice(1);
  // The family is the first segment, the record id the second.
  if (parts[0] === "clients" || parts[0] === "engagements" || parts[0] === "projects") {
    return parts[1] ?? "";
  }
  throw new MissingRecordError("No record for that path");
}

/** The statuses offered in a select control. */
const STATUS_OPTIONS: readonly { readonly value: string; readonly label: string }[] =
  ENGAGEMENT_STATUSES.map((status) => ({ value: status, label: status }));

const CLIENT_FIELDS: readonly FieldSpec[] = [
  { name: "name", label: "Name", required: true },
  { name: "background", label: "Background", type: "textarea" },
  { name: "contacts", label: "Contacts", type: "textarea" },
  { name: "stakeholders", label: "Stakeholders", type: "textarea" },
  { name: "requirements", label: "Requirements", type: "textarea" },
  { name: "objectives", label: "Objectives", type: "textarea" },
];

const ENGAGEMENT_FIELDS: readonly FieldSpec[] = [
  { name: "name", label: "Name", required: true },
  { name: "objectives", label: "Objectives", type: "textarea" },
  { name: "status", label: "Status", type: "select", options: STATUS_OPTIONS },
];

const PROJECT_FIELDS: readonly FieldSpec[] = [
  { name: "name", label: "Name", required: true },
  { name: "objectives", label: "Objectives", type: "textarea" },
  { name: "status", label: "Status", type: "select", options: STATUS_OPTIONS },
];

/** One page section: a heading and a body, so later sections can be appended. */
export interface PageSection {
  readonly title: string;
  readonly body: string;
}

/** Render a page from its title, fixed navigation links and section list. */
function pageWith(
  title: string,
  links: readonly { readonly label: string; readonly href: string }[],
  sections: readonly PageSection[],
): Page {
  const nav = links
    .map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`)
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
function showValue(value: string): string {
  return value === "" ? "<em>(none)</em>" : escapeHtml(value);
}

/** Render every profile field of a record, escaped. */
function profileFields(fields: readonly FieldSpec[], record: object): string {
  const values = record as Readonly<Record<string, string | undefined>>;
  const rows = fields.map(
    (field) => `<dt>${escapeHtml(field.label)}</dt><dd>${showValue(values[field.name] ?? "")}</dd>`,
  );
  return `<dl>${rows.join("")}</dl>`;
}

function link(path: string, label: string): string {
  return `<a href="${escapeHtml(path)}">${escapeHtml(label)}</a>`;
}

/** Render a list of child links, or a sentence when there are none. */
function childList(items: readonly { readonly href: string; readonly label: string; readonly note?: string }[]): string {
  if (items.length === 0) return "<p>None yet.</p>";
  return `<ul>${items
    .map(
      (item) =>
        `<li>${link(item.href, item.label)}${item.note === undefined ? "" : ` (${escapeHtml(item.note)})`}</li>`,
    )
    .join("")}</ul>`;
}

function clientsListPage(snapshot: Snapshot): Page {
  const items = snapshot.clients.map((client) => ({
    href: `/clients/${encodeURIComponent(client.id)}`,
    label: client.name,
  }));
  return pageWith(
    "Clients",
    [
      { label: "Home", href: "/" },
      { label: "Clients", href: "/clients" },
    ],
    [
      { title: "Clients", body: `<p>${link("/clients/new", "New client")}</p>${childList(items)}` },
    ],
  );
}

function clientShowPage(client: Client, snapshot: Snapshot): Page {
  const engagements = snapshot.engagements
    .filter((engagement) => engagement.clientId === client.id)
    .map((engagement) => ({
      href: `/engagements/${encodeURIComponent(engagement.id)}`,
      label: engagement.name,
      note: engagement.status,
    }));
  return pageWith(
    client.name,
    [
      { label: "Home", href: "/" },
      { label: "Clients", href: "/clients" },
      { label: "Edit client", href: `/clients/${encodeURIComponent(client.id)}/edit` },
    ],
    [
      { title: "Profile", body: profileFields(CLIENT_FIELDS, client) },
      {
        title: "Engagements",
        body: [
          `<p>${link(`/clients/${encodeURIComponent(client.id)}/engagements/new`, "New engagement")}</p>`,
          childList(engagements),
        ].join("\n"),
      },
    ],
  );
}

function engagementShowPage(engagement: Engagement, snapshot: Snapshot): Page {
  const client = findRecord(snapshot.clients, engagement.clientId, "client");
  const projects = snapshot.projects
    .filter((project) => project.engagementId === engagement.id)
    .map((project) => ({
      href: `/projects/${encodeURIComponent(project.id)}`,
      label: project.name,
      note: project.status,
    }));
  return pageWith(
    engagement.name,
    [
      { label: "Home", href: "/" },
      { label: "Clients", href: "/clients" },
      { label: client.name, href: `/clients/${encodeURIComponent(client.id)}` },
      { label: "Edit engagement", href: `/engagements/${encodeURIComponent(engagement.id)}/edit` },
    ],
    [
      { title: "Profile", body: profileFields(ENGAGEMENT_FIELDS, engagement) },
      {
        title: "Projects",
        body: [
          `<p>${link(`/engagements/${encodeURIComponent(engagement.id)}/projects/new`, "New project")}</p>`,
          childList(projects),
        ].join("\n"),
      },
    ],
  );
}

function projectShowPage(project: Project, snapshot: Snapshot): Page {
  const engagement = findRecord(snapshot.engagements, project.engagementId, "engagement");
  const client = findRecord(snapshot.clients, engagement.clientId, "client");
  return pageWith(
    project.name,
    [
      { label: "Home", href: "/" },
      { label: "Clients", href: "/clients" },
      { label: client.name, href: `/clients/${encodeURIComponent(client.id)}` },
      { label: engagement.name, href: `/engagements/${encodeURIComponent(engagement.id)}` },
      { label: "Edit project", href: `/projects/${encodeURIComponent(project.id)}/edit` },
    ],
    [{ title: "Profile", body: profileFields(PROJECT_FIELDS, project) }],
  );
}

/** Values for a create form: selects start at their first choice. */
/** Values for a create form: selects start at their first choice. */
function createFormValues(fields: readonly FieldSpec[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    if (field.hidden) continue;
    values[field.name] = field.value ?? (field.type === "select" ? ENGAGEMENT_STATUSES[0] : "");
  }
  return values;
}

/** Values for an edit form: every field starts from the stored record. */
function editFormValues(record: object): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") values[key] = value;
  }
  return values;
}

function renderHierarchyForm(
  title: string,
  action: string,
  fields: readonly FieldSpec[],
  values: Readonly<Record<string, string>>,
  submitLabel: string,
  cancelHref: string,
): Page {
  const body = [
    `<nav>${link("/", "Home")}${link(cancelHref, "Cancel")}</nav>`,
    renderForm({ action, fields, values, submitLabel }),
  ].join("\n");
  return renderPage(title, body);
}

/**
 * The controls for a submission that the store refused. The fixed hidden
 * fields (a record id or a parent id) are part of the form, so a corrected
 * resubmission still names the same record or parent.
 */
function submissionFields(
  base: readonly FieldSpec[],
  hidden: readonly FieldSpec[],
): readonly FieldSpec[] {
  return [...hidden, ...base];
}

/** Build a correctable form error from a store validation refusal. */
function formFailure(
  error: unknown,
  values: Readonly<Record<string, string>>,
  fields: readonly FieldSpec[],
  action: string,
): FormError | null {
  // The store's validation message names the field and the reason; it is shown
  // as the form summary so every submitted value can be corrected in place.
  return error instanceof ValidationError
    ? new FormError(error.message, values, [], fields, action)
    : null;
}

function text(form: Readonly<Record<string, string>>, name: string): string {
  return form[name] ?? "";
}

/**
 * The fields the submission actually supplied: only names present in the form.
 * An edit changes only what was posted and keeps every omitted field, which is
 * the store's own partial-update contract.
 */
function suppliedFields(
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

/**
 * Resolve the record an edit names. The target is the record in the URL path;
 * a submitted `id` must either be absent or name that same record, so one
 * record's edit URL can never write another record. A conflicting id is
 * refused as invalid input, and a missing target is a missing record.
 */
function editTargetId(
  request: HierarchyRequest,
  form: Readonly<Record<string, string>>,
  kind: string,
): string {
  let id: string;
  try {
    id = decodeURIComponent(idFromPath(request.path));
  } catch {
    throw new MissingRecordError(`No ${kind} for that path`);
  }
  const submitted = form["id"];
  if (submitted !== undefined && submitted !== "" && submitted !== id) {
    throw new ValidationError(`The submitted ${kind} id does not match this URL`);
  }
  return id;
}

/** Build the hierarchy routes for a store. */
export function hierarchyRoutes(store: Store): HierarchyRoutes {
  const snapshot = (): Snapshot => store.snapshot();

  function hiddenId(id: string): readonly FieldSpec[] {
    return [{ name: "id", label: "Id", hidden: true, value: id }];
  }

  function hiddenParent(name: string, id: string, label: string): readonly FieldSpec[] {
    return [{ name, label, hidden: true, value: id }];
  }

  async function createClient(form: Readonly<Record<string, string>>): Promise<HierarchyResult> {
    const values = suppliedFields(form, CLIENT_FIELDS);
    try {
      const client = await store.createClient(values as unknown as ClientCreate);
      return redirect(`/clients/${encodeURIComponent(client.id)}`);
    } catch (error) {
      const failure = formFailure(error, values, CLIENT_FIELDS, "/clients/new");
      if (failure !== null) throw failure;
      throw error;
    }
  }

  async function editClient(request: HierarchyRequest): Promise<HierarchyResult> {
    const id = editTargetId(request, request.form, "client");
    const client = findRecord(snapshot().clients, id, "client");
    const action = `/clients/${encodeURIComponent(client.id)}/edit`;
    const fields = submissionFields(CLIENT_FIELDS, hiddenId(client.id));
    // An edit changes only the fields it was given and keeps the others, so a
    // name-only submission leaves the rest of the profile untouched.
    const values = suppliedFields(request.form, CLIENT_FIELDS);
    try {
      await store.updateClient(client.id, values);
      return redirect(`/clients/${encodeURIComponent(client.id)}`);
    } catch (error) {
      const failure = formFailure(error, values, fields, action);
      if (failure !== null) throw failure;
      throw error;
    }
  }

  async function createEngagement(form: Readonly<Record<string, string>>): Promise<HierarchyResult> {
    const client = findRecord(snapshot().clients, text(form, "clientId"), "client");
    const values = suppliedFields(form, ENGAGEMENT_FIELDS);
    const input = { ...values, clientId: client.id } as unknown as EngagementCreate;
    try {
      const engagement = await store.createEngagement(input);
      return redirect(`/engagements/${encodeURIComponent(engagement.id)}`);
    } catch (error) {
      // The correction form repeats the hidden parent so the client is kept,
      // and posts to the same new endpoint again.
      const fields = submissionFields(
        ENGAGEMENT_FIELDS,
        hiddenParent("clientId", client.id, "Client"),
      );
      const failure = formFailure(error, values, fields, "/engagements/new");
      if (failure !== null) throw failure;
      throw error;
    }
  }

  async function editEngagement(request: HierarchyRequest): Promise<HierarchyResult> {
    const id = editTargetId(request, request.form, "engagement");
    const engagement = findRecord(snapshot().engagements, id, "engagement");
    const action = `/engagements/${encodeURIComponent(engagement.id)}/edit`;
    const fields = submissionFields(ENGAGEMENT_FIELDS, hiddenId(engagement.id));
    const values = suppliedFields(request.form, ENGAGEMENT_FIELDS);
    try {
      await store.updateEngagement(engagement.id, values);
      return redirect(`/engagements/${encodeURIComponent(engagement.id)}`);
    } catch (error) {
      const failure = formFailure(error, values, fields, action);
      if (failure !== null) throw failure;
      throw error;
    }
  }

  async function createProject(form: Readonly<Record<string, string>>): Promise<HierarchyResult> {
    const engagement = findRecord(snapshot().engagements, text(form, "engagementId"), "engagement");
    const values = suppliedFields(form, PROJECT_FIELDS);
    const input = { ...values, engagementId: engagement.id } as unknown as ProjectCreate;
    try {
      const project = await store.createProject(input);
      return redirect(`/projects/${encodeURIComponent(project.id)}`);
    } catch (error) {
      const fields = submissionFields(
        PROJECT_FIELDS,
        hiddenParent("engagementId", engagement.id, "Engagement"),
      );
      const failure = formFailure(error, values, fields, "/projects/new");
      if (failure !== null) throw failure;
      throw error;
    }
  }

  async function editProject(request: HierarchyRequest): Promise<HierarchyResult> {
    const id = editTargetId(request, request.form, "project");
    const project = findRecord(snapshot().projects, id, "project");
    const action = `/projects/${encodeURIComponent(project.id)}/edit`;
    const fields = submissionFields(PROJECT_FIELDS, hiddenId(project.id));
    const values = suppliedFields(request.form, PROJECT_FIELDS);
    try {
      await store.updateProject(project.id, values);
      return redirect(`/projects/${encodeURIComponent(project.id)}`);
    } catch (error) {
      const failure = formFailure(error, values, fields, action);
      if (failure !== null) throw failure;
      throw error;
    }
  }

  return {
    clients: {
      get: { method: "GET", render: () => clientsListPage(snapshot()) },
    },
    clientsNew: {
      get: {
        method: "GET",
        render: () =>
          renderHierarchyForm("New client", "/clients/new", CLIENT_FIELDS, createFormValues(CLIENT_FIELDS), "Create", "/clients"),
      },
      post: {
        method: "POST",
        async render(request) {
          // A refused write throws a FormError, which the shell renders as a
          // correctable 400 page with the submitted values kept.
          return await createClient(request.form);
        },
      },
    },
    clientsRecord: {
      get: {
        method: "GET",
        render: (request) => clientShowPage(findRecord(snapshot().clients, idFromPath(request.path), "client"), snapshot()),
      },
    },
    clientsEdit: {
      get: {
        method: "GET",
        render: (request) => {
          const client = findRecord(snapshot().clients, idFromPath(request.path), "client");
          const fields = submissionFields(CLIENT_FIELDS, hiddenId(client.id));
          return renderHierarchyForm(
            "Edit client",
            `/clients/${encodeURIComponent(client.id)}/edit`,
            fields,
            editFormValues({ ...client, id: client.id }),
            "Save",
            `/clients/${encodeURIComponent(client.id)}`,
          );
        },
      },
      post: {
        method: "POST",
        async render(request) {
          // A refused write throws a FormError, which the shell renders as a
          // correctable 400 page with the submitted values kept.
          return await editClient(request);
        },
      },
    },
    clientEngagementsNew: {
      get: {
        method: "GET",
        render: (request) => {
          const client = findRecord(snapshot().clients, idFromPath(request.path), "client");
          const fields = submissionFields(
            ENGAGEMENT_FIELDS,
            hiddenParent("clientId", client.id, "Client"),
          );
          return renderHierarchyForm(
            "New engagement",
            // The form posts to the collection's new endpoint, which writes
            // one engagement under the client carried in the hidden field.
            `/engagements/new`,
            fields,
            createFormValues(fields),
            "Create",
            `/clients/${encodeURIComponent(client.id)}`,
          );
        },
      },
    },
    engagementsNew: {
      post: {
        method: "POST",
        async render(request) {
          // A refused write throws a FormError, which the shell renders as a
          // correctable 400 page with the submitted values kept.
          return await createEngagement(request.form);
        },
      },
    },
    engagementsRecord: {
      get: {
        method: "GET",
        render: (request) =>
          engagementShowPage(findRecord(snapshot().engagements, idFromPath(request.path), "engagement"), snapshot()),
      },
    },
    engagementsEdit: {
      get: {
        method: "GET",
        render: (request) => {
          const engagement = findRecord(snapshot().engagements, idFromPath(request.path), "engagement");
          const fields = submissionFields(ENGAGEMENT_FIELDS, hiddenId(engagement.id));
          return renderHierarchyForm(
            "Edit engagement",
            `/engagements/${encodeURIComponent(engagement.id)}/edit`,
            fields,
            editFormValues({ ...engagement, id: engagement.id }),
            "Save",
            `/engagements/${encodeURIComponent(engagement.id)}`,
          );
        },
      },
      post: {
        method: "POST",
        async render(request) {
          // A refused write throws a FormError, which the shell renders as a
          // correctable 400 page with the submitted values kept.
          return await editEngagement(request);
        },
      },
    },
    engagementProjectsNew: {
      get: {
        method: "GET",
        render: (request) => {
          const engagement = findRecord(snapshot().engagements, idFromPath(request.path), "engagement");
          const fields = submissionFields(
            PROJECT_FIELDS,
            hiddenParent("engagementId", engagement.id, "Engagement"),
          );
          return renderHierarchyForm(
            "New project",
            `/projects/new`,
            fields,
            createFormValues(fields),
            "Create",
            `/engagements/${encodeURIComponent(engagement.id)}`,
          );
        },
      },
    },
    projectsNew: {
      post: {
        method: "POST",
        async render(request) {
          // A refused write throws a FormError, which the shell renders as a
          // correctable 400 page with the submitted values kept.
          return await createProject(request.form);
        },
      },
    },
    projectsRecord: {
      get: {
        method: "GET",
        render: (request) =>
          projectShowPage(findRecord(snapshot().projects, idFromPath(request.path), "project"), snapshot()),
      },
    },
    projectsEdit: {
      get: {
        method: "GET",
        render: (request) => {
          const project = findRecord(snapshot().projects, idFromPath(request.path), "project");
          const fields = submissionFields(PROJECT_FIELDS, hiddenId(project.id));
          return renderHierarchyForm(
            "Edit project",
            `/projects/${encodeURIComponent(project.id)}/edit`,
            fields,
            editFormValues({ ...project, id: project.id }),
            "Save",
            `/projects/${encodeURIComponent(project.id)}`,
          );
        },
      },
      post: {
        method: "POST",
        async render(request) {
          // A refused write throws a FormError, which the shell renders as a
          // correctable 400 page with the submitted values kept.
          return await editProject(request);
        },
      },
    },
  };
}
