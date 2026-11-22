/**
 * Archival pages and actions: the exact `POST /{family}/:id/{archive|unarchive}`
 * write routes for the five flag-carrying families, the archive notice shown
 * on a record's own detail, edit and create pages, and the `/archived`
 * discovery page that groups every explicitly or effectively archived record
 * by family with its ancestry, reason and detail link.
 *
 * The URL chooses the target and the action; form fields never do. A supplied
 * `id`, `clientId`, `engagementId` or `projectId` must match the target's
 * identity and current stored ancestry (an absent optional project compares as
 * empty), and a conflicting field is refused with a plain-text validation error
 * before anything is written. Only the selected flag is stored, through the
 * store's `setArchived`; descendants are never changed.
 *
 * Visibility follows the current stored links: the helpers here derive hiding
 * from `archive.ts` and the committed snapshot on every read, so a restored
 * ancestor immediately reveals its children. Meetings carry no flag and are
 * grouped with the family of their nearest archived ancestor; a meeting hidden
 * only by its parents links to those archived ancestors for restoration.
 */
import { ancestorsOf, archivedReason, hasArchivedFlag, isEffectivelyArchived, type ArchiveRecord } from "./archive.ts";
import { escapeHtml, redirect, type Page, type Redirect } from "./html.ts";
import { MissingRecordError, ValidationError } from "./model.ts";
import type {
  Client,
  Engagement,
  Project,
  Snapshot,
  Store,
  Task,
  WorkItem,
} from "./store.ts";
import { childList, emptyState, link, pageWith, type ListEntry } from "./work-pages.ts";

/** The five flag-carrying route families, in hierarchy order. */
export type ArchiveFamily = "clients" | "engagements" | "projects" | "tasks" | "items";

/** True when `value` is one of the archivable route families. */
export function isArchiveFamily(value: unknown): value is ArchiveFamily {
  return (
    value === "clients" ||
    value === "engagements" ||
    value === "projects" ||
    value === "tasks" ||
    value === "items"
  );
}

/** The two actions a record's archive endpoint takes. */
export type ArchiveAction = "archive" | "unarchive";

/** The fixed patterns of the archive endpoints, keyed by family. */
export type ArchivePath =
  | "/clients/:id/archive"
  | "/clients/:id/unarchive"
  | "/engagements/:id/archive"
  | "/engagements/:id/unarchive"
  | "/projects/:id/archive"
  | "/projects/:id/unarchive"
  | "/tasks/:id/archive"
  | "/tasks/:id/unarchive"
  | "/items/:id/archive"
  | "/items/:id/unarchive";

/**
 * Match a request path against the exact archive endpoints. Returns the
 * matched pattern, the family, the action and the raw (undecoded) id, or null
 * for any other path so an unregistered path is refused before any handler
 * runs. A malformed or missing id is not decoded here; the action refuses it.
 */
export function matchArchivePath(
  path: string,
): { readonly pattern: ArchivePath; readonly family: ArchiveFamily; readonly action: ArchiveAction; readonly id: string } | null {
  const pathname = path.split("?")[0];
  const parts = pathname.split("/").slice(1);
  if (parts.length !== 3) return null;
  if (!isArchiveFamily(parts[0])) return null;
  if (parts[2] !== "archive" && parts[2] !== "unarchive") return null;
  if (parts[1] === "" || parts[1] === "new") return null;
  const family = parts[0];
  const action = parts[2];
  return {
    pattern: `/${family}/:id/${action}` as ArchivePath,
    family,
    action,
    id: parts[1],
  };
}

/** The route shape registered under one archive endpoint. */
export interface ArchivePathRoute {
  readonly get?: never;
  readonly post?: ArchiveRoute;
}

/** A guarded archive route; `render` runs only after the request checks pass. */
export interface ArchiveRoute {
  readonly method: "POST";
  render(request: ArchiveRequest): Promise<ArchiveResult> | ArchiveResult;
}

