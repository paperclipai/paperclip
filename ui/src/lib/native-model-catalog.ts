import { aiConnectionBindingSchema, antigravityModelChoice, type Agent } from "@paperclipai/shared";
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

/** Google Antigravity ids are `<family>-<thinking level>`. The picker groups
 * them by family and shows the level, with the paid-plan note the API-key
 * catalog carries for Gemini 4. A Google account's own catalog uses the
 * account level spellings. */
export function antigravityModelGroup(method: string | undefined) {
  const catalog = method === "api_key" ? "server" as const : "account" as const;
  return (model: { id: string; label: string }) => {
    const choice = antigravityModelChoice(model, { catalog });
    if (!choice) return null;
    const note = model.label.includes(" · ") ? model.label.slice(model.label.indexOf(" · ") + 3) : undefined;
    return { group: choice.familyLabel, label: choice.levelLabel, ...(note ? { note } : {}) };
  };
}
