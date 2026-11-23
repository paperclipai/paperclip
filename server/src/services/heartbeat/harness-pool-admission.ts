import { harnessPoolEnvironmentScope } from "./harness-pool-environment.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { agentTaskSessions, agentWakeupRequests, aiConnectionPools, aiConnectionTaskPins, agents, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { BUILTIN_AI_FAILOVER_ROUTER_KEY, decodeHarnessPoolConfig, harnessPoolBindingSchema, type HarnessPoolExecutionSelection, type AiConnectionRouterSelection } from "@paperclipai/shared";
import { parseObject } from "../../adapters/utils.js";
import { unprocessable } from "../../errors.js";
import { instanceSettingsService } from "../instance-settings.js";
import { aiConnectionRouterService, applyAiConnectionRouterTaskSettings } from "../ai-connection-router.js";
import { resolvePaperclipRunnerProviderProfile, type PaperclipRunnerProviderProfile } from "../native-runtime/provider-profile.js";
import { deriveTaskKeyWithHeartbeatFallback, shouldResetTaskSessionForWake } from "./run-state.js";
import { hasNativeLocalProcessStop } from "../native-local-process-stop.js";
import { readTaskRetryIntent } from "../task-retry.js";
import { readNativeReviewAssignmentContext } from "../native-runtime/native-review-participant.js";

/** A completion review resolves through the Paperclip Runner review tool, so it
 * gets its own pool pin instead of inheriting the reviewer's task pin. */
export function harnessPoolReviewTaskKey(interactionId: string) {
  return `native-review:${interactionId}`;
}

export type HarnessPoolAdmission = { kind: "selected"; selection: HarnessPoolExecutionSelection;
  routerSelection: AiConnectionRouterSelection; taskKey: string; profile?: PaperclipRunnerProviderProfile };

/** A stopped task's explicitly authorized fresh attempt can use a different
 * account. An ordinary wake still preserves affinity and the old receipts. */
