import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { execute as openclawExecute } from "@paperclipai/adapter-openclaw-gateway/server";

const NANOCLAW_DEFAULTS = {
  url: "ws://127.0.0.1:18789",
  timeoutSec: 300,
  waitTimeoutMs: 300_000,
  sessionKeyStrategy: "issue",
  role: "operator",
  scopes: ["operator.admin"],
} as const;

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const agentName = typeof ctx.config.agentName === "string" ? ctx.config.agentName.trim() : "";

  // Merge NanoClaw defaults under user-provided config
  const mergedConfig: Record<string, unknown> = {
    ...NANOCLAW_DEFAULTS,
    ...ctx.config,
  };

  // If url was not explicitly set, apply the NanoClaw default
  if (!ctx.config.url || (typeof ctx.config.url === "string" && !ctx.config.url.trim())) {
    mergedConfig.url = NANOCLAW_DEFAULTS.url;
  }

  // Inject agentName into payloadTemplate for NanoClaw routing
  if (agentName) {
    const existing =
      typeof mergedConfig.payloadTemplate === "object" &&
      mergedConfig.payloadTemplate !== null &&
      !Array.isArray(mergedConfig.payloadTemplate)
        ? (mergedConfig.payloadTemplate as Record<string, unknown>)
        : {};

    mergedConfig.payloadTemplate = {
      ...existing,
      nanoclaw: {
        agentName,
      },
    };
  }

  return openclawExecute({
    ...ctx,
    config: mergedConfig,
  });
}
