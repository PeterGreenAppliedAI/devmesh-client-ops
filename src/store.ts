/**
 * Internal persistent workspace: a versioned JSON document owned by one
 * application process at a time, mutated serially and written atomically.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  BusyStoreError,
  clone,
  deepFreeze,
  MissingRecordError,
  parseClient,
  parseEngagement,
  parseMeeting,
  parseProject,
  parseTask,
  parseWorkItem,
  PersistenceError,
  ValidationError,
  type Client,
  type Engagement,
  type EngagementStatus,
  type ItemKind,
  type ItemState,
  type Meeting,
  type Project,
  type ProjectStatus,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type WorkItem,
} from "./model.ts";
import { requireArchiveArguments, type ArchiveKind } from "./archive.ts";
import { parseActivity, type ActivityEvent } from "./activity.ts";

export type { ActivityAction, ActivityEvent, ActivityTargetKind } from "./activity.ts";
export {
  ACTIVITY_ACTIONS,
  ACTIVITY_TARGET_KINDS,
  parseActivityEvent,
} from "./activity.ts";

export type {
  Client,
  Engagement,
  EngagementStatus,
  ItemKind,
  ItemState,
  Meeting,
  Project,
  ProjectStatus,
  Task,
  TaskPriority,
  TaskStatus,
  WorkItem,
} from "./model.ts";
export { ITEM_KINDS, ITEM_STATES, TASK_PRIORITIES, TASK_STATUSES } from "./model.ts";
export {
  BusyStoreError,
  MissingRecordError,
  PersistenceError,
  ValidationError,
} from "./model.ts";

/**
 * Version 5 carries the hierarchy, the work collections, archival flags and the
 * activity journal.
 */
const SCHEMA_VERSION = 5;
/** Version 1 stored only the client/engagement/project hierarchy. */
const LEGACY_SCHEMA_VERSION = 1;
/** Version 3 stored the hierarchy and work collections, without archival flags. */
const WORK_SCHEMA_VERSION = 3;
/** Version 4 added archival flags but predates the activity journal. */
const FLAGS_SCHEMA_VERSION = 4;
const STORE_FILE = "workspace.json";
const LOCK_FILE = "workspace.lock";
const WORK_KEYS = ["tasks", "items", "meetings"] as const;
const LEGACY_STATE_KEYS = [
  "schemaVersion",
  "clients",
  "engagements",
  "projects",
  "nextIds",
] as const;
const FLAGS_STATE_KEYS = [
  ...LEGACY_STATE_KEYS.slice(0, 4),
  ...WORK_KEYS,
  "nextIds",
] as const;
const ACTIVITY_KEYS = ["activity", "nextActivityId"] as const;
const STATE_KEYS = [...FLAGS_STATE_KEYS, ...ACTIVITY_KEYS] as const;

/** Input fields accepted when creating a client. */
export interface ClientCreate {
  name: string;
  background?: string;
  contacts?: string;
  stakeholders?: string;
  requirements?: string;
  objectives?: string;
}

/** Partial update of a client; omitted fields keep their current value. */
export type ClientEdit = Partial<ClientCreate>;

/** Input fields accepted when creating an engagement. */
export interface EngagementCreate {
  clientId: string;
  name: string;
  objectives?: string;
  status?: EngagementStatus;
}

/** Partial update of an engagement; parent links are immutable. */
export type EngagementEdit = Partial<
  Pick<EngagementCreate, "name" | "objectives" | "status">
>;

/** Input fields accepted when creating a project. */
export interface ProjectCreate {
  engagementId: string;
  name: string;
  objectives?: string;
  status?: ProjectStatus;
}

/** Partial update of a project; parent links are immutable. */
export type ProjectEdit = Partial<
  Pick<ProjectCreate, "name" | "objectives" | "status">
>;

/** Input fields accepted when creating a task. */
export interface TaskCreate {
  clientId: string;
  engagementId: string;
  projectId?: string;
  title: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  owner?: string;
  dueDate?: string;
  context?: string;
}

/**
 * Partial update of a task. Omitted fields keep their current value; the client
 * and engagement links are immutable. A project link can be set or changed by
 * supplying `projectId`, and cleared only by setting `clearProject` to true.
 */
export interface TaskEdit extends Partial<
  Pick<TaskCreate, "title" | "status" | "priority" | "owner" | "dueDate" | "context">
> {
  projectId?: string;
  clearProject?: boolean;
  /** Supplied parent links are ignored: a task cannot move between parents. */
  clientId?: string;
  engagementId?: string;
}

/** Input fields accepted when creating a work item. */
export interface WorkItemCreate {
  clientId: string;
  engagementId: string;
  projectId?: string;
  kind: ItemKind;
  title: string;
  context?: string;
  state?: ItemState;
}

/** Partial update of a work item; client and engagement links are immutable. */
export interface WorkItemEdit extends Partial<
  Pick<WorkItemCreate, "kind" | "title" | "context" | "state">
> {
  projectId?: string;
  clearProject?: boolean;
  /** Supplied parent links are ignored: a work item cannot move between parents. */
  clientId?: string;
  engagementId?: string;
}

/** Input fields accepted when creating a meeting. */
export interface MeetingCreate {
  clientId: string;
  engagementId: string;
  projectId?: string;
  title: string;
  date: string;
  notes?: string;
}

/** Partial update of a meeting; client and engagement links are immutable. */
export interface MeetingEdit extends Partial<
  Pick<MeetingCreate, "title" | "date" | "notes">
> {
  projectId?: string;
  clearProject?: boolean;
  /** Supplied parent links are ignored: a meeting cannot move between parents. */
  clientId?: string;
  engagementId?: string;
}

/** Detached, read-only view of the committed state. */
export interface Snapshot {
  readonly clients: readonly Client[];
  readonly engagements: readonly Engagement[];
  readonly projects: readonly Project[];
  readonly tasks: readonly Task[];
  readonly items: readonly WorkItem[];
  readonly meetings: readonly Meeting[];
  /**
   * The activity journal, oldest first. Snapshots built by hand may omit it;
   * an absent journal means no events have been recorded.
   */
  readonly activity?: readonly ActivityEvent[];
}

