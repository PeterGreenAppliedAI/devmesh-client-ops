/**
 * The application's entry point: `health()` for the health page, an
 * application constructor that wires the store, the hierarchy pages and the
 * HTTP shell together, and a CLI `main` for `node dist/index.js`.
 *
 * Importing this module never starts a listener: the constructor and `main`
 * only run when called. `main` is invoked solely from the command line (the
 * compiled `dist/index.js`), which is the program's own entry, not an import.
 *
 * Resource ownership: `startApplication` opens the store first and starts the
 * server second. If either step fails, everything opened so far is closed
 * before the failure is reported, so a failed startup never leaves a lock, a
 * listener or an open descriptor behind. On normal shutdown the server is
 * closed first (so no request can reach a closed store) and then the store,
 * releasing its lock. Each release is attempted even if an earlier one failed,
 * and the first failure is reported.
 */
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appRoutes, startServer, type PathRouteTable, type RouteResult, type RouteRequest, type Routes, type ServerOptions, type StartedServer } from "./server.ts";
import { hierarchyRoutes, matchHierarchyPath, routeForPattern, type HierarchyPath } from "./hierarchy-pages.ts";
import type { HierarchyRoute } from "./hierarchy-pages.ts";
import { matchWorkPath, routeForWorkPattern, workRoutes, type WorkPath } from "./work-pages.ts";
import type { WorkRoute } from "./work-pages.ts";
import { matchMeetingPath, meetingRoutes, routeForMeetingPattern, type MeetingPath } from "./meeting-pages.ts";
import type { MeetingRoute } from "./meeting-pages.ts";
import { archivedRoutes, archiveRoutes, matchArchivePath, type ArchivePath, type ArchiveRoute } from "./archive-pages.ts";
import { openStore, type Store } from "./store.ts";

export function health(): { status: "ok" } {
  return { status: "ok" };
}

/** The default TCP port for the local application. */
export const DEFAULT_PORT = 3000;

/** The workspace store directory name inside the user's home directory. */
export const DATA_DIRECTORY_NAME = ".devmesh-client-ops";

/**
 * The default store directory: a directory under the OS user's home, outside
 * the repository, so workspace data never lands in the source tree.
 */
export function defaultDataDirectory(): string {
  return join(homedir(), DATA_DIRECTORY_NAME);
}

/**
 * True when `candidate` is the repository directory or sits inside it. Both
 * paths are resolved first, so a relative or differently-spelled path compares
 * the same on every platform, and on Windows both are lowercased because that
 * filesystem compares names case-insensitively. No filesystem access is needed.
 * Symlinks are not followed, so a checkout reached through a link is compared
 * as spelled.
 */
