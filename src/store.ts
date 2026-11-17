import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  BusyStoreError,
  CorruptDataError,
  MissingRecordError,
  PersistenceError,
  STATUSES,
  ValidationError,
  type Client,
  type ClientInput,
  type ClientUpdate,
  type Engagement,
  type EngagementInput,
  type EngagementUpdate,
  type Project,
  type ProjectInput,
  type ProjectUpdate,
  type Status,
  type WorkspaceSnapshot,
} from "./model.ts";

/** The on-disk format version this store writes and accepts. */
const FORMAT_VERSION = 1;

/** Name of the state file within the data directory. */
const STATE_FILE = "workspace.json";

/** Name of the ownership lock file within the data directory. */
const LOCK_FILE = "owner.lock";

/** Internal mutable state. Never handed out directly. */
interface State {
  clients: Client[];
  engagements: Engagement[];
  projects: Project[];
}

/** The JSON document persisted to disk. */
interface PersistedDocument {
  version: number;
  clients: Client[];
  engagements: Engagement[];
  projects: Project[];
}

/** A handle onto one data directory. */
export interface Store {
  /** Detached, deep-frozen read-only snapshot of current state. */
  snapshot(): WorkspaceSnapshot;
  createClient(input: ClientInput): Promise<Client>;
  updateClient(id: string, update: ClientUpdate): Promise<Client>;
  createEngagement(input: EngagementInput): Promise<Engagement>;
  updateEngagement(id: string, update: EngagementUpdate): Promise<Engagement>;
  createProject(input: ProjectInput): Promise<Project>;
  updateProject(id: string, update: ProjectUpdate): Promise<Project>;
  /** Release ownership of the data directory. */
  close(): Promise<void>;
}

const isBlank = (value: string): boolean => value.trim().length === 0;

