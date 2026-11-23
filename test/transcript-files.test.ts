import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fsModule from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  MAX_ORIGINAL_BYTES,
  openOriginalStore,
  ORIGINALS_DIRECTORY,
  OriginalIntegrityError,
  OriginalPersistenceError,
  OriginalValidationError,
  type OriginalFileSystem,
  type OriginalReference,
  type OriginalStore,
} from "../src/transcript-files.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A workspace directory holding a workspace.json, as the workspace writer
 * creates it: it has no originals directory, so the store must create it on
 * first put.
 */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "transcript-files-"));
  roots.push(root);
  writeFileSync(join(root, "workspace.json"), "{\"untouched\":true}\n", "utf8");
  rmSync(join(root, ORIGINALS_DIRECTORY), { recursive: true, force: true });
  return root;
}

/**
 * Place bytes at an original path before the store runs, as a pre-existing
 * file would be, creating the owned directory to hold them.
 */
function seed(path: string, bytes: Uint8Array): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function originalPath(root: string, hash: string): string {
  return join(root, ORIGINALS_DIRECTORY, hash);
}

function temporaryFiles(root: string): string[] {
  return readdirSync(join(root, ORIGINALS_DIRECTORY)).filter((name) => name.endsWith(".tmp"));
}

function publishedFiles(root: string): string[] {
  const directory = join(root, ORIGINALS_DIRECTORY);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => !name.endsWith(".tmp"));
}

/** A plain adapter over node:fs, matching the store's default. */
function realFs(): OriginalFileSystem {
  return {
    existsSync: (path) => existsSync(path),
    mkdirSync: (path, options) => mkdirSync(path, options),
    openSync: (path, flags) => fsModule.openSync(path, flags),
    writeSync: (fd, data) => fsModule.writeSync(fd, data),
    fsyncSync: (fd) => fsModule.fsyncSync(fd),
    closeSync: (fd) => fsModule.closeSync(fd),
    renameSync: (oldPath, newPath) => fsModule.renameSync(oldPath, newPath),
    unlinkSync: (path) => fsModule.unlinkSync(path),
    readFileSync: (path) => new Uint8Array(fsModule.readFileSync(path)),
    // The directory flush is deliberately absent, so the store's own flush runs
    // and reaches this adapter's openSync, fsyncSync and closeSync.
    fsyncDirectorySync: undefined as unknown as () => void,
  };
}

/**
 * The descriptors handed out for directory handles; they are never passed to a
 * real fs operation, so a directory flush works even on a Windows host.
 */
const DIRECTORY_HANDLES = new Set<number>();
let nextDirectoryHandle = 1_000_000;

/** A simulated directory handle for the injected openSync, recording the path. */
function directoryAwareOpen(opened: string[], path: string, flags: "wx" | "r"): number {
  if (flags === "wx") return realFs().openSync(path, flags);
  opened.push(path);
  const fd = nextDirectoryHandle;
  nextDirectoryHandle += 1;
  DIRECTORY_HANDLES.add(fd);
  return fd;
}

/** True when `fd` is a simulated directory handle, not a real file descriptor. */
function isDirectoryHandle(fd: number): boolean {
  return DIRECTORY_HANDLES.has(fd);
}

