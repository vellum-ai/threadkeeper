/**
 * Thin wrapper over the workspace's configured inference provider. No plugin-supplied API key —
 * every call routes through `getConfiguredProvider`. Callers get a discriminated result instead of
 * a thrown error so "no provider configured" is a normal, retryable outcome rather than a crash.
 */
import { getConfiguredProvider } from "@vellumai/plugin-api";
import type { ThreadkeeperConfig } from "./config.ts";

export type ProviderCallResult =
  | { ok: true; text: string; model: string }
  | { ok: false; reason: "NO_PROVIDER" | "PROVIDER_TIMEOUT" | "PROVIDER_ERROR"; detail: string };

const DEFAULT_TIMEOUT_MS = 45_000;

export async function callProvider(
  systemPrompt: string,
  userPrompt: string,
  config: ThreadkeeperConfig,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProviderCallResult> {
  let provider;
  try {
    provider = await getConfiguredProvider(
      "inference",
      config.modelProfile ? { overrideProfile: config.modelProfile, forceOverrideProfile: true } : {},
    );
  } catch (cause) {
    return { ok: false, reason: "NO_PROVIDER", detail: (cause as Error).message.slice(0, 200) };
  }
  if (!provider) return { ok: false, reason: "NO_PROVIDER", detail: "no inference provider configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await provider.sendMessage([{ role: "user", content: [{ type: "text", text: userPrompt }] }], {
      systemPrompt,
      signal: controller.signal,
    });
    const block = response.content.find((b): b is { type: "text"; text: string } => b.type === "text");
    return { ok: true, text: block?.text ?? "", model: response.model };
  } catch (cause) {
    const reason = controller.signal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_ERROR";
    return { ok: false, reason, detail: (cause as Error).message?.slice(0, 200) ?? "provider call failed" };
  } finally {
    clearTimeout(timer);
  }
}
