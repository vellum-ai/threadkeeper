import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { resetDbForTests } from "../../src/db.ts";

let counter = 0;

/** Fresh, isolated on-disk SQLite database per call, matching the plugin's file-backed runtime. */
export function freshDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "threadkeeper-test-"));
  return resetDbForTests(join(dir, `test-${++counter}.sqlite`));
}
