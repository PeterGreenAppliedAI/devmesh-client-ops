/**
 * Archival: an optional flag on clients, engagements, projects, tasks and
 * work items. Only `true` marks a record archived; restoring a record removes
 * the flag. A record's effective archival is the flag on the record itself or
 * on any of its current stored ancestors (client > engagement > optional
 * project). Meetings never carry a flag; they inherit the visibility of their
 * parents.
 *
 * This module only holds the record kinds and the pure helpers. The store owns
 * the mutations and the persistence.
 */
import { ValidationError, type Client, type Engagement, type Project } from "./model.ts";

/** The record families that can carry an archival flag. */
export type ArchiveKind = "client" | "engagement" | "project" | "task" | "item";

/** The five archival record kinds, in hierarchy order. */
export const ARCHIVE_KINDS: readonly ArchiveKind[] = [
  "client",
  "engagement",
  "project",
  "task",
  "item",
];

/** True when `value` is one of the archival record kinds. */
export function isArchiveKind(value: unknown): value is ArchiveKind {
  return typeof value === "string" && (ARCHIVE_KINDS as readonly string[]).includes(value);
}

/**
 * Validate `setArchived` arguments before any lookup. An unknown kind, a
 * nonboolean flag or a nonstring/blank id is refused here; whether the id names
 * an existing record is the store's separate check.
 */
export function requireArchiveArguments(
  kind: unknown,
  id: unknown,
  archived: unknown,
): { kind: ArchiveKind; id: string; archived: boolean } {
  if (!isArchiveKind(kind)) {
    throw new ValidationError(
      `archive kind must be one of ${ARCHIVE_KINDS.join(", ")}`,
    );
  }
  if (typeof archived !== "boolean") {
    throw new ValidationError("archived must be a boolean");
  }
  if (typeof id !== "string" || id.trim() === "") {
    throw new ValidationError("id must be a nonblank string");
  }
  return { kind, id, archived };
}

/** A stored hierarchy record: the parts the helpers need to walk the tree. */
export type ArchiveHierarchyRecord =
  | Pick<Client, "id" | "archived">
  | Pick<Engagement, "id" | "archived" | "clientId">
  | Pick<Project, "id" | "archived" | "engagementId">;

/** A stored work record (task or item), whose parent chain is resolved by id. */
export interface ArchiveWorkRecord {
  readonly id: string;
  readonly clientId: string;
  readonly engagementId: string;
  readonly projectId?: string;
  readonly archived?: boolean;
}

/** A stored meeting: it has no flag but inherits visibility from its parents. */
export interface ArchiveMeetingRecord {
  readonly id: string;
  readonly clientId: string;
  readonly engagementId: string;
  readonly projectId?: string;
}

/**
 * The current stored hierarchy, plus the work records (tasks, items) and
 * meetings whose parent chains are resolved against it. This is normally a
 * `Snapshot`; the helpers never need the counters.
 */
export interface ArchiveState {
  readonly clients: readonly Pick<Client, "id" | "archived">[];
  readonly engagements: readonly Pick<Engagement, "id" | "archived" | "clientId">[];
  readonly projects: readonly Pick<Project, "id" | "archived" | "engagementId">[];
  readonly tasks?: readonly ArchiveWorkRecord[];
  readonly items?: readonly ArchiveWorkRecord[];
  readonly meetings?: readonly ArchiveMeetingRecord[];
}

/**
 * A record as the helpers see it: any stored hierarchy, work or meeting
 * record. Only the links it actually has are used: a client names no
 * ancestors, an engagement names its client, a project names its engagement
 * (its client is resolved through that engagement), and work records and
 * meetings name all their links explicitly.
 */
export type ArchiveRecord =
  | ArchiveHierarchyRecord
  | ArchiveWorkRecord
  | ArchiveMeetingRecord;

