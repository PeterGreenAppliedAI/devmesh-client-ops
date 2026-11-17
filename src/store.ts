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
} from "node:fs";
import { join } from "node:path";

import {
  BusyStoreError,
  MissingRecordError,
  PersistenceError,
  STATUSES,
  ValidationError,
  type Client,
  type ClientInput,
  type ClientUpdate,
  type Contact,
  type Engagement,
  type EngagementInput,
  type EngagementUpdate,
  type Project,
  type ProjectInput,
  type ProjectUpdate,
  type Stakeholder,
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

const requireTextList = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${field} must be an array of strings`);
  }
  return value.map((item, index) => requireText(item, `${field}[${index}]`, true));
};

const requireContacts = (value: unknown, field: string): Contact[] => {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${field} must be an array`);
  }
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new ValidationError(`${field}[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    return {
      name: requireText(record.name, `${field}[${index}].name`, false),
      role: requireText(record.role ?? "", `${field}[${index}].role`, true),
      email: requireText(record.email ?? "", `${field}[${index}].email`, true),
      phone: requireText(record.phone ?? "", `${field}[${index}].phone`, true),
    };
  });
};

const requireStakeholders = (value: unknown, field: string): Stakeholder[] => {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${field} must be an array`);
  }
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new ValidationError(`${field}[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    return {
      name: requireText(record.name, `${field}[${index}].name`, false),
      role: requireText(record.role ?? "", `${field}[${index}].role`, true),
      notes: requireText(record.notes ?? "", `${field}[${index}].notes`, true),
    };
  });
};

const requireStatus = (value: unknown, field: string): Status => {
  if (typeof value !== "string" || !(STATUSES as readonly string[]).includes(value)) {
    throw new ValidationError(`${field} must be one of ${STATUSES.join(", ")}`);
  }
  return value as Status;
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

const cloneClient = (client: Client): Client => ({
  id: client.id,
  name: client.name,
  background: client.background,
  contacts: client.contacts.map((c) => ({ ...c })),
  stakeholders: client.stakeholders.map((s) => ({ ...s })),
  requirements: [...client.requirements],
  objectives: [...client.objectives],
});

const cloneEngagement = (engagement: Engagement): Engagement => ({
  id: engagement.id,
  clientId: engagement.clientId,
  name: engagement.name,
  objectives: [...engagement.objectives],
  status: engagement.status,
});

const cloneProject = (project: Project): Project => ({
  id: project.id,
  engagementId: project.engagementId,
  name: project.name,
  objectives: [...project.objectives],
  status: project.status,
});

const cloneState = (state: State): State => ({
  clients: state.clients.map(cloneClient),
  engagements: state.engagements.map(cloneEngagement),
  projects: state.projects.map(cloneProject),
});

/** Validate a parsed document, returning a clean internal state. */
const validateDocument = (document: PersistedDocument): State => {
  const ids = new Set<string>();
  const clients = document.clients.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new ValidationError(`clients[${index}] must be an object`);
    }
    const record = raw as unknown as Record<string, unknown>;
    const id = requireText(record.id, `clients[${index}].id`, false);
    if (ids.has(id)) throw new ValidationError(`duplicate id ${id}`);
    ids.add(id);
    return {
      id,
      name: requireText(record.name, `clients[${index}].name`, false),
      background: requireText(record.background ?? "", `clients[${index}].background`, true),
      contacts: requireContacts(record.contacts ?? [], `clients[${index}].contacts`),
      stakeholders: requireStakeholders(record.stakeholders ?? [], `clients[${index}].stakeholders`),
      requirements: requireTextList(record.requirements ?? [], `clients[${index}].requirements`),
      objectives: requireTextList(record.objectives ?? [], `clients[${index}].objectives`),
    };
  });
  const clientIds = new Set(clients.map((c) => c.id));

  const engagementIds = new Set<string>();
  const engagements = document.engagements.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new ValidationError(`engagements[${index}] must be an object`);
    }
    const record = raw as unknown as Record<string, unknown>;
    const id = requireText(record.id, `engagements[${index}].id`, false);
    if (ids.has(id)) throw new ValidationError(`duplicate id ${id}`);
    ids.add(id);
    engagementIds.add(id);
    const clientId = requireText(record.clientId, `engagements[${index}].clientId`, false);
    if (!clientIds.has(clientId)) {
      throw new MissingRecordError(`engagement ${id} references missing client ${clientId}`);
    }
    return {
      id,
      clientId,
      name: requireText(record.name, `engagements[${index}].name`, false),
      objectives: requireTextList(record.objectives ?? [], `engagements[${index}].objectives`),
      status: requireStatus(record.status, `engagements[${index}].status`),
    };
  });

  const projects = document.projects.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new ValidationError(`projects[${index}] must be an object`);
    }
    const record = raw as unknown as Record<string, unknown>;
    const id = requireText(record.id, `projects[${index}].id`, false);
    if (ids.has(id)) throw new ValidationError(`duplicate id ${id}`);
    ids.add(id);
    const engagementId = requireText(record.engagementId, `projects[${index}].engagementId`, false);
    if (!engagementIds.has(engagementId)) {
      throw new MissingRecordError(`project ${id} references missing engagement ${engagementId}`);
    }
    return {
      id,
      engagementId,
      name: requireText(record.name, `projects[${index}].name`, false),
      objectives: requireTextList(record.objectives ?? [], `projects[${index}].objectives`),
      status: requireStatus(record.status, `projects[${index}].status`),
    };
  });

  return { clients, engagements, projects };
};

class FileStore implements Store {
  private readonly directory: string;
  private readonly statePath: string;
  private readonly lockPath: string;
  private state: State;
  private lockHandle: number | null;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private tempCounter = 0;

  constructor(directory: string, state: State, lockHandle: number) {
    this.directory = directory;
    this.statePath = join(directory, STATE_FILE);
    this.lockPath = join(directory, LOCK_FILE);
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
        contacts: requireContacts(input?.contacts ?? [], "contacts"),
        stakeholders: requireStakeholders(input?.stakeholders ?? [], "stakeholders"),
        requirements: requireTextList(input?.requirements ?? [], "requirements"),
        objectives: requireTextList(input?.objectives ?? [], "objectives"),
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
          update?.contacts === undefined ? current.contacts : requireContacts(update.contacts, "contacts"),
        stakeholders:
          update?.stakeholders === undefined
            ? current.stakeholders
            : requireStakeholders(update.stakeholders, "stakeholders"),
        requirements:
          update?.requirements === undefined
            ? current.requirements
            : requireTextList(update.requirements, "requirements"),
        objectives:
          update?.objectives === undefined
            ? current.objectives
            : requireTextList(update.objectives, "objectives"),
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
        objectives: requireTextList(input?.objectives ?? [], "objectives"),
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
            : requireTextList(update.objectives, "objectives"),
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
        objectives: requireTextList(input?.objectives ?? [], "objectives"),
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
            : requireTextList(update.objectives, "objectives"),
        status: update?.status === undefined ? current.status : requireStatus(update.status, "status"),
      };
      state.projects[index] = next;
      return next;
    });
  }

  async close(): Promise<void> {
    await this.queue;
    if (this.closed) return;
    this.closed = true;
    this.releaseLock();
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

  /** Write to a same-directory temp file, fsync, then atomically rename. */
  private persist(document: PersistedDocument): void {
    const json = `${JSON.stringify(document, null, 2)}\n`;
    this.tempCounter += 1;
    const tempPath = join(
      this.directory,
      `${STATE_FILE}.${process.pid}.${this.tempCounter}.tmp`,
    );
    try {
      const fd = openSync(tempPath, "wx");
      try {
        writeSync(fd, json);
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

  private releaseLock(): void {
    if (this.lockHandle !== null) {
      try {
        closeSync(this.lockHandle);
      } catch {
        // Nothing useful to do if the handle is already closed.
      }
      this.lockHandle = null;
    }
    try {
      unlinkSync(this.lockPath);
    } catch {
      // The lock file may already be gone.
    }
  }
}

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
    writeSync(
      fd,
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }) + "\n",
    );
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
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
    throw new PersistenceError(`workspace state is corrupt: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new PersistenceError("workspace state is corrupt: not a JSON object");
  }
  const document = parsed as Record<string, unknown>;
  if (document.version !== FORMAT_VERSION) {
    throw new PersistenceError(
      `unsupported workspace state version: ${String(document.version)}`,
    );
  }
  if (
    !Array.isArray(document.clients) ||
    !Array.isArray(document.engagements) ||
    !Array.isArray(document.projects)
  ) {
    throw new PersistenceError("workspace state is corrupt: missing record collections");
  }
  try {
    return validateDocument({
      version: document.version as number,
      clients: document.clients as Client[],
      engagements: document.engagements as Engagement[],
      projects: document.projects as Project[],
    });
  } catch (error) {
    if (error instanceof ValidationError || error instanceof MissingRecordError) {
      throw new PersistenceError(`workspace state is invalid: ${error.message}`, { cause: error });
    }
    throw new PersistenceError(`workspace state is invalid: ${(error as Error).message}`, {
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
 */
export function openStore(directory: string): Promise<Store> {
  return (async () => {
    try {
      mkdirSync(directory, { recursive: true });
      if (!statSync(directory).isDirectory()) {
        throw new PersistenceError(`not a directory: ${directory}`);
      }
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError(`could not prepare data directory: ${(error as Error).message}`, {
        cause: error,
      });
    }
    const lockPath = join(directory, LOCK_FILE);
    const lockHandle = acquireLock(lockPath);
    try {
      const state = loadState(join(directory, STATE_FILE));
      return new FileStore(directory, state, lockHandle);
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
  Contact,
  Engagement,
  EngagementInput,
  EngagementUpdate,
  Project,
  ProjectInput,
  ProjectUpdate,
  Stakeholder,
  Status,
  WorkspaceSnapshot,
};
