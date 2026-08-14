/** Best-effort teardown: close the SQLite handle so redeploys and daemon shutdown never leak it. */
import type { HookFunction, ShutdownContext } from "@vellumai/plugin-api";
import { closeDb } from "../src/db.ts";
import { closeDemoDb } from "../src/demoDb.ts";

const shutdown: HookFunction<ShutdownContext> = async () => {
  try {
    closeDb();
    closeDemoDb();
  } catch {
    // Best-effort; nothing left to do if close itself fails.
  }
};

export default shutdown;
