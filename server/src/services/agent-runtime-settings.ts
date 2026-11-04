import { isDeepStrictEqual } from "node:util";
import { agentRuntimeSettingsHarness, type UpdateAgent } from "@paperclipai/shared";
import type { AgentConfigurationRecord } from "../lib/agent-records.js";
import { conflict, unprocessable } from "../errors.js";

/** Translate a scoped edit into the existing validated configuration write. */
export function prepareRuntimeSettingsPatch(existing: Pick<AgentConfigurationRecord, "adapterType" | "adapterConfig" | "runtimeConfig" | "status">, input: UpdateAgent): Record<string, unknown> {
  const settings = input.runtimeSettings!;
  if (Object.keys(input).some(key => key !== "runtimeSettings")) {
    throw unprocessable("Runtime settings cannot be combined with other agent changes");
  }
  const harness = agentRuntimeSettingsHarness(existing.adapterType, existing.adapterConfig);
  if (harness !== settings.harness) throw conflict("This agent's harness changed. Refresh the roster and select it again.");
  if (["process", "http"].includes(harness) || ["terminated", "pending_approval"].includes(existing.status)) {
    throw unprocessable("This agent cannot be updated from the roster");
  }
  const model = typeof existing.adapterConfig.model === "string" ? existing.adapterConfig.model.trim() || null : null;
  const binding = existing.runtimeConfig.aiConnection ?? null;
  if (model !== settings.expected.model || !isDeepStrictEqual(binding, settings.expected.aiConnection)) {
    throw conflict("This agent's connection or model changed. Refresh the roster and review the changes again.");
  }
  if (settings.aiConnection?.mode === "router" || (binding && typeof binding === "object" && "mode" in binding && binding.mode === "router")) {
    throw unprocessable("Edit connection pool members on the agent's configuration page");
  }
  return {
    ...(settings.model !== undefined ? { adapterConfig: { model: settings.model } } : {}),
    ...(settings.aiConnection !== undefined ? { runtimeConfig: { ...existing.runtimeConfig, aiConnection: settings.aiConnection } } : {}),
  };
}