/** Internal file-system adapter, injectable so tests can simulate failures. */
export interface FileSystem {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { recursive: true }): void;
  readFileSync(path: string, encoding: "utf8"): string;
  /**
   * Open a file for exclusive creation; fails with EEXIST if it already exists.
   * It also opens a directory for reading when flushing it, with the "r" flag.
   */
  openSync(path: string, flags: "wx" | "r"): number;
  /** Write bytes at the descriptor's current position; returns bytes written. */
  writeSync(fd: number, data: Uint8Array): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
  /**
   * Flush a directory entry. The adapter itself decides whether the platform
   * supports this: it returns normally when unsupported, and throws only for a
   * genuine failure. The store never suppresses a throw from this operation.
   * It obtains the directory's handle by opening it through this adapter's own
   * `openSync` with the "r" flag, then flushes and closes it through this
   * adapter's own `fsyncSync` and `closeSync`, in that order, so each of those
   * operations can be observed and can fail on its own.
   */
  fsyncDirectorySync?(path: string): void;
}

/** Selector scope: records of one client, narrowed by engagement or project. */
export interface WorkFilter {
  clientId: string;
  engagementId?: string;
  projectId?: string;
}

/** Internal options accepted by openStore; only tests pass them. */
export interface StoreOptions {
  fs?: Partial<FileSystem>;
  /**
   * The platform whose directory-durability rules apply; defaults to
   * `process.platform`. Only tests pass it, so they can exercise either the
   * Windows skip or the POSIX directory flush on any operating system.
   */
  platform?: string;
}

/** A collection of records that a store persists. */
interface Collection<T extends { id: string }> {
  readonly key: "clients" | "engagements" | "projects" | "tasks" | "items" | "meetings";
  readonly kind: "client" | "engagement" | "project" | "task" | "item" | "meeting";
  parse(value: unknown, what: string): T;
}

const collections = {
  clients: {
    key: "clients",
    kind: "client",
    parse: parseClient,
  },
  engagements: {
    key: "engagements",
    kind: "engagement",
    parse: parseEngagement,
  },
  projects: {
    key: "projects",
    kind: "project",
    parse: parseProject,
  },
  tasks: {
    key: "tasks",
    kind: "task",
    parse: parseTask,
  },
  items: {
    key: "items",
    kind: "item",
    parse: parseWorkItem,
  },
  meetings: {
    key: "meetings",
    kind: "meeting",
    parse: parseMeeting,
  },
} satisfies Record<string, Collection<{ id: string }>>;

type CollectionKey = keyof typeof collections;
type Kind = (typeof collections)[CollectionKey]["kind"];
type CounterKey = (typeof collections)[CollectionKey]["key"];
const LEGACY_COLLECTION_KEYS = ["clients", "engagements", "projects"] as const;
const COLLECTION_KEYS = [...LEGACY_COLLECTION_KEYS, ...WORK_KEYS] as const;
/**
 * The persisted collection for each archivable kind. Meetings are absent: they
 * inherit visibility and never carry a flag.
 */
const ARCHIVE_COLLECTION_KEYS = {
  client: "clients",
  engagement: "engagements",
  project: "projects",
  task: "tasks",
  item: "items",
} satisfies Record<ArchiveKind, CounterKey>;

interface State {
  clients: Client[];
  engagements: Engagement[];
  projects: Project[];
  tasks: Task[];
  items: WorkItem[];
  meetings: Meeting[];
  nextIds: Record<string, number>;
  activity: ActivityEvent[];
  nextActivityId: number;
}

/**
 * Flush a directory through the adapter's own open, flush and close
 * operations, so a test that injects this adapter can fail any of the three.
 *
 * Directory durability is handled explicitly per platform: on Windows a
 * directory cannot be opened or flushed as a directory handle, so the step is
 * skipped by checking the platform before any operation, leaving the rename as
 * the durability point. That decision is never made by catching errors. On
 * every other platform a directory handle is requested from the adapter,
 * then flushed and closed through it, and a failure at any of those steps is a
 * genuine persistence failure that is reported; if the flush fails and the
 * close then fails too, the flush error is the one reported, with the close
 * error attached as context. A directory handle is requested by opening the
 * directory through the adapter's own `openSync` with the "r" flag, so a test
 * adapter can observe that open and can supply a simulated handle on any
 * operating system.
 *
 * The platform is the store's configured one, never read from process here.
 */
function flushDirectorySync(fs: FileSystem, path: string, platform: string): void {
  if (platform === "win32") return;
  const fd = fs.openSync(path, "r");
  let flushFailure: unknown;
  try {
    fs.fsyncSync(fd);
  } catch (cause) {
    flushFailure = cause;
  }
  try {
    fs.closeSync(fd);
  } catch (closeCause) {
    if (flushFailure !== undefined) {
      // A close error never replaces the flush error; it is kept as context.
      throw new PersistenceError("Failed to flush the store directory and could not close it", {
        cause: failureOr(flushFailure, closeCause),
      });
    }
    throw closeCause;
  }
  if (flushFailure !== undefined) throw flushFailure;
}

function defaultFileSystem(platform: string): FileSystem {
  const fs: FileSystem = {
    existsSync,
    mkdirSync: (path, options) => mkdirSync(path, options),
    readFileSync: (path, encoding) => readFileSync(path, encoding),
    openSync: (path, flags) => openSync(path, flags),
    writeSync: (fd, data) => writeSync(fd, data),
    fsyncSync: (fd) => fsyncSync(fd),
    closeSync: (fd) => closeSync(fd),
    renameSync: (oldPath, newPath) => renameSync(oldPath, newPath),
    unlinkSync: (path) => unlinkSync(path),
    fsyncDirectorySync: (path) => flushDirectorySync(fs, path, platform),
  };
  return fs;
}

