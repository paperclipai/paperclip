import { aiConnectionBindingSchema, type Agent } from "@paperclipai/shared";
import { COPILOT_MODEL_DISCOVERY_QUERY_OPTIONS, copilotTaskModelCatalogOptions } from "./copilot-task-model-catalog";

/** These ACP catalogs resolve the selected account rather than a generic list. */
export function isAccountBoundAcpxAgent(agent: unknown): agent is "copilot" | "antigravity" {
  return agent === "copilot" || agent === "antigravity";
}

export function nativeTaskModelCatalogOptions(agent: Agent | null | undefined) {
  if (agent?.adapterType === "paperclip_runner" && agent.adapterConfig.provider === "acpx" && agent.adapterConfig.acpxAgent === "antigravity") {
    return { acpxAgent: "antigravity", agentId: agent.id,
      aiConnection: aiConnectionBindingSchema.safeParse(agent.runtimeConfig?.aiConnection).data };
  }
  return copilotTaskModelCatalogOptions(agent);
}

/** Account reconciliation must not repeatedly provision catalog discovery. */
export const ACCOUNT_BOUND_MODEL_DISCOVERY_QUERY_OPTIONS = COPILOT_MODEL_DISCOVERY_QUERY_OPTIONS;
