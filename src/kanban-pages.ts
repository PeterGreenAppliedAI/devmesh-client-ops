/**
 * Protected board pages: the read-only kanban views under `/kanban` and the
 * exact `POST /tasks/:id/move` movement endpoint.
 *
 * A board is server-rendered HTML built from the store's own read-only
 * selector (`selectKanban`), so it shows exactly the visible tasks of one
 * scope in the four fixed columns open, in_progress, waiting and done. Every
 * card links to its task detail page (title, status, priority, owner, due date
 * and the actual client, engagement and optional project), and each column
 * offers a native, keyboard-operable form that moves a card to its own status.
 *
 * Movement is a small, no-script form post: the URL names the task and the
 * submission carries `status`, `scopeKind` and `scopeId` plus the optional
 * `id`, `clientId`, `engagementId` and `projectId` identity assertions. The
 * assertions are compared with the current record by the store and never edit
 * anything else; other fields are ignored. The URL ids are decoded and looked
 * up first, so a missing or malformed id is a 404. An invalid status is a
 * correctable `FormError` (400) that keeps the submitted status and the
 * validated scope; an invalid scope or a conflicting assertion is a plain 400
 * without a write; a persistence failure propagates as the shell's generic 500.
 * A successful move redirects (303) to the server-built path of the validated
 * scope, never to a submitted destination.
 *
 * Archived scopes stay usable: their board page carries an archive notice and
 * shows an empty board, and a stale submission from such a page still moves the
 * archived task (existing editable-archive practice) while the redirected board
 * keeps hiding it.
 */
import { isEffectivelyArchived } from "./archive.ts";
import {
  escapeHtml,
  fieldErrorsFor,
  FormError,
  redirect,
  renderPage,
  type FieldSpec,
  type Page,
  type Redirect,
} from "./html.ts";
import {
  assertTaskIdentity,
  requireBoardScope,
  requireBoardStatus,
  requireExpectations,
  selectKanban,
  taskInScope,
  type BoardScope,
  type KanbanBoard,
  type KanbanGroup,
  type KanbanGroupKind,
} from "./kanban.ts";
import { MissingRecordError, ValidationError, type Task, type TaskIdentityExpectation } from "./model.ts";
import type { Client, Engagement, Project, Snapshot, Store } from "./store.ts";
import { archiveNotice } from "./archive-pages.ts";
import { link } from "./work-pages.ts";

/** The result of rendering one board page, or a fixed redirect after a move. */
export type KanbanPage = Page | Redirect;

/** What a board route may read from an accepted request. */
export interface KanbanRequest {
  readonly method: "GET" | "POST";
  /** The request path including any query string (the query is never read). */
  readonly path: string;
  /** The form fields of an accepted POST; empty for a GET. */
  readonly form: Readonly<Record<string, string>>;
}

/** A guarded board route; `render` runs only after the request checks pass. */
export interface KanbanRoute {
  readonly method: "GET" | "POST";
  render(request: KanbanRequest): Promise<KanbanPage> | KanbanPage;
}

/** The route shape registered under one fixed board path. */
export interface KanbanPathRoute {
  readonly get?: KanbanRoute;
  readonly post?: KanbanRoute;
}

/** The board route table. Boards are GET-only; movement takes the POST. */
export interface KanbanRoutes {
  readonly board: KanbanPathRoute;
  readonly move: KanbanPathRoute;
}

/** The fixed board paths the table registers. */
export type KanbanPath =
  | "/kanban"
  | "/clients/:id/kanban"
  | "/engagements/:id/kanban"
  | "/projects/:id/kanban"
  | "/tasks/:id/move";

/**
 * Match a request path against the fixed board patterns, returning the matched
 * pattern and the raw (undecoded) id in its path, or null for any other path so
 * an unregistered path is refused before any handler runs. The id is not
 * decoded here: a malformed escape names no record.
 */