function toJson(state: State): string {
  const document = {
    schemaVersion: SCHEMA_VERSION,
    clients: state.clients,
    engagements: state.engagements,
    projects: state.projects,
    tasks: state.tasks,
    items: state.items,
    meetings: state.meetings,
    activity: state.activity,
    // The journal counter is the next event id to allocate. It is serialized as
    // it stands: the ceiling is a valid stored value, meaning the journal is
    // exhausted, and allocating there is refused rather than clamped.
    nextActivityId: state.nextActivityId,
    // A stored counter is the next id to allocate. It must therefore stay below
    // the safe-integer ceiling so the loader accepts it and allocation can
    // still advance: when the highest allocated id is one less than the
    // ceiling, the stored counter equals that highest id, which the loader
    // accepts as "cannot advance" and the next allocation refuses.
    nextIds: countersOf(state),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

function countersOf(state: State): Record<string, number> {
  const nextIds: Record<string, number> = {};
  for (const [key, value] of Object.entries(state.nextIds)) {
    nextIds[key] = Math.min(value, Number.MAX_SAFE_INTEGER - 1);
  }
  return nextIds;
}

function emptyState(): State {
  return {
    clients: [],
    engagements: [],
    projects: [],
    tasks: [],
    items: [],
    meetings: [],
    nextIds: {},
    activity: [],
    nextActivityId: 1,
  };
}

function idSuffix(kind: Kind, id: string): number | null {
  const prefix = `${kind}-`;
  if (!id.startsWith(prefix)) return null;
  const suffix = id.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(suffix)) return null;
  const value = Number(suffix);
  return Number.isSafeInteger(value) ? value : null;
}

function parseState(text: string): State {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new PersistenceError("Stored data is not valid JSON", { cause });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PersistenceError("Stored data must be a JSON object");
  }
  const record = raw as Record<string, unknown>;
  const version = record.schemaVersion;
  if (
    version !== SCHEMA_VERSION &&
    version !== FLAGS_SCHEMA_VERSION &&
    version !== WORK_SCHEMA_VERSION &&
    version !== LEGACY_SCHEMA_VERSION
  ) {
    throw new PersistenceError(
      `Unsupported stored schema version: ${JSON.stringify(version)}`,
    );
  }
  // Version 1 snapshots predate the work collections; they are accepted as
  // documents with empty task, item and meeting collections. Versions 1 and 3
  // predate archival flags: they are accepted as active records, and no flag is
  // invented for them. Versions 1, 3 and 4 predate the activity journal: they
  // are accepted with an empty journal in memory and the file is not rewritten
  // at open time. Each version keeps the strict key rules of its own
  // generation: version 1 must contain exactly the hierarchy keys, so a
  // document that mentions a work collection or a work counter while claiming
  // the old version is refused rather than guessed at. Versions 3 and 4 must
  // contain exactly the hierarchy plus the work collections, and version 5 must
  // contain exactly those plus the journal. Only versions 4 and 5 may carry an
  // `archived` field, and only as a boolean; `true` means archived and `false`
  // means active, read exactly as an absent flag.
  const legacy = version === LEGACY_SCHEMA_VERSION;
  const journal = version === SCHEMA_VERSION;
  const flagsAllowed = version === SCHEMA_VERSION || version === FLAGS_SCHEMA_VERSION;
  const allowedKeys = legacy
    ? LEGACY_STATE_KEYS
    : journal
      ? STATE_KEYS
      : FLAGS_STATE_KEYS;
  for (const key of Object.keys(record)) {
    if (!(allowedKeys as readonly string[]).includes(key)) {
      throw new PersistenceError(`Stored data has unsupported field ${JSON.stringify(key)}`);
    }
  }
  if (legacy) {
    for (const key of WORK_KEYS) {
      if (key in record) {
        throw new PersistenceError(
          `Stored schema version ${LEGACY_SCHEMA_VERSION} cannot contain ${key}`,
        );
      }
    }
  }
  if (!journal) {
    for (const key of ACTIVITY_KEYS) {
      if (key in record) {
        throw new PersistenceError(
          `Stored schema version ${version} cannot contain ${key}`,
        );
      }
    }
  }
  const state = emptyState();
  const highest: Record<string, number> = {};
  for (const key of COLLECTION_KEYS) {
    const collection = collections[key];
    const values = legacy && (WORK_KEYS as readonly string[]).includes(key)
      ? []
      : record[key];
    if (!Array.isArray(values)) {
      throw new PersistenceError(`Stored ${key} must be an array`);
    }
    const seen = new Set<string>();
    const parsedItems = values.map((value, index) => {
      let parsed: { id: string; archived?: boolean };
      try {
        parsed = collection.parse(value, `${key}[${index}]`);
        // Only schema 4 may carry archival flags; older documents are read
        // strictly, so a flag on a version 1 or 3 record is refused rather
        // than silently dropped. Meetings never carry a flag.
        if (!flagsAllowed && parsed.archived !== undefined) {
          throw new ValidationError(
            `Stored schema version ${version} cannot contain an archived flag`,
          );
        }
      } catch (cause) {
        throw new PersistenceError(
          `Stored ${collection.kind} at ${key}[${index}] is invalid`,
          { cause },
        );
      }
      if (seen.has(parsed.id)) {
        throw new PersistenceError(
          `Stored ${key} contains duplicate id ${JSON.stringify(parsed.id)}`,
        );
      }
      seen.add(parsed.id);
      const suffix = idSuffix(collection.kind, parsed.id);
      if (suffix === null) {
        throw new PersistenceError(
          `Stored ${collection.kind} id ${JSON.stringify(parsed.id)} is not a stable generated id`,
        );
      }
      highest[key] = Math.max(highest[key] ?? 0, suffix);
      return parsed;
    });
    (state[key] as unknown[]).push(...parsedItems);
  }
  const nextIds = record.nextIds;
  if (typeof nextIds !== "object" || nextIds === null || Array.isArray(nextIds)) {
    throw new PersistenceError("Stored nextIds must be an object");
  }
  const allowedCounters = legacy ? LEGACY_COLLECTION_KEYS : COLLECTION_KEYS;
  for (const [key, value] of Object.entries(nextIds)) {
    if (!(allowedCounters as readonly string[]).includes(key)) {
      throw new PersistenceError(`Stored nextIds has unsupported field ${JSON.stringify(key)}`);
    }
    if (
      !Number.isSafeInteger(value) ||
      (value as number) < 1 ||
      (value as number) >= Number.MAX_SAFE_INTEGER
    ) {
      // A counter at the safe-integer ceiling would produce a duplicate id on
      // the next allocation, so it is refused rather than accepted.
      throw new PersistenceError(
        `Stored nextIds.${key} must be a positive safe integer that can still advance`,
      );
    }
    const used = highest[key] ?? 0;
    // The counter may equal the highest allocated id only when that id is the
    // last one that can be allocated safely: the collection is then exhausted
    // and allocation is refused rather than producing a duplicate or an unsafe
    // counter. A counter below the highest id would reproduce an existing id,
    // so it is refused.
    if (
      (value as number) < used ||
      ((value as number) === used && used !== Number.MAX_SAFE_INTEGER - 1)
    ) {
      throw new PersistenceError(
        `Stored nextIds.${key} cannot safely advance past existing id ${collections[key as CounterKey].kind}-${used}`,
      )
    }
    state.nextIds[key] = value as number;
  }
  // Every collection with records must have a counter that covers them.
  for (const key of COLLECTION_KEYS) {
    const used = highest[key] ?? 0;
    if (used > 0 && state.nextIds[key] === undefined) {
      throw new PersistenceError(
        `Stored nextIds.${key} is missing while id ${collections[key].kind}-${used} exists`,
      );
    }
  }
  // Referential integrity must hold when loading.
  for (const engagement of state.engagements) {
    if (!state.clients.some((client) => client.id === engagement.clientId)) {
      throw new PersistenceError(
        `Stored engagement ${engagement.id} references missing client ${engagement.clientId}`,
      );
    }
  }
  for (const project of state.projects) {
    if (!state.engagements.some((e) => e.id === project.engagementId)) {
      throw new PersistenceError(
        `Stored project ${project.id} references missing engagement ${project.engagementId}`,
      );
    }
  }
  if (journal) {
    // A schema 5 document must carry both journal fields. The journal is
    // validated against the records just parsed: every target must exist, ids
    // must be unique, and the counter must be able to advance past them. No
    // event is invented for older documents, and a malformed
    // journal refuses the whole document rather than being repaired.
    try {
      const parsed = parseActivity(record.activity, record.nextActivityId, state);
      state.activity = [...parsed.activity];
      state.nextActivityId = parsed.nextActivityId;
    } catch (cause) {
      throw new PersistenceError("Stored activity journal is invalid", { cause });
    }
  }
  // Work records are linked to a client, that client's engagement and, when
  // present, a project inside the same engagement, exactly as for new creates.
  for (const key of WORK_KEYS) {
    for (const record of state[key] as readonly WorkRecord[]) {
      try {
        requireWorkParents(state, record.clientId, record.engagementId, record.projectId);
      } catch (cause) {
        throw new PersistenceError(
          `Stored ${collections[key].kind} ${record.id} has invalid parent links`,
          { cause },
        );
      }
    }
  }
  return state;
}

