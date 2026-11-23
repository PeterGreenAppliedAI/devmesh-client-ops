/**
 * Unexposed, immutable original-file store for imported transcripts.
 *
 * Each original a transcript import carries (its exact bytes) is kept beside the
 * workspace's `workspace.json` in the owned `originals` directory. A file's name
 * is the lowercase SHA-256 hex digest of its exact bytes, never the submitted
 * filename: content is identified by content alone, so two imports of the same
 * bytes share one original and a name can never carry a caller's path or text.
 *
 * This module only stores and returns original bytes. It writes no JSON and
 * never touches `workspace.json`, the workspace records or their references: an
 * original becomes an application source only once committed metadata names its
 * hash. There is no replacement, deletion or garbage collection of published
 * originals here: once a hash-named file is published it stays, whether it is
 * referenced or not, and this module never unlinks one.
 *
 * Durability and ownership:
 *
 * - The workspace writer owns put operations: they are serialized through one
 *   queue, so two puts never interleave their temporary files or publications.
 * - A put writes a unique, same-directory temporary file in full (every short
 *   write is retried by the byte offset), flushes it, closes it and only then
 *   atomically publishes it under its hash name. On platforms with directory
 *   durability (POSIX), the containing directory is then flushed and closed; on
 *   Windows the rename itself is the durability point, so the directory step is
 *   skipped by checking the platform, never by catching an error.
 * - A reference is returned only after publication and, where the platform
 *   requires it, the directory flush, so the caller gets a usable reference.
 * - Retrying after an earlier publication failure satisfies the same rules: a
 *   put checks for an existing hash-named file first and never overwrites one.
 *
 * Reuse and verification: before reusing an existing original its bytes are
 * read and verified against the hash. Verified bytes are reused. Missing or
 * corrupt bytes, a size outside the inclusive 10 MiB limit, and anything that is
 * not a validated lowercase SHA-256 hash are refused; nothing existing is ever
 * replaced or removed by a refused operation.
 *
 * Failures are reported as the module's own error classes (`OriginalIntegrityError`,
 * `OriginalPersistenceError`, `OriginalValidationError`), carrying the
 * underlying cause. Only owned temporary resources are cleaned up after a
 * handled failure, and only after the descriptor is known to be closed; a
 * cleanup failure is reported with the operation failure attached. Everything
 * else, the published original included, is left as evidence.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/** The inclusive limit, in bytes, for an original file. */
export const MAX_ORIGINAL_BYTES = 10 * 1024 * 1024;

/** The owned directory, inside the workspace directory, that holds originals. */
export const ORIGINALS_DIRECTORY = "originals";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const TEMPORARY_SUFFIX = ".tmp";

/** Raised for integrity failures: bytes absent, unreadable or not the hash. */
export class OriginalIntegrityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OriginalIntegrityError";
  }
}

/** Raised for persistence failures: a write, flush, close or publication failed. */
export class OriginalPersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OriginalPersistenceError";
  }
}

/** Raised for a refusal of the operation's arguments, before any file access. */
export class OriginalValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OriginalValidationError";
  }
}

/** A usable original: its hash, exact byte length and detached bytes. */
export interface OriginalReference {
  /** The lowercase SHA-256 hex digest of the original bytes. */
  readonly sha256: string;
  /** The original's exact byte length. */
  readonly byteLength: number;
  /** A detached copy of the original bytes, never the store's own buffer. */
  readonly bytes: Uint8Array;
}

/**
 * The file operations a store uses, injectable so failures can be simulated by
 * the caller instead of mocked at the module boundary.
 */
export interface OriginalFileSystem {
  /** True when a path exists (any file type). */
  existsSync(path: string): boolean;
  /** Open a file for exclusive creation ("wx"), or a directory for reading ("r"). */
  openSync(path: string, flags: "wx" | "r"): number;
  /** Write bytes at the descriptor's current position; returns bytes written. */
  writeSync(fd: number, data: Uint8Array): number;
  /** Flush a file's bytes. */
  fsyncSync(fd: number): void;
  /** Close a descriptor. */
  closeSync(fd: number): void;
  /** Replace a destination atomically; a destination on another device fails. */
  renameSync(oldPath: string, newPath: string): void;
  /** Remove a file. */
  unlinkSync(path: string): void;
  /** Read a file's exact bytes. */
  readFileSync(path: string): Uint8Array;
  /** Flush and close a directory, for platforms that require it. */
  fsyncDirectorySync(path: string): void;
}

