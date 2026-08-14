import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as pluginApi from "@vellumai/plugin-api";
import { ThreadkeeperError } from "./errors.ts";
import { openDatabase } from "./db.ts";

const DB_FILENAME = "threadkeeper-demo.sqlite";
const DEMO_DB_STATE_KEY = Symbol.for("threadkeeper.demo-database-state.v1");
type DemoDatabaseState = { db: Database | null; path: string | null };

function state(): DemoDatabaseState {
  const root = globalThis as typeof globalThis & { [DEMO_DB_STATE_KEY]?: DemoDatabaseState };
  return root[DEMO_DB_STATE_KEY] ??= { db: null, path: null };
}

function fallbackPath(): string {
  let apiWorkspace: string | undefined;
  try { apiWorkspace = (pluginApi as { getWorkspaceDir?: () => string }).getWorkspaceDir?.(); } catch { /* route contexts may not expose this helper */ }
  const workspace = apiWorkspace || process.env.VELLUM_WORKSPACE_DIR;
  if (!workspace) throw new ThreadkeeperError("DB_UNAVAILABLE", "workspace directory is unavailable before Threadkeeper init");
  return join(workspace, "plugins", "threadkeeper", "data", DB_FILENAME);
}

export function demoDatabasePath(pluginStorageDir: string): string { return join(pluginStorageDir, DB_FILENAME); }

/** Opens the separate demo database. It never closes, swaps, or mutates the live getDb singleton. */
export function initDemoDb(pluginStorageDir: string): Database {
  const path = demoDatabasePath(pluginStorageDir);
  const current = state();
  if (current.db && current.path === path) return current.db;
  closeDemoDb();
  mkdirSync(dirname(path), { recursive: true });
  current.db = openDatabase(path);
  current.path = path;
  return current.db;
}

export function getDemoDb(): Database {
  const current = state();
  if (current.db) return current.db;
  const path = fallbackPath();
  current.db = openDatabase(path);
  current.path = path;
  return current.db;
}

export function closeDemoDb(): void {
  const current = state();
  try { current.db?.close(); } catch { /* best effort */ }
  current.db = null;
  current.path = null;
}

/** Test-only helper kept separate from resetDbForTests so live state cannot move. */
export function resetDemoDbForTests(path: string): Database {
  closeDemoDb();
  const current = state();
  current.db = openDatabase(path);
  current.path = path;
  return current.db;
}