function snapshotOf(state: State): Snapshot {
  return deepFreeze({
    clients: clone(state.clients),
    engagements: clone(state.engagements),
    projects: clone(state.projects),
    tasks: clone(state.tasks),
    items: clone(state.items),
    meetings: clone(state.meetings),
    activity: clone(state.activity),
  });
}

/** The parent links every work record shares. */
interface WorkParents {
  readonly clientId: string;
  readonly engagementId: string;
  readonly projectId?: string;
}

type WorkRecord = WorkParents & { readonly id: string };

/**
 * Check that a work record's links form a chain: the engagement belongs to the
 * client and, when a project is given, the project belongs to that engagement.
 * A link value that is not a usable id, or a missing or mismatched record, is
 * refused. This is shared by creates, edits and snapshot loading.
 */
function requireWorkParents(
  state: State,
  clientId: string,
  engagementId: string,
  projectId: string | undefined,
): void {
  const client = requireParentId(clientId, "clientId", "client");
  const engagement = requireParentId(engagementId, "engagementId", "engagement");
  findRecord(state.clients, client, "client");
  const parent = findRecord(state.engagements, engagement, "engagement");
  if (parent.clientId !== client) {
    throw new ValidationError(
      `engagementId ${JSON.stringify(engagement)} does not belong to clientId ${JSON.stringify(client)}`,
    );
  }
  if (projectId === undefined) return;
  const project = requireParentId(projectId, "projectId", "project");
  const found = findRecord(state.projects, project, "project");
  if (found.engagementId !== engagement) {
    throw new ValidationError(
      `projectId ${JSON.stringify(project)} does not belong to engagementId ${JSON.stringify(engagement)}`,
    );
  }
}

/**
 * Resolve the project link for a create from the supplied field, then validate
 * the whole parent chain.
 */
function workParentFields(
  state: State,
  input: WorkParents,
): { clientId: string; engagementId: string; projectId?: string } {
  const projectId = input.projectId;
  requireWorkParents(state, input.clientId, input.engagementId, projectId);
  return {
    clientId: input.clientId,
    engagementId: input.engagementId,
    ...(projectId === undefined ? {} : { projectId }),
  };
}

/**
 * Resolve the project link for an edit. The supplied link is validated against
 * the record's immutable engagement, so it can be set or changed only within
 * that engagement. `clearProject` removes it; supplying both is refused rather
 * than silently preferring one.
 */
function editedProjectId(
  state: State,
  current: WorkRecord,
  edit: { projectId?: string; clearProject?: boolean },
): { projectId: string | undefined; clear: boolean } {
  if (edit.clearProject !== undefined && typeof edit.clearProject !== "boolean") {
    throw new ValidationError("clearProject must be a boolean");
  }
  if (edit.clearProject === true && edit.projectId !== undefined) {
    throw new ValidationError("projectId and clearProject cannot both be supplied");
  }
  if (edit.clearProject === true) return { projectId: undefined, clear: true };
  return {
    projectId: edit.projectId === undefined ? current.projectId : edit.projectId,
    clear: false,
  };
}

/**
 * Build the shared parent fields of an edited work record. `clear` says whether
 * the edit cleared the project link, so the record's old project link is
 * dropped rather than retained when the fields are merged.
 */
function editedParents(
  state: State,
  current: WorkRecord,
  edit: { projectId?: string; clearProject?: boolean },
): { clientId: string; engagementId: string; projectId?: string; clear: boolean } {
  const { projectId, clear } = editedProjectId(state, current, edit);
  requireWorkParents(state, current.clientId, current.engagementId, projectId);
  return {
    clientId: current.clientId,
    engagementId: current.engagementId,
    ...(projectId === undefined ? {} : { projectId }),
    clear,
  };
}

/**
 * Return the detached, frozen records in `items` whose links match a selector
 * scope. The scope is always a client, optionally narrowed by engagement or
 * project; an omitted filter is refused rather than widening to every client.
 * The caller's filter is never trusted as a record link: it only narrows which
 * records are returned.
 */