function isInsideRepository(candidate: string, repository: string): boolean {
  const normalize = (path: string): string => {
    const absolute = resolve(path);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  };
  const from = normalize(repository);
  const to = normalize(candidate);
  const rel = relative(from, to);
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The repository this module was built from, found from the module's own
 * location rather than the launch directory: `node dist/index.js` run from a
 * subdirectory must still recognise the checkout it lives in. The compiled
 * module sits at `<repository>/dist/index.js` and the source at
 * `<repository>/src/index.ts`, so the directory above the module's own folder
 * is the repository root when the checkout has those layouts. When the module
 * is loaded from elsewhere (a test runner importing `src/index.ts`), the
 * launch directory is the best available answer.
 */
function repositoryDirectory(moduleUrl: string): string {
  if (!moduleUrl.startsWith("file:")) return resolve(process.cwd());
  const modulePath = fileURLToPath(moduleUrl);
  const parts = modulePath.split(/[\\/]/);
  const parentName = parts[parts.length - 2];
  const fileName = parts[parts.length - 1];
  if (
    (parentName === "dist" && fileName === "index.js") ||
    (parentName === "src" && fileName === "index.ts")
  ) {
    return resolve(modulePath, "..", "..");
  }
  return resolve(process.cwd());
}

/**
 * The default data directory must never be the repository or inside it:
 * workspace data belongs to the OS user's home, not to the source tree. Only
 * the default is checked; a data directory the user names with `--data-dir` is
 * used as given. A collision is refused clearly before the store opens.
 */
function requireDefaultOutsideRepository(dataDirectory: string, repository: string): string {
  if (isInsideRepository(dataDirectory, repository)) {
    throw new StartupError(
      `The default data directory ${JSON.stringify(dataDirectory)} is inside the repository ${JSON.stringify(repository)}; pass --data-dir to choose a directory outside it`,
    );
  }
  return dataDirectory;
}

/** A running application: its canonical local URL and a shutdown method. */
export interface Application {
  /** The canonical local URL, for example `http://127.0.0.1:3000`. */
  readonly url: string;
  /** The bound port. */
  readonly port: number;
  /** Close the server and then the store, releasing every resource. */
  close(): Promise<void>;
}

/**
 * A path matcher and its route lookup for the hierarchy extension. The shell
 * keeps the matched value opaque (`PathRouteTable<P>`); the extension decides
 * what a match is and how it maps to a guarded route.
 */
export interface HierarchyPathMatch {
  readonly pattern: HierarchyPath | WorkPath | MeetingPath | ArchivePath | "/archived";
  readonly id: string;
}

/**
 * Build the full route table served by the application: the home and health
 * shell from `appRoutes`, plus the hierarchy routes registered under their
 * canonical list/detail paths.
 */
export function registerRoutes(store: Store): Routes {
  const base = appRoutes(store);
  const hierarchy = hierarchyRoutes(store);
  const work = workRoutes(store);
  const meetings = meetingRoutes(store);
  const archive = archiveRoutes(store);
  const archived = archivedRoutes(store).archived;
  const table: PathRouteTable<HierarchyPathMatch> = {
    match: (path: string) => {
      // The archive endpoints and the archived discovery page are matched
      // first (their paths are exact), then the hierarchy paths, then the
      // fixed work and meeting patterns. An unknown path matches none and is
      // refused by the shell.
      const archiveMatch = matchArchivePath(path);
      if (archiveMatch !== null) return archiveMatch;
      if (path.split("?")[0] === "/archived") return { pattern: "/archived", id: "" };
      const matched = matchHierarchyPath(path);
      if (matched !== null) return matched;
      const work = matchWorkPath(path);
      if (work !== null) return work;
      return matchMeetingPath(path);
    },
    route: (matched, method) => {
      // `matched` is only produced by `match` above, so its pattern is one of
      // the fixed hierarchy, work, meeting or archive shapes, never a
      // request-controlled destination. The archive endpoints are POST-only:
      // a GET finds the unarchive slot's `get`, which is absent, and the shell
      // answers 405 before any handler runs.
      if (matched.pattern === "/archived") {
        return method === "GET" ? adaptRoute(archived.get) : undefined;
      }
      if (matched.pattern.endsWith("/archive") || matched.pattern.endsWith("/unarchive")) {
        const action = matched.pattern.endsWith("/unarchive") ? archive.unarchive : archive.archive;
        const route = method === "POST" ? action.post : undefined;
        return route === undefined ? undefined : adaptRoute(route);
      }
      const route = isWorkPath(matched.pattern)
        ? routeForWorkPattern(work, matched.pattern, method)
        : isMeetingPath(matched.pattern)
          ? routeForMeetingPattern(meetings, matched.pattern, method)
          : routeForPattern(hierarchy, matched.pattern as HierarchyPath, method);
      return route === undefined ? undefined : adaptRoute(route);
    },
  };
  return { ...base, hierarchy: table };
}

/** The fixed work patterns; a matched pattern outside this list is a hierarchy pattern. */
const WORK_PATTERNS: readonly WorkPath[] = Object.freeze([
  "/tasks/:id",
  "/tasks/:id/edit",
  "/items/:id",
  "/items/:id/edit",
  "/engagements/:id/tasks/new",
  "/engagements/:id/items/new",
  "/projects/:id/tasks/new",
  "/projects/:id/items/new",
]);

function isWorkPath(pattern: string): pattern is WorkPath {
  return (WORK_PATTERNS as readonly string[]).includes(pattern);
}

/** The fixed meeting patterns; a matched pattern outside both lists is a hierarchy pattern. */
const MEETING_PATTERNS: readonly MeetingPath[] = Object.freeze([
  "/meetings/:id",
  "/meetings/:id/edit",
  "/engagements/:id/meetings/new",
  "/projects/:id/meetings/new",
]);

function isMeetingPath(pattern: string): pattern is MeetingPath {
  return (MEETING_PATTERNS as readonly string[]).includes(pattern);
}

/** Adapt a hierarchy, work, meeting or archive route to the shell's generic route interface. */
function adaptRoute(route: HierarchyRoute | WorkRoute | MeetingRoute | ArchiveRoute): { readonly method: "GET" | "POST"; render(request: RouteRequest): Promise<RouteResult> | RouteResult } {
  return {
    method: route.method,
    render: (request: RouteRequest) => route.render(request),
  };
}

/** A failure while starting the application; the message is shown to the user. */
export class StartupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StartupError";
  }
}

