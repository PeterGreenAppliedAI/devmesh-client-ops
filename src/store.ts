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
  parseProject,
  PersistenceError,
  ValidationError,
  type Client,
  type Engagement,
  type EngagementStatus,
  type Project,
  type ProjectStatus,
} from "./model.ts";

export type {
  Client,
  Engagement,
  EngagementStatus,
  Project,
  ProjectStatus,
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
const STATE_KEYS = ["schemaVersion", "clients", "engagements", "projects", "nextIds"] as const;

/** Input fields accepted when creating a client. */
export interface ClientCreate {
  name: string;
  background?: string;
  contacts?: string[];
  stakeholders?: string[];
  requirements?: string[];
  objectives?: string[];
}

/** Partial update of a client; omitted fields keep their current value. */
export type ClientEdit = Partial<ClientCreate>;

/** Input fields accepted when creating an engagement. */
export interface EngagementCreate {
  clientId: string;
  name: string;
  objectives?: string[];
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
  objectives?: string[];
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
  openSync(path: string, flags: "wx"): number;
  /** Write bytes at the descriptor's current position; returns bytes written. */
  writeSync(fd: number, data: Uint8Array): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
  /** Flush a directory entry; may throw ENOTSUP/EINVAL where unsupported. */
  fsyncDirectorySync?(path: string): void;
}

/** Internal options accepted by openStore; only tests pass them. */
export interface StoreOptions {
  fs?: Partial<FileSystem>;
}

/** A collection of records that a store persists. */
interface Collection<T extends { id: string }> {
  readonly key: "clients" | "engagements" | "projects";
  readonly kind: "client" | "engagement" | "project";
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
} satisfies Record<string, Collection<{ id: string }>>;

type CollectionKey = keyof typeof collections;
type Kind = (typeof collections)[CollectionKey]["kind"];
type CounterKey = (typeof collections)[CollectionKey]["key"];
const COLLECTION_KEYS = ["clients", "engagements", "projects"] as const;

interface State {
  clients: Client[];
  engagements: Engagement[];
  projects: Project[];
  nextIds: Record<string, number>;
}

/** Error codes that mean directory synchronization is not supported here. */
const UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set([
  "EINVAL",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EPERM",
  "EISDIR",
  "EBADF",
  "EACCES",
]);

function defaultFileSystem(): FileSystem {
  return {
    existsSync,
    mkdirSync: (path, options) => mkdirSync(path, options),
    readFileSync: (path, encoding) => readFileSync(path, encoding),
    writeFileSync: (path, data, options) => writeFileSync(path, data, options),
    openSync: (path, flags) => openSync(path, flags),
    writeSync: (fd, data) => writeSync(fd, data),
    fsyncSync: (fd) => fsyncSync(fd),
    closeSync: (fd) => closeSync(fd),
    renameSync: (oldPath, newPath) => renameSync(oldPath, newPath),
    unlinkSync: (path) => unlinkSync(path),
    fsyncDirectorySync: (path) => {
      const fd = openSync(path, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
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
  for (const key of Object.keys(record)) {
    if (!(STATE_KEYS as readonly string[]).includes(key)) {
      throw new PersistenceError(`Stored data has unsupported field ${JSON.stringify(key)}`);
    }
  }
  const version = record.schemaVersion;
  if (version !== SCHEMA_VERSION) {
    throw new PersistenceError(
      `Unsupported stored schema version: ${JSON.stringify(version)}`,
    );
  }
  const state = emptyState();
  const highest: Record<string, number> = {};
  for (const key of COLLECTION_KEYS) {
    const collection = collections[key];
    const values = record[key];
    if (!Array.isArray(values)) {
      throw new PersistenceError(`Stored ${key} must be an array`);
    }
    const seen = new Set<string>();
    const parsedItems = values.map((value, index) => {
      let parsed: { id: string };
      try {
        parsed = collection.parse(value, `${key}[${index}]`);
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
  for (const [key, value] of Object.entries(nextIds)) {
    if (!(COLLECTION_KEYS as readonly string[]).includes(key)) {
      throw new PersistenceError(`Stored nextIds has unsupported field ${JSON.stringify(key)}`);
    }
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw new PersistenceError(`Stored nextIds.${key} must be a positive safe integer`);
    }
    const used = highest[key] ?? 0;
    if ((value as number) <= used) {
      throw new PersistenceError(
        `Stored nextIds.${key} cannot safely advance past existing id ${collections[key as CounterKey].kind}-${used}`,
      );
    }
    state.nextIds[key] = value as number;
  }
  // Every collection with records must have a counter that advances past them.
  for (const key of COLLECTION_KEYS) {
    const used = highest[key] ?? 0;
    if (used > 0 && (state.nextIds[key] === undefined || state.nextIds[key] <= used)) {
      throw new PersistenceError(
        `Stored nextIds.${key} is missing or cannot advance past existing id ${collections[key].kind}-${used}`,
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

  private nextId(draft: State, key: CounterKey): string {
    const next = draft.nextIds[key] ?? 1;
    draft.nextIds[key] = next + 1;
    return `${collections[key].kind}-${next}`;
  }

  /**
   * Write the draft to a same-directory temporary file, flush it, replace the
   * store file atomically, then sync the directory entry. Nothing is published
   * or acknowledged until every step has succeeded; on any failure the
   * previously committed state remains in effect and the operation fails.
   */
  private async persist(next: State): Promise<void> {
    const tempPath = `${this.storePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    let fd: number | null = null;
    let tempCreated = false;
    try {
      fd = this.fs.openSync(tempPath, "wx");
      tempCreated = true;
      writeFully(this.fs, fd, toJson(next));
      this.fs.fsyncSync(fd);
      const openFd = fd;
      fd = null;
      this.fs.closeSync(openFd);
      this.fs.renameSync(tempPath, this.storePath);
    } catch (cause) {
      const cleanupFailure = this.discardTemp(tempPath, fd, tempCreated);
      if (cleanupFailure !== undefined) {
        throw new PersistenceError(
          "Failed to persist workspace data and could not remove the temporary file",
          { cause: failureOr(cause, cleanupFailure) },
        );
      }
      throw new PersistenceError("Failed to persist workspace data", { cause });
    }

    if (this.fs.fsyncDirectorySync) {
      try {
        this.fs.fsyncDirectorySync(this.directory);
      } catch (cause) {
        if (!UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(errorCode(cause) ?? "")) {
          throw new PersistenceError("Failed to flush the store directory", { cause });
        }
      }
    }

    // Only now, after the file is safely in place, publish the new state.
    this.state = next;
  }

  /**
   * Remove resources left behind by a failed write: close a descriptor we still
   * own and remove the temporary file only when we created it. Returns the
   * cleanup error, if any, so the caller can report it.
   */
  private discardTemp(
    tempPath: string,
    fd: number | null,
    tempCreated: boolean,
  ): unknown {
    let cleanupFailure: unknown;
    if (fd !== null) {
      try {
        this.fs.closeSync(fd);
      } catch (cause) {
        cleanupFailure = cause;
      }
    }
    if (tempCreated) {
      try {
        this.fs.unlinkSync(tempPath);
      } catch (cause) {
        if (!isMissing(cause) && cleanupFailure === undefined) cleanupFailure = cause;
      }
    }
    return cleanupFailure;
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
          id: this.nextId(draft, "clients"),
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
        const engagement = parseEngagement({
          id: this.nextId(draft, "engagements"),
          clientId,
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
        const project = parseProject({
          id: this.nextId(draft, "projects"),
          engagementId,
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
        const changes = supplied(edit, ["name", "objectives", "status"]);
        const updated = parseProject({ ...current, ...changes });
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
  const fs = { ...defaultFileSystem(), ...options.fs };
  const lockPath = join(directory, LOCK_FILE);
  const storePath = join(directory, STORE_FILE);
  let lockCreated = false;
  try {
    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch (cause) {
      throw new PersistenceError("Failed to create the store directory", { cause });
    }

    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), {
        encoding: "utf8",
        flag: "wx",
      });
      lockCreated = true;
    } catch (cause) {
      // EEXIST means the exclusive create never opened the file: another writer
      // owns the lock, and we must never remove it.
      if (errorCode(cause) === "EEXIST") {
        throw new BusyStoreError(
          `Store directory ${JSON.stringify(directory)} is owned by another writer`,
        );
      }
      // Any other failure happened after the exclusive open succeeded, so the
      // lock file is ours (possibly partial) and must be removed before failing.
      try {
        fs.unlinkSync(lockPath);
      } catch (cleanupCause) {
        if (!isMissing(cleanupCause)) {
          throw new PersistenceError(
            "Failed to acquire store ownership and could not remove the partial lock",
            { cause },
          );
        }
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
