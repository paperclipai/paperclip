import type { ActorInfo } from "../types.js";
import { isRemoteMcpConnectorMethod } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueThreadInteractions, toolConnectionInstalls, toolConnections } from "@paperclipai/db";
import type { ConnectToolAppResult, FinishToolApp, ToolCatalogEntry } from "@paperclipai/shared";

import type { FinishConnectionSetup } from "../catalog/contracts.js";
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

export function createOAuthCatalogCompletion(db: Db, finishGalleryAppConnection: FinishConnectionSetup) {
  async function finishOAuthCatalogWithRecommendedDefaults(input: {
    connection: typeof toolConnections.$inferSelect;
    catalog: ToolCatalogEntry[];
    suggestedDefaults: ConnectToolAppResult["suggestedDefaults"];
    activateQuarantined?: boolean;
    actor?: ActorInfo;
    interactionId?: string | null;
  }) {
    const linkedInteraction = input.interactionId
      ? await db
          .select({ kind: issueThreadInteractions.kind })
          .from(issueThreadInteractions)
          .where(
            and(
              eq(issueThreadInteractions.id, input.interactionId),
              eq(issueThreadInteractions.companyId, input.connection.companyId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;
    // A task callback only prepares the catalog. The intent completion transaction
    // validates current ownership and adds the requesting agent's access.
    const deferTaskAccess = linkedInteraction?.kind === "connection_intent";
    const installs = await db
      .select()
      .from(toolConnectionInstalls)
      .where(
        and(
          eq(toolConnectionInstalls.companyId, input.connection.companyId),
          eq(toolConnectionInstalls.connectionId, input.connection.id),
        ),
      );
    const companyInstall = installs.some(
      (install) => install.targetType === "company",
    );
    const agentIds = installs
      .filter((install) => install.targetType === "agent")
      .map((install) => install.targetId);
    const suggestedAccess = input.suggestedDefaults.access;
    const suggestedAccessRecord = asRecord(suggestedAccess);
    const suggestedAgentIds = Array.isArray(suggestedAccessRecord.agentIds)
      ? suggestedAccessRecord.agentIds.filter(
          (agentId): agentId is string => typeof agentId === "string",
        )
      : [];
    const normalizedSuggestedAccess: FinishToolApp["access"] =
      suggestedAccess === "all_agents"
        ? "all_agents"
        : suggestedAgentIds.length > 0
          ? { agentIds: suggestedAgentIds }
          : "all_agents";
    // Workspace setup saves the operator's install selection before OAuth too.
    // An empty selection means no agents, not permission to apply all-agent
    // defaults after the user returns from Google.
    const preserveEmptyInstalls = input.connection.config.sourceTemplateKey === "google-workspace"
      || isRemoteMcpConnectorMethod(
      input.connection.config.sourceTemplateKey,
      input.connection.config.connectionMethodKey,
    ) || (input.connection.transport === "mcp_remote"
      && input.connection.config.mcpAgentAccessConfigured === true);
    const access: FinishToolApp["access"] = deferTaskAccess
      ? { agentIds: [] }
      : installs.length === 0
        ? preserveEmptyInstalls ? { agentIds: [] } : normalizedSuggestedAccess
        : companyInstall
          ? "all_agents"
          : { agentIds };
    const askFirstRiskLevels = new Set(
      Array.isArray(input.suggestedDefaults.askFirstRiskLevels)
        ? input.suggestedDefaults.askFirstRiskLevels.filter(
            (riskLevel): riskLevel is string => typeof riskLevel === "string",
          )
        : [],
    );
    const enabledCatalog = input.catalog.filter(
      (entry) =>
        entry.status === "active" ||
        (input.activateQuarantined === true && entry.status === "quarantined"),
    );
    const finished = await finishGalleryAppConnection(
      input.connection.companyId,
      input.connection.id,
      {
        enabledCatalogEntryIds: enabledCatalog.map((entry) => entry.id),
        askFirstCatalogEntryIds: enabledCatalog
          .filter((entry) => askFirstRiskLevels.has(entry.riskLevel))
          .map((entry) => entry.id),
        reviewedCatalogEntryIds:
          input.activateQuarantined === true
            ? enabledCatalog
                .filter((entry) => entry.status === "quarantined")
                .map((entry) => entry.id)
            : undefined,
        access,
        preserveExistingAccess: deferTaskAccess,
      },
      input.actor,
    );
    if (!deferTaskAccess && !preserveEmptyInstalls && installs.length === 0) {
      const installTargets =
        access === "all_agents"
          ? [
              {
                targetType: "company" as const,
                targetId: input.connection.companyId,
              },
            ]
          : [...new Set(access.agentIds)].map((agentId) => ({
              targetType: "agent" as const,
              targetId: agentId,
            }));
      if (installTargets.length > 0) {
        await db
          .insert(toolConnectionInstalls)
          .values(
            installTargets.map((target) => ({
              companyId: input.connection.companyId,
              connectionId: input.connection.id,
              ...target,
              createdByAgentId:
                input.actor?.actorType === "agent"
                  ? (input.actor.actorId ?? null)
                  : null,
              createdByUserId:
                input.actor?.actorType === "user"
                  ? (input.actor.actorId ?? null)
                  : null,
            })),
          )
          .onConflictDoNothing();
      }
    }
    return finished;
  }
  return finishOAuthCatalogWithRecommendedDefaults;
}
export type OAuthCatalogCompletion = ReturnType<typeof createOAuthCatalogCompletion>;
