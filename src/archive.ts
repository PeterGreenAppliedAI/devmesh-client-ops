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

/** The parent links shared by every record whose visibility is inherited. */
export interface ArchiveLinks {
  readonly clientId: string;
  readonly engagementId: string;
  readonly projectId?: string;
}

/** The subset of the stored hierarchy the helpers need, plus the work records. */
export interface ArchiveState {
  readonly clients: readonly Pick<Client, "id" | "archived">[];
  readonly engagements: readonly Pick<Engagement, "id" | "archived">[];
  readonly projects: readonly Pick<Project, "id" | "archived">[];
}

/** True when the record carries an explicit archived flag. */
export function hasArchivedFlag(record: { readonly archived?: boolean }): boolean {
  return record.archived === true;
}

/**
 * The current stored ancestors of a linked record, most significant first:
 * the client, then the engagement, then the project when one is linked. A
 * missing ancestor is simply absent from the list; the store refuses broken
 * references when opening, so this is a plain lookup.
 */
export function ancestorsOf(
  state: ArchiveState,
  links: ArchiveLinks,
): readonly { readonly id: string; readonly archived?: boolean }[] {
  const ancestors: { readonly id: string; readonly archived?: boolean }[] = [];
  const client = state.clients.find((record) => record.id === links.clientId);
  if (client !== undefined) ancestors.push(client);
  const engagement = state.engagements.find((record) => record.id === links.engagementId);
  if (engagement !== undefined) ancestors.push(engagement);
  if (links.projectId !== undefined) {
    const project = state.projects.find((record) => record.id === links.projectId);
    if (project !== undefined) ancestors.push(project);
  }
  return ancestors;
}

/** True when the record is effectively archived through its own flag. */
export function isDirectlyArchived(record: { readonly archived?: boolean }): boolean {
  return hasArchivedFlag(record);
}

/**
 * True when the record or any current stored ancestor is archived. Meetings
 * pass their links here and so inherit visibility without a flag of their own.
 */
export function isEffectivelyArchived(
  state: ArchiveState,
  record: ArchiveLinks & { readonly archived?: boolean },
): boolean {
  if (hasArchivedFlag(record)) return true;
  return ancestorsOf(state, record).some(hasArchivedFlag);
}

/**
 * The reason a record is hidden, or null when it is visible: "self" for the
 * record's own flag, or the kind and id of the nearest archived ancestor,
 * named as `client:<id>`, `engagement:<id>` or `project:<id>`.
 */
export function archivedReason(
  state: ArchiveState,
  record: ArchiveLinks & { readonly archived?: boolean },
): string | null {
  if (hasArchivedFlag(record)) return "self";
  const client = state.clients.find((item) => item.id === record.clientId);
  if (client !== undefined && hasArchivedFlag(client)) return `client:${client.id}`;
  const engagement = state.engagements.find((item) => item.id === record.engagementId);
  if (engagement !== undefined && hasArchivedFlag(engagement)) {
    return `engagement:${engagement.id}`;
  }
  if (record.projectId !== undefined) {
    const project = state.projects.find((item) => item.id === record.projectId);
    if (project !== undefined && hasArchivedFlag(project)) return `project:${project.id}`;
  }
  return null;
}
