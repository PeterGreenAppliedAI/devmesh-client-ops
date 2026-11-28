/**
 * A disposable real-application child for the system-level DOCX tests.
 *
 * The harness starts the application's own source entry (`src/index.ts`) in a
 * child Node process using the same TypeScript support as the repository's
 * test runner, over a fresh temporary directory. A caller may seed that
 * directory before the child opens it. The harness waits for the child's own
 * listening announcement and a successful HTTP `/health` probe within one
 * deadline, fails on an early child exit or a readiness timeout, and exposes
 * the directory, PID, ready origin, Linux peak-RSS bytes and the child's actual
 * exit status or signal. Stopping is graceful (SIGTERM); a disposable run may
 * instead be SIGKILLed. Cleanup reaps a still-running child and removes the
 * directory, so a failed assertion cannot leave a child or workspace behind.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY = resolve(HERE, "..", "..");
const READY_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 5_000;

/** The child's actual termination: an exit code, or null with a signal. */
export interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** One running disposable application child. */
export interface DocxTestServer {
  /** The temporary workspace directory the child owns. */
  readonly directory: string;
  /** The child process id. */
  readonly pid: number;
  /** The local origin once `/health` answered. */
  readonly origin: string;
  /** The child's Linux RSS high-water mark (VmHWM) in bytes. */
  memoryBytes(): number;
  /** The child's actual exit status or signal, or null while it is running. */
  exitInfo(): ChildExit | null;
  /** Ask for a graceful stop and wait for the child, returning its exit information. */
  stop(): Promise<ChildExit>;
  /** Forcefully terminate the child and wait for it, returning its exit information. */
  kill(): Promise<ChildExit>;
  /** Reap a still-running child and remove the temporary directory. */
  cleanup(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** Reserve one loopback port, then release it for the child to bind. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close((error) => {
        if (error !== undefined) rejectPort(error);
        else resolvePort(port);
      });
    });
  });
}

/** The child's own complete announcement line for the selected port, or null. */
function announcedOrigin(stdout: string, port: number): string | null {
  const announcement = new RegExp(`^Listening on http:\\/\\/127\\.0\\.0\\.1:${port}\\r?\\n`, "m");
  return announcement.test(stdout) ? `http://127.0.0.1:${port}` : null;
}

/**
 * True when one GET /health reaches the child and answers 200 before the
 * deadline. The request is destroyed at the deadline or when the child exits,
 * so a response that keeps trickling cannot hold startup past its deadline.
 */
function healthReady(origin: string, deadline: number, exit: AbortSignal): Promise<boolean> {
  return new Promise((resolveHealth) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || exit.aborted) {
      resolveHealth(false);
      return;
    }
    const target = new URL("/health", origin);
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let req: ReturnType<typeof request> | null = null;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      exit.removeEventListener("abort", onExit);
      resolveHealth(ready && Date.now() <= deadline);
    };
    const onExit = (): void => {
      req?.destroy();
      finish(false);
    };
    exit.addEventListener("abort", onExit, { once: true });
    timer = setTimeout(onExit, remaining);
    req = request(
      {
        host: target.hostname,
        port: Number(target.port),
        path: target.pathname,
        method: "GET",
        headers: { host: target.host, "content-length": "0" },
        signal: exit,
      },
      (res) => {
        res.resume();
        res.on("end", () => finish(res.statusCode === 200));
        res.on("error", () => finish(false));
      },
    );
    req.on("error", () => finish(false));
    req.end();
  });
}

/**
 * Start one disposable application child. `seed` runs, with no child running
 * yet, against the created directory so a test can create its own synthetic
 * meetings. Readiness means the child announced its listening origin and its
 * loopback `/health` route answered before one shared deadline.
 */
