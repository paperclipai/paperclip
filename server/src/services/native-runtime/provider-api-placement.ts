import { parseObject } from "../../adapters/utils.js";
import { parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { resolvePaperclipRunnerNativeProviderInput } from "./provider-profile.js";

export interface ProviderApiPlacement {
  kind: "provider_api";
  provider: "cursor_cloud";
  controller: "paperclip";
}

/** Placement is server-owned. A provider's API client is not an agent Computer. */
export function resolveProviderApiPlacement(input: {
  agent: { adapterType: string; adapterConfig: unknown };
  run?: { runtimeMode: string | null; runnerProfileJson: unknown };
}): ProviderApiPlacement | null {
  const profile = parseObject(input.run?.runnerProfileJson);
  const persisted = input.run?.runtimeMode === "native" && profile.nativeExecutionInput !== undefined
    ? parseNativeExecutionInput(profile.nativeExecutionInput) : null;
  const saved = profile.executionPlacement;
  const savedRecord = parseObject(saved);
  if (saved !== undefined && (Object.keys(savedRecord).sort().join(",") !== "controller,kind,provider"
      || savedRecord.kind !== "provider_api" || savedRecord.provider !== "cursor_cloud" || savedRecord.controller !== "paperclip"
      || persisted?.provider.kind !== "cursor_cloud" || profile.backend !== "cursor_cloud_api")) {
    throw new Error("provider_api_placement_binding_mismatch");
  }
  if (persisted) return persisted.provider.kind === "cursor_cloud"
    ? { kind: "provider_api", provider: "cursor_cloud", controller: "paperclip" } : null;
  const config = parseObject(input.agent.adapterConfig);
  if (input.agent.adapterType !== "paperclip_runner" || config.provider !== "cursor_cloud") return null;
  // Validate the provider's complete launch contract before granting placement.
  resolvePaperclipRunnerNativeProviderInput({ backend: "cursor_cloud_api", adapterConfig: config });
  return { kind: "provider_api", provider: "cursor_cloud", controller: "paperclip" };
}
