import "../fixtures/plugin-api-mock.ts";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db.ts";
import { SCHEMA_VERSION } from "../../src/migrations.ts";
import { createProposal } from "../../src/repositories/review.ts";

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "threadkeeper-db-test-"));
  return join(dir, "db.sqlite");
}

describe("database", () => {
  test("fresh database applies every migration", () => {
    const db = openDatabase(tmpPath());
    const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(version).toBe(SCHEMA_VERSION);
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const names = new Set(tables.map((t) => t.name));
    for (const expected of ["sources", "source_revisions", "pipeline_runs", "artifacts", "evidence_edges", "threads", "open_loops", "claims", "proposals", "connections", "jobs", "tombstones"]) {
      expect(names.has(expected)).toBe(true);
    }
    db.close();
  });

  test("re-running migrations against an existing database is idempotent", () => {
    const path = tmpPath();
    const first = openDatabase(path);
    first.close();
    const second = openDatabase(path); // should not throw or duplicate schema objects
    const version = (second.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(version).toBe(SCHEMA_VERSION);
    second.close();
  });

  test("foreign keys are enabled", () => {
    const db = openDatabase(tmpPath());
    const row = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
    db.close();
  });

  test("rollback journal mode and busy timeout are set", () => {
    const db = openDatabase(tmpPath());
    const journalMode = (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    expect(journalMode.toLowerCase()).toBe("delete");
    const busyTimeout = (db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
    expect(busyTimeout).toBeGreaterThan(0);
    db.close();
  });

  test("a transaction that throws mid-way rolls back completely", () => {
    const db = openDatabase(tmpPath());
    expect(() => {
      db.transaction(() => {
        db.exec(`INSERT INTO schema_meta(key, value) VALUES ('rollback-probe', '1')`);
        throw new Error("simulated interruption");
      })();
    }).toThrow();
    const row = db.query(`SELECT * FROM schema_meta WHERE key = 'rollback-probe'`).get();
    expect(row).toBeNull();
    db.close();
  });

  test("proposal fingerprint uniqueness prevents duplicate visible proposals", () => {
    const db = openDatabase(tmpPath());
    const input = {
      proposalType: "create_open_loop" as const,
      targetType: "thread",
      targetId: "thread-1",
      operation: "create",
      payload: { description: "publish the landing page" },
      fingerprint: "fp-fixed-1",
      confidence: { extraction: 0.9, evidence_quality: 0.8, source_independence: 1, recency: 1, user_confirmation: 0, contradiction_penalty: 0, risk: "low" as const },
      createdByRunId: null,
      expiresAt: null,
    };
    const first = createProposal(db, input);
    const second = createProposal(db, input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    const count = (db.query(`SELECT COUNT(*) as n FROM proposals`).get() as { n: number }).n;
    expect(count).toBe(1);
    db.close();
  });
});