function selectWork<T extends WorkParents>(
  items: readonly T[],
  filter: WorkFilter,
): readonly T[] {
  if (filter === undefined || filter === null || typeof filter !== "object") {
    throw new ValidationError("a client-scoped WorkFilter is required");
  }
  const clientId = requireParentId(filter.clientId, "clientId", "client");
  const engagementId =
    filter.engagementId === undefined
      ? undefined
      : requireParentId(filter.engagementId, "engagementId", "engagement");
  const projectId =
    filter.projectId === undefined
      ? undefined
      : requireParentId(filter.projectId, "projectId", "project");
  return deepFreeze(
    clone(
      items.filter(
        (item) =>
          item.clientId === clientId &&
          (engagementId === undefined || item.engagementId === engagementId) &&
          (projectId === undefined || item.projectId === projectId),
      ),
    ),
  );
}

function findRecord<T extends { id: string }>(
  items: readonly T[],
  id: string,
  kind: string,
): T {
  const found = items.find((item) => item.id === id);
  if (!found) throw new MissingRecordError(`No ${kind} with id ${JSON.stringify(id)}`);
  return found;
}

/** Copy the fields the caller supplied; omitted fields are absent. */
function supplied<T extends object>(input: T, keys: readonly (keyof T)[]): Partial<T> {
  const result: Partial<T> = {};
  for (const key of keys) {
    if (input[key] !== undefined) result[key] = input[key];
  }
  return result;
}