export async function startDocxServer(
  seed?: (directory: string) => void | Promise<void>,
): Promise<DocxTestServer> {
  const directory = mkdtempSync(join(tmpdir(), "docx-system-"));
  let child: ChildProcess | null = null;
  let spawnError: Error | null = null;
  let exitInfo: ChildExit | null = null;
  let exitPromise: Promise<ChildExit> | null = null;

  function exitWithin(ms: number): Promise<ChildExit> {
    if (exitInfo !== null) return Promise.resolve(exitInfo);
    if (exitPromise === null) {
      return Promise.reject(new Error("the application child was not started"));
    }
    return new Promise<ChildExit>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        rejectExit(new Error(`the application child ${child?.pid ?? "unknown"} did not exit within ${ms} ms`));
      }, ms);
      exitPromise!.then((info) => {
        clearTimeout(timer);
        resolveExit(info);
      });
    });
  }

  /** Terminate and reap the child; cleanup and startup failure share this path. */
  async function terminate(signal: NodeJS.Signals): Promise<ChildExit> {
    if (exitInfo !== null) return exitInfo;
    if (spawnError !== null) throw spawnError;
    if (child === null) throw new Error("the application child was not started");
    try {
      child.kill(signal);
    } catch {
      // The child may already have exited between the check and the signal.
    }
    return exitWithin(EXIT_TIMEOUT_MS);
  }

  try {
    await seed?.(directory);
    const port = await freePort();
    const application = spawn(
      process.execPath,
      ["--experimental-strip-types", join(REPOSITORY, "src", "index.ts"), "--port", String(port), "--data-dir", directory],
      { cwd: REPOSITORY, stdio: ["ignore", "pipe", "pipe"] },
    );
    child = application;
    let stdout = "";
    let stderr = "";
    application.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    application.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    application.on("error", (error) => {
      spawnError = error;
    });
    const exitSignal = new AbortController();
    exitPromise = new Promise<ChildExit>((resolveExit) => {
      application.once("exit", (code, signal) => {
        exitInfo = { code, signal };
        exitSignal.abort();
        resolveExit(exitInfo);
      });
    });

    // One deadline covers both the child's own listening announcement and the
    // first successful HTTP probe, while every pass also observes an early exit.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let origin: string | null = null;
    let ready = false;
    while (Date.now() < deadline) {
      if (spawnError !== null) {
        const failure = spawnError as Error;
        throw new Error(`the application child could not be started: ${failure.message}`);
      }
      if (exitInfo !== null) {
        throw new Error(`the application child exited before readiness: ${JSON.stringify(exitInfo)}\n${stderr}`);
      }
      if (origin === null) origin = announcedOrigin(stdout, port);
      if (origin !== null && (await healthReady(origin, deadline, exitSignal.signal))) {
        ready = true;
        break;
      }
      await delay(25);
    }
    if (spawnError !== null) {
      const failure = spawnError as Error;
      throw new Error(`the application child could not be started: ${failure.message}`);
    }
    if (exitInfo !== null) {
      throw new Error(`the application child exited before readiness: ${JSON.stringify(exitInfo)}\n${stderr}`);
    }
    if (!ready || origin === null) {
      throw new Error(
        `the application child did not announce readiness and answer /health within ${READY_TIMEOUT_MS} ms\n${stdout}${stderr}`,
      );
    }

    let cleaned = false;
    return {
      directory,
      pid: application.pid ?? 0,
      origin,
      memoryBytes(): number {
        const status = readFileSync(`/proc/${application.pid}/status`, "utf8");
        const match = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
        if (match === null) throw new Error(`the application child ${application.pid} reports no VmHWM`);
        return Number(match[1]) * 1024;
      },
      exitInfo(): ChildExit | null {
        return exitInfo;
      },
      async stop(): Promise<ChildExit> {
        if (exitInfo !== null) return exitInfo;
        application.kill("SIGTERM");
        return exitWithin(EXIT_TIMEOUT_MS);
      },
      async kill(): Promise<ChildExit> {
        if (exitInfo !== null) return exitInfo;
        application.kill("SIGKILL");
        return exitWithin(EXIT_TIMEOUT_MS);
      },
      async cleanup(): Promise<void> {
        if (cleaned) return;
        try {
          if (exitInfo === null) await terminate("SIGKILL");
          rmSync(directory, { recursive: true, force: true });
          cleaned = true;
        } catch (error) {
          throw new Error(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    };
  } catch (error) {
    try {
      // A failed startup must not leave a live child behind. Remove the
      // directory only after the child, if there is one, has been reaped.
      if (child !== null && spawnError === null) await terminate("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new Error(
        `the application child start failed (${error instanceof Error ? error.message : String(error)}); cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw error;
  }
}

/** True when a path exists, for tests that snapshot an originals directory. */
export function pathExists(path: string): boolean {
  return existsSync(path);
}