/**
 * Start the application: open the store at `dataDirectory`, start the loopback
 * server on `port` with the full route table, and return its URL and shutdown
 * method. A failure at any step releases what was already opened before the
 * failure is rethrown as a `StartupError` with a readable message.
 */
/**
 * The dependencies of `startApplication`. The default is the real store and
 * server; a test supplies these so a failing file or system operation is
 * injected through this interface instead of induced by changing the
 * environment.
 */
export interface ApplicationDependencies {
  open(directory: string): Promise<Store>;
  start(options: ServerOptions): Promise<StartedServer>;
}

/** The real dependencies: the on-disk store and the loopback HTTP server. */
const REAL_DEPENDENCIES: ApplicationDependencies = Object.freeze({
  open: openStore,
  start: startServer,
});

/**
 * Start the application: open the store at `dataDirectory`, start the loopback
 * server on `port` with the full route table, and return its URL and shutdown
 * method. A failure at any step releases what was already opened before the
 * failure is rethrown as a `StartupError` with a readable message. A release
 * failure during startup cleanup is reported alongside the startup failure,
 * never hidden.
 */
export async function startApplication(
  options: {
    readonly dataDirectory: string;
    readonly port: number;
  },
  dependencies: ApplicationDependencies = REAL_DEPENDENCIES,
): Promise<Application> {
  let store: Store;
  try {
    store = await dependencies.open(options.dataDirectory);
  } catch (error) {
    throw new StartupError(`Cannot open the workspace store: ${describe(error)}`, { cause: error });
  }

  let server: StartedServer;
  try {
    const serverOptions: ServerOptions = {
      store,
      port: options.port,
      routes: registerRoutes(store),
    };
    server = await dependencies.start(serverOptions);
  } catch (error) {
    const failure = isPortInUse(error)
      ? new StartupError(`Port ${options.port} is already in use`, { cause: error })
      : new StartupError(`Cannot start the server: ${describe(error)}`, { cause: error });
    // Release the store opened above, even though startup has failed. A
    // release failure is reported with the startup failure, so neither is
    // swallowed: the message names both, and the release error is the cause.
    try {
      await store.close();
    } catch (closeError) {
      throw new StartupError(
        `${failure.message}; the store could not be closed either: ${describe(closeError)}`,
        { cause: closeError },
      );
    }
    throw failure;
  }

  return {
    url: server.origin,
    port: server.port,
    async close() {
      const failures: unknown[] = [];
      // The server closes first, so no request can reach a closed store.
      try {
        await server.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await store.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) throw failures[0];
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True for the error Node reports when a port is already bound. */
export function isPortInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "EADDRINUSE"
  );
}

/** Parsed command-line options for the CLI. */
export interface CliOptions {
  readonly port: number;
  readonly dataDirectory: string;
}

/** A refused command line: the message names the problem and is shown as-is. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

/**
 * Parse the CLI arguments: `--port <number>` and `--data-dir <path>`. Unknown
 * options, missing values (including an option followed by another option),
 * repeated options and an invalid port are refused with a clear message.
 * Omitted options default to port 3000 and the default data directory. A
 * relative data directory is resolved against the launch directory (the
 * process's current working directory), the usual convention for CLI paths, so
 * `--data-dir workspace` names the `workspace` directory where the program was
 * started.
 */
export function parseCliArguments(
  args: readonly string[],
  defaults: { readonly dataDirectory: string },
): CliOptions {
  let port: number | undefined;
  let dataDirectory: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--port" && arg !== "--data-dir") {
      throw new CliError(`Unknown argument: ${arg}`);
    }
    const value = args[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new CliError(`Missing value for ${arg}`);
    }
    if (arg === "--port") {
      if (port !== undefined) throw new CliError("--port may only be given once");
      port = parsePort(value);
    } else {
      if (dataDirectory !== undefined) throw new CliError("--data-dir may only be given once");
      dataDirectory = resolve(value);
    }
    index += 1;
  }
  return {
    port: port ?? DEFAULT_PORT,
    dataDirectory: dataDirectory ?? defaults.dataDirectory,
  };
}

