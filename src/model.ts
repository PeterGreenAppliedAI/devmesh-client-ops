/** Record types and validation for the internal client operations workspace. */

export type EngagementStatus = "planned" | "active" | "on_hold" | "completed";
export type ProjectStatus = EngagementStatus;

export const ENGAGEMENT_STATUSES: readonly EngagementStatus[] = [
  "planned",
  "active",
  "on_hold",
  "completed",
];

export interface Client {
  id: string;
  name: string;
  background: string;
  contacts: string;
  stakeholders: string;
  requirements: string;
  objectives: string;
  /** True when the record is archived; false or absent means active. */
  archived?: boolean;
}

export interface Engagement {
  id: string;
  clientId: string;
  name: string;
  objectives: string;
  status: EngagementStatus;
  /** True when the record is archived; false or absent means active. */
  archived?: boolean;
}

export interface Project {
  id: string;
  engagementId: string;
  name: string;
  objectives: string;
  status: ProjectStatus;
  /** True when the record is archived; false or absent means active. */
  archived?: boolean;
}

/** Error raised when a record or one of its fields is invalid. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Error raised when a referenced record does not exist. */
export class MissingRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingRecordError";
  }
}

/** Error raised when the data directory is already owned by another writer. */
export class BusyStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusyStoreError";
  }
}

/** Error raised when persisted data cannot be read, parsed, written or owned. */
export class PersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PersistenceError";
  }
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  what: string,
): void {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) {
      throw new ValidationError(`${what} has unsupported field ${JSON.stringify(key)}`);
    }
  }
}