const requireText = (value: unknown, field: string, allowEmpty: boolean): string => {
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string`);
  }
  if (!allowEmpty && isBlank(value)) {
    throw new ValidationError(`${field} must be nonblank`);
  }
  return value;
};

/** A descriptive field that must be present as text (empty text is allowed). */
const requireStoredText = (value: unknown, field: string): string => {
  if (value === undefined) {
    throw new ValidationError(`${field} is missing`);
  }
  return requireText(value, field, true);
};

const requireStatus = (value: unknown, field: string): Status => {
  if (typeof value !== "string" || !(STATUSES as readonly string[]).includes(value)) {
    throw new ValidationError(`${field} must be one of ${STATUSES.join(", ")}`);
  }
  return value as Status;
};

const requireRecord = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
};

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
};

const cloneClient = (client: Client): Client => ({ ...client });
const cloneEngagement = (engagement: Engagement): Engagement => ({ ...engagement });
const cloneProject = (project: Project): Project => ({ ...project });

const cloneValue = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = cloneValue(item);
    }
    return copy as unknown as T;
  }
  return value;
};

const cloneState = (state: State): State => ({
  clients: state.clients.map(cloneClient),
  engagements: state.engagements.map(cloneEngagement),
  projects: state.projects.map(cloneProject),
});

/** Validate one stored client record, returning a clean copy. */
const readStoredClient = (raw: unknown, field: string): Client => {
  const record = requireRecord(raw, field);
  return {
    id: requireText(record.id, `${field}.id`, false),
    name: requireText(record.name, `${field}.name`, false),
    background: requireStoredText(record.background, `${field}.background`),
    contacts: requireStoredText(record.contacts, `${field}.contacts`),
    stakeholders: requireStoredText(record.stakeholders, `${field}.stakeholders`),
    requirements: requireStoredText(record.requirements, `${field}.requirements`),
    objectives: requireStoredText(record.objectives, `${field}.objectives`),
  };
};

/** Validate one stored engagement record, returning a clean copy. */
const readStoredEngagement = (raw: unknown, field: string): Engagement => {
  const record = requireRecord(raw, field);
  return {
    id: requireText(record.id, `${field}.id`, false),
    clientId: requireText(record.clientId, `${field}.clientId`, false),
    name: requireText(record.name, `${field}.name`, false),
    objectives: requireStoredText(record.objectives, `${field}.objectives`),
    status: requireStatus(record.status, `${field}.status`),
  };
};

/** Validate one stored project record, returning a clean copy. */
const readStoredProject = (raw: unknown, field: string): Project => {
  const record = requireRecord(raw, field);
  return {
    id: requireText(record.id, `${field}.id`, false),
    engagementId: requireText(record.engagementId, `${field}.engagementId`, false),
    name: requireText(record.name, `${field}.name`, false),
    objectives: requireStoredText(record.objectives, `${field}.objectives`),
    status: requireStatus(record.status, `${field}.status`),
  };
};

/** Validate a parsed document, returning a clean internal state. */
const validateDocument = (document: {
  clients: unknown[];
  engagements: unknown[];
  projects: unknown[];
}): State => {
  const ids = new Set<string>();
  const addId = (id: string): void => {
    if (ids.has(id)) throw new ValidationError(`duplicate id ${id}`);
    ids.add(id);
  };

  const clients = document.clients.map((raw, index) => {
    const client = readStoredClient(raw, `clients[${index}]`);
    addId(client.id);
    return client;
  });
  const clientIds = new Set(clients.map((c) => c.id));

  const engagements = document.engagements.map((raw, index) => {
    const engagement = readStoredEngagement(raw, `engagements[${index}]`);
    addId(engagement.id);
    if (!clientIds.has(engagement.clientId)) {
      throw new MissingRecordError(
        `engagement ${engagement.id} references missing client ${engagement.clientId}`,
      );
    }
    return engagement;
  });
  const engagementIds = new Set(engagements.map((e) => e.id));

  const projects = document.projects.map((raw, index) => {
    const project = readStoredProject(raw, `projects[${index}]`);
    addId(project.id);
    if (!engagementIds.has(project.engagementId)) {
      throw new MissingRecordError(
        `project ${project.id} references missing engagement ${project.engagementId}`,
      );
    }
    return project;
  });

  return { clients, engagements, projects };
};

class FileStore implements Store {
  private readonly statePath: string;
  private readonly lockPath: string;
  private state: State;
  private lockHandle: number | null;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private tempCounter = 0;

  constructor(statePath: string, lockPath: string, state: State, lockHandle: number) {
    this.statePath = statePath;
    this.lockPath = lockPath;
    this.state = state;
    this.lockHandle = lockHandle;
  }

  snapshot(): WorkspaceSnapshot {
    return deepFreeze({
      clients: this.state.clients.map(cloneClient),
      engagements: this.state.engagements.map(cloneEngagement),
      projects: this.state.projects.map(cloneProject),
    });
  }

  createClient(input: ClientInput): Promise<Client> {
    return this.mutate((state) => {
      const client: Client = {
        id: this.newId(state),
        name: requireText(input?.name, "name", false),
        background: requireText(input?.background ?? "", "background", true),
        contacts: requireText(input?.contacts ?? "", "contacts", true),
        stakeholders: requireText(input?.stakeholders ?? "", "stakeholders", true),
        requirements: requireText(input?.requirements ?? "", "requirements", true),
        objectives: requireText(input?.objectives ?? "", "objectives", true),
      };
      state.clients.push(client);
      return client;
    });
  }

  updateClient(id: string, update: ClientUpdate): Promise<Client> {
    return this.mutate((state) => {
      const index = state.clients.findIndex((c) => c.id === id);
      if (index < 0) throw new MissingRecordError(`client ${id} not found`);
      const current = state.clients[index]!;
      const next: Client = {
        id: current.id,
        name: update?.name === undefined ? current.name : requireText(update.name, "name", false),
        background:
          update?.background === undefined
            ? current.background
            : requireText(update.background, "background", true),
        contacts:
          update?.contacts === undefined
            ? current.contacts
            : requireText(update.contacts, "contacts", true),
        stakeholders:
          update?.stakeholders === undefined
            ? current.stakeholders
            : requireText(update.stakeholders, "stakeholders", true),
        requirements:
          update?.requirements === undefined
            ? current.requirements
            : requireText(update.requirements, "requirements", true),
        objectives:
          update?.objectives === undefined
            ? current.objectives
            : requireText(update.objectives, "objectives", true),
      };
      state.clients[index] = next;
      return next;
    });
  }

  createEngagement(input: EngagementInput): Promise<Engagement> {
    return this.mutate((state) => {
      const clientId = requireText(input?.clientId, "clientId", false);
      if (!state.clients.some((c) => c.id === clientId)) {
        throw new MissingRecordError(`client ${clientId} not found`);
      }
      const engagement: Engagement = {
        id: this.newId(state),
        clientId,
        name: requireText(input?.name, "name", false),
        objectives: requireText(input?.objectives ?? "", "objectives", true),
        status: input?.status === undefined ? "planned" : requireStatus(input.status, "status"),
      };
      state.engagements.push(engagement);
      return engagement;
    });
  }

  updateEngagement(id: string, update: EngagementUpdate): Promise<Engagement> {
    return this.mutate((state) => {
      const index = state.engagements.findIndex((e) => e.id === id);
      if (index < 0) throw new MissingRecordError(`engagement ${id} not found`);
      const current = state.engagements[index]!;
      const next: Engagement = {
        id: current.id,
        clientId: current.clientId,
        name: update?.name === undefined ? current.name : requireText(update.name, "name", false),
        objectives:
          update?.objectives === undefined
            ? current.objectives
            : requireText(update.objectives, "objectives", true),
        status: update?.status === undefined ? current.status : requireStatus(update.status, "status"),
      };
      state.engagements[index] = next;
      return next;
    });
  }

  createProject(input: ProjectInput): Promise<Project> {
    return this.mutate((state) => {
      const engagementId = requireText(input?.engagementId, "engagementId", false);
      if (!state.engagements.some((e) => e.id === engagementId)) {
        throw new MissingRecordError(`engagement ${engagementId} not found`);
      }
      const project: Project = {
        id: this.newId(state),
        engagementId,
        name: requireText(input?.name, "name", false),
        objectives: requireText(input?.objectives ?? "", "objectives", true),
        status: input?.status === undefined ? "planned" : requireStatus(input.status, "status"),
      };
      state.projects.push(project);
      return project;
    });
  }

  updateProject(id: string, update: ProjectUpdate): Promise<Project> {
    return this.mutate((state) => {
      const index = state.projects.findIndex((p) => p.id === id);
      if (index < 0) throw new MissingRecordError(`project ${id} not found`);
      const current = state.projects[index]!;
      const next: Project = {
        id: current.id,
        engagementId: current.engagementId,
        name: update?.name === undefined ? current.name : requireText(update.name, "name", false),
        objectives:
          update?.objectives === undefined
            ? current.objectives
            : requireText(update.objectives, "objectives", true),
        status: update?.status === undefined ? current.status : requireStatus(update.status, "status"),
      };
      state.projects[index] = next;
      return next;
    });
  }

  async close(): Promise<void> {
    await this.queue.catch(() => undefined);
    if (this.closed) return;
    this.releaseLock();
    this.closed = true;
  }

  /** Ensure the store is open and serialize the mutation. */
  private mutate<T>(operation: (state: State) => T): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.closed) {
        throw new PersistenceError("store is closed");
      }
      const draft = cloneState(this.state);
      const result = operation(draft);
      const document = this.toDocument(draft);
      this.persist(document);
      this.state = draft;
      return cloneValue(result);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private toDocument(state: State): PersistedDocument {
    return {
      version: FORMAT_VERSION,
      clients: state.clients.map(cloneClient),
      engagements: state.engagements.map(cloneEngagement),
      projects: state.projects.map(cloneProject),
    };
  }

  /** Write the complete JSON to a same-directory temp file, fsync, then atomically rename. */
  private persist(document: PersistedDocument): void {
    const json = `${JSON.stringify(document, null, 2)}\n`;
    this.tempCounter += 1;
    const tempPath = join(
      dirname(this.statePath),
      `${STATE_FILE}.${process.pid}.${this.tempCounter}.tmp`,
    );
    try {
      const buffer = Buffer.from(json, "utf8");
      const fd = openSync(tempPath, "wx");
      try {
        let offset = 0;
        while (offset < buffer.length) {
          const written = writeSync(fd, buffer, offset, buffer.length - offset);
          if (!(written > 0)) {
            throw new Error(`short write: ${written} of ${buffer.length - offset} bytes`);
          }
          offset += written;
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tempPath, this.statePath);
    } catch (error) {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // Best effort cleanup; the original error is the one worth reporting.
      }
      throw new PersistenceError(`failed to persist workspace state: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }

  private newId(state: State): string {
    const used = new Set<string>([
      ...state.clients.map((c) => c.id),
      ...state.engagements.map((e) => e.id),
      ...state.projects.map((p) => p.id),
    ]);
    let id = randomUUID();
    while (used.has(id)) id = randomUUID();
    return id;
  }

  /**
   * Remove the lock file and close its handle.
   *
   * A missing lock file is fine. Any other failure is reported so `close` does
   * not claim success while ownership of the directory is still held.
   */
  private releaseLock(): void {
    let unlinkError: unknown = null;
    try {
      unlinkSync(this.lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") unlinkError = error;
    }
    if (this.lockHandle !== null) {
      try {
        closeSync(this.lockHandle);
      } catch (error) {
        if (!unlinkError) unlinkError = error;
      }
      this.lockHandle = null;
    }
    if (unlinkError) {
      throw new PersistenceError(
        `could not release store lock: ${(unlinkError as Error).message}`,
        { cause: unlinkError },
      );
    }
  }
}

