/**
 * Activity journal storage: the persisted record shape and its strict
 * validation. Recording events is not part of this module yet; it only defines
 * what a stored event is and how the journal and its counter are validated, so
 * that a document carrying a journal can be read and written faithfully.
 */
import {
  clone,
  deepFreeze,
  ValidationError,
  type Client,
  type Engagement,
  type Meeting,
  type Project,
  type Task,
  type WorkItem,
} from "./model.ts";

/** The actions a journal event can describe. */
export type ActivityAction = "create" | "edit" | "archive" | "restore";
export const ACTIVITY_ACTIONS: readonly ActivityAction[] = [
  "create",
  "edit",
  "archive",
  "restore",
];

/** The record families a journal event can target. */
export type ActivityTargetKind =
  | "client"
  | "engagement"
  | "project"
  | "task"
  | "item"
  | "meeting";
export const ACTIVITY_TARGET_KINDS: readonly ActivityTargetKind[] = [
  "client",
  "engagement",
  "project",
  "task",
  "item",
  "meeting",
];

/**
 * One recorded change: a locally assigned identity, a canonical UTC timestamp,
 * the action performed and the record it targeted. IDs never repeat and are
 * never reused; events are kept in the order they were recorded.
 */
export interface ActivityEvent {
  id: number;
  at: string;
  action: ActivityAction;
  targetKind: ActivityTargetKind;
  targetId: string;
}

/**
 * The record collections an event's target is looked up in. Meetings share the
 * `meeting` kind; their IDs are generated in the same `meeting-N` shape as the
 * other families.
 */
export interface ActivityTargets {
  readonly clients: readonly Client[];
  readonly engagements: readonly Engagement[];
  readonly projects: readonly Project[];
  readonly tasks: readonly Task[];
  readonly items: readonly WorkItem[];
  readonly meetings: readonly Meeting[];
}

const ACTIVITY_EVENT_KEYS = [
  "id",
  "at",
  "action",
  "targetKind",
  "targetId",
] as const;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The stored text is also compared with its own length, so a match cannot hide
 * trailing text: a JavaScript `$` anchor also matches just before a final
 * newline, which would otherwise let a non-canonical value through.
 */
function isCanonicalInstant(text: string): boolean {
  return ISO_INSTANT.test(text) && text.length === 24;
}

function requireText(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${what} must be a string`);
  }
  return value;
}

/**
 * Accept a canonical UTC timestamp: a calendar date and time with exactly
 * three fractional digits and a trailing `Z`, and a date that exists. The value
 * must already be in that form; a locally offset or otherwise spelled instant
 * is refused rather than normalised, so the stored text is the recorded text.
 */
function requireTimestamp(value: unknown, what: string): string {
  const text = requireText(value, what);
  if (!isCanonicalInstant(text)) {
    throw new ValidationError(`${what} must be a canonical UTC ISO timestamp`);
  }
  const [year, month, day] = text.slice(0, 10).split("-").map(Number);
  const [hour, minute, second] = text.slice(11, 19).split(":").map(Number);
  if (month < 1 || month > 12) {
    throw new ValidationError(`${what} must be a real calendar date`);
  }
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const limit = month === 2 && leap ? 29 : daysInMonth;
  if (day < 1 || day > limit || hour > 23 || minute > 59 || second > 59) {
    throw new ValidationError(`${what} must be a real calendar date and time`);
  }
  return text;
}

/**
 * Accept a positive safe integer id strictly below the safe-integer ceiling.
 * The ceiling itself is reserved: an id there cannot be safely represented and
 * the journal counter cannot advance past it, so it is refused as an event id.
 */
function requireEventId(value: unknown, what: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value >= Number.MAX_SAFE_INTEGER
  ) {
    throw new ValidationError(
      `${what} must be a positive safe integer below the safe-integer ceiling`,
    );
  }
  return value;
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

/**
 * Parse one stored journal event. The keys are exact, the id is a positive safe
 * integer below the ceiling, the timestamp is a canonical UTC instant, and the
 * action and target kind are from their fixed lists. Target existence, meeting
 * archive/restore refusal and id uniqueness need the whole document, so they
 * are checked by `parseActivity`.
 */
export function parseActivityEvent(value: unknown, what = "activity event"): ActivityEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`${what} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(ACTIVITY_EVENT_KEYS as readonly string[]).includes(key)) {
      throw new ValidationError(`${what} has unsupported field ${JSON.stringify(key)}`);
    }
  }
  for (const key of ACTIVITY_EVENT_KEYS) {
    if (!(key in record)) {
      throw new ValidationError(`${what} is missing field ${JSON.stringify(key)}`);
    }
  }
  const action = requireEnum(record.action, ACTIVITY_ACTIONS, `${what}.action`);
  const targetKind = requireEnum(
    record.targetKind,
    ACTIVITY_TARGET_KINDS,
    `${what}.targetKind`,
  );
  // A meeting inherits visibility and never carries a flag, so it cannot be
  // archived or restored; such an event is refused rather than kept.
  if (targetKind === "meeting" && (action === "archive" || action === "restore")) {
    throw new ValidationError(
      `${what} cannot ${action} a meeting: meetings are never archived`,
    );
  }
  return {
    id: requireEventId(record.id, `${what}.id`),
    at: requireTimestamp(record.at, `${what}.at`),
    action,
    targetKind,
    targetId: requireText(record.targetId, `${what}.targetId`),
  };
}