/** What an archive route may read from an accepted request. */
export interface ArchiveRequest {
  readonly method: "GET" | "POST";
  /** The request path including any query string. */
  readonly path: string;
  /** The form fields of an accepted POST; empty for a GET. */
  readonly form: Readonly<Record<string, string>>;
}

/** The archive route table. Only POST routes exist; a GET is refused before them. */
export interface ArchiveRoutes {
  readonly archive: ArchivePathRoute;
  readonly unarchive: ArchivePathRoute;
}

/** The store's `setArchived` kind for each route family. */
const KIND_OF_FAMILY: Readonly<Record<ArchiveFamily, "client" | "engagement" | "project" | "task" | "item">> =
  Object.freeze({
    clients: "client",
    engagements: "engagement",
    projects: "project",
    tasks: "task",
    items: "item",
  });

/** The singular name of each family, for messages. */
const NOUN_OF_FAMILY: Readonly<Record<ArchiveFamily, string>> = Object.freeze({
  clients: "client",
  engagements: "engagement",
  projects: "project",
  tasks: "task",
  items: "item",
});

/** The stored records of one family in a snapshot. */
function recordsOf(store: Store, family: ArchiveFamily): readonly { readonly id: string }[] {
  const snapshot = store.snapshot();
  switch (family) {
    case "clients":
      return snapshot.clients;
    case "engagements":
      return snapshot.engagements;
    case "projects":
      return snapshot.projects;
    case "tasks":
      return snapshot.tasks;
    case "items":
      return snapshot.items;
  }
}

/**
 * The record an archive endpoint names, decoded from the path. A malformed
 * escape or an id that names no record is a missing record (404), never a
 * malformed request, and nothing is written.
 */
export function findArchiveTarget<T extends { readonly id: string }>(
  records: readonly T[],
  rawId: string,
  noun: string,
): T {
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    throw new MissingRecordError(`No ${noun} with id ${JSON.stringify(rawId)}`);
  }
  const found = records.find((record) => record.id === id);
  if (found === undefined) {
    throw new MissingRecordError(`No ${noun} with id ${JSON.stringify(id)}`);
  }
  return found;
}

/** The client, engagement and project ids a family's record is linked by. */
function expectedLinks(
  snapshot: Snapshot,
  family: ArchiveFamily,
  id: string,
): { readonly id: string; readonly clientId: string; readonly engagementId: string; readonly projectId: string } {
  const found = (records: readonly { readonly id: string }[], noun: string) =>
    findArchiveTarget(records, id, noun);
  switch (family) {
    case "clients": {
      const client = found(snapshot.clients, "client") as Client;
      // A client is its own client: a supplied clientId must name it, and an
      // empty clientId is a conflict. It names no engagement or project.
      return { id: client.id, clientId: client.id, engagementId: "", projectId: "" };
    }
    case "engagements": {
      const engagement = found(snapshot.engagements, "engagement") as Engagement;
      return {
        id: engagement.id,
        clientId: engagement.clientId,
        engagementId: engagement.id,
        projectId: "",
      };
    }
    case "projects": {
      const project = found(snapshot.projects, "project") as Project;
      const engagement = findArchiveTarget(snapshot.engagements, project.engagementId, "engagement");
      return {
        id: project.id,
        clientId: engagement.clientId,
        engagementId: engagement.id,
        projectId: project.id,
      };
    }
    case "tasks": {
      const task = found(snapshot.tasks, "task") as Task;
      return {
        id: task.id,
        clientId: task.clientId,
        engagementId: task.engagementId,
        projectId: task.projectId ?? "",
      };
    }
    case "items": {
      const item = found(snapshot.items, "item") as WorkItem;
      return {
        id: item.id,
        clientId: item.clientId,
        engagementId: item.engagementId,
        projectId: item.projectId ?? "",
      };
    }
  }
}

/**
 * Check every supplied identity or parent field against the target's identity
 * and current ancestry. An omitted field is fine (the URL decides); a supplied
 * field must equal the target's value, and an absent optional project compares
 * as empty. A conflicting field is refused with the plain-text validation error
 * the shell turns into a 400, before any write.
 */
