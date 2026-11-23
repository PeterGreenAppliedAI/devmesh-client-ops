/**
 * The home dashboard: what needs attention across every client, computed from
 * one full stored snapshot.
 *
 * The selector is pure and takes its reference date as an injected clock, so a
 * caller (a test, or the server) chooses "today" rather than a module reading
 * it. Dates are calendar days: they are parsed and compared as YYYY-MM-DD
 * strings, so a task due yesterday stays overdue across the night and a task
 * due today is not "overdue" because a 24-hour interval has not elapsed. The
 * server hands this module the day from its own local calendar.
 *
 * Nothing here reads or writes the store: the snapshot is the read, and the
 * result is a fresh value, so a dashboard render cannot mutate a record.
 *
 * The board keeps the six original attention sections in their order and adds
 * the sections the owner asked for: high-priority actionable tasks, waiting
 * tasks, open follow-ups, recent activity and the unfinished engagements. A
 * record may qualify for more than one section (a dated waiting task is both
 * overdue/due soon and waiting), but it is listed at most once within any one
 * section.
 */
import { isEffectivelyArchived, type ArchiveState } from "./archive.ts";
import { selectRecentActivity, type ActivityEvent, type ActivityTargetKind } from "./activity.ts";
import { escapeHtml, renderPage, type Page } from "./html.ts";
import type { Snapshot, WorkItem } from "./store.ts";
import { link } from "./work-pages.ts";

/** The attention sections, in the order the home page shows them. */
export type DashboardSectionKind =
  | "overdue"
  | "due_soon"
  | "blocker"
  | "question"
  | "commitment"
  | "waiting"
  | "high_priority"
  | "waiting_tasks"
  | "follow_up"
  | "recent_activity"
  | "engagement";

/** How many calendar days ahead of today "due soon" extends (today + 7). */
export const DUE_SOON_DAYS = 7;

/**
 * One qualifying record: where it links, what it says and who owns it.
 *
 * A task or item row links its own record and its actual client, engagement
 * and (when it has one) project. An engagement row (kind "engagement") links
 * its engagement and client. A recent-activity row (kind "activity") links its
 * current target record, its client and (unless the target is a client) its
 * engagement.
 */
export interface DashboardRow {
  readonly kind: "task" | "item" | "engagement" | "activity";
  readonly id: string;
  readonly title: string;
  /** The record's detail URL, internal and already escaped. */
  readonly href: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly engagementId: string;
  readonly engagementName: string;
  /** The actual project the record belongs to, when it has one. */
  readonly projectId?: string;
  readonly projectName?: string;
  /** The task's due date, or the work item's kind text; shown as-is. */
  readonly detail: string;
  /** For a task, its status and priority; for an item, its kind and state. */
  readonly badges: readonly string[];
  /** For a recent-activity row, the action performed. */
  readonly action?: string;
  /** For a recent-activity row, the record family of its current target. */
  readonly targetKind?: ActivityTargetKind;
}

/** One section: its kind, title, rows (in display order) and range text. */
export interface DashboardSection {
  readonly kind: DashboardSectionKind;
  readonly title: string;
  readonly rows: readonly DashboardRow[];
  /**
   * The actual calendar range the section covers, such as
   * "2026-11-22 to 2026-11-29", or null for a section that has no range.
   */
  readonly range: string | null;
  /**
   * False for a section whose rows are not workspace records needing attention
   * (recent activity and the engagement overview), so its empty state says so
   * rather than offering the client list as a next step.
   */
  readonly attention?: boolean;
}

/** The dashboard's result: the reference day and the sections in order. */
export interface Dashboard {
  readonly today: string;
  readonly sections: readonly DashboardSection[];
}

const SECTION_TITLES: Readonly<Record<DashboardSectionKind, string>> = Object.freeze({
  overdue: "Overdue tasks",
  due_soon: "Tasks due soon",
  blocker: "Open blockers",
  question: "Open questions",
  commitment: "Open commitments",
  waiting: "Open waiting items",
  high_priority: "High-priority tasks",
  waiting_tasks: "Waiting tasks",
  follow_up: "Open follow-ups",
  recent_activity: "Recent activity",
  engagement: "Engagements in progress",
});

/** The work-item kinds that have their own attention section; decisions do not. */
const ITEM_SECTION_KINDS: ReadonlySet<string> = new Set([
  "blocker",
  "question",
  "commitment",
  "waiting",
  "follow_up",
]);

/**
 * The task statuses that count as actionable: high-priority tasks are shown
 * only when open or in progress, never when waiting or done.
 */