function targetExists(
  targets: ActivityTargets,
  targetKind: ActivityTargetKind,
  id: string,
): boolean {
  const ids = new Set<string>();
  for (const record of targets[`${targetKind}s` as keyof ActivityTargets]) {
    ids.add(record.id);
  }
  return ids.has(id);
}

/**
 * Parse a stored journal and its counter against the document's records. Every
 * event is validated strictly; ids are unique, and every target must exist.
 * Events are not required to be stored in id order: identity is the id, and
 * uniqueness is what the counter has to cover. The counter is a positive safe
 * integer, the ceiling included, that is greater than every event id, so the
 * next allocation cannot reproduce one; a counter at the ceiling therefore
 * means the journal is exhausted, and allocation there is refused. The
 * returned events are detached and frozen.
 */
export function parseActivity(
  value: unknown,
  nextActivityId: unknown,
  targets: ActivityTargets,
): { activity: readonly ActivityEvent[]; nextActivityId: number } {
  if (!Array.isArray(value)) {
    throw new ValidationError("activity must be an array");
  }
  const seen = new Set<number>();
  const events = value.map((raw, index) => {
    const event = parseActivityEvent(raw, `activity[${index}]`);
    if (seen.has(event.id)) {
      throw new ValidationError(
        `activity contains duplicate id ${JSON.stringify(event.id)}`,
      );
    }
    if (!targetExists(targets, event.targetKind, event.targetId)) {
      throw new ValidationError(
        `activity[${index}] references missing ${event.targetKind} ${JSON.stringify(event.targetId)}`,
      );
    }
    seen.add(event.id);
    return event;
  });
  const highest = events.reduce((max, event) => Math.max(max, event.id), 0);
  if (
    typeof nextActivityId !== "number" ||
    !Number.isSafeInteger(nextActivityId) ||
    nextActivityId < 1
  ) {
    throw new ValidationError("nextActivityId must be a positive safe integer");
  }
  if (nextActivityId <= highest) {
    throw new ValidationError(
      `nextActivityId cannot safely advance past existing event id ${highest}`,
    );
  }
  return { activity: deepFreeze(clone(events)), nextActivityId };
}

/**
 * Allocate the next journal event id and advance the counter. Allocation needs
 * room to advance: a counter at the safe-integer ceiling cannot produce a
 * further id, so it is refused and the state is left unchanged. The caller
 * owns the state passed in; this function never captures an event or writes
 * one to disk, it only hands out the next identity.
 */
export function allocateActivityId(
  state: { activity: readonly ActivityEvent[]; nextActivityId: number },
): number {
  const next = state.nextActivityId;
  if (!Number.isSafeInteger(next) || next < 1 || next >= Number.MAX_SAFE_INTEGER) {
    throw new ValidationError(
      "Cannot allocate an activity event id: the journal counter cannot advance safely",
    );
  }
  if (state.activity.some((event) => event.id === next)) {
    throw new ValidationError(
      `Cannot allocate an activity event id: ${next} is already used`,
    );
  }
  state.nextActivityId = next + 1;
  return next;
}
