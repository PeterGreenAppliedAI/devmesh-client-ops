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

/** A workspace directory holding a workspace.json and an originals directory. */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "transcript-files-"));
  roots.push(root);
  writeFileSync(join(root, "workspace.json"), "{\"untouched\":true}\n", "utf8");
  rmSync(join(root, ORIGINALS_DIRECTORY), { recursive: true, force: true });
  // The originals directory is the workspace writer's; a real adapter does not
  // create it, so the test creates the owned directory before using the store.
  return root;
}

/** Create the store's owned directory inside a workspace. */
function withDirectory(root: string): void {
  mkdirSync(join(root, ORIGINALS_DIRECTORY), { recursive: true });
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
  return readdirSync(join(root, ORIGINALS_DIRECTORY)).filter((name) => !name.endsWith(".tmp"));
}

/** A plain adapter over node:fs, matching the store's default. */
function realFs(): OriginalFileSystem {
  return {
    existsSync: (path) => existsSync(path),
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
    withDirectory(root);
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

  it("returns detached bytes that callers cannot use to change stored content", async () => {
    const root = workspace();
    withDirectory(root);
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
    withDirectory(root);
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
    withDirectory(root);
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
    withDirectory(root);
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
    withDirectory(root);
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
  ];

  for (const value of malformed) {
    it(`refuses ${JSON.stringify(value)} before any file access`, async () => {
      const root = workspace();
      withDirectory(root);
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
    withDirectory(root);
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
    withDirectory(root);
    const bytes = new TextEncoder().encode("honest content");
    const hash = sha256(bytes);
    const impostor = Buffer.from("different content");
    writeFileSync(originalPath(root, hash), impostor);

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
    withDirectory(root);
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
    withDirectory(root);
    const bytes = new TextEncoder().encode("corrupt me");
    const hash = sha256(bytes);
    const corrupt = Buffer.from("tampered bytes");
    writeFileSync(originalPath(root, hash), corrupt);
    const store = openOriginalStore(root);
    await assert.rejects(store.read(hash), OriginalIntegrityError);
    assert.equal(readFileSync(originalPath(root, hash)).equals(corrupt), true);
    assert.deepEqual(temporaryFiles(root), []);
  });

  it("reports an unreadable existing original as an integrity failure and keeps it", async () => {
    const root = workspace();
    withDirectory(root);
    const bytes = new TextEncoder().encode("present but unreadable");
    const hash = sha256(bytes);
    writeFileSync(originalPath(root, hash), Buffer.from(bytes));
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
    withDirectory(root);
    const bytes = new TextEncoder().encode("published elsewhere");
    const hash = sha256(bytes);
    // The file is present from the start, but the first existence check reports
    // it absent (as if another writer published it between the two checks); the
    // store verifies it on the second check rather than renaming over it.
    writeFileSync(originalPath(root, hash), Buffer.from(bytes));
    let calls = 0;
    const store = openOriginalStore(root, {
      fs: adapter({
        existsSync: (path) => {
          calls += 1;
          return calls === 1 ? false : existsSync(path);
        },
      }),
    });
    const ref = await store.put(bytes);
    assert.equal(ref.sha256, hash);
    assert.deepEqual(ref.bytes, bytes);
    assert.deepEqual(publishedFiles(root), [hash]);
    assert.deepEqual(temporaryFiles(root), []);
  });
});

describe("original store: injected persistence failures", () => {
  it("writes short writes fully, honoring the byte offset", async () => {
    const root = workspace();
    withDirectory(root);
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
    withDirectory(root);
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
    withDirectory(root);
    const store = openOriginalStore(root, { fs: adapter({ writeSync: () => 9999 }) });
    await assert.rejects(store.put(new TextEncoder().encode("x")), OriginalPersistenceError);
    assert.deepEqual(readdirSync(join(root, ORIGINALS_DIRECTORY)), []);
  });

  it("reports a flush failure, removes its temporary file and publishes nothing", async () => {
    const root = workspace();
    withDirectory(root);
    const store = openOriginalStore(root, {
      fs: adapter({
        fsyncSync: () => {
          throw fsError("EIO");
        },
      }),
    });
    await assert.rejects(store.put(new TextEncoder().encode("flush fails")), OriginalPersistenceError);
    assert.deepEqual(publishedFiles(root), []);
    assert.deepEqual(temporaryFiles(root), []);
  });

  it("reports a close failure, closes again and removes its temporary file", async () => {
    const root = workspace();
    withDirectory(root);
    const plain = realFs();
    let closes = 0;
    const store = openOriginalStore(root, {
      fs: adapter({
        // The first close reports failure but still closes; cleanup closes again.
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
    withDirectory(root);
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
    withDirectory(root);
    const bytes = new TextEncoder().encode("directory flush fails once");
    let flushes = 0;
    const store = openOriginalStore(root, {
      platform: "linux",
      fs: adapter({
        fsyncDirectorySync: () => {
          flushes += 1;
          if (flushes === 1) throw fsError("EIO");
        },
      }),
    });
    await assert.rejects(store.put(bytes), (error: unknown) => {
      assert.ok(error instanceof OriginalPersistenceError);
      assert.match(error.message, /directory/);
      return true;
    });
    // The publication happened; the published original is retained as evidence.
    const hash = sha256(bytes);
    assert.deepEqual(publishedFiles(root), [hash]);
    assert.equal(readFileSync(originalPath(root, hash)).equals(Buffer.from(bytes)), true);
    assert.deepEqual(temporaryFiles(root), []);

    // A verified retry reuses the published bytes and satisfies durability.
    const retried = await store.put(bytes);
    assertReference(retried, bytes);
    assert.ok(flushes >= 2, "the retry ran the directory flush");
    // A fresh store reusing the original runs the durability step too.
    let reopenedFlushes = 0;
    const reopened = openOriginalStore(root, {
      platform: "linux",
      fs: adapter({
        fsyncDirectorySync: () => {
          reopenedFlushes += 1;
        },
      }),
    });
    const reused = await reopened.put(bytes);
    assert.equal(reused.sha256, hash);
    assert.equal(reopenedFlushes, 1);
  });

  it("reports a directory open failure during the directory flush, keeping the published original", async () => {
    const root = workspace();
    withDirectory(root);
    const bytes = new TextEncoder().encode("directory open fails");
    const plain = realFs();
    const store = openOriginalStore(root, {
      platform: "linux",
      fs: adapter({
        openSync: (path, flags) => {
          if (flags === "r") throw fsError("EACCES");
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
    withDirectory(root);
    const bytes = new TextEncoder().encode("directory fsync fails");
    const plain = realFs();
    const store = openOriginalStore(root, {
      platform: "linux",
      fs: adapter({
        // The file's own flush (with the temp descriptor) succeeds; only the
        // directory handle's flush fails.
        fsyncSync: (fd) => {
          const stat = fsModule.fstatSync(fd);
          if (stat.isDirectory()) throw fsError("EIO");
          plain.fsyncSync(fd);
        },
      }),
    });
    await assert.rejects(store.put(bytes), OriginalPersistenceError);
    assert.deepEqual(publishedFiles(root), [sha256(bytes)]);
    assert.deepEqual(temporaryFiles(root), []);
  });

  it("reports a cleanup unlink failure as the operation failure with the cleanup attached", async () => {
    const root = workspace();
    withDirectory(root);
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
    withDirectory(root);
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
    withDirectory(root);
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
    withDirectory(root);
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
    withDirectory(root);
    const bytes = new TextEncoder().encode("posix directory flush");
    const opened: string[] = [];
    const store = openOriginalStore(root, {
      platform: "darwin",
      fs: adapter({
        openSync: (path, flags) => {
          if (flags === "r") opened.push(path);
          return realFs().openSync(path, flags);
        },
      }),
    });
    await store.put(bytes);
    assert.deepEqual(opened, [join(root, ORIGINALS_DIRECTORY)]);
    // A reuse also satisfies the durability step.
    await store.put(bytes);
    assert.deepEqual(opened, [join(root, ORIGINALS_DIRECTORY), join(root, ORIGINALS_DIRECTORY)]);
  });

  it("reports a directory flush failure on POSIX instead of treating it as a skip", async () => {
    const root = workspace();
    withDirectory(root);
    const bytes = new TextEncoder().encode("posix flush failure");
    const store = openOriginalStore(root, {
      platform: "linux",
      fs: adapter({
        fsyncDirectorySync: () => {
          throw fsError("EIO");
        },
      }),
    });
    await assert.rejects(store.put(bytes), OriginalPersistenceError);
    assert.deepEqual(publishedFiles(root), [sha256(bytes)]);
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
    withDirectory(root);
    const existing = new TextEncoder().encode("pre-existing original");
    writeFileSync(originalPath(root, sha256(existing)), Buffer.from(existing));
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
    withDirectory(root);
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
