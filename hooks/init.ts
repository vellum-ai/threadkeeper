/**
 * Bootstrap: validate config (leniently — bad fields fall back to safe defaults, never abort),
 * then open plugin-owned SQLite and run migrations. A database that truly cannot initialize is the
 * one case allowed to abort the plugin's own load (plan §6) — ordinary chat is unaffected either
 * way, since a plugin that fails to load simply contributes no hooks/tools.
 */
import type { HookFunction, InitContext } from "@vellumai/plugin-api";
import { parseConfig, setConfig } from "../src/config.ts";
import { initDb } from "../src/db.ts";
import { initDemoDb } from "../src/demoDb.ts";
import { ensureDemoSeeded } from "../src/demoSeed.ts";

const init: HookFunction<InitContext> = async (ctx) => {
  const { config, warnings } = parseConfig(ctx.config);
  setConfig(config);
  for (const warning of warnings) ctx.logger.warn({ warning }, "threadkeeper config validation fallback");

  try {
    initDb(ctx.pluginStorageDir);
    ensureDemoSeeded(initDemoDb(ctx.pluginStorageDir));
  } catch (cause) {
    ctx.logger.error({ err: (cause as Error).message }, "threadkeeper database could not initialize; plugin load aborted");
    throw cause;
  }
};

export default init;
