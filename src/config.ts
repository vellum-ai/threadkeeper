import { z } from "zod";

const backfillModeSchema = z.enum(["future_only", "last_30_days", "last_90_days", "all"]);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date in YYYY-MM-DD format");
const backfillScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preset"), preset: backfillModeSchema, confirmAllHistory: z.boolean().optional() }),
  z.object({ kind: z.literal("days"), days: z.number().int().min(1).max(36_500) }),
  z
    .object({ kind: z.literal("range"), startDate: isoDateSchema, endDate: isoDateSchema })
    .superRefine((value, ctx) => {
      const start = new Date(`${value.startDate}T00:00:00.000Z`);
      const end = new Date(`${value.endDate}T00:00:00.000Z`);
      if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== value.startDate) ctx.addIssue({ code: "custom", path: ["startDate"], message: "must be a valid calendar date" });
      if (Number.isNaN(end.getTime()) || end.toISOString().slice(0, 10) !== value.endDate) ctx.addIssue({ code: "custom", path: ["endDate"], message: "must be a valid calendar date" });
      if (value.startDate > value.endDate) ctx.addIssue({ code: "custom", path: ["endDate"], message: "must be on or after startDate" });
    }),
]);

const configSchema = z.object({
  schemaVersion: z.number().int().default(1),
  captureEnabled: z.boolean().default(true),
  automaticContextInjection: z.boolean().default(false),
  backfillMode: backfillModeSchema.default("future_only"),
  backfillScope: backfillScopeSchema.default({ kind: "preset", preset: "future_only" }),
  maxJobsPerRun: z.number().int().min(1).max(50).default(5),
  maxMessagesPerConversationRun: z.number().int().min(1).max(1000).default(100),
  maxExtractionChars: z.number().int().min(1000).max(200_000).default(40_000),
  modelProfile: z.string().nullable().default(null),
  serendipity: z
    .object({
      enabled: z.boolean().default(true),
      minimumScore: z.number().min(0).max(1).default(0.72),
      maxCandidatesPerRun: z.number().int().min(0).max(20).default(3),
      dismissalCooldownDays: z.number().int().min(0).max(3650).default(30),
      sensitiveCategoriesEnabled: z.boolean().default(false),
    })
    .default({ enabled: true, minimumScore: 0.72, maxCandidatesPerRun: 3, dismissalCooldownDays: 30, sensitiveCategoriesEnabled: false }),
  retention: z
    .object({
      rawExcerptDays: z.number().int().min(1).max(3650).default(90),
      runAuditDays: z.number().int().min(1).max(3650).default(180),
    })
    .default({ rawExcerptDays: 90, runAuditDays: 180 }),
  sources: z
    .object({
      conversations: z.boolean().default(true),
      workspaceFiles: z.boolean().default(false),
      allowedPaths: z.array(z.string()).default([]),
    })
    .default({ conversations: true, workspaceFiles: false, allowedPaths: [] }),
});

export type ThreadkeeperConfig = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: ThreadkeeperConfig = configSchema.parse({});

export type ConfigParseResult = { config: ThreadkeeperConfig; warnings: string[] };

/**
 * Parse and validate raw plugin config. Invalid or missing fields fall back to safe defaults
 * (field by field via zod's `.default()`), never throwing — an unusable config.json must not
 * abort ordinary chat. Fully unparsable input (not an object) falls back to DEFAULT_CONFIG wholesale.
 */
export function parseConfig(raw: unknown): ConfigParseResult {
  const warnings: string[] = [];
  if (raw === null || typeof raw !== "object") {
    if (raw !== undefined) warnings.push("config.json was not an object; using defaults");
    return { config: DEFAULT_CONFIG, warnings };
  }
  const result = configSchema.safeParse(raw);
  if (result.success) return { config: result.data, warnings };
  for (const issue of result.error.issues) warnings.push(`${issue.path.join(".") || "(root)"}: ${issue.message}`);
  // Best-effort partial recovery: merge whatever top-level keys are individually valid over defaults.
  const partial = { ...(raw as Record<string, unknown>) };
  const merged = configSchema.safeParse(partial);
  return { config: merged.success ? merged.data : DEFAULT_CONFIG, warnings };
}

let current: ThreadkeeperConfig = DEFAULT_CONFIG;

/** Set the process-wide cached config, read by the stop hook and other hot paths without re-parsing. */
export function setConfig(config: ThreadkeeperConfig): void {
  current = config;
}

export function getConfig(): ThreadkeeperConfig {
  return current;
}
