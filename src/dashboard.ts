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
 */
import { isEffectivelyArchived, type ArchiveState } from "./archive.ts";
import { escapeHtml, renderPage, type Page } from "./html.ts";
import type { Snapshot, WorkItem } from "./store.ts";
import { link } from "./work-pages.ts";

/** The six attention sections, in the order the home page shows them. */
export type DashboardSectionKind =
  | "overdue"
  | "due_soon"
  | "blocker"
  | "question"
  | "commitment"
  | "waiting";

/** How many calendar days ahead of today "due soon" extends (today + 7). */
export const DUE_SOON_DAYS = 7;

/** One qualifying record: where it links, what it says and who owns it. */
export interface DashboardRow {
  readonly kind: "task" | "item";
  readonly id: string;
  readonly title: string;
  /** The record's detail URL, internal and already escaped. */
  readonly href: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly engagementId: string;
  readonly engagementName: string;
  /** The task's due date, or the work item's kind text; shown as-is. */
  readonly detail: string;
  /** For a task, its status; for an item, its kind and state. */
  readonly badges: readonly string[];
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
}

/** The dashboard's result: the reference day and the six sections in order. */
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
});

/** The work-item kinds that have their own section; decisions and follow-ups do not. */
const ITEM_SECTION_KINDS: ReadonlySet<string> = new Set(["blocker", "question", "commitment", "waiting"]);

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
  // UTC getters so no local time zone can shift the day.
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
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
 * Compute the six attention sections from one snapshot at one reference day.
 *
 * Tasks are eligible when they are open or in progress and carry a due date;
 * done and undated tasks never appear. Overdue is a date before today, due
 * soon is today through today+7 inclusive (eight calendar dates). Items are
 * eligible when their kind has a section and their state is open; decisions
 * and follow-ups have no section. Effectively archived records (the record's
 * own flag or any of its current ancestors') are excluded throughout.
 *
 * Task groups are sorted by ascending due date, then by id. Item groups keep
 * the snapshot's own order, so the rows are exactly the qualifying records in
 * the order the store reported them, never truncated.
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

  const taskRow = (task: Snapshot["tasks"][number]): DashboardRow | null => {
    const names = ancestryOf(task);
    if (names === null) return null;
    return {
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
  };

  const itemRow = (item: WorkItem): DashboardRow | null => {
    const names = ancestryOf(item);
    if (names === null) return null;
    return {
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
  };

  const eligibleTasks = snapshot.tasks
    .filter((task) => !isEffectivelyArchived(state, task))
    .filter(
      (task) =>
        (task.status === "open" || task.status === "in_progress") &&
        task.dueDate !== undefined &&
        isCalendarDate(task.dueDate),
    );

  const overdueTasks = eligibleTasks
    .filter((task) => (task.dueDate as string) < referenceDate)
    .sort(compareTasks);
  const dueSoonTasks = eligibleTasks
    .filter(
      (task) =>
        (task.dueDate as string) >= referenceDate &&
        (task.dueDate as string) <= lastDueSoon,
    )
    .sort(compareTasks);

  const eligibleItems = snapshot.items.filter(
    (item) =>
      item.state === "open" &&
      ITEM_SECTION_KINDS.has(item.kind) &&
      !isEffectivelyArchived(state, item),
  );

  const rowsOf = (
    tasks: readonly Snapshot["tasks"][number][],
    items: readonly WorkItem[] = [],
  ): readonly DashboardRow[] => [
    ...tasks.map(taskRow).filter((row): row is DashboardRow => row !== null),
    ...items.map(itemRow).filter((row): row is DashboardRow => row !== null),
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
    ],
  };
}

/** Ascending due date, then ascending id, for a task-like row. */
function compareTasks(
  left: { readonly dueDate?: string; readonly id: string },
  right: { readonly dueDate?: string; readonly id: string },
): number {
  const a = left.dueDate ?? "";
  const b = right.dueDate ?? "";
  if (a < b) return -1;
  if (a > b) return 1;
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
    default:
      return `No open ${section.title.replace(/^Open /, "").toLowerCase()} here. Nothing needs attention here.`;
  }
}

/** One row rendered as a card: its record link, then its client and engagement. */
function renderRow(row: DashboardRow): string {
  const badges = row.badges.map((text) => `<span class="badge">${escapeHtml(text)}</span>`).join(" ");
  const client = `client ${link(`/clients/${encodeURIComponent(row.clientId)}`, row.clientName)}`;
  const engagement = `engagement ${link(`/engagements/${encodeURIComponent(row.engagementId)}`, row.engagementName)}`;
  const detail = row.kind === "task" ? `due ${row.detail}` : row.detail;
  return [
    `<li class="card">`,
    link(row.href, row.title),
    ` ${badges}`,
    ` <span class="detail">${escapeHtml(detail)}</span>`,
    ` <span class="ancestry">${client} · ${engagement}</span>`,
    `</li>`,
  ].join("");
}

function renderSection(section: DashboardSection): string {
  const heading = `<h2>${escapeHtml(section.title)}</h2>`;
  const range = section.range === null ? "" : `<p class="range">${escapeHtml(section.range)}</p>`;
  const body =
    section.rows.length === 0
      ? `<p>${escapeHtml(emptyMessage(section))}</p>\n<p>${link("/clients", "Browse clients")}</p>`
      : `<ul class="card-list">${section.rows.map(renderRow).join("")}</ul>`;
  return `<section>${heading}${range}${body}</section>`;
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