const ACTIONABLE_TASK_STATUSES: ReadonlySet<string> = new Set(["open", "in_progress"]);

/** The engagement statuses that are unfinished: planned, active and on hold. */
const UNFINISHED_ENGAGEMENT_STATUSES: ReadonlySet<string> = new Set([
  "planned",
  "active",
  "on_hold",
]);

/**
 * True when `value` is a real YYYY-MM-DD calendar date. The selector compares
 * dates as strings, which only orders correctly for well-formed dates, so an
 * unexpected stored value is refused rather than silently misordered.
 */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const monthLength = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const limit = month === 2 && leap ? 29 : monthLength;
  return day >= 1 && day <= limit;
}

/** The calendar day `days` days after `date`; negative values go backwards. */
export function addCalendarDays(date: string, days: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  // Date.UTC is pure calendar arithmetic; the result is read back through the
  // UTC getters so no local time zone can shift the day. Date.UTC maps years
  // 0-99 to 1900-1999, so `new Date(0)` is first given the literal year through
  // setUTCFullYear (with the time of day kept), then the day offset is added.
  const shifted = new Date(0);
  shifted.setUTCFullYear(year, month - 1, day);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  const yyyy = String(shifted.getUTCFullYear()).padStart(4, "0");
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * The server's local calendar day as YYYY-MM-DD. Local getters are used on
 * purpose: the day the server's own calendar shows is the reference the owner
 * asked for, not a UTC day that may differ near midnight.
 */
export function localCalendarToday(now: Date = new Date()): string {
  const yyyy = String(now.getFullYear()).padStart(4, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function byId<T extends { readonly id: string }>(records: readonly T[]): Map<string, T> {
  return new Map(records.map((record) => [record.id, record]));
}

/**
 * True when `at` is a canonical UTC instant (YYYY-MM-DDTHH:MM:SS.mmmZ). The
 * dashboard orders activity by this stored text, which only compares
 * chronologically for that exact shape, so any other value is refused.
 */
function isCanonicalInstant(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) && text.length === 24;
}

/** The detail route path of a record family's current target. */
function targetHref(kind: ActivityTargetKind, id: string): string {
  const family = kind === "item" ? "items" : `${kind}s`;
  return `/${family}/${encodeURIComponent(id)}`;
}

/** The current display title of a record family's target. */
function targetTitle(
  kind: ActivityTargetKind,
  record: { readonly title?: string; readonly name?: string },
): string {
  if (kind === "client" || kind === "engagement" || kind === "project") {
    return record.name ?? "";
  }
  return record.title ?? "";
}

/**
 * Compute the attention sections from one snapshot at one reference day.
 *
 * Tasks are eligible for the date sections when they are open, in progress or
 * waiting and carry a due date; done and undated tasks never appear there.
 * Overdue is a date before today, due soon is today through today+7 inclusive
 * (eight calendar dates). High-priority tasks are open or in progress tasks of
 * high priority, dated or not, ordered by due date then id with undated tasks
 * last; normal and low tasks never fall back into this section. Waiting tasks
 * are every waiting task (dated or undated) and are eligible for the date
 * sections too. Items are eligible when their kind has a section and their
 * state is open; decisions have no section. Unfinished engagements are the
 * planned, active and on-hold ones, ordered by client name, engagement name
 * and id. Recent activity is the latest 20 visible events. Effectively
 * archived records (the record's own flag or any of its current ancestors')
 * are excluded throughout.
 *
 * Task groups are sorted by ascending due date (undated last), then by id.
 * Item groups keep the snapshot's own order, so the rows are exactly the
 * qualifying records in the order the store reported them, never truncated.
 */
export function selectDashboard(
  snapshot: Snapshot,
  referenceDate: string,
): Dashboard {
  if (!isCalendarDate(referenceDate)) {
    throw new Error(`reference date must be a YYYY-MM-DD calendar date, got ${JSON.stringify(referenceDate)}`);
  }
  const state: ArchiveState = snapshot;
  const clients = byId(snapshot.clients);
  const engagements = byId(snapshot.engagements);
  const projects = byId(snapshot.projects);
  const lastDueSoon = addCalendarDays(referenceDate, DUE_SOON_DAYS);

  // The ancestry of a record: its client and its engagement. The store refuses
  // broken parent links on open, so a missing one is simply absent here.
  const ancestryOf = (
    record: { readonly clientId: string; readonly engagementId: string },
  ): { clientName: string; engagementName: string } | null => {
    const client = clients.get(record.clientId);
    const engagement = engagements.get(record.engagementId);
    if (client === undefined || engagement === undefined) return null;
    return { clientName: client.name, engagementName: engagement.name };
  };

  // The actual project a task or item belongs to, when its link resolves. A
  // record whose project is directly archived is itself effectively archived
  // and never reaches a row, so a shown project link always names a visible
  // project.
  const projectOf = (
    record: { readonly projectId?: string },
  ): { projectId: string; projectName: string } | null => {
    if (record.projectId === undefined) return null;
    const project = projects.get(record.projectId);
    if (project === undefined) return null;
    return { projectId: project.id, projectName: project.name };
  };

  const taskRow = (task: Snapshot["tasks"][number]): DashboardRow | null => {
    const names = ancestryOf(task);
    if (names === null) return null;
    const project = projectOf(task);
    const row: DashboardRow = {
      kind: "task",
      id: task.id,
      title: task.title,
      href: `/tasks/${encodeURIComponent(task.id)}`,
      clientId: task.clientId,
      clientName: names.clientName,
      engagementId: task.engagementId,
      engagementName: names.engagementName,
      detail: task.dueDate ?? "",
      badges: [task.status, task.priority],
    };
    return project === null ? row : { ...row, ...project };
  };

  const itemRow = (item: WorkItem): DashboardRow | null => {
    const names = ancestryOf(item);
    if (names === null) return null;
    const project = projectOf(item);
    const row: DashboardRow = {
      kind: "item",
      id: item.id,
      title: item.title,
      href: `/items/${encodeURIComponent(item.id)}`,
      clientId: item.clientId,
      clientName: names.clientName,
      engagementId: item.engagementId,
      engagementName: names.engagementName,
      detail: item.kind,
      badges: [item.kind, item.state],
    };
    return project === null ? row : { ...row, ...project };
  };

  const engagementRow = (engagement: Snapshot["engagements"][number]): DashboardRow | null => {
    const client = clients.get(engagement.clientId);
    if (client === undefined) return null;
    return {
      kind: "engagement",
      id: engagement.id,
      title: engagement.name,
      href: `/engagements/${encodeURIComponent(engagement.id)}`,
      clientId: client.id,
      clientName: client.name,
      engagementId: engagement.id,
      engagementName: engagement.name,
      detail: engagement.status,
      badges: [engagement.status],
    };
  };

  const visibleTasks = snapshot.tasks.filter((task) => !isEffectivelyArchived(state, task));
  const datedTasks = visibleTasks.filter(
    (task) =>
      (task.status === "open" ||
        task.status === "in_progress" ||
        task.status === "waiting") &&
      task.dueDate !== undefined &&
      isCalendarDate(task.dueDate),
  );

  const overdueTasks = datedTasks
    .filter((task) => (task.dueDate as string) < referenceDate)
    .sort(compareTasks);
  const dueSoonTasks = datedTasks
    .filter(
      (task) =>
        (task.dueDate as string) >= referenceDate &&
        (task.dueDate as string) <= lastDueSoon,
    )
    .sort(compareTasks);

  const highPriorityTasks = visibleTasks
    .filter((task) => task.priority === "high" && ACTIONABLE_TASK_STATUSES.has(task.status))
    .sort(compareTasks);

  const waitingTasks = visibleTasks
    .filter((task) => task.status === "waiting")
    .sort(compareTasks);

  const eligibleItems = snapshot.items.filter(
    (item) =>
      item.state === "open" &&
      ITEM_SECTION_KINDS.has(item.kind) &&
      !isEffectivelyArchived(state, item),
  );

  const unfinishedEngagements = snapshot.engagements
    .filter(
      (engagement) =>
        UNFINISHED_ENGAGEMENT_STATUSES.has(engagement.status) &&
        !isEffectivelyArchived(state, engagement),
    )
    .sort((left, right) => {
      const clientA = clients.get(left.clientId)?.name ?? "";
      const clientB = clients.get(right.clientId)?.name ?? "";
      if (clientA < clientB) return -1;
      if (clientA > clientB) return 1;
      if (left.name < right.name) return -1;
      if (left.name > right.name) return 1;
      if (left.id < right.id) return -1;
      if (left.id > right.id) return 1;
      return 0;
    });

  // The recent-activity rows resolve each visible event's current target, so
  // the label and links are the record as it is now, never a stored history.
  const activityRow = (event: ActivityEvent): DashboardRow | null => {
    const kind = event.targetKind;
    const records = snapshot[`${kind}s` as keyof Snapshot] as
      | readonly { id: string }[]
      | undefined;
    if (records === undefined) return null;
    const record = records.find((candidate) => candidate.id === event.targetId);
    if (record === undefined) return null;
    const target = record as unknown as {
      readonly id: string;
      readonly title?: string;
      readonly name?: string;
      readonly clientId?: string;
      readonly engagementId?: string;
    };
    // A client has no parent; every other family carries its client and
    // engagement links, while a project names only its engagement and reaches
    // its client through the engagement's own stored link, exactly as the
    // archive helpers do.
    const engagementId =
      kind === "client" ? "" : target.engagementId ?? "";
    const clientId =
      kind === "client"
        ? target.id
        : target.clientId ?? engagements.get(engagementId)?.clientId ?? "";
    const client = clients.get(clientId);
    const engagement = engagements.get(engagementId);
    if (client === undefined) return null;
    if (kind !== "client" && engagement === undefined) return null;
    return {
      kind: "activity",
      id: String(event.id),
      title: targetTitle(kind, target),
      href: targetHref(kind, event.targetId),
      clientId: client.id,
      clientName: client.name,
      engagementId,
      engagementName: engagement?.name ?? "",
      detail: event.at,
      badges: [kind],
      action: event.action,
      targetKind: kind,
    };
  };
  // A stored timestamp that cannot be ordered would silently misorder the
  // activity, so it is refused rather than guessed at; the response boundary
  // then answers with its generic 500.
  const journal = snapshot.activity ?? [];
  if (!journal.every((event) => isCanonicalInstant(event.at))) {
    throw new Error("stored activity timestamp is not a canonical UTC instant");
  }
  const activityRows = selectRecentActivity(snapshot)
    .map(activityRow)
    .filter((row): row is DashboardRow => row !== null);

  const rowsOf = (
    tasks: readonly Snapshot["tasks"][number][],
    items: readonly WorkItem[] = [],
    engagements: readonly Snapshot["engagements"][number][] = [],
  ): readonly DashboardRow[] => [
    ...tasks.map(taskRow).filter((row): row is DashboardRow => row !== null),
    ...items.map(itemRow).filter((row): row is DashboardRow => row !== null),
    ...engagements.map(engagementRow).filter((row): row is DashboardRow => row !== null),
  ];

  const itemRows = (kind: string): readonly DashboardRow[] =>
    rowsOf([], eligibleItems.filter((item) => item.kind === kind));

  return {
    today: referenceDate,
    sections: [
      {
        kind: "overdue",
        title: SECTION_TITLES.overdue,
        rows: rowsOf(overdueTasks),
        // Overdue spans every date before today; its actual range runs from the
        // earliest overdue due date through yesterday.
        range:
          overdueTasks.length === 0
            ? null
            : `${overdueTasks[0].dueDate} to ${addCalendarDays(referenceDate, -1)}`,
      },
      {
        kind: "due_soon",
        title: SECTION_TITLES.due_soon,
        rows: rowsOf(dueSoonTasks),
        range: `${referenceDate} to ${lastDueSoon}`,
      },
      {
        kind: "blocker",
        title: SECTION_TITLES.blocker,
        rows: itemRows("blocker"),
        range: null,
      },
      {
        kind: "question",
        title: SECTION_TITLES.question,
        rows: itemRows("question"),
        range: null,
      },
      {
        kind: "commitment",
        title: SECTION_TITLES.commitment,
        rows: itemRows("commitment"),
        range: null,
      },
      {
        kind: "waiting",
        title: SECTION_TITLES.waiting,
        rows: itemRows("waiting"),
        range: null,
      },
      {
        kind: "high_priority",
        title: SECTION_TITLES.high_priority,
        rows: rowsOf(highPriorityTasks),
        range: null,
      },
      {
        kind: "waiting_tasks",
        title: SECTION_TITLES.waiting_tasks,
        rows: rowsOf(waitingTasks),
        range: null,
      },
      {
        kind: "follow_up",
        title: SECTION_TITLES.follow_up,
        rows: itemRows("follow_up"),
        range: null,
      },
      {
        kind: "recent_activity",
        title: SECTION_TITLES.recent_activity,
        rows: activityRows,
        range: null,
        attention: false,
      },
      {
        kind: "engagement",
        title: SECTION_TITLES.engagement,
        rows: rowsOf([], [], unfinishedEngagements),
        range: null,
        attention: false,
      },
    ],
  };
}

/**
 * Ascending due date, then ascending id, for a task-like row. Undated tasks
 * sort after every dated one, as the owner asked.
 */
function compareTasks(
  left: { readonly dueDate?: string; readonly id: string },
  right: { readonly dueDate?: string; readonly id: string },
): number {
  const a = left.dueDate ?? null;
  const b = right.dueDate ?? null;
  if (a !== b) {
    if (a === null) return 1;
    if (b === null) return -1;
    return a < b ? -1 : 1;
  }
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

/** The empty-state sentence for a section: nothing needs attention there. */
function emptyMessage(section: DashboardSection): string {
  switch (section.kind) {
    case "overdue":
      return "No tasks are overdue. Nothing needs attention here.";
    case "due_soon":
      return "No tasks are due in this range. Nothing needs attention here.";
    case "recent_activity":
      return "No recorded activity yet.";
    case "engagement":
      return "No unfinished engagements (planned, active or on hold).";
    default:
      return `No open ${section.title.replace(/^Open /, "").toLowerCase()} here. Nothing needs attention here.`;
  }
}

/** One task or item row as a card: its record link, then its ancestry. */
function renderRecordRow(row: DashboardRow): string {
  const badges = row.badges.map((text) => `<span class="badge">${escapeHtml(text)}</span>`).join(" ");
  const client = `client ${link(`/clients/${encodeURIComponent(row.clientId)}`, row.clientName)}`;
  const engagement = `engagement ${link(`/engagements/${encodeURIComponent(row.engagementId)}`, row.engagementName)}`;
  const project =
    row.projectId === undefined
      ? ""
      : ` · project ${link(`/projects/${encodeURIComponent(row.projectId)}`, row.projectName ?? "")}`;
  const detail = row.kind === "task" ? `due ${row.detail}` : row.detail;
  return [
    `<li class="card">`,
    link(row.href, row.title),
    ` ${badges}`,
    ` <span class="detail">${escapeHtml(detail)}</span>`,
    ` <span class="ancestry">${client} · ${engagement}${project}</span>`,
    `</li>`,
  ].join("");
}

/** One engagement row as a card: its engagement link, then its client link. */
function renderEngagementRow(row: DashboardRow): string {
  const client = `client ${link(`/clients/${encodeURIComponent(row.clientId)}`, row.clientName)}`;
  return [
    `<li class="card">`,
    link(row.href, row.title),
    ` <span class="badge">${escapeHtml(row.detail)}</span>`,
    ` <span class="ancestry">${client}</span>`,
    `</li>`,
  ].join("");
}

/**
 * One recent-activity row as a card: the current target's record link with its
 * current label, the action, the timestamp and the ancestry links.
 */
function renderActivityRow(row: DashboardRow): string {
  const target = link(row.href, row.title);
  const client = link(`/clients/${encodeURIComponent(row.clientId)}`, row.clientName);
  const ancestry =
    row.targetKind === "client"
      ? `client ${client}`
      : `client ${client} · engagement ${link(`/engagements/${encodeURIComponent(row.engagementId)}`, row.engagementName)}`;
  return [
    `<li class="card">`,
    `<span class="action">${escapeHtml(row.action ?? "")}</span> `,
    `<span class="target">${target}</span>`,
    ` <span class="detail">${escapeHtml(row.detail)}</span>`,
    ` <span class="ancestry">${ancestry}</span>`,
    `</li>`,
  ].join("");
}

function renderRow(row: DashboardRow): string {
  switch (row.kind) {
    case "engagement":
      return renderEngagementRow(row);
    case "activity":
      return renderActivityRow(row);
    default:
      return renderRecordRow(row);
  }
}

function renderSection(section: DashboardSection): string {
  const heading = `<h2>${escapeHtml(section.title)}</h2>`;
  const range = section.range === null ? "" : `<p class="range">${escapeHtml(section.range)}</p>`;
  if (section.rows.length === 0) {
    const browse =
      section.attention === false ? "" : `\n<p>${link("/clients", "Browse clients")}</p>`;
    return `<section>${heading}${range}<p>${escapeHtml(emptyMessage(section))}</p>${browse}</section>`;
  }
  return `<section>${heading}${range}<ul class="card-list">${section.rows.map(renderRow).join("")}</ul></section>`;
}

/**
 * Render the dashboard as a page. The snapshot is read once; the reference day
 * is the given clock's local calendar day. The page is built through
 * `renderPage` so the server wraps it in the shared shell exactly as the other
 * pages are, and every stored value is escaped.
 */
export function renderDashboard(
  snapshot: Snapshot,
  now: Date = new Date(),
): Page {
  const dashboard = selectDashboard(snapshot, localCalendarToday(now));
  const body = [
    `<p>Attention across the workspace as of ${escapeHtml(dashboard.today)}.</p>`,
    ...dashboard.sections.map(renderSection),
  ].join("\n");
  return renderPage("Client operations", body);
}