function requireText(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${what} must be a string`);
  }
  return value;
}

function requireName(value: unknown, what: string): string {
  const text = requireText(value, what);
  if (text.trim() === "") {
    throw new ValidationError(`${what} must be nonblank`);
  }
  return text;
}

function requireStatus(value: unknown, what: string): EngagementStatus {
  if (typeof value !== "string" || !ENGAGEMENT_STATUSES.includes(value as EngagementStatus)) {
    throw new ValidationError(
      `${what} must be one of ${ENGAGEMENT_STATUSES.join(", ")}`,
    );
  }
  return value as EngagementStatus;
}

/**
 * Accept an optional archival flag. The flag is only ever boolean; `true`
 * marks a record archived and `false` means active. A stored document may
 * spell active either as an absent flag or as `false`; both are read as
 * active. Removing the flag from a record is `setArchived(false)`'s job, not
 * the parser's, so a stored `false` is accepted rather than refused.
 */
function optionalArchived(value: unknown, what: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ValidationError(`${what} must be a boolean`);
  }
  return value;
}

/** Keep the archival flag when one is given; otherwise the field is absent. */
function withArchived<T extends { archived?: boolean }>(
  record: T,
  archived: boolean | undefined,
): T {
  if (archived !== undefined) record.archived = archived;
  return record;
}

const CLIENT_KEYS = [
  "id",
  "name",
  "background",
  "contacts",
  "stakeholders",
  "requirements",
  "objectives",
  "archived",
] as const;
const ENGAGEMENT_KEYS = [
  "id",
  "clientId",
  "name",
  "objectives",
  "status",
  "archived",
] as const;
const PROJECT_KEYS = [
  "id",
  "engagementId",
  "name",
  "objectives",
  "status",
  "archived",
] as const;

export function parseClient(value: unknown, what = "client"): Client {
  const record = requireObject(value, what);
  requireExactKeys(record, CLIENT_KEYS, what);
  return withArchived<Client>(
    {
      id: requireName(record.id, `${what}.id`),
      name: requireName(record.name, `${what}.name`),
      background: requireText(record.background, `${what}.background`),
      contacts: requireText(record.contacts, `${what}.contacts`),
      stakeholders: requireText(record.stakeholders, `${what}.stakeholders`),
      requirements: requireText(record.requirements, `${what}.requirements`),
      objectives: requireText(record.objectives, `${what}.objectives`),
    },
    optionalArchived(record.archived, `${what}.archived`),
  );
}

export function parseEngagement(value: unknown, what = "engagement"): Engagement {
  const record = requireObject(value, what);
  requireExactKeys(record, ENGAGEMENT_KEYS, what);
  return withArchived<Engagement>(
    {
      id: requireName(record.id, `${what}.id`),
      clientId: requireName(record.clientId, `${what}.clientId`),
      name: requireName(record.name, `${what}.name`),
      objectives: requireText(record.objectives, `${what}.objectives`),
      status: requireStatus(record.status, `${what}.status`),
    },
    optionalArchived(record.archived, `${what}.archived`),
  );
}

export function parseProject(value: unknown, what = "project"): Project {
  const record = requireObject(value, what);
  requireExactKeys(record, PROJECT_KEYS, what);
  return withArchived<Project>(
    {
      id: requireName(record.id, `${what}.id`),
      engagementId: requireName(record.engagementId, `${what}.engagementId`),
      name: requireName(record.name, `${what}.name`),
      objectives: requireText(record.objectives, `${what}.objectives`),
      status: requireStatus(record.status, `${what}.status`),
    },
    optionalArchived(record.archived, `${what}.archived`),
  );
}

/** Freeze an array (and nested plain objects) so snapshots cannot be mutated. */
export function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value) as T;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    return Object.freeze(value) as T;
  }
  return value;
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export type TaskStatus = "open" | "in_progress" | "waiting" | "done";
export const TASK_STATUSES: readonly TaskStatus[] = ["open", "in_progress", "waiting", "done"];
/**
 * The statuses a stored document may carry. Schema 5 added `waiting`; the
 * legacy schemas 1, 3 and 4 keep their old status rules, so a task in a legacy
 * document must still hold one of the three original statuses.
 */
export const LEGACY_TASK_STATUSES: readonly TaskStatus[] = ["open", "in_progress", "done"];
/**
 * The statuses the task form offers. Every status is offered, `waiting`
 * included: the boards expose waiting as its own group, so the task form no
 * longer holds a temporary gate against it.
 */
export const TASK_FORM_STATUSES: readonly TaskStatus[] = ["open", "in_progress", "waiting", "done"];

/**
 * The assertions a board movement may make about the target record before it
 * is moved. Each supplied id must equal the current stored record's link; an
 * absent project link compares as the empty string, so a caller can assert
 * that a task belongs to no project.
 */
export interface TaskIdentityExpectation {
  id?: string;
  clientId?: string;
  engagementId?: string;
  projectId?: string;
}

export type TaskPriority = "low" | "normal" | "high";
export const TASK_PRIORITIES: readonly TaskPriority[] = ["low", "normal", "high"];

export type ItemKind =
  | "decision"
  | "question"
  | "blocker"
  | "commitment"
  | "waiting"
  | "follow_up";
export const ITEM_KINDS: readonly ItemKind[] = [
  "decision",
  "question",
  "blocker",
  "commitment",
  "waiting",
  "follow_up",
];

export type ItemState = "open" | "closed";
export const ITEM_STATES: readonly ItemState[] = ["open", "closed"];

export interface Task {
  id: string;
  clientId: string;
  engagementId: string;
  projectId?: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  owner: string;
  dueDate?: string;
  context: string;
  /** True when the record is archived; false or absent means active. */
  archived?: boolean;
}

export interface WorkItem {
  id: string;
  clientId: string;
  engagementId: string;
  projectId?: string;
  kind: ItemKind;
  title: string;
  context: string;
  state: ItemState;
  /** True when the record is archived; false or absent means active. */
  archived?: boolean;
}

export interface Meeting {
  id: string;
  clientId: string;
  engagementId: string;
  projectId?: string;
  title: string;
  date: string;
  notes: string;
}

/**
 * Report a required date that is not a real YYYY-MM-DD calendar date. The
 * format, the month/day ranges and leap years are all checked, so dates such as
 * 2023-02-29 or 2026-13-01 are refused rather than normalised.
 */
export function requireDate(value: unknown, what: string): string {
  const text = requireText(value, what);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) {
    throw new ValidationError(`${what} must be a YYYY-MM-DD date`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) {
    throw new ValidationError(`${what} must be a real calendar date`);
  }
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const limit = month === 2 && leap ? 29 : daysInMonth;
  if (day < 1 || day > limit) {
    throw new ValidationError(`${what} must be a real calendar date`);
  }
  return text;
}

/**
 * Accept an absent optional project link. A project link is either omitted
 * (absent) or a nonblank project id; null is not a way to clear it, an edit
 * clears it only by supplying the `clearProject` flag.
 */
function requireOptionalParentId(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${what} must be a nonblank project id when supplied`);
  }
  return value;
}