export function archiveConflict(
  form: Readonly<Record<string, string>>,
  expected: { readonly id: string; readonly clientId: string; readonly engagementId: string; readonly projectId: string },
  noun: string,
): ValidationError | null {
  const check = (
    name: "id" | "clientId" | "engagementId" | "projectId",
    value: string,
    label: string,
  ): ValidationError | null => {
    if (!Object.hasOwn(form, name)) return null;
    if (form[name] === value) return null;
    return new ValidationError(
      `Submitted ${name} ${JSON.stringify(form[name])} is not the ${label} of this ${noun}`,
    );
  };
  return (
    check("id", expected.id, "record") ??
    check("clientId", expected.clientId, "client") ??
    check("engagementId", expected.engagementId, "engagement") ??
    check("projectId", expected.projectId, "project")
  );
}

/** The detail path of a record in a family. */
function detailPath(family: ArchiveFamily, id: string): string {
  return `/${family}/${encodeURIComponent(id)}`;
}

/**
 * The records of a family that are not effectively archived. This is the one
 * selection every active view applies: lists, rollups, counts and histories
 * use it, so they always agree on what is visible. Direct lookups (a record's
 * own detail, edit or create page) use the full snapshot instead.
 */
export function visibleRecords<T extends ArchiveRecord>(snapshot: Snapshot, records: readonly T[]): readonly T[] {
  return records.filter((record) => !isEffectivelyArchived(snapshot, record));
}


const FLAG_OF_ACTION: Readonly<Record<ArchiveAction, boolean>> = Object.freeze({
  archive: true,
  unarchive: false,
});

/**
 * Build the archive action routes for a store. The URL names the target and the
 * action; the fields are only checked for conflicts. A save failure is not
 * caught here, so it becomes the shell's generic 500 and the committed memory
 * is left as it was.
 */
export function archiveRoutes(store: Store): ArchiveRoutes {
  async function act(request: ArchiveRequest): Promise<ArchiveResult> {
    const matched = matchArchivePath(request.path);
    if (matched === null) throw new MissingRecordError("No record for that path");
    const snapshot = store.snapshot();
    // The target must exist; a malformed escape or an unknown id is a 404.
    const target = findArchiveTarget(recordsOf(store, matched.family), matched.id, NOUN_OF_FAMILY[matched.family]);
    const expected = expectedLinks(snapshot, matched.family, target.id);
    // A conflicting identity or parent field is refused before any write; the
    // shell answers it with the existing plain-text validation error (400).
    const conflict = archiveConflict(request.form, expected, NOUN_OF_FAMILY[matched.family]);
    if (conflict !== null) throw conflict;
    await store.setArchived(KIND_OF_FAMILY[matched.family], target.id, FLAG_OF_ACTION[matched.action]);
    return redirect(detailPath(matched.family, target.id));
  }

  return {
    archive: {
      post: { method: "POST", render: (request) => act(request) },
    },
    unarchive: {
      post: { method: "POST", render: (request) => act(request) },
    },
  };
}

/** A route's result: a redirect after a write, or a correctable refusal. */
export type ArchiveResult = Redirect;

// ---------------------------------------------------------------------------
// Archive notice and forms on record pages
// ---------------------------------------------------------------------------

/**
 * The archive or restore control for a record with its own flag: a small POST
 * form to the record's exact endpoint. A record that is explicitly archived is
 * offered restoration (removing its own flag); any other record is offered
 * archiving. The control posts no fields: the URL chooses the target and the
 * action, and an omitted field is valid. The path is escaped.
 */
export function archiveControl(family: ArchiveFamily, id: string, archived: boolean): string {
  const action = `/${family}/${encodeURIComponent(id)}/${archived ? "unarchive" : "archive"}`;
  return `<form method="post" action="${escapeHtml(action)}"><button type="submit">${
    archived ? "Restore" : "Archive"
  }</button></form>`;
}

