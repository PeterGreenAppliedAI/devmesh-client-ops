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
  /** Open a file for exclusive creation; fails with EEXIST if it already exists. */
  openSync(path: string, flags: "wx"): number;
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
   */
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

/**
 * Error codes that mean a platform cannot open or flush a directory entry at
 * all; the default adapter treats them as "unsupported" rather than failures.
 */
const UNSUPPORTED_DIRECTORY_CODES = new Set([
  "EINVAL",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EPERM",
  "EACCES",
  "EISDIR",
]);

function defaultFileSystem(): FileSystem {
  return {
    existsSync,
    mkdirSync: (path, options) => mkdirSync(path, options),
    readFileSync: (path, encoding) => readFileSync(path, encoding),
    openSync: (path, flags) => openSync(path, flags),
    writeSync: (fd, data) => writeSync(fd, data),
    fsyncSync: (fd) => fsyncSync(fd),
    closeSync: (fd) => closeSync(fd),
    renameSync: (oldPath, newPath) => renameSync(oldPath, newPath),
    unlinkSync: (path) => unlinkSync(path),
    fsyncDirectorySync: (path) => {
      // Some platforms cannot open a directory descriptor this way; that is
      // "unsupported", not a failure of the data write. A descriptor that did
      // open is always closed, and a real close failure is reported.
      let fd: number;
      try {
        fd = openSync(path, "r");
      } catch (cause) {
        if (UNSUPPORTED_DIRECTORY_CODES.has(errorCode(cause) ?? "")) return;
        throw cause;
      }
      try {
        try {
          fsyncSync(fd);
        } catch (cause) {
          if (!UNSUPPORTED_DIRECTORY_CODES.has(errorCode(cause) ?? "")) throw cause;
        }
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
    if (!Number.isSafeInteger(next) || next < 1 || next >= Number.MAX_SAFE_INTEGER) {
      throw new PersistenceError(
        `Cannot allocate a new ${collections[key].kind}: the id counter cannot advance safely`,
      );
    }
    draft.nextIds[key] = next + 1;
    return `${collections[key].kind}-${next}`;
  }

  /**
   * Write the draft to a same-directory temporary file, flush it, replace the
   * store file atomically, then sync the directory entry.
   *
   * Failures before the rename leave the previous store file untouched, so the
   * previously committed state stays in effect and nothing is published. Once
   * the rename has happened the new bytes are the store file; a later directory
   * flush failure is reported, but memory is reconciled to the file so a writer
   * never builds succeeding mutations on stale state. Only a fully successful
   * write is acknowledged.
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
      // Clear ownership only after close returns; a close that reports failure
      // might have left the descriptor open, and cleanup must close it again.
      const closed = this.closeDescriptor(fd);
      if (!closed.closed) throw closed.failure;
      fd = null;
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
        // The replacement already happened, so the file holds `next`. Keep
        // memory identical to the file before rejecting the acknowledgement.
        this.state = next;
        throw new PersistenceError("Failed to flush the store directory", { cause });
      }
    }

    // Only now, after the file is safely in place, acknowledge the new state.
    this.state = next;
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

  private commit<T>(mutate: (draft: State) => T): Promise<T> {
    const draft: State = clone(this.state);
    const result = mutate(draft);
    return this.persist(draft).then(() => clone(result));
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
      const closed = closeDescriptorSync(fs, lockFd);
      // Keep ownership until close is confirmed; cleanup closes it again if not.
      if (closed.closed) lockFd = null;
      else throw closed.failure;
    } catch (cause) {
      // The exclusive create succeeded, so this partial lock is ours and must be
      // removed before failing. Close any descriptor we still own only once its
      // descriptor is known to be closed, then unlink.
      let cleanupFailure: unknown;
      if (lockFd !== null) {
        const result = closeDescriptorSync(fs, lockFd);
        if (!result.closed) cleanupFailure = result.failure;
        else lockFd = null;
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
