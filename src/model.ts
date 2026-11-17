/** Record types and validation for the internal client operations workspace. */

export type EngagementStatus = "planned" | "active" | "on_hold" | "completed";
export type ProjectStatus = EngagementStatus;

export const ENGAGEMENT_STATUSES: readonly EngagementStatus[] = [
  "planned",
  "active",
  "on_hold",
  "completed",
];

export interface Contact {
  name: string;
  email: string;
  phone: string;
  role: string;
}

export interface Stakeholder {
  name: string;
  role: string;
  influence: string;
  notes: string;
}

export interface Objective {
  title: string;
  description: string;
}

export interface Client {
  id: string;
  name: string;
  background: string;
  contacts: Contact[];
  stakeholders: Stakeholder[];
  requirements: string[];
  objectives: Objective[];
}

export interface Engagement {
  id: string;
  clientId: string;
  name: string;
  objectives: Objective[];
  status: EngagementStatus;
}

export interface Project {
  id: string;
  engagementId: string;
  name: string;
  objectives: Objective[];
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

function requireArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${what} must be an array`);
  }
  return value;
}

function parseContact(value: unknown, what: string): Contact {
  const record = requireObject(value, what);
  return {
    name: requireName(record.name, `${what}.name`),
    email: requireText(record.email, `${what}.email`),
    phone: requireText(record.phone, `${what}.phone`),
    role: requireText(record.role, `${what}.role`),
  };
}

function parseStakeholder(value: unknown, what: string): Stakeholder {
  const record = requireObject(value, what);
  return {
    name: requireName(record.name, `${what}.name`),
    role: requireText(record.role, `${what}.role`),
    influence: requireText(record.influence, `${what}.influence`),
    notes: requireText(record.notes, `${what}.notes`),
  };
}

function parseObjective(value: unknown, what: string): Objective {
  const record = requireObject(value, what);
  return {
    title: requireName(record.title, `${what}.title`),
    description: requireText(record.description, `${what}.description`),
  };
}

function parseArray<T>(
  value: unknown,
  what: string,
  parseItem: (item: unknown, itemWhat: string) => T,
): T[] {
  return requireArray(value, what).map((item, index) =>
    parseItem(item, `${what}[${index}]`),
  );
}

export function parseClient(value: unknown, what = "client"): Client {
  const record = requireObject(value, what);
  return {
    id: requireName(record.id, `${what}.id`),
    name: requireName(record.name, `${what}.name`),
    background: requireText(record.background, `${what}.background`),
    contacts: parseArray(record.contacts, `${what}.contacts`, parseContact),
    stakeholders: parseArray(
      record.stakeholders,
      `${what}.stakeholders`,
      parseStakeholder,
    ),
    requirements: parseArray(
      record.requirements,
      `${what}.requirements`,
      (item, itemWhat) => requireText(item, itemWhat),
    ),
    objectives: parseArray(
      record.objectives,
      `${what}.objectives`,
      parseObjective,
    ),
  };
}

export function parseEngagement(value: unknown, what = "engagement"): Engagement {
  const record = requireObject(value, what);
  return {
    id: requireName(record.id, `${what}.id`),
    clientId: requireName(record.clientId, `${what}.clientId`),
    name: requireName(record.name, `${what}.name`),
    objectives: parseArray(
      record.objectives,
      `${what}.objectives`,
      parseObjective,
    ),
    status: requireStatus(record.status, `${what}.status`),
  };
}

export function parseProject(value: unknown, what = "project"): Project {
  const record = requireObject(value, what);
  return {
    id: requireName(record.id, `${what}.id`),
    engagementId: requireName(record.engagementId, `${what}.engagementId`),
    name: requireName(record.name, `${what}.name`),
    objectives: parseArray(
      record.objectives,
      `${what}.objectives`,
      parseObjective,
    ),
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
