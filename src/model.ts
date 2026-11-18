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
}

export interface Engagement {
  id: string;
  clientId: string;
  name: string;
  objectives: string;
  status: EngagementStatus;
}

export interface Project {
  id: string;
  engagementId: string;
  name: string;
  objectives: string;
  status: ProjectStatus;
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

const CLIENT_KEYS = [
  "id",
  "name",
  "background",
  "contacts",
  "stakeholders",
  "requirements",
  "objectives",
] as const;
const ENGAGEMENT_KEYS = ["id", "clientId", "name", "objectives", "status"] as const;
const PROJECT_KEYS = ["id", "engagementId", "name", "objectives", "status"] as const;

export function parseClient(value: unknown, what = "client"): Client {
  const record = requireObject(value, what);
  requireExactKeys(record, CLIENT_KEYS, what);
  return {
    id: requireName(record.id, `${what}.id`),
    name: requireName(record.name, `${what}.name`),
    background: requireText(record.background, `${what}.background`),
    contacts: requireText(record.contacts, `${what}.contacts`),
    stakeholders: requireText(record.stakeholders, `${what}.stakeholders`),
    requirements: requireText(record.requirements, `${what}.requirements`),
    objectives: requireText(record.objectives, `${what}.objectives`),
  };
}

export function parseEngagement(value: unknown, what = "engagement"): Engagement {
  const record = requireObject(value, what);
  requireExactKeys(record, ENGAGEMENT_KEYS, what);
  return {
    id: requireName(record.id, `${what}.id`),
    clientId: requireName(record.clientId, `${what}.clientId`),
    name: requireName(record.name, `${what}.name`),
    objectives: requireText(record.objectives, `${what}.objectives`),
    status: requireStatus(record.status, `${what}.status`),
  };
}

export function parseProject(value: unknown, what = "project"): Project {
  const record = requireObject(value, what);
  requireExactKeys(record, PROJECT_KEYS, what);
  return {
    id: requireName(record.id, `${what}.id`),
    engagementId: requireName(record.engagementId, `${what}.engagementId`),
    name: requireName(record.name, `${what}.name`),
    objectives: requireText(record.objectives, `${what}.objectives`),
    status: requireStatus(record.status, `${what}.status`),
  };
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