async function switchFreshRetryQuotaPin(input: {
  db: Db; run: typeof heartbeatRuns.$inferSelect; agent: typeof agents.$inferSelect; userId: string | null;
  pin: typeof aiConnectionTaskPins.$inferSelect; environmentId: string; sourceAdapterConfig: Record<string, unknown>;
}): Promise<void> {
  const { db, run, agent, userId, pin, environmentId, sourceAdapterConfig } = input;
  const explicit = z.object({ commentId: z.null(), previousRunId: z.uuid(), taskRetryRequestId: z.uuid() })
    .safeParse(run.contextSnapshot?.explicitUserContinuation);
  if (!run.issueId || pin.taskKey !== run.issueId || run.contextSnapshot?.forceFreshSession !== true || !explicit.success) return;
  const issueId = run.issueId;
  const { previousRunId, taskRetryRequestId } = explicit.data;
  await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [task] = await tx.select().from(issues).where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId))).for("update");
    if (!task || task.assigneeAgentId !== agent.id || task.executionRunId !== run.id ||
        !["todo", "in_progress", "in_review"].includes(task.status)) return;
    const [queued] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId),
      eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.issueId, issueId), eq(heartbeatRuns.id, run.id),
      eq(heartbeatRuns.status, "queued"), isNull(heartbeatRuns.startedAt))).for("update");
    if (queued?.contextSnapshot?.forceFreshSession !== true ||
        !isDeepStrictEqual(queued.contextSnapshot.explicitUserContinuation, run.contextSnapshot?.explicitUserContinuation)) return;
    const [wake] = await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, run.companyId),
      eq(agentWakeupRequests.agentId, agent.id), eq(agentWakeupRequests.id, taskRetryRequestId), eq(agentWakeupRequests.runId, run.id),
      eq(agentWakeupRequests.reason, "task_retry"), eq(agentWakeupRequests.status, "coalesced"),
      eq(agentWakeupRequests.requestedByActorType, "user")));
    const retry = readTaskRetryIntent(wake?.payload);
    if (!wake || !retry || retry.generationId !== taskRetryRequestId || retry.sourceRunId !== previousRunId ||
        retry.strategy !== "fresh_isolated_workspace" || retry.actorId !== wake.requestedByActorId || wake.payload?.issueId !== issueId) return;
    const authority = { ...explicit.data, runId: run.id, actorId: retry.actorId };
    const [receipt] = await tx.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
      eq(issueRecoveryActions.status, "resolved"),
      sql`${issueRecoveryActions.evidence}->'explicitUserContinuation' @> ${JSON.stringify(authority)}::jsonb`,
    )).limit(1);
    if (!receipt && !Object.entries(authority).every(([key, value]) => parseObject(parseObject(wake.payload?.taskRetry).continuation)[key] === value)) return;
    const [source] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId),
      eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.issueId, issueId), eq(heartbeatRuns.id, previousRunId),
      eq(heartbeatRuns.status, "failed"), eq(heartbeatRuns.runtimeMode, "native"),
      eq(heartbeatRuns.errorCode, "native_provider_usage_limit")));
    if (!source?.finishedAt || source.contextSnapshot?.aiRouterTaskKey !== issueId ||
        !isDeepStrictEqual(source.contextSnapshot.aiRouterSelection, pin.selection) ||
        !await hasNativeLocalProcessStop(tx, run.companyId, source.id)) return;
    const [finalization] = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.issueId, issueId), eq(nativeRunFinalizations.runId, source.id))).for("update");
    if (finalization?.phase !== "terminal_failure" || finalization.leaseOwner ||
        finalization.failureCode !== "native_provider_usage_limit" ||
        finalization.failureDetail?.replacementDenied !== "explicit_user_continuation" || finalization.failureDetail.successorRunId) return;
    const [quota] = await tx.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, source.id),
      eq(heartbeatRunEvents.agentId, agent.id), eq(heartbeatRunEvents.eventType, "ai_connection.quota_attributed"),
      eq(heartbeatRunEvents.sourceEventId, `ai-connection-quota-attributed:${source.id}`), isNull(heartbeatRunEvents.sourceInstanceId),
    ));
    if (quota?.payload?.schema !== "paperclip.ai-connection-quota-attribution.v1" || quota.payload.runId !== source.id ||
        quota.payload.taskKey !== issueId || !isDeepStrictEqual(quota.payload.selection, pin.selection)) return;
    const router = aiConnectionRouterService(tx);
    if (!(await router.currentMemberCooldown({ companyId: run.companyId, agentId: agent.id, userId,
      adapterType: agent.adapterType, member: pin.member, failureKind: "quota", sourceAdapterConfig }))?.retryAt) return;
    await router.transitionQuotaPin({ companyId: run.companyId, poolId: pin.poolId, agentId: agent.id, taskKey: issueId,
      expectedSelection: pin.selection, userId, adapterType: agent.adapterType, attemptedMemberIds: [pin.member.id],
      environmentId, sourceAdapterConfig });
  });
}
export async function resolveHarnessPoolExecution(input: { db: Db; run: typeof heartbeatRuns.$inferSelect;
  agent: typeof agents.$inferSelect; userId: string | null }): Promise<HarnessPoolAdmission> {
  const { db, run, agent, userId } = input;
  const binding = harnessPoolBindingSchema.parse(agent.runtimeConfig.harnessPool);
  if (agent.adapterType !== "paperclip_runner" || !(await instanceSettingsService(db).getExperimental()).enableNativeRunner)
    throw unprocessable("Pool harness requires an enabled Paperclip Runner");
  if (!run.issueId || run.scopeKind !== "issue") throw unprocessable("Pool harness requires a task");
  if (agent.runtimeConfig.aiConnection || agent.adapterConfig.homeMode === "preconfigured")
    throw unprocessable("Pool harness owns its model account; remove conflicting connection settings");
  const [pool] = await db.select().from(aiConnectionPools).where(and(eq(aiConnectionPools.companyId, agent.companyId), eq(aiConnectionPools.id, binding.poolId)));
  if (!pool || pool.pluginKey !== BUILTIN_AI_FAILOVER_ROUTER_KEY || decodeHarnessPoolConfig(pool.config).kind !== "harness_pool")
    throw unprocessable("Choose an available harness pool");
  const context = parseObject(run.contextSnapshot);
  const review = readNativeReviewAssignmentContext(context);
  const taskKey = review ? harnessPoolReviewTaskKey(review.nativeReviewInteractionId)
    : typeof context.aiRouterTaskKey === "string" && context.aiRouterTaskKey.trim() ? context.aiRouterTaskKey : deriveTaskKeyWithHeartbeatFallback(context, null) ?? run.issueId;
  const [task] = await db.select().from(issues).where(and(eq(issues.companyId, agent.companyId), eq(issues.id, run.issueId)));
  const [existingPin] = await db.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.companyId, agent.companyId),
    eq(aiConnectionTaskPins.poolId, pool.id), eq(aiConnectionTaskPins.agentId, agent.id), eq(aiConnectionTaskPins.taskKey, taskKey)));
  const [session] = await db.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agent.id),
    eq(agentTaskSessions.adapterType, existingPin?.selection.adapterType ?? "paperclip_runner"), eq(agentTaskSessions.taskKey, taskKey))).limit(1);
  const identity = session?.sessionParamsJson?.paperclipAiCredentialIdentity;
  const overrides = parseObject(parseObject(task?.assigneeAdapterOverrides).adapterConfig);
  const environmentId = await harnessPoolEnvironmentScope(db, agent, task);
  const sourceAdapterConfig = { ...agent.adapterConfig, ...overrides };
  if (!review && existingPin) await switchFreshRetryQuotaPin({ db, run, agent, userId, pin: existingPin, environmentId, sourceAdapterConfig });
  const routerSelection = await aiConnectionRouterService(db).resolve({ companyId: agent.companyId, agentId: agent.id, poolId: pool.id,
    adapterType: "paperclip_runner", environmentId, userId, taskKey, sourceAdapterConfig, overrides,
    existingGrantId: typeof identity === "string" ? identity.split(":")[0] : undefined,
    requireExisting: Boolean(session?.sessionDisplayId) && !shouldResetTaskSessionForWake(context), skipUsageProbe: true,
    requirePaperclipRunner: review !== null });
  const decoded = decodeHarnessPoolConfig(pool.config);
  if (decoded.kind !== "harness_pool") throw unprocessable("Invalid harness pool");
  const [pin] = await db.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.companyId, agent.companyId),
    eq(aiConnectionTaskPins.poolId, pool.id), eq(aiConnectionTaskPins.agentId, agent.id), eq(aiConnectionTaskPins.taskKey, taskKey)));
  const pinned = pin?.member && decodeHarnessPoolConfig({ ...pool.config, members: [pin.member] });
  const memberSnapshot = pinned?.kind === "harness_pool" ? pinned.config.members[0] : undefined;
  if (!memberSnapshot) throw unprocessable("The selected pool member is unavailable");
  // A retained pin owns its historical model profile, including after pool edits.
  const profile = routerSelection.adapterType === "paperclip_runner" ? resolvePaperclipRunnerProviderProfile(applyAiConnectionRouterTaskSettings(agent.adapterConfig, routerSelection, "paperclip_runner")) : undefined;
  if (routerSelection.binding.mode === "responsible_user") throw unprocessable("Pool members require an explicit account");
  const admittedMember = { ...memberSnapshot, connection: routerSelection.binding, model: String(routerSelection.runtimeConfig.model),
    effort: typeof routerSelection.runtimeConfig.modelReasoningEffort === "string" ? routerSelection.runtimeConfig.modelReasoningEffort
      : typeof routerSelection.runtimeConfig.reasoningEffort === "string" ? routerSelection.runtimeConfig.reasoningEffort
      : typeof routerSelection.runtimeConfig.effort === "string" ? routerSelection.runtimeConfig.effort : undefined };
  const selection: HarnessPoolExecutionSelection = { schemaVersion: 2, poolId: pool.id, poolRevision: pool.revision, poolName: decoded.config.name,
    memberId: routerSelection.memberId, memberSnapshot: admittedMember,
    fingerprint: createHash("sha256").update(JSON.stringify([routerSelection.binding, routerSelection.runtimeConfig, profile, routerSelection.runnerScope, ...(routerSelection.adapterType !== "paperclip_runner" ? [routerSelection.adapterType] : [])])).digest("hex") };
  return { kind: "selected", selection, routerSelection, taskKey, profile };
}