/** Validate a supplied parent link value before checking that it exists. */
function requireParentId(value: unknown, field: string, kind: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${field} must be a nonblank ${kind} id`);
  }
  return value;
}

function errorCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isMissing(cause: unknown): boolean {
  return errorCode(cause) === "ENOENT";
}

/** Write all of `data`, honoring Node's byte offset when a write is short. */
function writeFully(fs: FileSystem, fd: number, data: string): void {
  const buffer = Buffer.from(data, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer.subarray(offset));
    if (!Number.isInteger(written) || written <= 0 || written > buffer.length - offset) {
      throw new PersistenceError("Failed to write the temporary store file");
    }
    offset += written;
  }
}

/**
 * Close a descriptor on an initial (non-cleanup) path. Any failure, including
 * one that resembles an already-closed descriptor, is an operation failure that
 * must be reported; only cleanup after a reported failure may treat EBADF as
 * released.
 */
function closeInitialDescriptorSync(fs: FileSystem, fd: number): void {
  fs.closeSync(fd);
}

/**
 * Close a descriptor owned during lock acquisition. EBADF means it is already
 * closed; any other failure leaves it possibly open.
 */
function closeDescriptorSync(
  fs: FileSystem,
  fd: number,
): { closed: boolean; failure?: unknown } {
  try {
    fs.closeSync(fd);
    return { closed: true };
  } catch (cause) {
    if (errorCode(cause) === "EBADF") return { closed: true };
    return { closed: false, failure: cause };
  }
}

/** Keep the operation failure as cause, attaching a cleanup failure to it. */
function failureOr(cause: unknown, cleanup: unknown): unknown {
  if (cause instanceof PersistenceError) return cause;
  if (cause instanceof Error) {
    try {
      (cause as Error & { cleanupCause?: unknown }).cleanupCause = cleanup;
    } catch {
      // The cause may not accept extra properties; it is still reported.
    }
  }
  return cause;
}

export interface Store {
  /** Detached, read-only snapshot of the committed state. */
  snapshot(): Snapshot;
  createClient(input: ClientCreate): Promise<Client>;
  updateClient(id: string, edit: ClientEdit): Promise<Client>;
  createEngagement(input: EngagementCreate): Promise<Engagement>;
  updateEngagement(id: string, edit: EngagementEdit): Promise<Engagement>;
  createProject(input: ProjectCreate): Promise<Project>;
  updateProject(id: string, edit: ProjectEdit): Promise<Project>;
  createTask(input: TaskCreate): Promise<Task>;
  updateTask(id: string, edit: TaskEdit): Promise<Task>;
  createItem(input: WorkItemCreate): Promise<WorkItem>;
  updateItem(id: string, edit: WorkItemEdit): Promise<WorkItem>;
  createMeeting(input: MeetingCreate): Promise<Meeting>;
  updateMeeting(id: string, edit: MeetingEdit): Promise<Meeting>;
  /**
   * Set the archival flag on a client, engagement, project, task or work item.
   * `true` archives the record, `false` removes the flag. Descendants are never
   * changed; restoring a parent preserves independently archived children.
   */
  setArchived(kind: ArchiveKind, id: string, archived: boolean): Promise<void>;
  /** Tasks of a client, optionally narrowed to one engagement or project. */
  listTasks(filter: WorkFilter): readonly Task[];
  /** Work items of a client, optionally narrowed to one engagement or project. */
  listItems(filter: WorkFilter): readonly WorkItem[];
  /** Meetings of a client, optionally narrowed to one engagement or project. */
  listMeetings(filter: WorkFilter): readonly Meeting[];
  /** Release ownership of the data directory; can be retried after failure. */
  close(): Promise<void>;
}

class StoreImpl implements Store {
  private state: State;
  private readonly fs: FileSystem;
  private readonly directory: string;
  private readonly storePath: string;
  private readonly lockPath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private lockReleased = false;
  /**
   * Set when a failed save could not restore the committed file and the store
   * therefore cannot tell whether disk and memory agree. All further mutations
   * are refused until the store is closed and reopened; memory is never
   * published from a failed save.
   */
  private blocked: PersistenceError | null = null;

  constructor(state: State, fs: FileSystem, directory: string) {
    this.state = state;
    this.fs = fs;
    this.directory = directory;
    this.storePath = join(directory, STORE_FILE);
    this.lockPath = join(directory, LOCK_FILE);
  }

  snapshot(): Snapshot {
    return snapshotOf(this.state);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new PersistenceError("Store is closed"));
    }
    if (this.blocked) {
      // A failed save could not restore the committed file, so disk and memory
      // may disagree. Refuse to build a new write on state that is not known to
      // be committed; the store must be closed and reopened.
      return Promise.reject(
        new PersistenceError(
          "The store cannot accept further mutations until it is reopened",
          { cause: this.blocked },
        ),
      );
    }
    const run = this.queue.then(operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private nextId(draft: State, key: CounterKey): string {
    const next = draft.nextIds[key] ?? 1;
    const items = draft[key] as readonly { id: string }[];
    const kind = collections[key].kind;
    if (!Number.isSafeInteger(next) || next < 1 || next >= Number.MAX_SAFE_INTEGER) {
      throw new PersistenceError(
        `Cannot allocate a new ${kind}: the id counter cannot advance safely`,
      );
    }
    // A counter that equals an existing id would reproduce it. The loader only
    // accepts such a counter when the collection is exhausted at the safe-integer
    // boundary, and allocation there must be refused.
    if (items.some((item) => idSuffix(kind, item.id) === next)) {
      throw new PersistenceError(
        `Cannot allocate a new ${kind}: the id counter cannot advance safely`,
      );
    }
    draft.nextIds[key] = next + 1;
    return `${kind}-${next}`;
  }

  /**
   * Write the draft to a same-directory temporary file, flush it, replace the
   * store file atomically, then sync the directory entry.
   *
   * Failures before the rename leave the previous store file untouched, so the
   * previously committed state stays in effect and nothing is published. If the
   * directory flush after the rename fails, the new bytes are already in the
   * store file, so the previous committed state is written back, flushed and
   * the operation is rejected: both disk and memory then hold the previously
   * committed state, and later writes never build on stale state. If that
   * restore fails too, the store is blocked: it never publishes the failed
   * mutation, and refuses every further mutation until it is reopened. Only a
   * fully successful write is acknowledged and published.
   */
  private async persist(next: State): Promise<void> {
    let replaced = false;
    try {
      replaced = this.replaceFile(next);
    } catch (cause) {
      // A cleanup failure already has a specific persistence message; keep it.
      if (cause instanceof PersistenceError) throw cause;
      throw new PersistenceError("Failed to persist workspace data", { cause });
    }

    if (replaced && this.fs.fsyncDirectorySync) {
      try {
        this.fs.fsyncDirectorySync(this.directory);
      } catch (cause) {
        // The replacement already happened, so the store file now holds `next`
        // even though the change was not acknowledged. Write the previously
        // committed state back, including its own directory flush, so disk and
        // memory agree before any later write; then reject without publishing.
        try {
          this.replaceFile(this.state);
          this.fs.fsyncDirectorySync(this.directory);
        } catch (restoreCause) {
          this.blocked = new PersistenceError(
            "Failed to flush the store directory and could not restore the previous state",
            { cause: failureOr(cause, restoreCause) },
          );
          throw this.blocked;
        }
        throw new PersistenceError("Failed to flush the store directory", { cause });
      }
    }

    // Only now, after the file is safely in place, acknowledge the new state.
    this.state = next;
  }

  /**
   * Replace the store file with `state` through a flushed temporary file in the
   * same directory. The previous file is left alone if anything fails before
   * the rename, and the temporary file is only removed once it is closed.
   * Returns true when the rename has happened, so the caller knows the store
   * file now holds `state` even if a later directory flush fails.
   */
  private replaceFile(state: State): boolean {
    const tempPath = `${this.storePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    let fd: number | null = null;
    let tempCreated = false;
    try {
      fd = this.fs.openSync(tempPath, "wx");
      tempCreated = true;
      writeFully(this.fs, fd, toJson(state));
      this.fs.fsyncSync(fd);
      // Clear ownership only after close returns; a close that reports failure
      // might have left the descriptor open, and cleanup must close it again.
      const closed = this.closeInitialDescriptor(fd);
      if (!closed.closed) throw closed.failure;
      fd = null;
      this.fs.renameSync(tempPath, this.storePath);
      return true;
    } catch (cause) {
      const cleanupFailure = this.discardTemp(tempPath, fd, tempCreated);
      if (cleanupFailure !== undefined) {
        throw new PersistenceError(
          "Failed to persist workspace data and could not remove the temporary file",
          { cause: failureOr(cause, cleanupFailure) },
        );
      }
      throw cause;
    }
  }

  /**
   * Close a descriptor we own. An EBADF means the descriptor is already closed
   * (for example after an injected close failure that still closed it), so it
   * is treated as released; any other failure leaves it possibly open.
   */
  private closeDescriptor(fd: number): { closed: boolean; failure?: unknown } {
    return closeDescriptorSync(this.fs, fd);
  }

  /**
   * Close a descriptor on the successful persistence path. There is no failure
   * to clean up here, so an EBADF is a genuine failure to report, not a
   * descriptor that may be considered released.
   */
  private closeInitialDescriptor(fd: number): { closed: boolean; failure?: unknown } {
    try {
      closeInitialDescriptorSync(this.fs, fd);
      return { closed: true };
    } catch (failure) {
      return { closed: false, failure };
    }
  }

  /**
   * Remove resources left behind by a failed write: close a descriptor we still
   * own and remove the temporary file only when we created it. The file is only
   * unlinked once its descriptor is known to be closed, so no open file is
   * deleted. Returns the cleanup error, if any, so the caller can report it.
   */
  private discardTemp(
    tempPath: string,
    fd: number | null,
    tempCreated: boolean,
  ): unknown {
    let cleanupFailure: unknown;
    let descriptorClosed = true;
    if (fd !== null) {
      const result = this.closeDescriptor(fd);
      descriptorClosed = result.closed;
      if (!result.closed) cleanupFailure = result.failure;
    }
    if (tempCreated && descriptorClosed) {
      try {
        this.fs.unlinkSync(tempPath);
      } catch (cause) {
        if (!isMissing(cause) && cleanupFailure === undefined) cleanupFailure = cause;
      }
    }
    return cleanupFailure;
  }

  private async commit<T>(mutate: (draft: State) => T): Promise<T> {
    // An earlier operation may have failed recovery while this one waited.
    if (this.blocked) {
      throw new PersistenceError(
        "The store cannot accept further mutations until it is reopened",
        { cause: this.blocked },
      );
    }
    const draft: State = clone(this.state);
    const result = mutate(draft);
    await this.persist(draft);
    return clone(result);
  }

  createClient(input: ClientCreate): Promise<Client> {
    return this.enqueue(() =>
      this.commit((draft) => {
        const fields = supplied(input, [
          "name",
          "background",
          "contacts",
          "stakeholders",
          "requirements",
          "objectives",
        ]);
        // Defaults apply only to omitted fields; an explicitly supplied null or
        // other invalid value reaches validation and is rejected.
        const client = parseClient({
          id: this.nextId(draft, "clients"),
          name: fields.name,
          background: "background" in fields ? fields.background : "",
          contacts: "contacts" in fields ? fields.contacts : "",
          stakeholders: "stakeholders" in fields ? fields.stakeholders : "",
          requirements: "requirements" in fields ? fields.requirements : "",
          objectives: "objectives" in fields ? fields.objectives : "",
        });
        draft.clients.push(client);
        return client;
      }),
    );
  }

  updateClient(id: string, edit: ClientEdit): Promise<Client> {
    return this.enqueue(() =>
      this.commit((draft) => {
        const current = findRecord(draft.clients, id, "client");
        const changes = supplied(edit, [
          "name",
          "background",
          "contacts",
          "stakeholders",
          "requirements",
          "objectives",
        ]);
        const updated = parseClient({ ...current, ...changes });
        draft.clients = draft.clients.map((c) => (c.id === id ? updated : c));
        return updated;
      }),
    );
  }

  createEngagement(input: EngagementCreate): Promise<Engagement> {
    return this.enqueue(() =>
      this.commit((draft) => {
        const clientId = requireParentId(input.clientId, "clientId", "client");
        findRecord(draft.clients, clientId, "client");
        const fields = supplied(input, ["name", "objectives", "status"]);
        const engagement = parseEngagement({
          id: this.nextId(draft, "engagements"),
          clientId,
          name: fields.name,
          objectives: "objectives" in fields ? fields.objectives : "",
          status: "status" in fields ? fields.status : "planned",
        });
        draft.engagements.push(engagement);
        return engagement;
      }),
    );
  }

  updateEngagement(id: string, edit: EngagementEdit): Promise<Engagement> {
    return this.enqueue(() =>
      this.commit((draft) => {
        const current = findRecord(draft.engagements, id, "engagement");
        const changes = supplied(edit, ["name", "objectives", "status"]);
        const updated = parseEngagement({ ...current, ...changes });
        draft.engagements = draft.engagements.map((e) => (e.id === id ? updated : e));
        return updated;
      }),
    );
  }

  createProject(input: ProjectCreate): Promise<Project> {
    return this.enqueue(() =>
      this.commit((draft) => {
        const engagementId = requireParentId(input.engagementId, "engagementId", "engagement");
        findRecord(draft.engagements, engagementId, "engagement");
        const fields = supplied(input, ["name", "objectives", "status"]);
        const project = parseProject({
          id: this.nextId(draft, "projects"),
          engagementId,
          name: fields.name,
          objectives: "objectives" in fields ? fields.objectives : "",
          status: "status" in fields ? fields.status : "planned",
        });
        draft.projects.push(project);
        return project;
      }),
    );
  }

  updateProject(id: string, edit: ProjectEdit): Promise<Project> {
    return this.enqueue(() =>
      this.commit((draft) => {
        const current = findRecord(draft.projects, id, "project");
        const changes = supplied(edit, ["name", "objectives", "status"]);
        const updated = parseProject({ ...current, ...changes });
        draft.projects = draft.projects.map((p) => (p.id === id ? updated : p));
        return updated;
      }),
    );
  }

  createTask(input: TaskCreate): Promise<Task> {
    return this.enqueue(() =>
      this.commit((draft) => {
        const parents = workParentFields(draft, input);
        const fields = supplied(input, [
          "title",
          "status",
          "priority",
          "owner",
          "dueDate",
          "context",
        ]);
        const task = parseTask({
          id: this.nextId(draft, "tasks"),
          ...parents,
          title: fields.title,
          status: "status" in fields ? fields.status : "open",
          priority: "priority" in fields ? fields.priority : "normal",
          owner: "owner" in fields ? fields.owner : "",
          // A blank due date means the task has no due date; there is no default.
          dueDate: fields.dueDate,
          context: "context" in fields ? fields.context : "",
        });
        draft.tasks.push(task);
        return task;
      }),
    );
  }

  updateTask(id: string, edit: TaskEdit): Promise<Task> {
    return this.enqueue(() =>
      this.commit((draft) => {
        const current = findRecord(draft.tasks, id, "task");
        const { clear, ...parents } = editedParents(draft, current, edit);
        const changes = supplied(edit, [
          "title",
          "status",
          "priority",
          "owner",
          "dueDate",
          "context",
        ]);
        const base = { ...current, projectId: clear ? undefined : parents.projectId };
        const updated = parseTask({ ...base, ...parents, ...changes });
        draft.tasks = draft.tasks.map((t) => (t.id === id ? updated : t));
        return updated;
      }),
    );
  }

  createItem(input: WorkItemCreate): Promise<WorkItem> {
    return this.enqueue(() =>
      this.commit((draft) => {
        const parents = workParentFields(draft, input);
        const fields = supplied(input, ["kind", "title", "context", "state"]);
        const item = parseWorkItem({
          id: this.nextId(draft, "items"),
          ...parents,
          kind: fields.kind,
          title: fields.title,
          context: "context" in fields ? fields.context : "",
          state: "state" in fields ? fields.state : "open",
        });
        draft.items.push(item);
        return item;
      }),
    );
  }

  updateItem(id: string, edit: WorkItemEdit): Promise<WorkItem> {
    return this.enqueue(() =>
      this.commit((draft) => {
        const current = findRecord(draft.items, id, "item");
        const { clear, ...parents } = editedParents(draft, current, edit);
        const changes = supplied(edit, ["kind", "title", "context", "state"]);
        const base = { ...current, projectId: clear ? undefined : parents.projectId };
        const updated = parseWorkItem({ ...base, ...parents, ...changes });
        draft.items = draft.items.map((i) => (i.id === id ? updated : i));
        return updated;
      }),
    );
  }

  createMeeting(input: MeetingCreate): Promise<Meeting> {
    return this.enqueue(() =>
      this.commit((draft) => {
        const parents = workParentFields(draft, input);
        const fields = supplied(input, ["title", "date", "notes"]);
        const meeting = parseMeeting({
          id: this.nextId(draft, "meetings"),
          ...parents,
          title: fields.title,
          date: fields.date,
          notes: "notes" in fields ? fields.notes : "",
        });
        draft.meetings.push(meeting);
        return meeting;
      }),
    );
  }

  updateMeeting(id: string, edit: MeetingEdit): Promise<Meeting> {
    return this.enqueue(() =>
      this.commit((draft) => {
        const current = findRecord(draft.meetings, id, "meeting");
        const { clear, ...parents } = editedParents(draft, current, edit);
        const changes = supplied(edit, ["title", "date", "notes"]);
        const base = { ...current, projectId: clear ? undefined : parents.projectId };
        const updated = parseMeeting({ ...base, ...parents, ...changes });
        draft.meetings = draft.meetings.map((m) => (m.id === id ? updated : m));
        return updated;
      }),
    );
  }

  setArchived(kind: ArchiveKind, id: string, archived: boolean): Promise<void> {
    // Archival is an ordinary mutation: it enters the queue first, so a closed
    // or blocked store refuses it exactly as it refuses every other mutation.
    // The arguments are then validated inside the queued operation, and only
    // after that is the record looked up; a bad argument is refused without
    // writing anything.
    return this.enqueue(() =>
      this.commit((draft) => {
        const args = requireArchiveArguments(kind, id, archived);
        const key = ARCHIVE_COLLECTION_KEYS[args.kind];
        const items = draft[key];
        const current = findRecord(
          items as readonly { id: string }[],
          args.id,
          args.kind,
        );
        // Rebuild the record so `true` adds the flag and `false` drops it;
        // every other field, including links and counters, is untouched. The
        // record is parsed again so a rebuilt record is still strictly valid.
        const rebuilt: Record<string, unknown> = { ...current };
        if (args.archived) rebuilt.archived = true;
        else delete rebuilt.archived;
        const updated = collections[key].parse(rebuilt, args.kind);
        const index = items.findIndex((item) => item.id === args.id);
        (items as unknown[])[index] = updated;
      }),
    );
  }

  listTasks(filter: WorkFilter): readonly Task[] {
    return selectWork(this.state.tasks, filter);
  }

  listItems(filter: WorkFilter): readonly WorkItem[] {
    return selectWork(this.state.items, filter);
  }

  listMeetings(filter: WorkFilter): readonly Meeting[] {
    return selectWork(this.state.meetings, filter);
  }

  async close(): Promise<void> {
    this.closed = true;
    const pending = this.queue;
    // Wait for queued mutations that were accepted before close. A failure in
    // any of them is the caller's error, reported by that operation.
    await pending.then(
      () => undefined,
      () => undefined,
    );
    if (this.lockReleased) return;
    try {
      try {
        this.fs.readFileSync(this.lockPath, "utf8");
      } catch (cause) {
        if (isMissing(cause)) {
          this.lockReleased = true;
          return;
        }
        throw cause;
      }
      try {
        this.fs.unlinkSync(this.lockPath);
      } catch (cause) {
        if (!isMissing(cause)) throw cause;
      }
      this.lockReleased = true;
    } catch (cause) {
      throw new PersistenceError("Failed to release store ownership", { cause });
    }
  }
}