/**
 * The notice shown on a record's own detail, edit and create pages when the
 * record is effectively hidden. The notice always says the page stays usable.
 * For a record hidden by its own flag it names the record as archived and, when
 * `family` and `id` are given, offers the restore control. For a record hidden
 * only by its current stored ancestors it names the nearest archived ancestor
 * and links to that ancestor for restoration; restoring it reveals the record.
 * Everything is escaped.
 */
export function archiveNotice(
  snapshot: Snapshot,
  record: ArchiveRecord & { readonly name?: string },
  options: { readonly family?: ArchiveFamily } = {},
): string {
  if (!isEffectivelyArchived(snapshot, record)) return "";
  const reason = archivedReason(snapshot, record);
  const ancestors = ancestorsOf(snapshot, record);
  const nearestIndex = ancestors.findIndex((ancestor) => ancestor.archived === true);
  const nearest = nearestIndex === -1 ? undefined : ancestors[nearestIndex];
  const nearestFamily: ArchiveFamily | undefined =
    nearestIndex === 0 ? "clients" : nearestIndex === 1 ? "engagements" : nearestIndex === 2 ? "projects" : undefined;
  const parts: string[] = [
    '<div class="archive-notice" role="status">',
    "<p>This record is archived. It is hidden from normal lists, counts and histories, but this page stays editable.</p>",
  ];
  if (reason === "self") {
    parts.push("<p>This record carries its own archive flag.</p>");
    if (options.family !== undefined) {
      parts.push(archiveControl(options.family, record.id, true));
    }
  } else if (nearest !== undefined && nearestFamily !== undefined) {
    const name = (nearest as { readonly name?: string }).name ?? nearest.id;
    parts.push(
      `<p>It is hidden through an archived ancestor: ${link(detailPath(nearestFamily, nearest.id), name)}. Restoring that ancestor reveals it here.</p>`,
    );
  }
  parts.push("</div>");
  return parts.join("\n");
}

/**
 * The archive notice for a record a write targets, or an empty string when the
 * record is not effectively archived. The corrected page shows the same notice
 * the record's own form shows (with its restore control), so an archived
 * record's edit or create form stays usable and clearly marked after a refused
 * submission. A record that is not effectively archived has no notice.
 */
export function archiveNoticeFor(snapshot: Snapshot, record: ArchiveRecord & { readonly name?: string }, family: ArchiveFamily): string {
  if (!isEffectivelyArchived(snapshot, record)) return "";
  return archiveNotice(snapshot, record, { family });
}

// ---------------------------------------------------------------------------
// The /archived discovery page
// ---------------------------------------------------------------------------

/** One archived record as the discovery page shows it. */
export interface ArchivedEntry {
  /** The record's own family ("meetings" for a meeting, which carries no flag). */
  readonly family: ArchiveFamily | "meetings";
  /** Why it is hidden: "self", or `client:<id>`, `engagement:<id>`, `project:<id>`. */
  readonly reason: string;
  /**
   * True when the entry is hidden only through a current stored ancestor: its
   * detail link is to that archived ancestor, where restoration is offered.
   */
  readonly inheritedOnly: boolean;
  /** The detail link, with its reason badge and, when inherited, the ancestry. */
  readonly entry: ListEntry;
}

/** The headings of the discovery page, in hierarchy order: five families and meetings. */
type ArchivedGroupFamily = ArchiveFamily | "meetings";

const FAMILY_HEADINGS: readonly { readonly family: ArchivedGroupFamily; readonly title: string }[] = [
  { family: "clients", title: "Clients" },
  { family: "engagements", title: "Engagements" },
  { family: "projects", title: "Projects" },
  { family: "tasks", title: "Tasks" },
  { family: "items", title: "Work items" },
  { family: "meetings", title: "Meetings" },
];

/** A human phrase for a record's archive reason. */
function reasonText(reason: string): string {
  if (reason === "self") return "archived itself";
  const [kind, ...rest] = reason.split(":");
  const label = kind === "client" ? "client" : kind === "engagement" ? "engagement" : "project";
  return `archived through ${label} ${rest.join(":")}`;
}