/** Acquire exclusive ownership of a data directory by creating the lock file. */
const acquireLock = (lockPath: string): number => {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new BusyStoreError(`data directory is owned by another store: ${lockPath}`);
    }
    throw new PersistenceError(`could not acquire store lock: ${(error as Error).message}`, {
      cause: error,
    });
  }
  try {
    const contents = Buffer.from(
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }) + "\n",
      "utf8",
    );
    let offset = 0;
    while (offset < contents.length) {
      const written = writeSync(fd, contents, offset, contents.length - offset);
      if (!(written > 0)) throw new Error("short write of lock contents");
      offset += written;
    }
    fsyncSync(fd);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // Ignore.
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // Ignore cleanup failure; the acquire error is what matters.
    }
    throw new PersistenceError(`could not write store lock: ${(error as Error).message}`, {
      cause: error,
    });
  }
  return fd;
};

/** Read and validate the persisted document, refusing corrupt or unsupported data. */
const loadState = (statePath: string): State => {
  let raw: string;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { clients: [], engagements: [], projects: [] };
    }
    throw new PersistenceError(`could not read workspace state: ${(error as Error).message}`, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CorruptDataError(`workspace state is corrupt: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CorruptDataError("workspace state is corrupt: not a JSON object");
  }
  const document = parsed as Record<string, unknown>;
  if (document.version !== FORMAT_VERSION) {
    throw new CorruptDataError(
      `unsupported workspace state version: ${String(document.version)}`,
    );
  }
  if (
    !Array.isArray(document.clients) ||
    !Array.isArray(document.engagements) ||
    !Array.isArray(document.projects)
  ) {
    throw new CorruptDataError("workspace state is corrupt: missing record collections");
  }
  try {
    return validateDocument({
      clients: document.clients,
      engagements: document.engagements,
      projects: document.projects,
    });
  } catch (error) {
    if (error instanceof ValidationError || error instanceof MissingRecordError) {
      throw new CorruptDataError(`workspace state is invalid: ${error.message}`, { cause: error });
    }
    throw new CorruptDataError(`workspace state is invalid: ${(error as Error).message}`, {
      cause: error,
    });
  }
};

/**
 * Open (or create) the persistent workspace in `directory`.
 *
 * Acquires exclusive ownership, loads and validates any existing state, and
 * returns a store whose reads are detached snapshots and whose writes are
 * serialized, validated and persisted atomically before they are acknowledged.
 * A failed initialization releases ownership.
 */
export function openStore(directory: string): Promise<Store> {
  return (async () => {
    let stats: Stats;
    try {
      mkdirSync(directory, { recursive: true });
      stats = statSync(directory);
    } catch (error) {
      throw new PersistenceError(`could not prepare data directory: ${(error as Error).message}`, {
        cause: error,
      });
    }
    if (!stats.isDirectory()) {
      throw new PersistenceError(`not a directory: ${directory}`);
    }
    const statePath = join(directory, STATE_FILE);
    const lockPath = join(directory, LOCK_FILE);
    const lockHandle = acquireLock(lockPath);
    try {
      const state = loadState(statePath);
      return new FileStore(statePath, lockPath, state, lockHandle);
    } catch (error) {
      try {
        closeSync(lockHandle);
      } catch {
        // Ignore.
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // Ignore.
      }
      throw error;
    }
  })();
}

export type {
  Client,
  ClientInput,
  ClientUpdate,
  Engagement,
  EngagementInput,
  EngagementUpdate,
  Project,
  ProjectInput,
  ProjectUpdate,
  Status,
  WorkspaceSnapshot,
};