/** Accept an absent task due date; a blank date means the field is absent. */
function optionalDate(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  return requireDate(value, what);
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  what: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ValidationError(`${what} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

const TASK_KEYS = [
  "id",
  "clientId",
  "engagementId",
  "projectId",
  "title",
  "status",
  "priority",
  "owner",
  "dueDate",
  "context",
  "archived",
] as const;
const ITEM_KEYS = [
  "id",
  "clientId",
  "engagementId",
  "projectId",
  "kind",
  "title",
  "context",
  "state",
  "archived",
] as const;
const MEETING_KEYS = [
  "id",
  "clientId",
  "engagementId",
  "projectId",
  "title",
  "date",
  "notes",
] as const;

export function parseTask(value: unknown, what = "task"): Task {
  const record = requireObject(value, what);
  requireExactKeys(record, TASK_KEYS, what);
  const task: Task = {
    id: requireName(record.id, `${what}.id`),
    clientId: requireName(record.clientId, `${what}.clientId`),
    engagementId: requireName(record.engagementId, `${what}.engagementId`),
    title: requireName(record.title, `${what}.title`),
    status: requireEnum(record.status, TASK_STATUSES, `${what}.status`),
    priority: requireEnum(record.priority, TASK_PRIORITIES, `${what}.priority`),
    owner: requireText(record.owner, `${what}.owner`),
    context: requireText(record.context, `${what}.context`),
  };
  const projectId = requireOptionalParentId(record.projectId, `${what}.projectId`);
  if (projectId !== undefined) task.projectId = projectId;
  const dueDate = optionalDate(record.dueDate, `${what}.dueDate`);
  if (dueDate !== undefined) task.dueDate = dueDate;
  return withArchived(task, optionalArchived(record.archived, `${what}.archived`));
}

export function parseWorkItem(value: unknown, what = "work item"): WorkItem {
  const record = requireObject(value, what);
  requireExactKeys(record, ITEM_KEYS, what);
  const item: WorkItem = {
    id: requireName(record.id, `${what}.id`),
    clientId: requireName(record.clientId, `${what}.clientId`),
    engagementId: requireName(record.engagementId, `${what}.engagementId`),
    kind: requireEnum(record.kind, ITEM_KINDS, `${what}.kind`),
    title: requireName(record.title, `${what}.title`),
    context: requireText(record.context, `${what}.context`),
    state: requireEnum(record.state, ITEM_STATES, `${what}.state`),
  };
  const projectId = requireOptionalParentId(record.projectId, `${what}.projectId`);
  if (projectId !== undefined) item.projectId = projectId;
  return withArchived(item, optionalArchived(record.archived, `${what}.archived`));
}

export function parseMeeting(value: unknown, what = "meeting"): Meeting {
  const record = requireObject(value, what);
  requireExactKeys(record, MEETING_KEYS, what);
  const meeting: Meeting = {
    id: requireName(record.id, `${what}.id`),
    clientId: requireName(record.clientId, `${what}.clientId`),
    engagementId: requireName(record.engagementId, `${what}.engagementId`),
    title: requireName(record.title, `${what}.title`),
    date: requireDate(record.date, `${what}.date`),
    notes: requireText(record.notes, `${what}.notes`),
  };
  const projectId = requireOptionalParentId(record.projectId, `${what}.projectId`);
  if (projectId !== undefined) meeting.projectId = projectId;
  return meeting;
}
