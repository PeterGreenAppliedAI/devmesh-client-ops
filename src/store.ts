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
 * Directory durability is handled explicitly per platform: on Windows a
 * directory cannot be opened or flushed as a directory handle, so the step is
 * skipped by checking the platform and the rename is the durability point.
 * That decision is never made by catching errors. On every other platform the
 * directory is opened for reading, flushed and closed, and a failure at any of
 * those steps is a genuine persistence failure that is reported.
 */
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
      // Windows cannot fsync a directory: skip the open and the flush there by
      // checking the platform, leaving the rename as the durability point.
      if (process.platform === "win32") return;
      // Everywhere else the directory is opened, flushed and closed, and each
      // step's failure propagates unchanged to be reported as a persistence
      // failure.
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
