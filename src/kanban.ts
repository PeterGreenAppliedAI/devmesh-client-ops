/**
 * Read-only kanban boards: one stored snapshot, one scope, four status groups.
 *
 * The selector is pure: it reads the snapshot and returns detached, frozen
 * groups in the fixed order open, in_progress, waiting, done. Every visible
 * task appears exactly once, in its own status group, keeping the snapshot's
 * own order within the group. Archived tasks (by their own flag or any current
 * ancestor) stay off the boards, though they remain directly movable through
 * the store, as existing editable-archive practice allows.
 *
 * This module also holds the shared argument checks and scope membership test
 * that a board movement uses, so the selector and the store agree on what a
 * valid scope is and which tasks it contains.
 */
import { isEffectivelyArchived, type ArchiveState } from "./archive.ts";
import {
  clone,
  deepFreeze,
  TASK_STATUSES,
  ValidationError,
  type Task,
  type TaskIdentityExpectation,
  type TaskStatus,
} from "./model.ts";
import type { Snapshot } from "./store.ts";

/**
 * The read-only board a movement may target: the whole workspace, or one
 * client, engagement or project. The id names the exact record for the three
 * narrowed kinds and is ignored for `all`.
 */
export type BoardScope =
  | { readonly kind: "all" }
  | { readonly kind: "client" | "engagement" | "project"; readonly id: string };
export type { TaskIdentityExpectation } from "./model.ts";

/** The four board groups, in the order a board shows them. */
export type KanbanGroupKind = "open" | "in_progress" | "waiting" | "done";

/** One board group: its status and the tasks that hold it, in snapshot order. */
export interface KanbanGroup {
  readonly kind: KanbanGroupKind;
  readonly tasks: readonly Task[];
}

/** The validated scope and the four groups of one board selection. */
export interface KanbanBoard {
  readonly scope:
    | { readonly kind: "all" }
    | { readonly kind: "client" | "engagement" | "project"; readonly id: string };
  readonly groups: readonly KanbanGroup[];
}


/**
 * Validate a caller-supplied board scope before any lookup. `all` is the whole
 * workspace; the narrowed kinds name exactly one stored record and therefore
 * require a nonblank id. The returned scope carries only the fields of its kind
 * so a caller's extra fields are never used as a record link.
 */
export function requireBoardScope(scope: BoardScope): BoardScope {
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
    throw new ValidationError("board scope must be an object");
  }
  const kind = (scope as { kind?: unknown }).kind;
  if (kind === "all") return { kind: "all" };
  if (kind !== "client" && kind !== "engagement" && kind !== "project") {
    throw new ValidationError(
      "board scope kind must be one of all, client, engagement, project",
    );
  }
  const id = (scope as { id?: unknown }).id;
  if (typeof id !== "string" || id.trim() === "") {
    throw new ValidationError(`board scope ${kind} id must be a nonblank ${kind} id`);
  }
  return { kind, id };
}

/** Validate a movement's new status; any status may follow any other status. */
export function requireBoardStatus(status: unknown): TaskStatus {
  if (
    typeof status !== "string" ||
    !(TASK_STATUSES as readonly string[]).includes(status)
  ) {
    throw new ValidationError(`task.status must be one of ${TASK_STATUSES.join(", ")}`);
  }
  return status as TaskStatus;
}

/**
 * Validate the optional identity assertions a movement carries. Each supplied
 * assertion must be a string (an absent project link compares as the empty
 * string, so `""` is an accepted assertion); an assertion that is not a string
 * is refused before any lookup.
 */
export function requireExpectations(
  expected: TaskIdentityExpectation | undefined,
): TaskIdentityExpectation {
  if (expected === undefined) return {};
  if (typeof expected !== "object" || expected === null || Array.isArray(expected)) {
    throw new ValidationError("expected task identity must be an object");
  }
  const result: TaskIdentityExpectation = {};
  for (const key of ["id", "clientId", "engagementId", "projectId"] as const) {
    const value = (expected as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new ValidationError(`expected ${key} must be a string`);
    }
    result[key] = value;
  }
  return result;
}

/**
 * The stored link value an assertion is compared with: the record's own project
 * when it has one, otherwise the empty string.
 */
function taskLink(
  task: Task,
  key: "id" | "clientId" | "engagementId" | "projectId",
): string {
  if (key === "projectId") return task.projectId ?? "";
  return task[key];
}

/**
 * Refuse a movement whose assertions disagree with the current record. The
 * check runs inside the mutation queue against the record as it stands, so a
 * movement queued behind a scope change is judged by the state it actually
 * writes to.
 */
export function assertTaskIdentity(
  task: Task,
  expected: TaskIdentityExpectation,
): void {
  for (const key of ["id", "clientId", "engagementId", "projectId"] as const) {
    const wanted = expected[key];
    if (wanted === undefined) continue;
    const actual = taskLink(task, key);
    if (wanted !== actual) {
      throw new ValidationError(
        `task ${key} is ${JSON.stringify(actual)}, not the expected ${JSON.stringify(wanted)}`,
      );
    }
  }
}

/**
 * Whether a task is inside a board scope. `all` includes assigned and
 * unassigned work; a client includes all of its engagements; an engagement
 * includes its own work; a project includes only its tasks, never the
 * engagement's project-less work.
 */
export function taskInScope(task: Task, scope: BoardScope): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "client") return task.clientId === scope.id;
  if (scope.kind === "engagement") return task.engagementId === scope.id;
  return task.projectId === scope.id;
}

/**
 * Select one read-only board from a snapshot. The scope is validated first, so
 * a bad scope is refused rather than silently widened. Each visible task of the
 * scope appears once, in exactly one group, in the snapshot's own order; a
 * group with no tasks is present and empty.
 */
export function selectKanban(
  snapshot: Snapshot,
  scope: BoardScope,
): KanbanBoard {
  const checked = requireBoardScope(scope);
  const state: ArchiveState = snapshot;
  const groups: KanbanGroup[] = TASK_STATUSES.map((kind) => ({
    kind: kind as KanbanGroupKind,
    tasks: snapshot.tasks.filter(
      (task) =>
        task.status === kind &&
        taskInScope(task, checked) &&
        !isEffectivelyArchived(state, task),
    ),
  }));
  return deepFreeze({
    scope: checked,
    groups: clone(groups),
  }) as KanbanBoard;
}