export function matchKanbanPath(
  path: string,
): { readonly pattern: KanbanPath; readonly id: string } | null {
  const pathname = path.split("?")[0];
  if (pathname === "/kanban") return { pattern: "/kanban", id: "" };
  const parts = pathname.split("/").slice(1);
  // A trailing slash leaves an empty segment, which names no record.
  if (parts.length !== 3) return null;
  if (parts.some((part) => part === "")) return null;
  if (
    parts[2] === "kanban" &&
    (parts[0] === "clients" || parts[0] === "engagements" || parts[0] === "projects") &&
    parts[1] !== "new"
  ) {
    return { pattern: `/${parts[0]}/:id/kanban` as KanbanPath, id: parts[1] };
  }
  if (parts[0] === "tasks" && parts[2] === "move" && parts[1] !== "new") {
    return { pattern: "/tasks/:id/move", id: parts[1] };
  }
  return null;
}

/** Pick the registered route for a matched pattern from the table. */
export function routeForKanbanPattern(
  routes: KanbanRoutes,
  pattern: KanbanPath,
  method: "GET" | "POST",
): KanbanRoute | undefined {
  const slot = pattern === "/tasks/:id/move" ? routes.move : routes.board;
  return method === "POST" ? slot.post : slot.get;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/** The visible text label of each board group: actionable, waiting or completed. */
const GROUP_LABELS: Readonly<Record<KanbanGroupKind, string>> = Object.freeze({
  open: "Actionable",
  in_progress: "Actionable",
  waiting: "Waiting",
  done: "Completed",
});

/** The status text shown in each group's heading, beside its label. */
const GROUP_STATUS_TEXT: Readonly<Record<KanbanGroupKind, string>> = Object.freeze({
  open: "open",
  in_progress: "in progress",
  waiting: "waiting",
  done: "done",
});

/**
 * The server-built, redirect-safe path of a validated scope: the whole board,
 * or the exact record's board. Every id is escaped for the path, never taken
 * from a submitted destination.
 */
export function boardPath(scope: BoardScope): string {
  if (scope.kind === "all") return "/kanban";
  return `/${scope.kind}s/${encodeURIComponent(scope.id)}/kanban`;
}

/** A stored value shown at most once, escaped; blank values read as "(none)". */
function fieldValue(value: string | undefined): string {
  return value === undefined || value === "" ? "<em>(none)</em>" : escapeHtml(value);
}

/** The four scope kind headings, in the order a board shows its navigation. */
const SCOPE_HEADINGS = ["All work", "Clients", "Engagements", "Projects"] as const;

/**
 * The fixed scope navigation of a board: the whole workspace plus one link for
 * every visible client, engagement and project, each marked current when it is
 * the board's own scope. Every link is the server-built board path of a stored
 * record, so the chain all → client → engagement → project is always followed
 * through existing records. Archived records are left out, exactly as the
 * navigation and the boards hide them.
 */
function scopeNavigation(snapshot: Snapshot, board: KanbanBoard): string {
  const current = board.scope.kind === "all" ? "/kanban" : boardPath(board.scope);
  const link_ = (href: string, label: string): string => {
    const now = href === current ? ' aria-current="page"' : "";
    return `<li><a href="${escapeHtml(href)}"${now}>${escapeHtml(label)}</a></li>`;
  };
  const groups: string[] = [];
  groups.push(
    `<h3>${escapeHtml(SCOPE_HEADINGS[0])}</h3><ul>${link_("/kanban", "All work")}</ul>`,
  );
  const visibleClients = snapshot.clients.filter((client) => !isEffectivelyArchived(snapshot, client));
  const visibleEngagements = snapshot.engagements.filter((engagement) => !isEffectivelyArchived(snapshot, engagement));
  const visibleProjects = snapshot.projects.filter((project) => !isEffectivelyArchived(snapshot, project));
  const clientsBody =
    visibleClients.length === 0
      ? "<p>No clients yet.</p>"
      : `<ul>${visibleClients.map((client) => link_(boardPath({ kind: "client", id: client.id }), client.name)).join("")}</ul>`;
  groups.push(`<h3>${escapeHtml(SCOPE_HEADINGS[1])}</h3>${clientsBody}`);
  const engagementsBody =
    visibleEngagements.length === 0
      ? "<p>No engagements yet.</p>"
      : `<ul>${visibleEngagements
          .map((engagement) => link_(boardPath({ kind: "engagement", id: engagement.id }), engagement.name))
          .join("")}</ul>`;
  groups.push(`<h3>${escapeHtml(SCOPE_HEADINGS[2])}</h3>${engagementsBody}`);
  const engagementById = new Map(visibleEngagements.map((engagement) => [engagement.id, engagement]));
  const projectsBody =
    visibleProjects.length === 0
      ? "<p>No projects yet.</p>"
      : `<ul>${visibleProjects
          .map((project) => {
            const engagement = engagementById.get(project.engagementId);
            const name = engagement === undefined ? project.name : `${project.name} (${engagement.name})`;
            return link_(boardPath({ kind: "project", id: project.id }), name);
          })
          .join("")}</ul>`;
  groups.push(`<h3>${escapeHtml(SCOPE_HEADINGS[3])}</h3>${projectsBody}`);
  return `<nav class="scope-nav" aria-label="Board scopes">${groups.join("\n")}</nav>`;
}

/** The title of a board: the whole workspace, or the scope record's own name. */
function boardTitle(snapshot: Snapshot, board: KanbanBoard): string {
  switch (board.scope.kind) {
    case "all":
      return "Kanban";
    case "client":
      return `${findScopeName(snapshot.clients, board.scope.id, "client")} board`;
    case "engagement":
      return `${findScopeName(snapshot.engagements, board.scope.id, "engagement")} board`;
    case "project":
      return `${findScopeName(snapshot.projects, board.scope.id, "project")} board`;
  }
}

/** The stored record the board scope names; a missing record cannot happen. */
function findScopeName<T extends { readonly id: string; readonly name: string }>(
  records: readonly T[],
  id: string,
  kind: string,
): string {
  const found = records.find((record) => record.id === id);
  if (found === undefined) throw new MissingRecordError(`No ${kind} with id ${JSON.stringify(id)}`);
  return found.name;
}

/**
 * One linked card: the task title links to its detail page, then its status,
 * priority, owner, due date and its actual client, engagement and optional
 * project are shown as escaped text links to those records, and its own move
 * form follows inside the same card.
 */
function card(
  task: Task,
  client: Client | undefined,
  engagement: Engagement | undefined,
  project: Project | undefined,
  move: string,
): string {
  const clientLink =
    client === undefined
      ? "<em>(missing client)</em>"
      : link(`/clients/${encodeURIComponent(client.id)}`, client.name);
  const engagementLink =
    engagement === undefined
      ? "<em>(missing engagement)</em>"
      : link(`/engagements/${encodeURIComponent(engagement.id)}`, engagement.name);
  const projectLink =
    project === undefined
      ? "<em>(no project)</em>"
      : link(`/projects/${encodeURIComponent(project.id)}`, project.name);
  return [
    `<li class="card board-card">`,
    `<p class="card-title">${link(`/tasks/${encodeURIComponent(task.id)}`, task.title)}</p>`,
    `<dl class="card-fields">`,
    `<dt>Status</dt><dd><span class="badge">${escapeHtml(task.status)}</span></dd>`,
    `<dt>Priority</dt><dd><span class="badge">${escapeHtml(task.priority)}</span></dd>`,
    `<dt>Owner</dt><dd>${fieldValue(task.owner)}</dd>`,
    `<dt>Due date</dt><dd>${fieldValue(task.dueDate)}</dd>`,
    `<dt>Client</dt><dd>${clientLink}</dd>`,
    `<dt>Engagement</dt><dd>${engagementLink}</dd>`,
    `<dt>Project</dt><dd>${projectLink}</dd>`,
    `</dl>`,
    move,
    `</li>`,
  ].join("");
}

/** The scope's own record, resolved from the board's validated scope. */
function scopeRecord(snapshot: Snapshot, board: KanbanBoard): Client | Engagement | Project | undefined {
  const scope = board.scope;
  switch (scope.kind) {
    case "all":
      return undefined;
    case "client":
      return snapshot.clients.find((client) => client.id === scope.id);
    case "engagement":
      return snapshot.engagements.find((engagement) => engagement.id === scope.id);
    case "project":
      return snapshot.projects.find((project) => project.id === scope.id);
  }
}

/**
 * The move form of one card: a POST to the task's own move endpoint with the
 * new status, the validated scope and the record's current identity as the
 * assertions the store compares. The status is a native select, shown on the
 * card's own status, so a keyboard user chooses any of the four statuses
 * directly and submits that choice; every control is native, so the form
 * works from the keyboard with no script. A task already in the chosen status
 * is still offered (a move to its own status records no event).
 */
function moveForm(
  task: Task,
  status: KanbanGroupKind,
  scope: BoardScope,
): string {
  const hidden = (name: string, value: string): string =>
    `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
  const id = `field-status-${escapeHtml(task.id)}`;
  const options = moveStatusOptions()
    .map((option) => {
      const selected = option.value === status ? " selected" : "";
      return `<option value="${escapeHtml(option.value)}"${selected}>${escapeHtml(option.label)}</option>`;
    })
    .join("");
  return `<form class="move-form" method="post" action="${escapeHtml(`/tasks/${encodeURIComponent(task.id)}/move`)}">${
    hidden("scopeKind", scope.kind) +
    hidden("scopeId", scope.kind === "all" ? "" : scope.id) +
    hidden("id", task.id) +
    hidden("clientId", task.clientId) +
    hidden("engagementId", task.engagementId) +
    hidden("projectId", task.projectId ?? "")
  }<label for="${id}">Move to</label><select id="${id}" name="status">${options}</select><button type="submit">Move</button></form>`;
}

/** The markup of one board column: its heading, empty state and cards. */
function column(
  group: KanbanGroup,
  board: KanbanBoard,
  lookup: {
    readonly clients: ReadonlyMap<string, Client>;
    readonly engagements: ReadonlyMap<string, Engagement>;
    readonly projects: ReadonlyMap<string, Project>;
  },
): string {
  const heading = `<h2>${escapeHtml(GROUP_LABELS[group.kind])}: ${escapeHtml(GROUP_STATUS_TEXT[group.kind])}</h2>`;
  if (group.tasks.length === 0) {
    return `<section class="board-column column-${escapeHtml(group.kind)}">${heading}<p class="empty-state">No ${escapeHtml(GROUP_LABELS[group.kind].toLowerCase())} tasks.</p></section>`;
  }
  const cards = group.tasks
    .map((task) =>
      card(
        task,
        lookup.clients.get(task.clientId),
        lookup.engagements.get(task.engagementId),
        task.projectId === undefined ? undefined : lookup.projects.get(task.projectId),
        moveForm(task, group.kind, board.scope),
      ),
    )
    .join("");
  return `<section class="board-column column-${escapeHtml(group.kind)}">${heading}<ul class="card-list">${cards}</ul></section>`;
}

/** The archive route family of each record scope kind. */
const SCOPE_FAMILY: Readonly<Record<"client" | "engagement" | "project", "clients" | "engagements" | "projects">> =
  Object.freeze({ client: "clients", engagement: "engagements", project: "projects" });

/**
 * The archive notice of a board whose scope record is effectively archived.
 * The board stays usable and shows an empty board (its tasks are hidden with
 * it); a stale movement submission from it still moves the archived task.
 */
function boardNotice(snapshot: Snapshot, board: KanbanBoard): string {
  const record = scopeRecord(snapshot, board);
  if (record === undefined || board.scope.kind === "all") return "";
  return archiveNotice(snapshot, record, { family: SCOPE_FAMILY[board.scope.kind] });
}

/** Render one board page from its validated scope and the current snapshot. */
export function renderBoard(snapshot: Snapshot, scope: BoardScope): Page {
  const board = selectKanban(snapshot, scope);
  const clients = new Map(snapshot.clients.map((client) => [client.id, client]));
  const engagements = new Map(snapshot.engagements.map((engagement) => [engagement.id, engagement]));
  const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
  const notice = boardNotice(snapshot, board);
  const columns = board.groups
    .map((group) => column(group, board, { clients, engagements, projects }))
    .join("\n");
  const body = [
    `<p>${link("/", "Home")}${link("/kanban", "All work")}</p>`,
    notice,
    `<section class="board-scopes"><h2>Scopes</h2>${scopeNavigation(snapshot, board)}</section>`,
    `<style>${BOARD_STYLE}</style>`,
    `<div class="board" role="group" aria-label="Kanban board">${columns}</div>`,
  ].join("\n");
  return renderPage(boardTitle(snapshot, board), body);
}

/**
 * The stylesheet additions the board needs: four columns that reflow to a
 * single column at phone widths without hiding any control, and status styling
 * that pairs colour with the text label already shown in each heading.
 */
export const BOARD_STYLE = [
  ".board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem;align-items:start}",
  ".board-column{min-width:0;border:1px solid #b8b8b8;border-radius:6px;padding:.5rem;background:#f7f7f7}",
  ".board-column h2{font-size:1.05rem;margin:.25rem 0 .5rem}",
  ".board-column .card-list{display:block;list-style:none;margin:0;padding:0}",
  ".board-card{list-style:none;margin:0 0 .75rem;padding:.5rem;border:1px solid #d0d0d0;border-radius:4px;background:#ffffff;overflow-wrap:anywhere}",
  ".board-card .card-fields{display:grid;grid-template-columns:auto minmax(0,1fr);gap:.1rem .5rem;margin:.35rem 0}",
  ".board-card .card-fields dt{font-weight:600}",
  ".board-card .card-fields dd{margin:0;min-width:0}",
  ".move-form{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.35rem}",
  ".move-form button{margin-top:0;width:100%}",
  ".column-open{border-top:.4rem solid #0b4f9c}",
  ".column-in_progress{border-top:.4rem solid #8a5a00}",
  ".column-waiting{border-top:.4rem solid #6b4f8a}",
  ".column-done{border-top:.4rem solid #1c6b3a}",
  ".column-open h2,.column-in_progress h2{color:#0b3a73}",
  ".column-waiting h2{color:#4a3462}",
  ".column-done h2{color:#14502b}",
  ".scope-nav ul{list-style:none;margin:.25rem 0 .75rem;padding:0}",
  ".scope-nav li{margin:.15rem 0;overflow-wrap:anywhere}",
  ".scope-nav a[aria-current=page]{font-weight:700}",
  "@media (max-width:1000px){.board{grid-template-columns:repeat(2,minmax(0,1fr))}}",
  "@media (max-width:560px){.board{grid-template-columns:minmax(0,1fr)}}",
].join("");

// ---------------------------------------------------------------------------
// Movement arguments
// ---------------------------------------------------------------------------

/** The fixed status choices of a move form, in board order. */
function moveStatusOptions(): readonly { readonly value: string; readonly label: string }[] {
  return (["open", "in_progress", "waiting", "done"] as const).map((status) => ({
    value: status,
    label: `${GROUP_LABELS[status]} (${status})`,
  }));
}

/**
 * The validated scope the submission names. `scopeKind` must be one of the four
 * known kinds and `scopeId` must be blank for `all`; the three narrowed kinds
 * require a nonblank id. A malformed value is a `ValidationError` and no write.
 */
function submittedScope(form: Readonly<Record<string, string>>): BoardScope {
  const kind = form["scopeKind"] ?? "";
  const id = form["scopeId"] ?? "";
  if (kind !== "all" && kind !== "client" && kind !== "engagement" && kind !== "project") {
    throw new ValidationError(
      "scopeKind must be one of all, client, engagement, project",
    );
  }
  if (kind === "all") {
    if (id !== "") {
      throw new ValidationError("scopeId must be empty for the all scope");
    }
    return requireBoardScope({ kind });
  }
  return requireBoardScope({ kind, id });
}

/** The optional identity assertions the submission carries, validated. */
function submittedExpectations(form: Readonly<Record<string, string>>): TaskIdentityExpectation {
  const expected: Record<string, string> = {};
  for (const key of ["id", "clientId", "engagementId", "projectId"] as const) {
    if (Object.hasOwn(form, key)) expected[key] = form[key];
  }
  return requireExpectations(expected);
}

/** A record id from a path that names no record: a missing record (404). */
function decodeId(rawId: string, kind: string): string {
  try {
    return decodeURIComponent(rawId);
  } catch {
    throw new MissingRecordError(`No ${kind} for that path`);
  }
}

/** The stored record a submitted scope names; an unknown scope is invalid input (400). */
function findScopeRecord<T extends { readonly id: string }>(
  records: readonly T[],
  id: string,
  kind: string,
): T {
  const found = records.find((record) => record.id === id);
  if (found === undefined) {
    throw new ValidationError(`scopeId ${JSON.stringify(id)} is not a stored ${kind}`);
  }
  return found;
}

/** The stored task a path names, or a missing record (404). */
function findTask(snapshot: Snapshot, rawId: string): Task {
  const id = decodeId(rawId, "task");
  const found = snapshot.tasks.find((task) => task.id === id);
  if (found === undefined) throw new MissingRecordError(`No task with id ${JSON.stringify(id)}`);
  return found;
}

/**
 * The scope a board path names: the whole board for `/kanban`, else the
 * decoded record id of one client, engagement or project. A malformed or
 * unknown id is a 404 before any board is selected.
 */
function boardScopeFromPath(snapshot: Snapshot, path: string): BoardScope {
  const matched = matchKanbanPath(path);
  if (matched === null || matched.pattern === "/tasks/:id/move") {
    throw new MissingRecordError("No board for that path");
  }
  if (matched.pattern === "/kanban") return { kind: "all" };
  const kind = matched.pattern.split("/")[1] as "clients" | "engagements" | "projects";
  const id = decodeId(matched.id, kind.slice(0, -1));
  const records: readonly { readonly id: string }[] =
    kind === "clients" ? snapshot.clients : kind === "engagements" ? snapshot.engagements : snapshot.projects;
  if (!records.some((record) => record.id === id)) {
    throw new MissingRecordError(`No ${kind.slice(0, -1)} with id ${JSON.stringify(id)}`);
  }
  return { kind: kind.slice(0, -1) as "client" | "engagement" | "project", id };
}

/**
 * Build the board routes for a store. Read pages never write; a movement goes
 * only through the store's own `moveTask`, whose single record/event
 * transaction is the only write. A persistence failure is not caught here, so
 * it becomes the shell's generic 500 and the committed memory is left as it was.
 */
export function kanbanRoutes(store: Store): KanbanRoutes {
  const snapshot = (): Snapshot => store.snapshot();

  /** A board page for a matched path; a missing or malformed id is a 404. */
  function showBoard(request: KanbanRequest): Page {
    const snap = snapshot();
    const scope = boardScopeFromPath(snap, request.path);
    return renderBoard(snap, scope);
  }

  /**
   * A move: the URL task is resolved first (404 when missing), then the
   * submitted status, scope and assertions are validated. An invalid status is
   * a correctable `FormError` retaining the submitted status and the validated
   * scope; an invalid scope or conflicting assertion is a plain 400. Only valid
   * arguments reach the store, whose transaction is the single write.
   */
  async function move(request: KanbanRequest): Promise<KanbanPage> {
    const snap = snapshot();
    const matched = matchKanbanPath(request.path);
    if (matched === null || matched.pattern !== "/tasks/:id/move") {
      throw new MissingRecordError("No task for that path");
    }
    const task = findTask(snap, matched.id);
    const form = request.form;
    const submittedStatus = form["status"] ?? "";
    // The scope is validated before the status so a correction keeps the
    // validated scope; a bad scope is a plain 400 and no write. A named scope
    // record must exist, so an unknown scope id is refused before any write and
    // the scope navigation of the board never names an invented record.
    const scope = submittedScope(form);
    if (scope.kind === "client") findScopeRecord(snap.clients, scope.id, "client");
    if (scope.kind === "engagement") findScopeRecord(snap.engagements, scope.id, "engagement");
    if (scope.kind === "project") findScopeRecord(snap.projects, scope.id, "project");
    const expected = submittedExpectations(form);
    // The identity assertions and the scope membership are checked against the
    // current record here, before any correction is rendered, so a conflict is
    // refused as a plain 400 with no write even alongside an invalid status.
    // The store checks the same assertions again inside its queue at commit
    // time, so a movement queued behind another write is still judged by the
    // state it writes to. Both checks are pure and never write.
    assertTaskIdentity(task, expected);
    if (!taskInScope(task, scope)) {
      throw new ValidationError(`task ${JSON.stringify(task.id)} is outside the board scope`);
    }
    if (!(TASK_STATUS_VALUES as readonly string[]).includes(submittedStatus)) {
      // Correctable: the submitted status is retained (even an unoffered one),
      // the validated scope and the (already checked) submitted assertions are
      // kept, and the status select is the marked control.
      const values = moveValues(submittedStatus, scope, expected);
      const fields = moveFields(scope, expected);
      const message = `task.status must be one of ${TASK_STATUS_VALUES.join(", ")}`;
      throw new FormError(
        message,
        values,
        fieldErrorsFor(message, values, fields, { field: "status", value: submittedStatus }),
        fields,
        taskMoveAction(task.id),
      );
    }
    const status = requireBoardStatus(submittedStatus);
    // The store validates the scope record, the assertions and the membership
    // again inside its queue; a refusal there is a plain 400 and no write.
    await store.moveTask(task.id, status, scope, expected);
    return redirect(boardPath(scope));
  }

  return {
    board: {
      get: { method: "GET", render: (request) => showBoard(request) },
    },
    move: {
      post: {
        method: "POST",
        async render(request) {
          return await move(request);
        },
      },
    },
  };
}

/** The known task statuses in board order, for the refusal message. */
const TASK_STATUS_VALUES = ["open", "in_progress", "waiting", "done"] as const;

/** The fixed destination one task's movement posts to. */
function taskMoveAction(id: string): string {
  return `/tasks/${encodeURIComponent(id)}/move`;
}

/**
 * The controls of a move correction: a visible status select and the hidden
 * links. The identity assertions are optional in a submission, so a hidden
 * assertion control is rendered only for an assertion the submission actually
 * carried; the corrected form then resubmits exactly the assertions that were
 * submitted, and an omitted assertion stays omitted instead of becoming a
 * blank value that a resubmission would fail.
 */
function moveFields(
  scope: BoardScope,
  expected: TaskIdentityExpectation,
): readonly FieldSpec[] {
  const fields: FieldSpec[] = [
    {
      name: "status",
      label: "Status",
      type: "select",
      options: moveStatusOptions(),
      value: "open",
    },
    { name: "scopeKind", label: "Scope kind", hidden: true, value: scope.kind },
    { name: "scopeId", label: "Scope id", hidden: true, value: scope.kind === "all" ? "" : scope.id },
  ];
  const assertionControls: Readonly<Record<keyof TaskIdentityExpectation, { readonly label: string }>> = {
    id: { label: "Id" },
    clientId: { label: "Client" },
    engagementId: { label: "Engagement" },
    projectId: { label: "Project" },
  };
  for (const key of ["id", "clientId", "engagementId", "projectId"] as const) {
    if (expected[key] === undefined) continue;
    fields.push({ name: key, label: assertionControls[key].label, hidden: true, value: expected[key] });
  }
  return fields;
}

/**
 * The submitted values kept for a status correction: the submitted status, the
 * validated scope (server-built, never a submitted id) and the submitted
 * identity assertions the target task already matched, so a corrected
 * resubmission names the same record and scope. An assertion the submission did
 * not carry stays absent, exactly as it was submitted.
 */
function moveValues(
  submittedStatus: string,
  scope: BoardScope,
  expected: TaskIdentityExpectation,
): Record<string, string> {
  const values: Record<string, string> = {
    status: submittedStatus,
    scopeKind: scope.kind,
    scopeId: scope.kind === "all" ? "" : scope.id,
  };
  for (const key of ["id", "clientId", "engagementId", "projectId"] as const) {
    if (expected[key] !== undefined) values[key] = expected[key];
  }
  return values;
}
