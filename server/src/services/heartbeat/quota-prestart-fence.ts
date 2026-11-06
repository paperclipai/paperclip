import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { agentTaskSessions, agentWakeupRequests, agents, aiConnectionTaskPins, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { aiConnectionRouterService } from "../ai-connection-router.js";
import { conflict } from "../../errors.js";
import { cancellationRequestId } from "../native-runtime/native-cancellation-request.js";
import { poolFailureKind } from "./pool-failover.js";

const KEY = "legacyQuotaPrestartFence";

/** Called only from a first durable queue claim, before run preparation. */
export function legacyQuotaFenceForFirstClaim(agent: { adapterType: string; runtimeConfig: unknown }, run: {
  id: string; companyId: string; agentId: string; startedAt: Date | null; runnerProfileJson: Record<string, unknown> | null;
}): Record<string, unknown> {
  const config = agent.runtimeConfig && typeof agent.runtimeConfig === "object" && !Array.isArray(agent.runtimeConfig)
    ? agent.runtimeConfig as Record<string, unknown> : {};
  const binding = config.aiConnection && typeof config.aiConnection === "object" && !Array.isArray(config.aiConnection)
    ? config.aiConnection as Record<string, unknown> : {};
  if (agent.adapterType !== "claude_local" || binding.mode !== "router" || run.startedAt !== null ||
      (run.runnerProfileJson && Object.hasOwn(run.runnerProfileJson, KEY))) return {};
  return { [KEY]: { schema: "paperclip.legacy-quota-prestart.v1", companyId: run.companyId,
    agentId: run.agentId, runId: run.id, state: "preparing" } };
}

/** Consume before any provider-capable preparation. Old runs remain unproven.
 * This state alone is never a provider-stop, action-outcome, or handoff proof. */
export async function consumeLegacyQuotaPrestartFence(db: Db, run: { id: string; companyId: string; agentId: string }): Promise<void> {
  await db.transaction(async tx => {
    const [current] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run.id),
      eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId))).for("update");
    const profile = current?.runnerProfileJson;
    const raw = profile?.[KEY];
    if (!raw) return;
    if (!current || current.status !== "running" || typeof raw !== "object" || Array.isArray(raw) ||
        (raw as Record<string, unknown>).schema !== "paperclip.legacy-quota-prestart.v1" ||
        (raw as Record<string, unknown>).companyId !== run.companyId || (raw as Record<string, unknown>).agentId !== run.agentId ||
        (raw as Record<string, unknown>).runId !== run.id || !["preparing", "consumed"].includes(String((raw as Record<string, unknown>).state)))
      throw new Error("legacy_quota_prestart_fence_invalid");
    if ((raw as Record<string, unknown>).state === "consumed") return;
    await tx.update(heartbeatRuns).set({ runnerProfileJson: { ...profile, [KEY]: { ...raw, state: "consumed" } }, updatedAt: new Date() })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.status, "running")));
  });
}

/** Caller holds issue and run locks and inserts the successor in this transaction. */
export async function switchUnstartedLegacyQuotaPin(tx: Db, input: { companyId: string; runId: string; issueId: string; agentId: string; userId: string | null }) {
  const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId)));
  const [issue] = await tx.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  const [agent] = await tx.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId))).for("share");
  const fence = run?.runnerProfileJson?.[KEY] as Record<string, unknown> | undefined;
  const recovery = run?.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  const cancellation = run?.resultJson?.cancellation as Record<string, unknown> | undefined;
  const bindingValue = agent?.runtimeConfig?.aiConnection;
  const binding = bindingValue && typeof bindingValue === "object" && !Array.isArray(bindingValue)
    ? bindingValue as Record<string, unknown> : {};
  const poolId = typeof binding.connectionId === "string" ? binding.connectionId : null;
  if (!run || !issue || !agent || agent.adapterType !== "claude_local" || agent.status === "paused" || agent.status === "terminated" ||
      binding.mode !== "router" || !poolId || run.scopeKind !== "issue" || run.issueId !== input.issueId ||
      run.status !== "cancelled" || run.errorCode !== "ai_connection_pool_exhausted" || !run.finishedAt || !run.startedAt ||
      run.processPid || run.processGroupId || run.processStartedAt || run.sessionIdBefore || run.sessionIdAfter || run.runtimeModeResolvedAt ||
      run.contextSnapshot?.resumeSessionParams != null || run.contextSnapshot?.resumeSessionDisplayId != null ||
      run.contextSnapshot?.executionContinuation != null || run.contextSnapshot?.paperclipContinuationSummary != null ||
      run.contextSnapshot?.previousRunId != null ||
      recovery?.kind !== "ai_connection_wait" || recovery.providerWorkStarted !== false ||
      cancellation?.source !== "control_plane" || cancellation.reason !== "Waiting for an AI connection pool account" ||
      run.resultJson?.executionCancellation != null || run.resultJson?.startupCancellation != null || run.resultJson?.legacyQuotaStopRequested != null ||
      fence?.schema !== "paperclip.legacy-quota-prestart.v1" || fence.state !== "preparing" || fence.runId !== run.id ||
      fence.companyId !== run.companyId || fence.agentId !== run.agentId ||
      issue.executionRunId !== run.id || issue.assigneeAgentId !== run.agentId || issue.assigneeUserId ||
      !["todo", "in_progress", "in_review"].includes(issue.status) || run.contextSnapshot?.aiRouterTaskKey !== issue.id) return null;
  const aliases = [issue.id, ...(issue.identifier ? [issue.identifier] : [])];
  const [other] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).leftJoin(agentWakeupRequests,
    and(eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId), eq(agentWakeupRequests.companyId, heartbeatRuns.companyId)))
    .where(and(eq(heartbeatRuns.companyId, input.companyId), ne(heartbeatRuns.id, run.id), or(
      eq(heartbeatRuns.issueId, issue.id), eq(heartbeatRuns.nativeIssueId, issue.id),
      ...["issueId", "taskId", "taskKey"].flatMap(key => aliases.flatMap(alias => [
        sql`${heartbeatRuns.contextSnapshot}->>${key} = ${alias}`, sql`${agentWakeupRequests.payload}->>${key} = ${alias}`,
      ])),
    ))).limit(1);
  const [session] = await tx.select({ id: agentTaskSessions.id }).from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, input.companyId),
    inArray(agentTaskSessions.taskKey, [issue.id, ...(issue.identifier ? [issue.identifier] : [])]))).limit(1);
  if (other || session) return null;
  const [pin] = await tx.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.companyId, input.companyId),
    eq(aiConnectionTaskPins.poolId, poolId), eq(aiConnectionTaskPins.agentId, input.agentId), eq(aiConnectionTaskPins.taskKey, issue.id))).limit(1);
  if (!pin || pin.createdAt < run.startedAt || pin.createdAt > run.finishedAt) return null;
  const result = await aiConnectionRouterService(tx).transitionQuotaPin({ companyId: input.companyId, poolId,
    agentId: input.agentId, taskKey: issue.id, expectedSelection: pin.selection, userId: input.userId,
    adapterType: "claude_local", attemptedMemberIds: [pin.member.id] });
  return result.kind === "selected" ? result.selection : null;
}

