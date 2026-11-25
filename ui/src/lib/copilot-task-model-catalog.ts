import { aiConnectionBindingSchema, type Agent } from "@paperclipai/shared";

/** Task overrides must discover models through the assignee's saved connection. */
export function copilotTaskModelCatalogOptions(agent: Agent | null | undefined) {
  if (agent?.adapterType !== "paperclip_runner"
    || agent.adapterConfig.provider !== "acpx"
    || agent.adapterConfig.acpxAgent !== "copilot") return undefined;
  return {
    acpxAgent: "copilot",
    agentId: agent.id,
    aiConnection: aiConnectionBindingSchema.safeParse(agent.runtimeConfig?.aiConnection).data,
  };
}

/** Remote catalogs may provision a sandbox; live-data reconciliation must not repeat discovery. */
export const COPILOT_MODEL_DISCOVERY_QUERY_OPTIONS = {
  staleTime: "static" as const,
  retry: false as const,
};
