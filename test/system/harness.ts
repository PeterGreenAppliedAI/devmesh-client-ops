/**
 * A disposable real-application child for the system-level DOCX tests.
 *
 * The harness starts the application's own source entry (`src/index.ts`) in a
 * child Node process using the same TypeScript support as the repository's
 * test runner, over a fresh temporary directory. A caller may seed that
 * directory before the child opens it. The harness waits for HTTP `/health`
 * readiness, fails on an early child exit or a readiness timeout, and exposes
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

/** True when one GET /health reaches the child and answers 200. */
function healthReady(origin: string): Promise<boolean> {
  return new Promise((resolveHealth) => {
    const target = new URL("/health", origin);
    const req = request(
      {
        host: target.hostname,
        port: Number(target.port),
        path: target.pathname,
        method: "GET",
        headers: { host: target.host, "content-length": "0" },
        timeout: 250,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolveHealth(res.statusCode === 200));
        res.on("error", () => resolveHealth(false));
      },
    );
    req.on("error", () => resolveHealth(false));
    req.on("timeout", () => {
      req.destroy();
      resolveHealth(false);
    });
    req.end();
  });
}

/**
 * Start one disposable application child. `seed` runs, with no child running
 * yet, against the created directory so a test can create its own synthetic
 * meetings. Readiness means the child's loopback `/health` route answered.
 */
export async function startDocxServer(
  seed?: (directory: string) => void | Promise<void>,
): Promise<DocxTestServer> {
  const directory = mkdtempSync(join(tmpdir(), "docx-system-"));
  try {
    await seed?.(directory);
    const port = await freePort();
    const child: ChildProcess = spawn(
      process.execPath,
      ["--experimental-strip-types", join(REPOSITORY, "src", "index.ts"), "--port", String(port), "--data-dir", directory],
      { cwd: REPOSITORY, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let spawnError: Error | null = null;
    let exitInfo: ChildExit | null = null;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    const exitPromise = new Promise<ChildExit>((resolveExit) => {
      child.once("exit", (code, signal) => {
        exitInfo = { code, signal };
        resolveExit(exitInfo);
      });
    });
    const origin = `http://127.0.0.1:${port}`;

    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (spawnError !== null) {
        const failure = spawnError as Error;
        throw new Error(`the application child could not be started: ${failure.message}`);
      }
      if (exitInfo !== null) {
        throw new Error(`the application child exited before readiness: ${JSON.stringify(exitInfo)}\n${stderr}`);
      }
      if (await healthReady(origin)) break;
      await delay(25);
    }
    if (exitInfo !== null || (spawnError as Error | null) !== null || !(await healthReady(origin))) {
      throw new Error(`the application child did not become ready within ${READY_TIMEOUT_MS} ms\n${stdout}${stderr}`);
    }

    let cleaned = false;
    function exitWithin(ms: number): Promise<ChildExit> {
      if (exitInfo !== null) return Promise.resolve(exitInfo);
      return new Promise<ChildExit>((resolveExit, rejectExit) => {
        const timer = setTimeout(() => {
          rejectExit(new Error(`the application child ${child.pid ?? "unknown"} did not exit within ${ms} ms`));
        }, ms);
        exitPromise.then((info) => {
          clearTimeout(timer);
          resolveExit(info);
        });
      });
    }

    return {
      directory,
      pid: child.pid ?? 0,
      origin,
      memoryBytes(): number {
        const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
        const match = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
        if (match === null) throw new Error(`the application child ${child.pid} reports no VmHWM`);
        return Number(match[1]) * 1024;
      },
      exitInfo(): ChildExit | null {
        return exitInfo;
      },
      async stop(): Promise<ChildExit> {
        if (exitInfo !== null) return exitInfo;
        child.kill("SIGTERM");
        return exitWithin(EXIT_TIMEOUT_MS);
      },
      async kill(): Promise<ChildExit> {
        if (exitInfo !== null) return exitInfo;
        child.kill("SIGKILL");
        return exitWithin(EXIT_TIMEOUT_MS);
      },
      async cleanup(): Promise<void> {
        if (cleaned) return;
        cleaned = true;
        if (exitInfo === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The child may have exited between the check and the signal.
          }
          try {
            await exitWithin(EXIT_TIMEOUT_MS);
          } catch {
            // Cleanup still removes the disposable directory; the failed wait
            // is reported by the test run's failing assertion, not swallowed.
          }
        }
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** True when a path exists, for tests that snapshot an originals directory. */
export function pathExists(path: string): boolean {
  return existsSync(path);
}