/** The archived ancestor's family by hierarchy position: client, engagement, project. */
const ANCESTOR_FAMILIES: readonly ArchiveFamily[] = ["clients", "engagements", "projects"];

/** The label of an ancestry position: the family the ancestor belongs to. */
function ancestorLabel(family: ArchiveFamily): string {
  return family === "clients" ? "Client" : family === "engagements" ? "Engagement" : "Project";
}

/**
 * The record's current stored ancestry, most significant first (client,
 * engagement, project), as one text chain. Every entry renders its stored
 * ancestry, whether it carries its own archive flag or is hidden only through
 * ancestors, and each ancestor's name links to its own detail page. The chain
 * is escaped markup; a record with no stored ancestors has none.
 */
function ancestryChain(snapshot: Snapshot, record: ArchiveRecord): string {
  const parts: string[] = [];
  for (const [index, ancestor] of ancestorsOf(snapshot, record).entries()) {
    const family = ANCESTOR_FAMILIES[index];
    const name = (ancestor as { readonly name?: string }).name ?? ancestor.id;
    parts.push(`${ancestorLabel(family)}: ${link(detailPath(family, ancestor.id), name)}`);
  }
  return parts.join(" · ");
}

/**
 * The current stored archived ancestors of a record, most significant first.
 * These are the restoration targets for an inherited-only entry: opening one
 * offers restoration, and restoring it can reveal this record. A record archived
 * by its own flag has no restoration targets here; restoring its own flag is
 * offered on its own detail page.
 */
function archivedAncestorLinks(snapshot: Snapshot, record: ArchiveRecord): readonly ListEntry[] {
  const links: ListEntry[] = [];
  for (const [index, ancestor] of ancestorsOf(snapshot, record).entries()) {
    if (!hasArchivedFlag(ancestor)) continue;
    const family = ANCESTOR_FAMILIES[index];
    const name = (ancestor as { readonly name?: string }).name ?? ancestor.id;
    links.push({ href: detailPath(family, ancestor.id), label: name });
  }
  return links;
}
/** One record to place on the discovery page. */
interface DiscoveryCandidate {
  /** The record's own family heading ("meetings" for a meeting). */
  readonly family: ArchiveFamily | "meetings";
  /** The stored id of the record. */
  readonly id: string;
  readonly label: string;
  /** The detail link to the record itself. */
  readonly href: string;
  /** Extra badges beside the reason (a meeting's date, for example). */
  readonly badges?: readonly string[];
}

/**
 * Group every explicitly or effectively archived record of the workspace by
 * family. This is the one place the rule is applied, for all five families and
 * for meetings, so the headings, badges and links always agree.
 *
 * A record is grouped under its own family heading (Clients, Engagements,
 * Projects, Tasks, Work items or Meetings) and always links to its own detail
 * page. Its reason names why it is hidden: `self` for its own flag, or the
 * nearest archived ancestor. An inherited-only record (hidden only through a
 * current stored ancestor, including a meeting, which never carries a flag)
 * also lists each current stored archived ancestor, most significant first, with
 * its own detail link, where that ancestor is restored; restoring an ancestor
 * can reveal its descendants but never changes their own flags. Records appear
 * exactly once.
 */
