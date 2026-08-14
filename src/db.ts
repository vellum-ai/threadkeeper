import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as pluginApi from "@vellumai/plugin-api";
import { ThreadkeeperError } from "./errors.ts";
import { runMigrations } from "./migrations.ts";

const DB_FILENAME = "threadkeeper.sqlite";
const DB_STATE_KEY = Symbol.for("threadkeeper.database-state.v1");

type DatabaseState = { db: Database | null; path: string | null };

/** Route handlers are hot-reloaded as fresh module instances. Keep the connection on globalThis so
 * inline routes and lifecycle hooks in the daemon reuse one SQLite handle instead of competing as
 * independent writers. A route-host subprocess gets its own globalThis and therefore its own state. */
function databaseState(): DatabaseState {
  const root = globalThis as typeof globalThis & { [DB_STATE_KEY]?: DatabaseState };
  return root[DB_STATE_KEY] ??= { db: null, path: null };
}

function applyPragmas(handle: Database): void {
  // The workspace may be a mounted volume whose shared-memory semantics are incompatible with
  // SQLite WAL across the plugin process and the dashboard route process. Rollback journaling
  // keeps both connections usable while busy_timeout bounds ordinary reader/writer contention.
  handle.exec("PRAGMA busy_timeout = 5000");
  handle.exec("PRAGMA journal_mode = DELETE");
  handle.exec("PRAGMA foreign_keys = ON");
  handle.exec("PRAGMA synchronous = NORMAL");
}

/** Open (or create) a SQLite file at `path`, apply pragmas, and run migrations. Idempotent. */
export function openDatabase(path: string): Database {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const handle = new Database(path);
    applyPragmas(handle);
    runMigrations(handle);
    return handle;
  } catch (cause) {
    if (cause instanceof ThreadkeeperError) throw cause;
    throw new ThreadkeeperError("DB_UNAVAILABLE", `could not open threadkeeper database: ${(cause as Error).message}`);
  }
}

/** Called once from the `init` hook with the host-resolved plugin storage directory. */
export function initDb(pluginStorageDir: string): Database {
  const path = join(pluginStorageDir, DB_FILENAME);
  const state = databaseState();
  if (state.db && state.path === path) return state.db;
  closeDb();
  state.db = openDatabase(path);
  state.path = path;
  return state.db;
}

/**
 * Documented fallback for surfaces that may run before `init` populated the singleton (or in a
 * separate execution context). Resolves the same path an installed plugin's `init` would have used.
 */
type WorkspaceDirProvider = (() => string | undefined) | null | undefined;

/**
 * Resolve the canonical installed-plugin database path. The plugin API helper is preferred, but
 * fresh scheduler/route contexts may omit it or expose a helper that throws before the database
 * can be opened; in either case the workspace environment variable is the safe fallback.
 *
 * The optional arguments keep this narrow resolver directly testable without changing the runtime
 * plugin API module or the database singleton behavior.
 */
export function resolveDatabasePath(
  getWorkspaceDir: WorkspaceDirProvider = (pluginApi as { getWorkspaceDir?: () => string }).getWorkspaceDir,
  envWorkspaceDir?: string,
): string {
  let apiWorkspaceDir: string | undefined;
  try {
    apiWorkspaceDir = getWorkspaceDir?.();
  } catch {
    // A broken optional plugin API helper must not prevent the environment fallback.
  }
  const configuredEnvWorkspaceDir = arguments.length >= 2 ? envWorkspaceDir : process.env.VELLUM_WORKSPACE_DIR;
  const workspaceDir = apiWorkspaceDir || configuredEnvWorkspaceDir;
  if (!workspaceDir) {
    throw new ThreadkeeperError(
      "DB_UNAVAILABLE",
      "workspace directory is unavailable before the Threadkeeper init hook",
    );
  }
  return join(workspaceDir, "plugins", "threadkeeper", "data", DB_FILENAME);
}

/** Get the shared handle, opening it via the fallback resolver if `init` has not run yet. */
export function getDb(): Database {
  const state = databaseState();
  if (state.db) return state.db;
  const path = resolveDatabasePath();
  state.db = openDatabase(path);
  state.path = path;
  return state.db;
}

export function closeDb(): void {
  const state = databaseState();
  try {
    state.db?.close();
  } catch {
    // Already closed or unusable, either way the handle is discarded.
  }
  state.db = null;
  state.path = null;
}

/** Test-only: point the singleton at an explicit (typically temp-file or in-memory) path. */
export function resetDbForTests(path: string): Database {
  closeDb();
  const state = databaseState();
  state.db = openDatabase(path);
  state.path = path;
  return state.db;
}