export async function openStore(
  directory: string,
  options: StoreOptions = {},
): Promise<Store> {
  // The default adapter's directory flush calls back into the adapter it was
  // built for, so merge the injected operations onto that one instead of onto a
  // copy: an injected open, flush or close is then the operation the flush uses.
  const platform = options.platform ?? process.platform;
  const fs = defaultFileSystem(platform);
  Object.assign(fs, options.fs);
  if (options.fs?.fsyncDirectorySync === undefined) {
    // A copy without an injected directory flush still reaches the merged adapter.
    fs.fsyncDirectorySync = (path) => flushDirectorySync(fs, path, platform);
  }
  const lockPath = join(directory, LOCK_FILE);
  const storePath = join(directory, STORE_FILE);
  let lockCreated = false;
  try {
    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch (cause) {
      throw new PersistenceError("Failed to create the store directory", { cause });
    }

    // Acquire the lock with an exclusive create. Only a successful open means
    // the lock file is ours; an open failure (EEXIST, EMFILE, ...) may have
    // touched nothing, so it must never remove a lock another writer owns.
    let lockFd: number | null = null;
    try {
      lockFd = fs.openSync(lockPath, "wx");
    } catch (cause) {
      if (errorCode(cause) === "EEXIST") {
        throw new BusyStoreError(
          `Store directory ${JSON.stringify(directory)} is owned by another writer`,
        );
      }
      throw new PersistenceError("Failed to acquire store ownership", { cause });
    }
    lockCreated = true;
    try {
      writeFully(fs, lockFd, JSON.stringify({ pid: process.pid }));
      let lockClosed = false;
      try {
        closeInitialDescriptorSync(fs, lockFd);
        lockClosed = true;
      } catch (failure) {
        throw failure;
      }
      // Keep ownership until close is confirmed; cleanup closes it again if not.
      if (lockClosed) lockFd = null;
    } catch (cause) {
      // The exclusive create succeeded, so this partial lock is ours and must be
      // removed before failing. Close any descriptor we still own only once its
      // descriptor is known to be closed, then unlink.
      let cleanupFailure: unknown;
      if (lockFd !== null) {
        const result = closeDescriptorSync(fs, lockFd);
        // An EBADF after a reported close failure means cleanup already closed
        // it; otherwise the descriptor may still be open and the file is kept.
        if (result.closed) lockFd = null;
        else cleanupFailure = result.failure;
      }
      if (lockFd === null) {
        try {
          fs.unlinkSync(lockPath);
        } catch (cleanupCause) {
          if (!isMissing(cleanupCause) && cleanupFailure === undefined) {
            cleanupFailure = cleanupCause;
          }
        }
      }
      // The cleanup has been attempted; do not retry it in the outer catch and
      // thereby hide the original, more specific error.
      lockCreated = false;
      if (cleanupFailure !== undefined) {
        throw new PersistenceError(
          "Failed to acquire store ownership and could not remove the partial lock",
          { cause: failureOr(cause, cleanupFailure) },
        );
      }
      throw new PersistenceError("Failed to acquire store ownership", { cause });
    }

    let state = emptyState();
    if (fs.existsSync(storePath)) {
      let text: string;
      try {
        text = fs.readFileSync(storePath, "utf8");
      } catch (cause) {
        throw new PersistenceError("Failed to read workspace data", { cause });
      }
      state = parseState(text);
    }
    return new StoreImpl(state, fs, directory);
  } catch (error) {
    if (lockCreated) {
      try {
        fs.unlinkSync(lockPath);
      } catch (cleanupCause) {
        if (!isMissing(cleanupCause)) {
          throw new PersistenceError(
            "Store initialization failed and its lock could not be released",
            { cause: error },
          );
        }
      }
    }
    throw error;
  }
}