/** Serialize user Stop with a not-yet-started pool retry. */
export function isLegacyQuotaPrestartStopCandidate(run: typeof heartbeatRuns.$inferSelect): boolean {
  if (run.runtimeMode !== "native" && run.issueId && poolFailureKind(run)) return true;
  const fence = run.runnerProfileJson?.[KEY] as Record<string, unknown> | undefined;
  const recovery = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  return run.status === "cancelled" && run.errorCode === "ai_connection_pool_exhausted" && Boolean(run.issueId) &&
    fence?.schema === "paperclip.legacy-quota-prestart.v1" && fence.state === "preparing" && fence.runId === run.id &&
    fence.companyId === run.companyId && fence.agentId === run.agentId && recovery?.kind === "ai_connection_wait" && recovery.providerWorkStarted === false;
}

export async function fenceLegacyQuotaPrestartStop(db: Db, input: { companyId: string; runId: string; issueId: string; requestId?: string; userId?: string | null }) {
  const requestId = cancellationRequestId(input.requestId);
  const userId = input.userId ?? null;
  return db.transaction(async tx => {
    await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.issueId, input.issueId))).for("update");
    if (!run || !isLegacyQuotaPrestartStopCandidate(run)) return null;
    const previous = run.resultJson?.legacyQuotaStopRequested as Record<string, unknown> | undefined;
    const attempts = previous && Array.isArray(previous.attempts) ? previous.attempts as Array<Record<string, unknown>>
      : previous ? [{ requestId: previous.requestId, userId: previous.userId, requestedAt: previous.requestedAt }] : [];
    const knownAttempt = attempts.some(attempt => attempt.requestId === (requestId ?? null) && attempt.userId === userId);
    if (requestId && attempts.some(attempt => attempt.requestId === requestId && attempt.userId !== userId))
      throw conflict("Cancellation request belongs to another actor or conflicts with an earlier Stop");
    if (previous && !knownAttempt && previous.acknowledgedAt != null)
      throw conflict("Cancellation request belongs to another actor or conflicts with an earlier Stop");
    const [successor] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId),
      eq(heartbeatRuns.retryOfRunId, run.id), eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.issueId, input.issueId))).limit(1);
    const now = new Date().toISOString();
    const nextAttempts = knownAttempt ? attempts : [...attempts, { requestId: requestId ?? null, userId, requestedAt: now }];
    const stop = previous ? { ...previous, attempts: nextAttempts, ...(!successor ? { acknowledgedAt: previous.acknowledgedAt ?? now } : {}) }
      : { requestedAt: now, requestId: requestId ?? null, userId, attempts: nextAttempts, ...(successor ? {} : { acknowledgedAt: now }) };
    await tx.update(heartbeatRuns).set({ resultJson: { ...run.resultJson, legacyQuotaStopRequested: stop }, updatedAt: new Date() })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)));
    if (successor) return { kind: "successor" as const, run: successor };
    return { kind: "fenced" as const };
  });
}

export async function acknowledgeLegacyQuotaPrestartStop(db: Db, input: { companyId: string; runId: string; requestId?: string; userId?: string | null }) {
  const requestId = cancellationRequestId(input.requestId), userId = input.userId ?? null;
  await db.transaction(async tx => {
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).for("update");
    const stop = run?.resultJson?.legacyQuotaStopRequested as Record<string, unknown> | undefined;
    const attempts = stop && Array.isArray(stop.attempts) ? stop.attempts as Array<Record<string, unknown>>
      : stop ? [{ requestId: stop.requestId, userId: stop.userId }] : [];
    if (!run || !stop || !attempts.some(attempt => attempt.requestId === (requestId ?? null) && attempt.userId === userId))
      throw conflict("Cancellation request changed before acknowledgement");
    await tx.update(heartbeatRuns).set({ resultJson: { ...run.resultJson, legacyQuotaStopRequested: { ...stop, acknowledgedAt: new Date().toISOString() } }, updatedAt: new Date() })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)));
  });
}