/** True when the record carries an explicit archived flag. */
export function hasArchivedFlag(record: { readonly archived?: boolean }): boolean {
  return record.archived === true;
}

/** Read the optional flag of any record, including a meeting (which has none). */
function recordFlag(record: ArchiveRecord): boolean {
  return (record as { readonly archived?: boolean }).archived === true;
}

/** The client, engagement and project ids a record's ancestors are found by. */
function ancestorIds(record: ArchiveRecord): {
  clientId?: string;
  engagementId?: string;
  projectId?: string;
} {
  const links = record as {
    clientId?: unknown;
    engagementId?: unknown;
    projectId?: unknown;
  };
  return {
    clientId: typeof links.clientId === "string" ? links.clientId : undefined,
    engagementId: typeof links.engagementId === "string" ? links.engagementId : undefined,
    projectId: typeof links.projectId === "string" ? links.projectId : undefined,
  };
}

/**
 * The current stored ancestors of a record, most significant first: the
 * client, then the engagement, then the project when one is linked. A
 * project's client is resolved through the project's stored engagement, so a
 * project record needs no clientId of its own. A record that names no
 * ancestors (a client) has an empty list. A missing ancestor is simply absent;
 * the store refuses broken references when opening, so this is a plain lookup.
 */
export function ancestorsOf(
  state: ArchiveState,
  record: ArchiveRecord,
): readonly ArchiveHierarchyRecord[] {
  const { clientId, engagementId, projectId } = ancestorIds(record);
  const ancestors: ArchiveHierarchyRecord[] = [];
  const engagement =
    engagementId === undefined
      ? undefined
      : state.engagements.find((item) => item.id === engagementId);
  const project =
    projectId === undefined
      ? undefined
      : state.projects.find((item) => item.id === projectId);
  // A project names only its engagement; its client is that engagement's. A
  // record whose named chain is incomplete (for example a project whose
  // engagement is absent) does not report the links it cannot reach.
  const namesEngagement = engagementId !== undefined || projectId !== undefined;
  if (namesEngagement && engagement === undefined) return [];
  const owningClientId = clientId ?? engagement?.clientId;
  if (owningClientId !== undefined) {
    const client = state.clients.find((item) => item.id === owningClientId);
    if (client !== undefined) ancestors.push(client);
  }
  if (engagement !== undefined) ancestors.push(engagement);
  if (project !== undefined) ancestors.push(project);
  return ancestors;
}

/** True when the record is effectively archived through its own flag. */
export function isDirectlyArchived(record: { readonly archived?: boolean }): boolean {
  return hasArchivedFlag(record);
}

/**
 * True when the record or any current stored ancestor is archived. Meetings
 * pass their stored links here and so inherit visibility without a flag of
 * their own.
 */
export function isEffectivelyArchived(
  state: ArchiveState,
  record: ArchiveRecord,
): boolean {
  // A meeting has no flag field, so only its ancestors can hide it.
  if (recordFlag(record)) return true;
  return ancestorsOf(state, record).some(hasArchivedFlag);
}

/**
 * The reason a record is hidden, or null when it is visible: "self" for the
 * record's own flag, or the kind and id of the nearest archived ancestor,
 * named as `client:<id>`, `engagement:<id>` or `project:<id>`.
 */
export function archivedReason(
  state: ArchiveState,
  record: ArchiveRecord,
): string | null {
  if (recordFlag(record)) return "self";
  // `ancestorsOf` lists the ancestors in hierarchy order, so the first
  // archived one is the nearest: the client, then the engagement, then the
  // project. Its position names its kind; matching on link fields would
  // misread an id such as "project-1" when it contains another kind's name.
  const ancestors = ancestorsOf(state, record);
  for (const [index, ancestor] of ancestors.entries()) {
    if (!hasArchivedFlag(ancestor)) continue;
    const kind = ARCHIVE_KINDS[index];
    return `${kind}:${ancestor.id}`;
  }
  return null;
}