/** Parse a decimal port number in 1..65535; anything else is refused. */
function parsePort(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new CliError(`Invalid port: ${value}. The port must be a number from 1 to 65535.`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new CliError(`Invalid port: ${value}. The port must be a number from 1 to 65535.`);
  }
  return port;
}

/** The dependencies of `main`, injectable so a test can simulate failures. */
export interface CliEnvironment {
  /** The command-line arguments after the program and script path. */
  readonly args: readonly string[];
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** The default data directory, computed from the OS user's home. */
  readonly defaultDataDirectory: string;
  /** Start the application. */
  readonly start: (options: { readonly dataDirectory: string; readonly port: number }) => Promise<Application>;
  /** Register a normal-shutdown handler; returns a function that removes it. */
  readonly onShutdown: (handler: () => void) => () => void;
  /** Exit the process with a status code. */
  readonly exit: (code: number) => void;
}

/** The result of a successful `main` call. */
export interface CliResult {
  /** The running application, once startup succeeded. */
  readonly application: Application;
  /** Stop the application (idempotent) and remove the shutdown handlers. */
  shutdown(): Promise<void>;
}

/**
 * The CLI: parse the arguments, start the application, print its canonical URL
 * and release everything on normal shutdown. A refused argument prints a clear
 * message and exits with status 2 without starting anything; a failed startup
 * exits with status 1 after releasing whatever was opened. It returns null when
 * startup was refused or failed.
 */
export async function main(environment: CliEnvironment): Promise<CliResult | null> {
  let options: CliOptions;
  try {
    options = parseCliArguments(environment.args, { dataDirectory: environment.defaultDataDirectory });
    // Only an omitted data directory is the default; a named one is used as
    // given. The default must lie outside the repository.
    if (!environment.args.includes("--data-dir")) {
      requireDefaultOutsideRepository(options.dataDirectory, repositoryDirectory(import.meta.url));
    }
  } catch (error) {
    if (error instanceof CliError || error instanceof StartupError) {
      environment.stderr(`Error: ${error.message}`);
      environment.exit(2);
      return null;
    }
    throw error;
  }

  let application: Application;
  try {
    application = await environment.start({ dataDirectory: options.dataDirectory, port: options.port });
  } catch (error) {
    environment.stderr(`Error: ${describe(error)}`);
    environment.exit(1);
    return null;
  }

  // The canonical local URL is printed once, after the listener is up.
  environment.stdout(`Listening on ${application.url}`);

  let closing: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (closing !== null) return closing;
    closing = application.close().catch((error: unknown) => {
      environment.stderr(`Error: ${describe(error)}`);
      throw error;
    });
    return closing;
  };
  const removeHandlers = environment.onShutdown(() => {
    shutdown().then(
      () => environment.exit(0),
      () => environment.exit(1),
    );
  });

  return {
    application,
    async shutdown() {
      if (removeHandlers) removeHandlers();
      await shutdown();
    },
  };
}

/**
 * The real CLI environment for `node dist/index.js`: standard streams, the
 * OS home directory and SIGINT/SIGTERM as normal shutdown signals. A listener
 * keeps the process alive until a signal arrives; shutdown releases the server
 * and the store before the process exits.
 */
export function cliEnvironment(args: readonly string[]): CliEnvironment {
  return {
    args,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    defaultDataDirectory: defaultDataDirectory(),
    start: startApplication,
    onShutdown: (handler) => {
      const stop = (): void => {
        handler();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      };
    },
    exit: (code) => {
      process.exitCode = code;
    },
  };
}

/** True when this module is the program's own entry (`node dist/index.js`). */
export function isEntryPoint(moduleUrl: string, argv: readonly string[]): boolean {
  const entry = argv[1];
  if (entry === undefined) return false;
  return pathToFileURL(entry).href === moduleUrl;
}

// The CLI runs only when this file is the process's entry point, never when it
// is imported. A failed startup exits after releasing everything; a successful
// startup keeps the process alive through the listener until a signal arrives.
if (isEntryPoint(import.meta.url, process.argv)) {
  void main(cliEnvironment(process.argv.slice(2)));
}
