import { and, eq, inArray, ne } from "drizzle-orm";
import {
  agents,
  agentTaskSessions,
  connectionGrants,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import {
  defaultMigrationTargetForProvider,
  isAgentUsingCloudTrialInference,
  type MigrateCloudTrialAgentsInput,
  type MigrateCloudTrialAgentsResult,
  type MigratedCloudTrialAgentSummary,
} from "@paperclipai/shared";
import { badRequest, forbidden, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { AuthorizationActor } from "./authorization.js";
import { logActivity } from "./activity-log.js";
import { createAgentLifecycle } from "./agent-lifecycle.js";
import { connectionManagementService } from "./connection-management.js";
import { heartbeatService } from "./heartbeat.js";
import { publishLiveEvent } from "./live-events.js";
import { toolAccessService } from "./tool-access.js";
import { trackCloudPostHogEvent } from "../telemetry.js";
import { readJsonRecord, type CloudTrialKeyStore } from "./cloud-trial-key-store.js";
import {
  canActorConfigureTrialAgent,
  findLatestExhaustedTrialRun,
} from "./cloud-trial-status.js";

export interface CloudTrialMigrationActor {
  userId: string;
  actor?: AuthorizationActor;
}

/**
 * Migrates all (or selected) Cloud-trial agents in a company onto a newly
 * connected user subscription / API key:
 * 1. Verifies connection + grant belong to the company, are active, and are permitted.
 * 2. Verifies the caller has `agent_config:update` (or setup-draft creator) authority
 *    for every target trial agent.
 * 3. Ensures every target agent has an install for the selected connection via the
 *    existing connection service (creating authorized missing installs before mutating).
 * 4. Updates agent configuration through `createAgentLifecycle(db).updateConfiguration`,
 *    clears incompatible task sessions, and optionally resumes the latest blocked run.
 */
export async function migrateCloudTrialAgents(
  db: Db,
  companyId: string,
  input: MigrateCloudTrialAgentsInput,
  actorCtx: CloudTrialMigrationActor,
  keyStore: CloudTrialKeyStore,
): Promise<MigrateCloudTrialAgentsResult> {
  // 1. Verify the connection + grant belong to this company and are active.
  const [grantRow] = await db
    .select({
      connection: toolConnections,
      grant: connectionGrants,
    })
    .from(connectionGrants)
    .innerJoin(
      toolConnections,
      and(
        eq(toolConnections.id, connectionGrants.connectionId),
        eq(toolConnections.companyId, connectionGrants.companyId),
      ),
    )
    .where(
      and(
        eq(connectionGrants.companyId, companyId),
        eq(connectionGrants.id, input.grantId),
        eq(toolConnections.id, input.connectionId),
        eq(toolConnections.connectionPurpose, "ai"),
      ),
    )
    .limit(1);

  if (!grantRow) {
    throw notFound("Selected AI connection grant was not found for this company");
  }
  if (grantRow.grant.status !== "active" || !grantRow.connection.enabled) {
    throw badRequest("Selected AI connection is not active");
  }
  if (grantRow.grant.kind === "user" && grantRow.grant.subjectUserId !== actorCtx.userId) {
    throw forbidden("You cannot migrate agents onto another user's personal AI connection");
  }

  const companyAgents = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        ne(agents.status, "terminated"),
        ne(agents.status, "pending_approval"),
      ),
    );

  const requestedIds = input.agentIds ? new Set(input.agentIds) : null;
  const targets = companyAgents.filter((agent) => {
    if (!isAgentUsingCloudTrialInference(agent.runtimeConfig)) return false;
    if (requestedIds && !requestedIds.has(agent.id)) return false;
    return true;
  });

  // 2. Check per-agent configuration authority before making any mutation.
  if (actorCtx.actor) {
    for (const agent of targets) {
      const allowed = await canActorConfigureTrialAgent(db, actorCtx.actor, agent);
      if (!allowed) {
        throw forbidden("You do not have permission to update this agent's model configuration");
      }
    }
  }

  // 3. Check & add missing connection install access atomically under the
  // connection write lock so concurrent access changes are never overwritten.
  if (targets.length > 0) {
    const toolAccess = toolAccessService(db);
    const existingInstalls = await toolAccess.listConnectionInstalls(input.connectionId);
    const hasCompanyInstall = existingInstalls.some(
      (install) => install.targetType === "company" && install.targetId === companyId,
    );
    if (!hasCompanyInstall) {
      const installedAgentIds = new Set(
        existingInstalls
          .filter((install) => install.targetType === "agent")
          .map((install) => install.targetId),
      );
      const missingAgentIds = targets
        .map((agent) => agent.id)
        .filter((agentId) => !installedAgentIds.has(agentId));

      if (missingAgentIds.length > 0) {
        let managementContext = undefined;
        if (actorCtx.actor) {
          managementContext = await connectionManagementService(db).authorize(
            actorCtx.actor,
            "connections:configure",
            {
              type: "connection_management",
              companyId,
              connectionId: input.connectionId,
              purpose: "ai",
              operation: "POST /api/companies/:companyId/cloud-inference/migrate",
              selfServiceUserId:
                grantRow.grant.kind === "user" ? grantRow.grant.subjectUserId : null,
              selfServiceAgentInstalls: true,
            },
            { targetAgentIds: missingAgentIds },
          );
        }
        await toolAccess.ensureAgentConnectionInstalls(
          input.connectionId,
          missingAgentIds,
          {
            actorType: "user",
            actorId: actorCtx.userId,
            responsibleUserId: actorCtx.userId,
            ...(managementContext ? { managementContext } : {}),
          },
        );
      }
    }
  }

  const targetSpec = defaultMigrationTargetForProvider(
    input.provider,
    input.method,
    input.model,
    keyStore.configuredMigrationTargets(),
  );
  const binding = {
    provider: input.provider,
    method: input.method,
    mode: input.ownership === "shared" ? ("shared" as const) : ("delegated" as const),
    connectionId: input.connectionId,
    grantId: input.grantId,
  };

  // 4. Update each target agent through the agent-lifecycle module boundary.
  const lifecycle = createAgentLifecycle(db);
  const migrated: MigratedCloudTrialAgentSummary[] = [];
  const migratedAgentIds: string[] = [];

  for (const agent of targets) {
    const currentAdapterConfig = readJsonRecord(agent.adapterConfig);
    const nextAdapterConfig: Record<string, unknown> = {
      ...currentAdapterConfig,
      model: targetSpec.model,
    };
    if (targetSpec.runnerProvider) {
      nextAdapterConfig.provider = targetSpec.runnerProvider;
    } else {
      delete nextAdapterConfig.provider;
    }
    if (targetSpec.acpxAgent) {
      nextAdapterConfig.acpxAgent = targetSpec.acpxAgent;
    } else {
      delete nextAdapterConfig.acpxAgent;
    }

    const currentRuntimeConfig = readJsonRecord(agent.runtimeConfig);
    const nextRuntimeConfig: Record<string, unknown> = {
      ...currentRuntimeConfig,
      aiConnection: binding,
    };
    delete nextRuntimeConfig.cloudTrialInference;

    await lifecycle.updateConfiguration(agent.id, {
      adapterType: targetSpec.adapterType,
      adapterConfig: nextAdapterConfig,
      runtimeConfig: nextRuntimeConfig,
    });

    migratedAgentIds.push(agent.id);
    migrated.push({
      agentId: agent.id,
      name: agent.name,
      adapterType: targetSpec.adapterType,
      ...(targetSpec.runnerProvider ? { runnerProvider: targetSpec.runnerProvider } : {}),
      ...(targetSpec.acpxAgent ? { acpxAgent: targetSpec.acpxAgent } : {}),
      model: targetSpec.model,
    });
  }

  if (migratedAgentIds.length > 0) {
    // Reset incompatible provider task sessions so resumed work starts fresh on the new harness.
    await db
      .delete(agentTaskSessions)
      .where(
        and(
          eq(agentTaskSessions.companyId, companyId),
          inArray(agentTaskSessions.agentId, migratedAgentIds),
        ),
      );

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorCtx.userId,
      action: "cloud_trial.agents_migrated",
      entityType: "company",
      entityId: companyId,
      details: {
        provider: input.provider,
        method: input.method,
        connectionId: input.connectionId,
        migratedAgentIds,
        targetAdapterType: targetSpec.adapterType,
        targetRunnerProvider: targetSpec.runnerProvider ?? null,
        targetAcpxAgent: targetSpec.acpxAgent ?? null,
        targetModel: targetSpec.model,
      },
    });
  }

  // Resume the most recent blocked turn/issue if requested (only when latest run was exhausted).
  const resumedRunIds: string[] = [];
  let resumedIssueId: string | null = null;
  if (input.resumeBlockedWork && migratedAgentIds.length > 0) {
    const blocked = await findLatestExhaustedTrialRun(db, companyId, migratedAgentIds);
    if (blocked) {
      resumedIssueId = blocked.issueId;
      try {
        const woke = await heartbeatService(db).wakeup(blocked.agentId, {
          source: "on_demand",
          triggerDetail: "manual",
          reason: "cloud_trial_migrated_resume",
          requestedByActorType: "user",
          requestedByActorId: actorCtx.userId,
          payload: resumedIssueId ? { issueId: resumedIssueId } : undefined,
          contextSnapshot: {
            ...(resumedIssueId ? { issueId: resumedIssueId, taskId: resumedIssueId } : {}),
            wakeReason: "cloud_trial_migrated_resume",
            source: "cloud_trial_migration",
          },
        });
        if (woke?.id) {
          resumedRunIds.push(woke.id);
        }
      } catch (err) {
        logger.warn(
          { err, companyId, agentId: blocked.agentId, issueId: resumedIssueId },
          "Migrated trial agents succeeded, but auto-resuming the blocked run failed",
        );
      }
    }
  }

  publishLiveEvent({
    companyId,
    type: "cloud_trial.status.updated",
    payload: {
      status: "migrated",
      migratedCount: migrated.length,
      provider: input.provider,
      resumedRunIds,
      resumedIssueId,
    },
  });

  const exhaustedAtMs = keyStore.getExhaustedAtMs();
  const secondsSinceExhausted =
    exhaustedAtMs !== null
      ? Math.max(0, Math.round((keyStore.now() - exhaustedAtMs) / 1000))
      : undefined;
  trackCloudPostHogEvent(
    "cloud_trial.migrated",
    {
      provider: input.provider,
      auth_method: input.method,
      ownership: input.ownership,
      migrated_agent_count: migrated.length,
      resumed_run_count: resumedRunIds.length,
      target_adapter_type: targetSpec.adapterType,
      target_model: targetSpec.model,
      ...(secondsSinceExhausted !== undefined
        ? { seconds_since_exhausted: secondsSinceExhausted }
        : {}),
    },
    { userId: actorCtx.userId, companyId },
  );

  return {
    migratedCount: migrated.length,
    agents: migrated,
    resumedRunIds,
    resumedIssueId,
  };
}
