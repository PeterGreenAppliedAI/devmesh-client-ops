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
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  BusyStoreError,
  clone,
  deepFreeze,
  MissingRecordError,
  parseClient,
  parseEngagement,
  parseProject,
  PersistenceError,
  ValidationError,
  type Client,
  type Contact,
  type Engagement,
  type EngagementStatus,
  type Objective,
  type Project,
  type ProjectStatus,
  type Stakeholder,
} from "./model.ts";

export type {
  Client,
  Contact,
  Engagement,
  EngagementStatus,
  Objective,
  Project,
  ProjectStatus,
  Stakeholder,
} from "./model.ts";
export {
  BusyStoreError,
  MissingRecordError,
  PersistenceError,
  ValidationError,
} from "./model.ts";

const SCHEMA_VERSION = 1;
const STORE_FILE = "workspace.json";
const LOCK_FILE = "workspace.lock";

/** Input fields accepted when creating a client. */
export interface ClientCreate {
  name: string;
  background?: string;
  contacts?: Contact[];
  stakeholders?: Stakeholder[];
  requirements?: string[];
  objectives?: Objective[];
}

/** Partial update of a client; omitted fields keep their current value. */
export type ClientEdit = Partial<ClientCreate>;

/** Input fields accepted when creating an engagement. */
export interface EngagementCreate {
  clientId: string;
  name: string;
  objectives?: Objective[];
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
  objectives?: Objective[];
  status?: ProjectStatus;
}

/** Partial update of a project; parent links are immutable. */
export type ProjectEdit = Partial<
  Pick<ProjectCreate, "name" | "objectives" | "status">
>;

/** Detached, read-only view of the committed state. */
export interface Snapshot {
  readonly clients: readonly Client[];
  readonly engagements: readonly Engagement[];
  readonly projects: readonly Project[];
}

/** Internal file-system adapter, injectable so tests can simulate failures. */
export interface FileSystem {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { recursive: true }): void;
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string, options: { encoding: "utf8"; flag?: string }): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
  fsyncDirectorySync?(path: string): void;
}

/** Internal options accepted by openStore; only tests pass them. */
export interface StoreOptions {
  fs?: Partial<FileSystem>;
}

/** A collection of records that a store persists. */
interface Collection<T extends { id: string }> {
  readonly key: string;
  readonly kind: string;
  parse(value: unknown, what: string): T;
}

const collections = {
  clients: { key: "clients", kind: "client", parse: parseClient },
  engagements: { key: "engagements", kind: "engagement", parse: parseEngagement },
  projects: { key: "projects", kind: "project", parse: parseProject },
} satisfies Record<string, Collection<{ id: string }>>;

interface State {
  clients: Client[];
  engagements: Engagement[];
  projects: Project[];
  nextIds: Record<string, number>;
}