/** Options accepted by `openOriginalStore`; only tests pass them. */
export interface OriginalStoreOptions {
  /** Overrides for the default `node:fs` adapter; a test wraps one method. */
  fs?: Partial<OriginalFileSystem>;
  /**
   * The platform whose directory-durability rules apply; defaults to
   * `process.platform`. Only tests pass it, so either rule can be exercised on
   * any operating system.
   */
  platform?: string;
}

/** An unexposed original-file store over one trusted workspace directory. */
export interface OriginalStore {
  /**
   * The original files directory this store publishes into, an owned directory
   * inside the workspace directory. A store does not create or clean it.
   */
  readonly directory: string;
  /**
   * Publish `bytes` under their lowercase SHA-256 name and return a verified
   * reference once the original is durable. An existing original is reused only
   * after its bytes are verified against the hash; existing bytes that mismatch
   * are refused without replacement.
   */
  put(bytes: unknown): Promise<OriginalReference>;
  /**
   * Read and verify the original with the validated `sha256` hash. The path is
   * derived only from that hash, so no caller path can reach the filesystem.
   */
  read(sha256: unknown): Promise<OriginalReference>;
}

/** The default adapter over `node:fs`, with directory durability per platform. */
function defaultFileSystem(platform: string): OriginalFileSystem {
  const fs: OriginalFileSystem = {
    existsSync: (path) => {
      // A dangling link is refused as an integrity failure rather than read.
      return existsAt(path);
    },
    openSync: (path, flags) => openSync(path, flags),
    writeSync: (fd, data) => writeSync(fd, data),
    fsyncSync: (fd) => fsyncSync(fd),
    closeSync: (fd) => closeSync(fd),
    renameSync: (oldPath, newPath) => renameSync(oldPath, newPath),
    unlinkSync: (path) => unlinkSync(path),
    readFileSync: (path) => new Uint8Array(readFileSync(path)),
    fsyncDirectorySync: (path) => flushDirectorySync(fs, path, platform),
  };
  return fs;
}

/**
 * True when a path exists. `lstatSync` is used so a dangling link is seen as
 * existing (and refused) rather than silently treated as absent.
 */
function existsAt(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return false;
    throw cause;
  }
}

/**
 * Flush a directory through the adapter's own open, flush and close operations.
 * On Windows a directory cannot be opened or flushed as a handle, so the step is
 * skipped by checking the platform before any operation; on every other platform
 * a handle is opened for reading, flushed and closed, and any failure there is a
 * genuine persistence failure that is reported. A flush failure is reported even
 * when the close then fails too, with the close failure attached as context.
 */
function flushDirectorySync(fs: OriginalFileSystem, path: string, platform: string): void {
  if (platform === "win32") return;
  const fd = fs.openSync(path, "r");
  let flushFailure: unknown;
  try {
    fs.fsyncSync(fd);
  } catch (cause) {
    flushFailure = cause;
  }
  try {
    fs.closeSync(fd);
  } catch (closeCause) {
    if (flushFailure !== undefined) {
      throw new OriginalPersistenceError(
        "Failed to flush the originals directory and could not close it",
        { cause: withCleanup(flushFailure, closeCause) },
      );
    }
    throw closeCause;
  }
  if (flushFailure !== undefined) throw flushFailure;
}

/** Keep the operation failure as cause, attaching a cleanup failure to it. */
function withCleanup(cause: unknown, cleanup: unknown): unknown {
  if (cause instanceof OriginalPersistenceError || cause instanceof OriginalIntegrityError) {
    return cause;
  }
  if (cause instanceof Error) {
    try {
      (cause as Error & { cleanupCause?: unknown }).cleanupCause = cleanup;
    } catch {
      // The cause may not accept extra properties; it is still reported.
    }
  }
  return cause;
}

function errorCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isMissing(cause: unknown): boolean {
  return errorCode(cause) === "ENOENT";
}

/**
 * Write all of `data`, honoring a short write by continuing at the byte offset.
 * A write that reports a non-positive or out-of-range count is a persistence
 * failure, not a silent truncation.
 */
function writeFully(fs: OriginalFileSystem, fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.length) {
    const written = fs.writeSync(fd, data.subarray(offset));
    if (!Number.isInteger(written) || written <= 0 || written > data.length - offset) {
      throw new OriginalPersistenceError("Failed to write the temporary original file");
    }
    offset += written;
  }
}

/** The lowercase SHA-256 hex digest of bytes. */
function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** True when `value` is exactly a lowercase 64-character SHA-256 hex digest. */
function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

/** Require a validated hash or refuse the call before any file access. */
function requireHash(value: unknown): string {
  if (!isHash(value)) {
    throw new OriginalValidationError("A SHA-256 hash must be 64 lowercase hexadecimal characters");
  }
  return value;
}

