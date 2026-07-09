import type { Db } from "@paperclipai/db";
import type { BriefsOverview } from "@paperclipai/shared";
import { builtInAgentService } from "./built-in-agents.js";

export function briefsService(db: Db) {
  const builtIns = builtInAgentService(db);

  return {
    async overview(companyId: string, options: { now?: Date } = {}): Promise<BriefsOverview> {
      const required = await builtIns.requireBuiltInAgent(companyId, "briefs");
      const now = options.now ?? new Date();
      const { agent, warning } = required;

      return {
        featureKey: "briefs",
        status: warning?.code === "built_in_agent_paused"
          ? "paused"
          : warning
            ? "unavailable"
            : "ready",
        generatedAt: now.toISOString(),
        agent: {
          id: agent.id,
          name: agent.name,
          status: agent.status,
          adapterType: agent.adapterType,
        },
        warning,
        summaryItems: [
          {
            label: "Agent",
            value: agent.name,
            detail: agent.status,
          },
          {
            label: "Adapter",
            value: agent.adapterType,
          },
          {
            label: "Last checked",
            value: now.toISOString(),
          },
        ],
      };
    },
  };
}