function defaultFileSystem(): FileSystem {
  return {
    existsSync,
    mkdirSync: (path, options) => mkdirSync(path, options),
    readFileSync: (path, encoding) => readFileSync(path, encoding),
    writeFileSync: (path, data, options) => writeFileSync(path, data, options),
    renameSync: (oldPath, newPath) => renameSync(oldPath, newPath),
    unlinkSync: (path) => unlinkSync(path),
    fsyncDirectorySync: (path) => {
      try {
        const fd = openSync(path, "r");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch {
        // Directory fsync is best-effort and unsupported on some platforms.
      }
    },
  };
}

function toJson(state: State): string {
  const document = {
    schemaVersion: SCHEMA_VERSION,
    clients: state.clients,
    engagements: state.engagements,
    projects: state.projects,
    nextIds: state.nextIds,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

function emptyState(): State {
  return { clients: [], engagements: [], projects: [], nextIds: {} };
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
  if (version !== SCHEMA_VERSION) {
    throw new PersistenceError(
      `Unsupported stored schema version: ${JSON.stringify(version)}`,
    );
  }
  const state = emptyState();
  for (const key of ["clients", "engagements", "projects"] as const) {
    const collection = collections[key];
    const values = record[key];
    if (!Array.isArray(values)) {
      throw new PersistenceError(`Stored ${key} must be an array`);
    }
    for (const [index, value] of values.entries()) {
      let parsed;
      try {
        parsed = collection.parse(value, `${key}[${index}]`);
      } catch (cause) {
        throw new PersistenceError(
          `Stored ${collection.kind} at ${key}[${index}] is invalid`,
          { cause },
        );
      }
      (state[key] as { id: string }[]).push(parsed);
    }
  }
  const nextIds = record.nextIds;
  if (typeof nextIds !== "object" || nextIds === null || Array.isArray(nextIds)) {
    throw new PersistenceError("Stored nextIds must be an object");
  }
  for (const [key, value] of Object.entries(nextIds)) {
    if (!Number.isInteger(value) || (value as number) < 1) {
      throw new PersistenceError(`Stored nextIds.${key} must be a positive integer`);
    }
    state.nextIds[key] = value as number;
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
  return state;
}

function snapshotOf(state: State): Snapshot {
  return deepFreeze({
    clients: clone(state.clients),
    engagements: clone(state.engagements),
    projects: clone(state.projects),
  });
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

export interface Store {
  /** Detached, read-only snapshot of the committed state. */
  snapshot(): Snapshot;
  createClient(input: ClientCreate): Promise<Client>;
  updateClient(id: string, edit: ClientEdit): Promise<Client>;
  createEngagement(input: EngagementCreate): Promise<Engagement>;
  updateEngagement(id: string, edit: EngagementEdit): Promise<Engagement>;
  createProject(input: ProjectCreate): Promise<Project>;
  updateProject(id: string, edit: ProjectEdit): Promise<Project>;
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
    const run = this.queue.then(operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private nextId(draft: State, kind: string): string {
    const next = draft.nextIds[kind] ?? 1;
    draft.nextIds[kind] = next + 1;
    return `${kind}-${next}`;
  }

  private async persist(next: State): Promise<void> {
    const tempPath = `${this.storePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    let tempCreated = false;
    try {
      this.fs.writeFileSync(tempPath, toJson(next), { encoding: "utf8", flag: "wx" });
      tempCreated = true;
      this.fs.renameSync(tempPath, this.storePath);
      tempCreated = false;
    } catch (cause) {
      if (tempCreated) {
        try {
          this.fs.unlinkSync(tempPath);
        } catch {
          // Best-effort cleanup of the orphaned temporary file.
        }
      }
      throw new PersistenceError("Failed to persist workspace data", { cause });
    }
    this.fs.fsyncDirectorySync?.(this.directory);
    this.state = next;
  }

  private commit<T>(mutate: (draft: State) => T): Promise<T> {
    const draft: State = clone(this.state);
    const result = mutate(draft);
    return this.persist(draft).then(() => clone(result));
  }

  createClient(input: ClientCreate): Promise<Client> {
    return this.enqueue(() =>
      this.commit((draft) => {
        const client = parseClient({
          id: this.nextId(draft, "client"),
          name: input.name,
          background: input.background ?? "",
          contacts: input.contacts ?? [],
          stakeholders: input.stakeholders ?? [],
          requirements: input.requirements ?? [],
          objectives: input.objectives ?? [],
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
        const updated = parseClient({
          id: current.id,
          name: edit.name ?? current.name,
          background: edit.background ?? current.background,
          contacts: edit.contacts ?? current.contacts,
          stakeholders: edit.stakeholders ?? current.stakeholders,
          requirements: edit.requirements ?? current.requirements,
          objectives: edit.objectives ?? current.objectives,
        });
        draft.clients = draft.clients.map((c) => (c.id === id ? updated : c));
        return updated;
      }),
    );
  }

  createEngagement(input: EngagementCreate): Promise<Engagement> {
    return this.enqueue(() =>
      this.commit((draft) => {
        findRecord(draft.clients, input.clientId, "client");
        const engagement = parseEngagement({
          id: this.nextId(draft, "engagement"),
          clientId: input.clientId,
          name: input.name,
          objectives: input.objectives ?? [],
          status: input.status ?? "planned",
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
        const updated = parseEngagement({
          id: current.id,
          clientId: current.clientId,
          name: edit.name ?? current.name,
          objectives: edit.objectives ?? current.objectives,
          status: edit.status ?? current.status,
        });
        draft.engagements = draft.engagements.map((e) => (e.id === id ? updated : e));
        return updated;
      }),
    );
  }

  createProject(input: ProjectCreate): Promise<Project> {
    return this.enqueue(() =>
      this.commit((draft) => {
        findRecord(draft.engagements, input.engagementId, "engagement");
        const project = parseProject({
          id: this.nextId(draft, "project"),
          engagementId: input.engagementId,
          name: input.name,
          objectives: input.objectives ?? [],
          status: input.status ?? "planned",
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
        const updated = parseProject({
          id: current.id,
          engagementId: current.engagementId,
          name: edit.name ?? current.name,
          objectives: edit.objectives ?? current.objectives,
          status: edit.status ?? current.status,
        });
        draft.projects = draft.projects.map((p) => (p.id === id ? updated : p));
        return updated;
      }),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.queue.then(
      () => undefined,
      () => undefined,
    );
    if (this.lockReleased) return;
    try {
      let text: string | null = null;
      try {
        text = this.fs.readFileSync(this.lockPath, "utf8");
      } catch (cause) {
        if (isMissing(cause)) {
          this.lockReleased = true;
          return;
        }
        throw cause;
      }
      if (text !== null) {
        try {
          this.fs.unlinkSync(this.lockPath);
        } catch (cause) {
          if (!isMissing(cause)) throw cause;
        }
      }
      this.lockReleased = true;
    } catch (cause) {
      throw new PersistenceError("Failed to release store ownership", { cause });
    }
  }
}

function isMissing(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "ENOENT"
  );
}

export async function openStore(
  directory: string,
  options: StoreOptions = {},
): Promise<Store> {
  const fs = { ...defaultFileSystem(), ...options.fs };
  const lockPath = join(directory, LOCK_FILE);
  const storePath = join(directory, STORE_FILE);
  let lockCreated = false;
  try {
    fs.mkdirSync(directory, { recursive: true });
    const lockExistedBefore = fs.existsSync(lockPath);
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), {
        encoding: "utf8",
        flag: "wx",
      });
      lockCreated = true;
    } catch (cause) {
      // A failed exclusive create may still have left a partial lock file; if
      // the lock did not exist before the attempt, remove what we created.
      if (!lockExistedBefore) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Best-effort: the acquisition is already failing.
        }
      }
      if (typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "EEXIST") {
        throw new BusyStoreError(`Store directory ${JSON.stringify(directory)} is owned by another writer`);
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
      } catch {
        // Best-effort: the initialization itself is already failing.
      }
    }
    throw error;
  }
}