/** A detached copy of bytes, never the caller's or the store's own buffer. */
function detached(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

/** Refuse an original outside the inclusive size limit, before any write. */
function requireSize(length: number): void {
  if (length > MAX_ORIGINAL_BYTES) {
    throw new OriginalValidationError(
      `The original is ${length} bytes; it must be at most ${MAX_ORIGINAL_BYTES} bytes`,
    );
  }
}

/** The temporary file name for a hash: unique per put, in the same directory. */
function temporaryPath(directory: string, sha256: string): string {
  const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  return join(directory, `${sha256}.${unique}${TEMPORARY_SUFFIX}`);
}

/** A reference built from verified bytes. */
function reference(sha256: string, bytes: Uint8Array): OriginalReference {
  return Object.freeze({
    sha256,
    byteLength: bytes.length,
    bytes: detached(bytes),
  });
}

class OriginalStoreImpl implements OriginalStore {
  private readonly fs: OriginalFileSystem;
  private readonly platform: string;
  readonly directory: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(fs: OriginalFileSystem, workspace: string, platform: string) {
    this.fs = fs;
    this.platform = platform;
    this.directory = join(workspace, ORIGINALS_DIRECTORY);
  }

  /** Serialize put operations, so temporary files and publications never race. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async put(bytes: unknown): Promise<OriginalReference> {
    if (!(bytes instanceof Uint8Array)) {
      throw new OriginalValidationError("original bytes must be a Uint8Array");
    }
    // Copy the caller's bytes at once, so later mutation cannot change what is
    // hashed, written or returned.
    const content = detached(bytes);
    requireSize(content.length);
    const sha256 = sha256Hex(content);
    return this.enqueue(async () => this.putVerified(sha256, content));
  }

  /** Reuse a verified existing original, else publish a new one durably. */
  private async putVerified(sha256: string, content: Uint8Array): Promise<OriginalReference> {
    const existing = this.readIfPresent(sha256);
    if (existing !== null) {
      // Existing bytes are reused only when they verify; a hash that names
      // matching bytes is a successful reuse, and mismatching bytes are refused
      // untouched by `readIfPresent`. A reuse still satisfies the platform's
      // directory-durability requirement before a usable reference is returned.
      this.fsyncDirectory();
      return reference(sha256, existing);
    }

    const target = join(this.directory, sha256);
    // Re-check just before publishing: another writer may have published the
    // same hash while this put waited. Bytes are verified before reuse, and a
    // mismatching file is refused without replacement.
    const again = this.readIfPresent(sha256);
    if (again !== null) {
      this.fsyncDirectory();
      return reference(sha256, again);
    }

    this.publish(sha256, target, content);
    // The rename is the publication; on POSIX the directory flush makes it
    // durable. Either failure is reported, and the published original is kept.
    this.fsyncDirectory();
    return reference(sha256, content);
  }

  /**
   * Publish the content under the hash name via a unique same-directory
   * temporary file: open exclusively, write fully, flush, close, rename. Any
   * failure before the rename leaves any existing original untouched; the
   * temporary file is removed only once its descriptor is known to be closed.
   * Every failure is reported as a persistence failure, with the underlying
   * operation failure attached.
   */
  private publish(sha256: string, target: string, content: Uint8Array): void {
    const tempPath = temporaryPath(this.directory, sha256);
    let fd: number | null = null;
    let tempCreated = false;
    try {
      fd = this.fs.openSync(tempPath, "wx");
      tempCreated = true;
      writeFully(this.fs, fd, content);
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd);
      // Ownership is cleared only after close returns; a close that reports
      // failure might have left the descriptor open, so cleanup closes it again.
      fd = null;
      this.fs.renameSync(tempPath, target);
    } catch (cause) {
      const cleanupFailure = this.discardTemporary(tempPath, fd, tempCreated);
      if (cleanupFailure !== undefined) {
        throw new OriginalPersistenceError(
          "Failed to publish the original and could not remove the temporary file",
          { cause: withCleanup(cause, cleanupFailure) },
        );
      }
      throw cause instanceof OriginalPersistenceError
        ? cause
        : new OriginalPersistenceError("Failed to publish the original", { cause });
    }
  }

  /**
   * Remove resources left behind by a failed publication: close a descriptor we
   * still own, and unlink the temporary file only when it was created and its
   * descriptor is known to be closed. Returns the cleanup error, if any, so the
   * caller reports it. A file already gone is not a cleanup failure.
   */
  private discardTemporary(tempPath: string, fd: number | null, tempCreated: boolean): unknown {
    let cleanupFailure: unknown;
    let descriptorClosed = true;
    if (fd !== null) {
      try {
        this.fs.closeSync(fd);
      } catch (cause) {
        if (errorCode(cause) === "EBADF") {
          // Already closed (for example an injected failure that closed it).
          descriptorClosed = true;
        } else {
          descriptorClosed = false;
          cleanupFailure = cause;
        }
      }
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

  /** Flush the originals directory where the platform requires it. */
  private fsyncDirectory(): void {
    if (this.platform === "win32") return;
    try {
      this.fs.fsyncDirectorySync(this.directory);
    } catch (cause) {
      throw cause instanceof OriginalPersistenceError
        ? cause
        : new OriginalPersistenceError("Failed to flush the originals directory", { cause });
    }
  }

  /**
   * Read an existing original and verify it, or return null when the file is
   * absent. A present file that cannot be read is reported as an integrity
   * failure, as is one whose bytes are not the hash it is named by (or which is
   * outside the size limit); nothing is replaced or removed.
   */
  private readIfPresent(sha256: string): Uint8Array | null {
    const path = join(this.directory, sha256);
    let present: boolean;
    try {
      present = this.fs.existsSync(path);
    } catch (cause) {
      throw new OriginalIntegrityError("Failed to check for the original file", { cause });
    }
    if (!present) return null;
    let bytes: Uint8Array;
    try {
      bytes = this.fs.readFileSync(path);
    } catch (cause) {
      if (isMissing(cause)) {
        throw new OriginalIntegrityError("The original file disappeared while it was being reused", {
          cause,
        });
      }
      throw new OriginalIntegrityError("Failed to read the original file", { cause });
    }
    this.verify(sha256, bytes);
    return bytes;
  }

  /** Refuse bytes whose hash is not `sha256`, or whose size is out of limit. */
  private verify(sha256: string, bytes: Uint8Array): void {
    if (bytes.length > MAX_ORIGINAL_BYTES) {
      throw new OriginalIntegrityError(
        `The original ${sha256} is ${bytes.length} bytes, over the ${MAX_ORIGINAL_BYTES}-byte limit`,
      );
    }
    if (sha256Hex(bytes) !== sha256) {
      throw new OriginalIntegrityError(
        `The original ${sha256} does not match its hash; the stored file is corrupt and was left untouched`,
      );
    }
  }

  async read(sha256: unknown): Promise<OriginalReference> {
    const hash = requireHash(sha256);
    return this.enqueue(async () => {
      const bytes = this.readVerified(hash);
      return reference(hash, bytes);
    });
  }

  /**
   * Read the original named by `sha256`, verifying its bytes. A missing original
   * is an integrity failure; the bytes are never served unverified.
   */
  private readVerified(sha256: string): Uint8Array {
    const path = join(this.directory, sha256);
    let bytes: Uint8Array;
    try {
      bytes = this.fs.readFileSync(path);
    } catch (cause) {
      if (isMissing(cause)) {
        throw new OriginalIntegrityError(`The original ${sha256} is missing`, { cause });
      }
      throw new OriginalIntegrityError("Failed to read the original file", { cause });
    }
    this.verify(sha256, bytes);
    return bytes;
  }
}

/**
 * Open the original-file store for a trusted workspace directory: the directory
 * that holds `workspace.json`. This never reads or writes `workspace.json` and
 * does not create anything until a `put` runs.
 */
export function openOriginalStore(
  workspaceDirectory: string,
  options: OriginalStoreOptions = {},
): OriginalStore {
  if (typeof workspaceDirectory !== "string" || workspaceDirectory.trim() === "") {
    throw new OriginalValidationError("workspace directory must be a nonblank string");
  }
  if (options.fs !== undefined && (typeof options.fs !== "object" || options.fs === null)) {
    throw new OriginalValidationError("filesystem operations must be an object");
  }
  const platform = options.platform ?? process.platform;
  // The default adapter's directory flush calls back into the adapter it was
  // built for, so merge the injected operations onto that one: an injected open,
  // flush or close is then the operation the directory flush uses. The platform
  // skip is made by the store itself before the flush, so an injected directory
  // flush is only ever called where the platform requires it.
  const fs = defaultFileSystem(platform);
  Object.assign(fs, options.fs);
  if (options.fs?.fsyncDirectorySync === undefined) {
    fs.fsyncDirectorySync = (path) => flushDirectorySync(fs, path, platform);
  }
  return new OriginalStoreImpl(fs, workspaceDirectory, platform);
}