export function archivedGroups(snapshot: Snapshot): readonly {
  readonly family: ArchivedGroupFamily;
  readonly title: string;
  readonly entries: readonly ArchivedEntry[];
}[] {
  const groups = FAMILY_HEADINGS.map((heading) => ({
    family: heading.family,
    title: heading.title,
    entries: [] as ArchivedEntry[],
  }));
  const byFamily = new Map(groups.map((group) => [group.family, group]));

  const place = (candidate: DiscoveryCandidate): void => {
    const record = recordFor(snapshot, candidate.family, candidate.id);
    if (record === undefined) return;
    const reason = archivedReason(snapshot, record);
    if (reason === null) return;
    const ownFlag = reason === "self";
    // Every record sits under the heading of its own family; nothing is moved
    // to the ancestor's heading, so the groups are the families' own archives.
    const group = byFamily.get(candidate.family);
    if (group === undefined) return;
    // Every entry renders its stored ancestry; an inherited-only entry also
    // links each current stored archived ancestor as a restoration target.
    const chain = ancestryChain(snapshot, record);
    const restore = ownFlag ? [] : archivedAncestorLinks(snapshot, record);
    const trailing = [
      chain,
      restore.length === 0
        ? ""
        : `${restore.map((ancestor) => link(ancestor.href, ancestor.label)).join(", ")} — restore archived ancestors there`,
    ].filter((part) => part !== "").join(" · ");
    const entry: ListEntry = {
      href: candidate.href,
      label: candidate.label,
      badges: [...(candidate.badges ?? []), reasonText(reason)],
      ...(trailing === "" ? {} : { trailing }),
    };
    group.entries.push({
      family: candidate.family,
      reason,
      inheritedOnly: !ownFlag,
      entry,
    });
  };

  for (const client of snapshot.clients) {
    place({ family: "clients", id: client.id, label: client.name, href: detailPath("clients", client.id) });
  }
  for (const engagement of snapshot.engagements) {
    place({ family: "engagements", id: engagement.id, label: engagement.name, href: detailPath("engagements", engagement.id) });
  }
  for (const project of snapshot.projects) {
    place({ family: "projects", id: project.id, label: project.name, href: detailPath("projects", project.id) });
  }
  for (const task of snapshot.tasks) {
    place({ family: "tasks", id: task.id, label: task.title, href: detailPath("tasks", task.id) });
  }
  for (const item of snapshot.items) {
    place({ family: "items", id: item.id, label: item.title, href: detailPath("items", item.id) });
  }
  for (const meeting of snapshot.meetings) {
    place({
      family: "meetings",
      id: meeting.id,
      label: meeting.title,
      href: `/meetings/${encodeURIComponent(meeting.id)}`,
      badges: [`meeting ${meeting.date}`],
    });
  }
  return groups.filter((group) => group.entries.length > 0);
}

/** The stored record a discovery candidate names, for its archive reason. */
function recordFor(
  snapshot: Snapshot,
  family: ArchiveFamily | "meetings",
  id: string,
): ArchiveRecord | undefined {
  // A meeting is placed under its nearest archived ancestor's heading but is
  // found in the meetings collection; it carries no flag of its own.
  if (family === "meetings") {
    return snapshot.meetings.find((candidate) => candidate.id === id);
  }
  const records: readonly ArchiveRecord[] =
    family === "clients"
      ? snapshot.clients
      : family === "engagements"
        ? snapshot.engagements
        : family === "projects"
          ? snapshot.projects
          : family === "tasks"
            ? snapshot.tasks
            : snapshot.items;
  return records.find((record) => record.id === id);
}

/** The discovery page: archived records grouped by family, or an empty state. */
export function archivedPage(store: Store): Page {
  const snapshot = store.snapshot();
  const groups = archivedGroups(snapshot);
  const links = [
    { label: "Home", href: "/" },
    { label: "Clients", href: "/clients" },
    { label: "Archived", href: "/archived" },
  ];
  const sections = groups.map((group) => ({
    title: group.title,
    body: childList(group.entries.map((entry) => entry.entry)),
  }));
  if (sections.length === 0) {
    sections.push({
      title: "Archived records",
      body: emptyState(
        "No archived records yet. Archiving a client, engagement, project, task or work item hides it from normal lists, counts and histories; it appears here.",
        { href: "/clients", label: "Go to Clients" },
      ),
    });
  }
  return pageWith("Archived", links, sections);
}

/** The `/archived` page route table: GET only, no write endpoint. */
export interface ArchivedRoutes {
  readonly archived: { readonly get: { readonly method: "GET"; render(): Page } };
}

/** Build the `/archived` page route for a store. */
export function archivedRoutes(store: Store): ArchivedRoutes {
  return {
    archived: { get: { method: "GET", render: () => archivedPage(store) } },
  };
}