/** A failing operation thrown as a Node-style error with a code. */
function fsError(code: string): Error & { code: string } {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

/**
 * An adapter that delegates to a plain one, with optional overrides. Like the
 * store's default, it has no directory-flush operation of its own unless the
 * test supplies one, so the store's flush reaches the overridden open, flush or
 * close.
 */
function adapter(overrides: Partial<OriginalFileSystem> = {}): Partial<OriginalFileSystem> {
  const fs = realFs();
  delete (fs as Partial<OriginalFileSystem>).fsyncDirectorySync;
  return Object.assign(fs, overrides);
}

/** Assert a reference matches exactly the given bytes. */
function assertReference(ref: OriginalReference, bytes: Uint8Array): void {
  assert.equal(ref.sha256, sha256(bytes));
  assert.equal(ref.byteLength, bytes.length);
  assert.deepEqual(ref.bytes, bytes);
}

describe("original store: put and read", () => {
  it("stores exact bytes under their lowercase SHA-256 name, never the submitted filename", async () => {
    const root = workspace();
    const store = openOriginalStore(root);
    const bytes = new TextEncoder().encode("Grüße 👩‍👩‍👧 binary-ish \u0000\u0001\r\n");
    const ref = await store.put(bytes);

    assertReference(ref, bytes);
    assert.equal(ref.sha256, sha256(bytes));
    assert.equal(readFileSync(originalPath(root, ref.sha256)).equals(Buffer.from(bytes)), true);
    assert.deepEqual(readdirSync(join(root, ORIGINALS_DIRECTORY)), [ref.sha256]);
    // The store writes no JSON reference and leaves workspace.json untouched.
    assert.equal(readFileSync(join(root, "workspace.json"), "utf8"), "{\"untouched\":true}\n");
  });

  it("works on first use in a normal workspace that has no originals directory", async () => {
    const root = workspace();
    assert.equal(existsSync(join(root, ORIGINALS_DIRECTORY)), false);
    const bytes = new TextEncoder().encode("first use");
    const store = openOriginalStore(root);
    const ref = await store.put(bytes);
    assertReference(ref, bytes);
    assert.equal(existsSync(join(root, ORIGINALS_DIRECTORY)), true);
    assert.deepEqual(publishedFiles(root), [ref.sha256]);
    assert.deepEqual(temporaryFiles(root), []);
    assert.equal(readFileSync(join(root, "workspace.json"), "utf8"), "{\"untouched\":true}\n");
    // Reopening reuses the created directory without creating anything new.
    const reopened = openOriginalStore(root);
    assert.equal((await reopened.read(ref.sha256)).sha256, ref.sha256);
    assert.deepEqual(publishedFiles(root), [ref.sha256]);
  });

  it("returns detached bytes that callers cannot use to change stored content", async () => {
    const root = workspace();
    const store = openOriginalStore(root);
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const ref = await store.put(bytes);
    // Mutating the caller's buffer and the returned bytes changes nothing.
    bytes.fill(9);
    ref.bytes.fill(7);
    const reread = await store.read(ref.sha256);
    assert.deepEqual(reread.bytes, Uint8Array.from([1, 2, 3, 4]));
    assert.equal(readFileSync(originalPath(root, ref.sha256)).equals(Buffer.from([1, 2, 3, 4])), true);
  });

  it("handles an empty original and the inclusive 10 MiB limit, refusing one byte over", async () => {
    const root = workspace();
    const store = openOriginalStore(root);
    const empty = await store.put(new Uint8Array(0));
    assert.equal(empty.byteLength, 0);
    assert.equal(empty.sha256, sha256(new Uint8Array(0)));

    const limit = new Uint8Array(MAX_ORIGINAL_BYTES);
    limit.fill(0x41);
    const atLimit = await store.put(limit);
    assertReference(atLimit, limit);
    assert.equal(readFileSync(originalPath(root, atLimit.sha256)).length, MAX_ORIGINAL_BYTES);

    await assert.rejects(
      store.put(new Uint8Array(MAX_ORIGINAL_BYTES + 1)),
      (error: unknown) => {
        assert.ok(error instanceof OriginalValidationError);
        assert.match(error.message, /at most 10485760 bytes/);
        return true;
      },
    );
    // The refusal wrote nothing.
    assert.equal(publishedFiles(root).length, 2);
    assert.deepEqual(temporaryFiles(root), []);
  });

  it("verifies and reuses an existing original instead of writing a second file", async () => {
    const root = workspace();
    const store = openOriginalStore(root);
    const bytes = new TextEncoder().encode("same content twice");
    const first = await store.put(bytes);
    const second = await store.put(Uint8Array.from(bytes));
    assert.equal(second.sha256, first.sha256);
    assert.deepEqual(second.bytes, bytes);
    assert.deepEqual(publishedFiles(root), [first.sha256]);
    assert.deepEqual(temporaryFiles(root), []);
  });

  it("reuses an original across reopening the store", async () => {
    const root = workspace();
    const bytes = new TextEncoder().encode("durable across reopen");
    const first = await openOriginalStore(root).put(bytes);

    const reopened = openOriginalStore(root);
    const ref = await reopened.read(first.sha256);
    assertReference(ref, bytes);
    const again = await reopened.put(bytes);
    assert.equal(again.sha256, first.sha256);
    assert.deepEqual(publishedFiles(root), [first.sha256]);
  });

  it("reads a verified original by hash, deriving the path only from the hash", async () => {
    const root = workspace();
    const store = openOriginalStore(root);
    const bytes = new TextEncoder().encode("read me");
    const { sha256: hash } = await store.put(bytes);
    const ref = await store.read(hash);
    assertReference(ref, bytes);
    // A caller-supplied path cannot reach the filesystem through read.
    await assert.rejects(store.read(`../workspace.json`), OriginalValidationError);
    await assert.rejects(store.read(join(root, "workspace.json")), OriginalValidationError);
  });
});

describe("original store: malformed hashes", () => {
  const malformed: readonly unknown[] = [
    "",
    "abc",
    "A".repeat(64), // uppercase is not a validated hash
    "g".repeat(64),
    `sha256:${"0".repeat(64)}`,
    `${"0".repeat(64)}0`,
    "0".repeat(63),
    "  " + "0".repeat(64),
    "0".repeat(64) + " ",
    123,
    null,
    undefined,
    {},
    ["0".repeat(64)],
    // A valid digest followed by a line terminator is 65 characters, so `$`
    // matching before the terminator must not let it through.
    "0".repeat(64) + "\n",
    "0".repeat(64) + "\r",
    "0".repeat(64) + "\r\n",
    "0".repeat(64) + "\u2028",
    "\n" + "0".repeat(64),
  ];

  for (const value of malformed) {
    it(`refuses ${JSON.stringify(value)} before any file access`, async () => {
      const root = workspace();
      let touched = false;
      const store = openOriginalStore(root, {
        fs: adapter({
          existsSync: () => {
            touched = true;
            return false;
          },
          readFileSync: () => {
            touched = true;
            return new Uint8Array(0);
          },
        }),
      });
      await assert.rejects(store.read(value), (error: unknown) => {
        assert.ok(error instanceof OriginalValidationError, String(error));
        assert.match(error.message, /64 lowercase hexadecimal/);
        return true;
      });
      assert.equal(touched, false, "no file access for a malformed hash");
    });
  }

  it("refuses non-Uint8Array bytes for put", async () => {
    const root = workspace();
    const store = openOriginalStore(root);
    for (const value of [undefined, null, "text", [1, 2, 3], new ArrayBuffer(4), { bytes: [1] }]) {
      await assert.rejects(store.put(value), OriginalValidationError);
    }
    assert.deepEqual(publishedFiles(root), []);
  });
});

describe("original store: mismatching, missing and corrupt existing bytes", () => {
  it("refuses mismatching existing bytes without replacing them", async () => {
    const root = workspace();
    const bytes = new TextEncoder().encode("honest content");
    const hash = sha256(bytes);
    const impostor = Buffer.from("different content");
    seed(originalPath(root, hash), impostor);

    const store = openOriginalStore(root);
    await assert.rejects(store.put(bytes), (error: unknown) => {
      assert.ok(error instanceof OriginalIntegrityError);
      assert.match(error.message, /does not match its hash/);
      return true;
    });
    // The existing bytes are evidence and are left exactly as they were.
    assert.equal(readFileSync(originalPath(root, hash)).equals(impostor), true);
    assert.deepEqual(publishedFiles(root), [hash]);
    assert.deepEqual(temporaryFiles(root), []);
  });

  it("refuses a missing read as an integrity error", async () => {
    const root = workspace();
    const hash = sha256(new TextEncoder().encode("never stored"));
    const store = openOriginalStore(root);
    await assert.rejects(store.read(hash), (error: unknown) => {
      assert.ok(error instanceof OriginalIntegrityError);
      assert.match(error.message, /is missing/);
      return true;
    });
  });

  it("refuses a corrupt read, including an oversized file, without touching it", async () => {
    const root = workspace();
    const bytes = new TextEncoder().encode("corrupt me");
    const hash = sha256(bytes);
    const corrupt = Buffer.from("tampered bytes");
    seed(originalPath(root, hash), corrupt);
    const store = openOriginalStore(root);
    await assert.rejects(store.read(hash), OriginalIntegrityError);
    assert.equal(readFileSync(originalPath(root, hash)).equals(corrupt), true);
    assert.deepEqual(temporaryFiles(root), []);
  });

  it("reports an unreadable existing original as an integrity failure and keeps it", async () => {
    const root = workspace();
    const bytes = new TextEncoder().encode("present but unreadable");
    const hash = sha256(bytes);
    seed(originalPath(root, hash), Buffer.from(bytes));
    const store = openOriginalStore(root, {
      fs: adapter({
        readFileSync: () => {
          throw fsError("EIO");
        },
      }),
    });
    await assert.rejects(store.put(bytes), (error: unknown) => {
      assert.ok(error instanceof OriginalIntegrityError);
      assert.match(error.message, /Failed to read/);
      return true;
    });
    await assert.rejects(store.read(hash), OriginalIntegrityError);
    assert.deepEqual(publishedFiles(root), [hash]);
  });

  it("does not overwrite an existing original that a concurrent put published", async () => {
    const root = workspace();
    const bytes = new TextEncoder().encode("published elsewhere");
    const hash = sha256(bytes);
    // The file is present from the start, but the first existence check reports
    // it absent (as if another writer published it between the two checks); the
    // store verifies it on the second check rather than renaming over it.
    seed(originalPath(root, hash), Buffer.from(bytes));
    let hashChecks = 0;
    let verifications = 0;
    let directoryChecks = 0;
    const store = openOriginalStore(root, {
      platform: "win32",
      fs: adapter({
        // Only the hash-file existence checks are affected: the first hash check
        // reports the file absent (as if another writer published it between the
        // two checks) and the second finds it. Directory checks are unaffected.
        existsSync: (path) => {
          if (path === originalPath(root, hash)) {
            hashChecks += 1;
            return hashChecks === 1 ? false : existsSync(path);
          }
          directoryChecks += 1;
          return existsSync(path);
        },
        // A successful verification of the seeded bytes is counted; the store
        // must never rename over or delete it.
        readFileSync: (path) => {
          const read = new Uint8Array(fsModule.readFileSync(path));
          if (path === originalPath(root, hash)) verifications += 1;
          return read;
        },
        renameSync: () => {
          throw new Error("the store must not rename over an existing original");
        },
        unlinkSync: () => {
          throw new Error("the store must not unlink an existing original");
        },
      }),
    });
    const ref = await store.put(bytes);
    assert.equal(ref.sha256, hash);
    assert.deepEqual(ref.bytes, bytes);
    assert.equal(hashChecks, 2, "both target checks ran");
    assert.equal(verifications, 1, "the second check verified the seeded bytes before reuse");
    assert.equal(directoryChecks >= 1, true, "the directory was checked separately");
    assert.deepEqual(publishedFiles(root), [hash]);
    assert.deepEqual(temporaryFiles(root), []);
  });
});

describe("original store: injected persistence failures", () => {
  it("writes short writes fully, honoring the byte offset", async () => {
    const root = workspace();
    const bytes = new TextEncoder().encode("a moderately long original to write in pieces");
    const plain = realFs();
    let writeCalls = 0;
    const store = openOriginalStore(root, {
      fs: adapter({
        // Every write is short by at most three bytes.
        writeSync: (fd, data) => {
          writeCalls += 1;
          const short = data.subarray(0, Math.max(1, Math.min(3, data.length)));
          return plain.writeSync(fd, short);
        },
      }),
    });
    const ref = await store.put(bytes);
    assertReference(ref, bytes);
    assert.ok(writeCalls > 1, "the write was exercised in several pieces");
    assert.equal(readFileSync(originalPath(root, ref.sha256)).equals(Buffer.from(bytes)), true);
  });

  it("reports a write that makes no progress and removes only its temporary file", async () => {
    const root = workspace();
    const bytes = new TextEncoder().encode("refused write");
    const store = openOriginalStore(root, {
      fs: adapter({ writeSync: () => 0 }),
    });
    await assert.rejects(store.put(bytes), (error: unknown) => {
      assert.ok(error instanceof OriginalPersistenceError);
      assert.match(error.message, /Failed to write/);
      return true;
    });
    assert.deepEqual(publishedFiles(root), []);
    assert.deepEqual(temporaryFiles(root), []);
  });

  it("reports a write that claims to write past the buffer end", async () => {
    const root = workspace();
    const store = openOriginalStore(root, { fs: adapter({ writeSync: () => 9999 }) });
    await assert.rejects(store.put(new TextEncoder().encode("x")), OriginalPersistenceError);
    assert.deepEqual(readdirSync(join(root, ORIGINALS_DIRECTORY)), []);
  });

  it("reports a flush failure, removes its temporary file and publishes nothing", async () => {
    const root = workspace();
    const plain = realFs();
    let fileFlushes = 0;
    let closes = 0;
    const unlinked: string[] = [];
    const store = openOriginalStore(root, {
      fs: adapter({
        // The directory flush succeeds (it is injected), so the failure below is
        // the file-descriptor flush of the temporary file, reached after the
        // temporary file was created. The subsequent close and unlink are
        // recorded so the assertions prove the cleanup ran.
        fsyncDirectorySync: () => {},
        fsyncSync: (fd) => {
          if (isDirectoryHandle(fd)) return;
          fileFlushes += 1;
          throw fsError("EIO");
        },
        closeSync: (fd) => {
          if (isDirectoryHandle(fd)) return;
          closes += 1;
          plain.closeSync(fd);
        },
        unlinkSync: (path) => {
          unlinked.push(path);
          plain.unlinkSync(path);
        },
      }),
    });
    await assert.rejects(store.put(new TextEncoder().encode("flush fails")), OriginalPersistenceError);
    assert.equal(fileFlushes, 1, "the injected file flush was reached");
    assert.equal(closes, 1, "cleanup closed the temporary file descriptor");
    assert.equal(unlinked.length, 1, "cleanup removed the temporary file after closing it");
    assert.match(unlinked[0], /\.tmp$/);
    assert.deepEqual(publishedFiles(root), []);
    assert.deepEqual(temporaryFiles(root), []);
  });

  it("reports a close failure, closes again and removes its temporary file", async () => {
    const root = workspace();
    const plain = realFs();
    let closes = 0;
    const store = openOriginalStore(root, {
      platform: "win32",
      fs: adapter({
        // The first file close reports failure but still closes; cleanup closes
        // again, which this adapter observes and lets succeed.
        closeSync: (fd) => {
          closes += 1;
          plain.closeSync(fd);
          if (closes === 1) throw fsError("EIO");
        },
      }),
    });
    await assert.rejects(store.put(new TextEncoder().encode("close fails")), OriginalPersistenceError);
    assert.equal(closes, 2, "the descriptor was closed by cleanup after the failure");
    assert.deepEqual(publishedFiles(root), []);
    assert.deepEqual(temporaryFiles(root), []);
  });

  it("reports a rename (publication) failure and removes only its temporary file", async () => {
    const root = workspace();
    const store = openOriginalStore(root, {
      fs: adapter({
        renameSync: () => {
          throw fsError("EXDEV");
        },
      }),
    });
    const bytes = new TextEncoder().encode("rename fails");
    await assert.rejects(store.put(bytes), OriginalPersistenceError);
    assert.deepEqual(publishedFiles(root), []);
    assert.deepEqual(temporaryFiles(root), []);
  });

  it("reports a directory flush failure, keeps the published original and retries to success", async () => {
    const root = workspace();
    const bytes = new TextEncoder().encode("directory flush fails once");
    const flushed: string[] = [];
    const store = openOriginalStore(root, {
      platform: "linux",
      fs: adapter({
        // The first use flushes the workspace directory and then `originals`;
        // the third flush, for the publication, fails once.
        fsyncDirectorySync: (path) => {
          flushed.push(path);
          if (flushed.length === 3) throw fsError("EIO");
        },
      }),
    });
    await assert.rejects(store.put(bytes), (error: unknown) => {
      assert.ok(error instanceof OriginalPersistenceError);
      assert.match(error.message, /directory/);
      return true;
    });
    assert.deepEqual(flushed, [root, join(root, ORIGINALS_DIRECTORY), join(root, ORIGINALS_DIRECTORY)]);
    // The publication happened; the published original is retained as evidence.
    const hash = sha256(bytes);
    assert.deepEqual(publishedFiles(root), [hash]);
    assert.equal(readFileSync(originalPath(root, hash)).equals(Buffer.from(bytes)), true);
    assert.deepEqual(temporaryFiles(root), []);

    // A verified retry of an unreopen store reuses the published bytes and
    // satisfies durability again on the same adapter: only `originals` is
    // flushed now that the directory exists.
    const retried = await store.put(bytes);
    assertReference(retried, bytes);
    assert.deepEqual(flushed, [
      root,
      join(root, ORIGINALS_DIRECTORY),
      join(root, ORIGINALS_DIRECTORY),
      // The retry: prepare's flush of the existing `originals`, then the
      // reuse's durability flush.
      join(root, ORIGINALS_DIRECTORY),
      join(root, ORIGINALS_DIRECTORY),
    ]);
    // A fresh store reusing the original runs the durability step too.
    const reopenedFlushed: string[] = [];
    const reopened = openOriginalStore(root, {
      platform: "linux",
      fs: adapter({
        fsyncDirectorySync: (path) => {
          reopenedFlushed.push(path);
        },
      }),
    });
    const reused = await reopened.put(bytes);
    assert.equal(reused.sha256, hash);
    // A reopened store flushes `originals` in prepare and again for the reuse.
    assert.deepEqual(reopenedFlushed, [join(root, ORIGINALS_DIRECTORY), join(root, ORIGINALS_DIRECTORY)]);
  });

  it("completes the durability step on a retry when originals already exists", async () => {
    const root = workspace();
    const bytes = new TextEncoder().encode("retry after rename failure");
    const failing = openOriginalStore(root, {
      platform: "linux",
      fs: adapter({
        fsyncDirectorySync: () => {},
        renameSync: () => {
          throw fsError("EIO");
        },
      }),
    });
    await assert.rejects(failing.put(bytes), OriginalPersistenceError);
    // The first use created `originals`; it is present before the retry.
    assert.equal(existsSync(join(root, ORIGINALS_DIRECTORY)), true);
    assert.deepEqual(publishedFiles(root), []);

    const flushed: string[] = [];
    const reopened = openOriginalStore(root, {
      platform: "linux",
      fs: adapter({
        fsyncDirectorySync: (path) => {
          flushed.push(path);
        },
      }),
    });
    const ref = await reopened.put(bytes);
    assertReference(ref, bytes);
    // The workspace directory is not flushed again (its entry already exists),
    // but the retry flushes `originals`: once in prepare and once for the new
    // publication, so the durability step is completed on retry.
    assert.deepEqual(flushed, [join(root, ORIGINALS_DIRECTORY), join(root, ORIGINALS_DIRECTORY)]);
    assert.deepEqual(publishedFiles(root), [ref.sha256]);
  });

  it("reports a directory open failure during the directory flush, keeping the published original", async () => {
    const root = workspace();
    const bytes = new TextEncoder().encode("directory open fails");
    mkdirSync(join(root, ORIGINALS_DIRECTORY), { recursive: true });
    const plain = realFs();
    let directoryOpens = 0;
    const store = openOriginalStore(root, {
      platform: "linux",
      fs: adapter({
        // Only the directory open fails, and only after the prepare step's
        // flush; the file's own open is unaffected. The failure is reported when
        // the publication's directory flush opens it.
        openSync: (path, flags) => {
          if (flags === "r" && path === join(root, ORIGINALS_DIRECTORY)) {
            directoryOpens += 1;
            if (directoryOpens > 1) throw fsError("EACCES");
          }
          return plain.openSync(path, flags);
        },
      }),
    });
    await assert.rejects(store.put(bytes), OriginalPersistenceError);
    // The rename already published the original; it is kept.
    assert.deepEqual(publishedFiles(root), [sha256(bytes)]);
    assert.deepEqual(temporaryFiles(root), []);
  });

  it("reports a directory flush failure during the directory flush, keeping the published original", async () => {
    const root = workspace();
    const bytes = new TextEncoder().encode("directory fsync fails");
    mkdirSync(join(root, ORIGINALS_DIRECTORY), { recursive: true });
    const directoryFlushes: number[] = [];
    const store = openOriginalStore(root, {
      platform: "linux",
      fs: adapter({
        // A simulated directory handle; the file's open is real. The simulated
        // directory handle's flush succeeds during prepare and fails on its
        // second flush, the publication's, so the failure is reported there.
        openSync: (path, flags) => {
          if (flags === "r" && (path === root || path === join(root, ORIGINALS_DIRECTORY))) {
            return directoryAwareOpen([], path, flags);
          }
          return realFs().openSync(path, flags);
        },
        closeSync: (fd) => {
          if (!isDirectoryHandle(fd)) realFs().closeSync(fd);
        },
        fsyncSync: (fd) => {
          if (!isDirectoryHandle(fd)) {
            realFs().fsyncSync(fd);
            return;
          }
          directoryFlushes.push(fd);
          if (directoryFlushes.length > 1) throw fsError("EIO");
        },
      }),
    });
    await assert.rejects(store.put(bytes), OriginalPersistenceError);
    assert.deepEqual(publishedFiles(root), [sha256(bytes)]);
    assert.deepEqual(temporaryFiles(root), []);
  });

  it("reports a cleanup unlink failure as the operation failure with the cleanup attached", async () => {
    const root = workspace();
    const renameFailure = fsError("EXDEV");
    const store = openOriginalStore(root, {
      fs: adapter({
        renameSync: () => {
          throw renameFailure;
        },
        unlinkSync: () => {
          throw fsError("EIO");
        },
      }),
    });
    await assert.rejects(store.put(new TextEncoder().encode("cannot clean up")), (error: unknown) => {
      assert.ok(error instanceof OriginalPersistenceError);
      assert.match(error.message, /could not remove the temporary file/);
      assert.equal(error.cause, renameFailure);
      return true;
    });
    // The temporary file was left behind as evidence; nothing published.
    assert.deepEqual(publishedFiles(root), []);
    assert.equal(temporaryFiles(root).length, 1);
  });

  it("retries successfully after an earlier publication failure without replacing anything", async () => {
    const root = workspace();
    const bytes = new TextEncoder().encode("retry after failure");
    const failing = openOriginalStore(root, {
      fs: adapter({
        renameSync: () => {
          throw fsError("EIO");
        },
      }),
    });
    await assert.rejects(failing.put(bytes), OriginalPersistenceError);
    assert.deepEqual(publishedFiles(root), []);

    const store = openOriginalStore(root);
    const ref = await store.put(bytes);
    assertReference(ref, bytes);
    assert.deepEqual(publishedFiles(root), [ref.sha256]);
    assert.deepEqual(temporaryFiles(root), []);
  });

  it("publishes nothing and leaves the existing original when a failure hits an existing hash", async () => {
    const root = workspace();
    const bytes = new TextEncoder().encode("existing survives failures");
    const first = await openOriginalStore(root).put(bytes);
    const before = readFileSync(originalPath(root, first.sha256));

    // A failing store that cannot read the existing file does not overwrite it.
    const failing = openOriginalStore(root, {
      fs: adapter({
        readFileSync: () => {
          throw fsError("EIO");
        },
      }),
    });
    await assert.rejects(failing.put(bytes), OriginalIntegrityError);
    assert.equal(readFileSync(originalPath(root, first.sha256)).equals(before), true);
    assert.deepEqual(publishedFiles(root), [first.sha256]);
    assert.deepEqual(temporaryFiles(root), []);
  });
});

describe("original store: platform directory durability", () => {
  it("skips the directory step on Windows by checking the platform before any operation", async () => {
    const root = workspace();
    let directoryOpened = false;
    const store = openOriginalStore(root, {
      platform: "win32",
      fs: adapter({
        openSync: (path, flags) => {
          if (flags === "r") directoryOpened = true;
          return realFs().openSync(path, flags);
        },
        fsyncDirectorySync: () => {
          throw new Error("the platform skip must not call the directory flush");
        },
      }),
    });
    const bytes = new TextEncoder().encode("windows rename is durable");
    const ref = await store.put(bytes);
    assertReference(ref, bytes);
    assert.equal(directoryOpened, false);
  });

  it("flushes the directory on POSIX, including a reused original", async () => {
    const root = workspace();
    const bytes = new TextEncoder().encode("posix directory flush");
    const opened: string[] = [];
    const store = openOriginalStore(root, {
      platform: "darwin",
      fs: adapter({
        // A simulated directory handle for directory opens only, so this runs on
        // a Windows host too and a file read is not handed a fake descriptor.
        openSync: (path, flags) => {
          if (flags === "r" && (path === root || path === join(root, ORIGINALS_DIRECTORY))) {
            return directoryAwareOpen(opened, path, flags);
          }
          return realFs().openSync(path, flags);
        },
        // Simulated handles are never passed to a real fs operation.
        fsyncSync: (fd) => {
          if (!isDirectoryHandle(fd)) realFs().fsyncSync(fd);
        },
        closeSync: (fd) => {
          if (!isDirectoryHandle(fd)) realFs().closeSync(fd);
        },
      }),
    });
    await store.put(bytes);
    // The workspace directory holding the new entry, then `originals`, then the
    // published rename.
    assert.deepEqual(opened, [
      root,
      join(root, ORIGINALS_DIRECTORY),
      join(root, ORIGINALS_DIRECTORY),
    ]);
    // A reuse also satisfies the durability step: prepare flushes `originals`
    // and the reuse flushes it again, with the workspace directory left alone
    // because its entry already exists.
    await store.put(bytes);
    assert.deepEqual(opened, [
      root,
      join(root, ORIGINALS_DIRECTORY),
      join(root, ORIGINALS_DIRECTORY),
      join(root, ORIGINALS_DIRECTORY),
      join(root, ORIGINALS_DIRECTORY),
    ]);
  });

  it("flushes the workspace directory before originals on first use, and a retry completes it", async () => {
    const root = workspace();
    const bytes = new TextEncoder().encode("parents before children");
    const order: string[] = [];
    const store = openOriginalStore(root, {
      platform: "linux",
      fs: adapter({
        fsyncDirectorySync: (path) => {
          order.push(path);
        },
      }),
    });
    await store.put(bytes);
    assert.deepEqual(order[0], root, "the workspace directory entry is flushed first");
    assert.deepEqual(order[1], join(root, ORIGINALS_DIRECTORY));
  });

  it("reports a workspace directory flush failure while creating originals and publishes nothing", async () => {
    const root = workspace();
    const flushed: string[] = [];
    const store = openOriginalStore(root, {
      platform: "linux",
      fs: adapter({
        fsyncDirectorySync: (path) => {
          flushed.push(path);
          if (path === root) throw fsError("EIO");
        },
      }),
    });
    await assert.rejects(store.put(new TextEncoder().encode("workspace flush fails")), (error: unknown) => {
      assert.ok(error instanceof OriginalPersistenceError);
      assert.match(error.message, /workspace directory/);
      return true;
    });
    assert.deepEqual(flushed, [root], "the failure stopped before writing into originals");
    assert.deepEqual(publishedFiles(root), []);
    assert.deepEqual(temporaryFiles(root), []);
  });

  it("reports a directory flush failure on POSIX instead of treating it as a skip", async () => {
    const root = workspace();
    const bytes = new TextEncoder().encode("posix flush failure");
    mkdirSync(join(root, ORIGINALS_DIRECTORY), { recursive: true });
    const flushes: string[] = [];
    const store = openOriginalStore(root, {
      platform: "linux",
      fs: adapter({
        // Only directory opens get a simulated handle; the file read is real.
        openSync: (path, flags) => {
          if (flags === "r" && (path === root || path === join(root, ORIGINALS_DIRECTORY))) {
            return directoryAwareOpen([], path, flags);
          }
          return realFs().openSync(path, flags);
        },
        closeSync: (fd) => {
          if (!isDirectoryHandle(fd)) realFs().closeSync(fd);
        },
        fsyncSync: (fd) => {
          // Only the publication's directory flush fails; prepare's succeeds.
          if (isDirectoryHandle(fd)) {
            flushes.push("directory");
            if (flushes.length > 1) throw fsError("EIO");
            return;
          }
          realFs().fsyncSync(fd);
        },
      }),
    });
    await assert.rejects(store.put(bytes), OriginalPersistenceError);
    assert.deepEqual(
      flushes,
      ["directory", "directory"],
      "the injected publication directory flush was reached",
    );
    assert.deepEqual(publishedFiles(root), [sha256(bytes)]);
    assert.deepEqual(temporaryFiles(root), []);
  });

  it("reports a directory close failure on POSIX, keeping the published original", async () => {
    const root = workspace();
    const bytes = new TextEncoder().encode("directory close fails");
    mkdirSync(join(root, ORIGINALS_DIRECTORY), { recursive: true });
    const closed: number[] = [];
    let closeCalls = 0;
    const store = openOriginalStore(root, {
      platform: "linux",
      fs: adapter({
        // Only directory opens get a simulated handle; the file read is real.
        openSync: (path, flags) => {
          if (flags === "r" && (path === root || path === join(root, ORIGINALS_DIRECTORY))) {
            return directoryAwareOpen([], path, flags);
          }
          return realFs().openSync(path, flags);
        },
        fsyncSync: (fd) => {
          if (!isDirectoryHandle(fd)) realFs().fsyncSync(fd);
        },
        closeSync: (fd) => {
          if (isDirectoryHandle(fd)) {
            closeCalls += 1;
            closed.push(fd);
            // Prepare's directory close succeeds; the publication's fails.
            if (closeCalls > 1) throw fsError("EIO");
            return;
          }
          realFs().closeSync(fd);
        },
      }),
    });
    await assert.rejects(store.put(bytes), OriginalPersistenceError);
    assert.deepEqual(closed.length, 2, "the injected publication directory close was reached");
    assert.deepEqual(publishedFiles(root), [sha256(bytes)]);
    assert.deepEqual(temporaryFiles(root), []);
  });

  it("reports a failure to create the originals directory and publishes nothing", async () => {
    const root = workspace();
    const store = openOriginalStore(root, {
      fs: adapter({
        mkdirSync: () => {
          throw fsError("EACCES");
        },
      }),
    });
    await assert.rejects(store.put(new TextEncoder().encode("no directory")), (error: unknown) => {
      assert.ok(error instanceof OriginalPersistenceError);
      assert.match(error.message, /create the originals directory/);
      return true;
    });
    assert.equal(existsSync(join(root, ORIGINALS_DIRECTORY)), false);
  });

  it("reports an injected directory flush failure while creating the directory", async () => {
    const root = workspace();
    const store = openOriginalStore(root, {
      platform: "linux",
      fs: adapter({
        fsyncDirectorySync: () => {
          throw fsError("EIO");
        },
      }),
    });
    await assert.rejects(store.put(new TextEncoder().encode("flush new directory")), (error: unknown) => {
      assert.ok(error instanceof OriginalPersistenceError);
      assert.match(error.message, /workspace directory/);
      return true;
    });
    // The first flush is the workspace directory; the failure there stops before
    // anything is written into originals.
    if (existsSync(join(root, ORIGINALS_DIRECTORY))) {
      assert.deepEqual(publishedFiles(root), []);
      assert.deepEqual(temporaryFiles(root), []);
    }
  });

  it("reports an injected originals-directory flush failure while creating the directory", async () => {
    const root = workspace();
    const flushed: string[] = [];
    const store = openOriginalStore(root, {
      platform: "linux",
      fs: adapter({
        fsyncDirectorySync: (path) => {
          flushed.push(path);
          if (path === join(root, ORIGINALS_DIRECTORY)) throw fsError("EIO");
        },
      }),
    });
    await assert.rejects(store.put(new TextEncoder().encode("originals flush fails")), (error: unknown) => {
      assert.ok(error instanceof OriginalPersistenceError);
      assert.match(error.message, /originals directory/);
      return true;
    });
    assert.deepEqual(flushed, [root, join(root, ORIGINALS_DIRECTORY)]);
    assert.deepEqual(publishedFiles(root), []);
    assert.deepEqual(temporaryFiles(root), []);
  });
});

describe("original store: arguments and boundaries", () => {
  it("refuses a blank workspace directory", () => {
    assert.throws(() => openOriginalStore(""), OriginalValidationError);
    assert.throws(() => openOriginalStore("   "), OriginalValidationError);
    assert.throws(() => openOriginalStore(42 as unknown as string), OriginalValidationError);
  });

  it("exposes the owned originals directory inside the workspace directory", () => {
    const root = workspace();
    const store: OriginalStore = openOriginalStore(root);
    assert.equal(store.directory, join(root, ORIGINALS_DIRECTORY));
  });

  it("writes no JSON reference and leaves workspace.json and existing originals untouched", async () => {
    const root = workspace();
    const existing = new TextEncoder().encode("pre-existing original");
    seed(originalPath(root, sha256(existing)), Buffer.from(existing));
    const jsonBefore = readFileSync(join(root, "workspace.json"), "utf8");
    const store = openOriginalStore(root);
    const ref = await store.put(new TextEncoder().encode("new original"));
    assert.equal(readFileSync(join(root, "workspace.json"), "utf8"), jsonBefore);
    assert.deepEqual(
      publishedFiles(root).sort(),
      [sha256(existing), ref.sha256].sort(),
    );
    assert.equal(readFileSync(originalPath(root, sha256(existing))).equals(Buffer.from(existing)), true);
  });

  it("never deletes a published hash file when a later put fails", async () => {
    const root = workspace();
    const bytes = new TextEncoder().encode("published first");
    const first = await openOriginalStore(root).put(bytes);
    const failing = openOriginalStore(root, {
      fs: adapter({
        renameSync: () => {
          throw fsError("EIO");
        },
        unlinkSync: () => {
          throw fsError("EIO");
        },
      }),
    });
    await assert.rejects(failing.put(new TextEncoder().encode("other")), OriginalPersistenceError);
    assert.deepEqual(publishedFiles(root), [first.sha256]);
  });
});
