import { and, desc, eq, inArray, ne } from "drizzle-orm";
import {
  agents,
  heartbeatRuns,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import {
  CLOUD_TRIAL_EXHAUSTED_ERROR_CODE,
  isAgentUsingCloudTrialInference,
  type CloudTrialBlockedRunSummary,
  type CloudTrialInferenceState,
  type CloudTrialInferenceStatus,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { accessService } from "./access.js";
import type { AuthorizationActor } from "./authorization.js";
import { isAgentSetupDraft } from "../modules/agent-lifecycle/index.js";
import { instanceSettingsService } from "./instance-settings.js";
import type { CloudTrialKeyStore } from "./cloud-trial-key-store.js";

const EXHAUSTION_ERROR_CODES = new Set([
  CLOUD_TRIAL_EXHAUSTED_ERROR_CODE,
  "native_provider_usage_limit",
]);

export interface TrialAgentCandidate {
  id: string;
  companyId: string;
  createdByUserId?: string | null;
  lifecycleState?: string;
  pauseReason?: string | null;
}

/**
 * Mirrors `assertCanConfigureAgentSetup` in `routes/agents.ts`:
 * requires `agent_config:update` on the target agent, or setup-draft creator
 * authority (`agents:create` + `createdByUserId === actor.userId` + draft state).
 */
export async function canActorConfigureTrialAgent(
  db: Db,
  actor: AuthorizationActor,
  targetAgent: TrialAgentCandidate,
): Promise<boolean> {
  if (actor.type !== "board" || !actor.userId) return false;
  if (actor.isInstanceAdmin) return true;
  const access = accessService(db);
  if (targetAgent.createdByUserId === actor.userId && isAgentSetupDraft(targetAgent)) {
    const createDecision = await access.decide({
      actor,
      action: "agents:create",
      resource: { type: "company", companyId: targetAgent.companyId },
    });
    if (createDecision.allowed) return true;
  }
  const updateDecision = await access.decide({
    actor,
    action: "agent_config:update",
    resource: { type: "agent", companyId: targetAgent.companyId, agentId: targetAgent.id },
  });
  return updateDecision.allowed;
}

/**
 * Enforces server-side eligibility before any route permits setting
 * `runtimeConfig.cloudTrialInference: true`: the instance flag must be
 * enabled and the company must not already have an active AI connection.
 */
export async function assertCloudTrialInferenceEligible(
  db: Db,
  companyId: string,
): Promise<void> {
  const experimental = await instanceSettingsService(db).getExperimental();
  if (!experimental.enableCloudTrialInference) {
    throw unprocessable("Cloud starter inference is not enabled on this instance.", {
      code: "cloud_trial_disabled",
    });
  }
  const [existingAiConnection] = await db
    .select({ id: toolConnections.id })
    .from(toolConnections)
    .where(
      and(
        eq(toolConnections.companyId, companyId),
        eq(toolConnections.connectionPurpose, "ai"),
        eq(toolConnections.enabled, true),
        eq(toolConnections.status, "active"),
      ),
    )
    .limit(1);
  if (existingAiConnection) {
    throw unprocessable(
      "Cloud starter inference is only available before a model provider is connected.",
      { code: "cloud_trial_ineligible_existing_connection" },
    );
  }
}

/**
 * Finds the most recent blocked trial run ONLY among agents whose *latest* run
 * ended with a trial exhaustion error. Once credits are restored or a newer
 * run succeeds, older historical failures no longer pin the blocking modal.
 */
export async function findLatestExhaustedTrialRun(
  db: Db,
  companyId: string,
  trialAgentIds: string[],
): Promise<CloudTrialBlockedRunSummary | null> {
  if (trialAgentIds.length === 0) return null;

  const recentRuns = await db
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      issueId: heartbeatRuns.issueId,
      nativeIssueId: heartbeatRuns.nativeIssueId,
      errorCode: heartbeatRuns.errorCode,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.agentId, trialAgentIds),
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(Math.max(trialAgentIds.length * 4, 20));

  const seenAgents = new Set<string>();
  for (const run of recentRuns) {
    if (seenAgents.has(run.agentId)) continue;
    seenAgents.add(run.agentId);
    if (run.errorCode && EXHAUSTION_ERROR_CODES.has(run.errorCode)) {
      return {
        runId: run.id,
        agentId: run.agentId,
        issueId: run.nativeIssueId ?? run.issueId ?? null,
        failedAt: (run.finishedAt ?? run.createdAt).toISOString(),
      };
    }
  }
  return null;
}

export async function getCompanyCloudTrialStatus(
  db: Db,
  companyId: string,
  keyStore: CloudTrialKeyStore,
  options: { refreshUsage?: boolean; actor?: AuthorizationActor } = {},
): Promise<CloudTrialInferenceStatus> {
  const experimental = await instanceSettingsService(db).getExperimental();
  const enabled = experimental.enableCloudTrialInference === true;

  const companyAgents = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      role: agents.role,
      title: agents.title,
      runtimeConfig: agents.runtimeConfig,
      createdByUserId: agents.createdByUserId,
      lifecycleState: agents.lifecycleState,
      pauseReason: agents.pauseReason,
    })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        ne(agents.status, "terminated"),
        ne(agents.status, "pending_approval"),
      ),
    );

  const trialAgentRows = companyAgents.filter((a) => isAgentUsingCloudTrialInference(a.runtimeConfig));
  const trialAgents = trialAgentRows.map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    title: a.title,
  }));
  const trialAgentIds = trialAgents.map((a) => a.id);

  let canMigrate = true;
  if (options.actor) {
    if (options.actor.type !== "board" || !options.actor.userId) {
      canMigrate = false;
    } else if (!options.actor.isInstanceAdmin) {
      const membership = options.actor.memberships?.find(
        (m) => m.companyId === companyId && m.status === "active",
      );
      if (membership?.membershipRole === "viewer") {
        canMigrate = false;
      } else if (trialAgentRows.length > 0) {
        const checks = await Promise.all(
          trialAgentRows.map((agent) => canActorConfigureTrialAgent(db, options.actor!, agent)),
        );
        canMigrate = checks.every(Boolean);
      } else {
        const decision = await accessService(db).decide({
          actor: options.actor,
          action: "agent_config:update",
          resource: { type: "company", companyId },
        });
        canMigrate = decision.allowed;
      }
    }
  }

  const blockedRun = await findLatestExhaustedTrialRun(db, companyId, trialAgentIds);

  if (!enabled) {
    return {
      enabled: false,
      provider: "openrouter",
      status: "unavailable",
      reason: "feature_disabled",
      limitUsdCents: 0,
      spentUsdCents: 0,
      remainingUsdCents: 0,
      defaultModel: keyStore.configuredDefaultModel(),
      canMigrate,
      trialAgentIds,
      trialAgents,
      blockedRun,
    };
  }

  let state = keyStore.getCached();
  if (!state || options.refreshUsage) {
    try {
      state = await keyStore.fetchKeyFromCloudOrLocal(Boolean(options.refreshUsage));
      if (options.refreshUsage && state.status === "active") {
        await keyStore.probeOpenRouterUsage(companyId, true);
        state = keyStore.getCached() ?? state;
      }
    } catch (err) {
      logger.warn({ err, companyId }, "Failed to fetch Cloud trial inference status");
      state = {
        status: "unavailable",
        reason: "cloud_unavailable",
        apiKey: null,
        limitUsdCents: 0,
        spentUsdCents: 0,
        remainingUsdCents: 0,
        defaultModel: keyStore.configuredDefaultModel(),
        fetchedAtMs: keyStore.now(),
        lastUsageProbeAtMs: 0,
      };
    }
  }

  // If the user already migrated every trial agent to their own subscription, report migrated.
  const effectiveStatus: CloudTrialInferenceState =
    state.status === "exhausted" && trialAgentIds.length === 0 && companyAgents.length > 0
      ? "migrated"
      : blockedRun && state.status === "active"
        ? "exhausted"
        : state.status;

  return {
    enabled: true,
    provider: "openrouter",
    status: effectiveStatus,
    ...(state.reason ? { reason: state.reason } : {}),
    limitUsdCents: state.limitUsdCents,
    spentUsdCents: state.spentUsdCents,
    remainingUsdCents: effectiveStatus === "exhausted" ? 0 : state.remainingUsdCents,
    defaultModel: state.defaultModel,
    canMigrate,
    trialAgentIds,
    trialAgents,
    blockedRun,
  };
}
