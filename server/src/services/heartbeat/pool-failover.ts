import { and, eq, isNull } from "drizzle-orm";
import { agents, heartbeatRunEvents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { readProviderFailure, type AiConnectionRouterSelection } from "@paperclipai/shared";
import { isDeepStrictEqual } from "node:util";
import { parseObject } from "../../adapters/utils.js";
import { aiConnectionRouterService } from "../ai-connection-router.js";
import { hasConversationContinuationPolicy } from "../conversation-continuation.js";
import { hasRequiredWorkspaceRecovery } from "../workspace-restore-recovery-state.js";

type Run = typeof heartbeatRuns.$inferSelect;
export type PoolFailureKind = "quota" | "auth" | "runner";
export const POOL_ACCOUNT_DEFAULT_COOLDOWN_MS = 2 * 60 * 60_000;

export function poolFailureKind(run: Pick<Run, "status" | "errorCode" | "resultJson" | "contextSnapshot"> & Partial<Pick<Run, "runnerProfileJson">>): PoolFailureKind | null {
  if (run.status !== "failed" || !parseObject(run.contextSnapshot?.aiRouterSelection).poolId) return null;
  const family = run.resultJson?.errorFamily;
  const failure = readProviderFailure(run.resultJson?.providerFailure);
  if (family === "provider_quota" || run.errorCode === "provider_quota" || failure?.category === "quota_exhausted") return "quota";
  if (["refresh_token_reused", "refresh_token_expired", "refresh_token_invalidated"].includes(String(family)) ||
      ["claude_auth_required", "codex_auth_required", "codex_auth_missing"].includes(String(run.errorCode)) ||
      (parseObject(run.resultJson?.configurationIncomplete).reason === "ai_connection_unavailable" &&
        parseObject(parseObject(run.runnerProfileJson?.adapterDispatch).poolPreparationFailure).kind === "configuration") ||
      failure?.category === "authentication") return "auth";
  if (["codex_harness_crash", "process_lost", "adapter_engine_unavailable"].includes(String(run.errorCode))) return "runner";
  return null;
}

export function hasSettledPoolContinuation(run: Run): boolean {
  const settlement = parseObject(run.resultJson?.executionSettlement);
  const bootstrap = parseObject(run.resultJson?.executionRecovery);
  return run.runtimeMode !== "native" && hasConversationContinuationPolicy(run.resultJson) &&
    !hasRequiredWorkspaceRecovery(run.resultJson) && !run.resultJson?.legacyQuotaStopRequested &&
    !run.resultJson?.executionCancellation && !run.resultJson?.startupCancellation &&
    ((settlement.providerStopped === true && settlement.workspaceSettled === true) ||
      (bootstrap.kind === "bootstrap" && bootstrap.providerWorkStarted === false));
}

/** The retry owner holds the issue and source run locks and creates the successor
 * in this transaction. This switches conversation context, never tool requests. */
export async function switchFailedPoolPin(db: Db, input: {
  run: Run; agent: typeof agents.$inferSelect; userId: string | null;
}) {
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.run.id),
    eq(heartbeatRuns.companyId, input.run.companyId), eq(heartbeatRuns.agentId, input.agent.id)));
  const kind = run && poolFailureKind(run);
  if (!run || !kind || !hasSettledPoolContinuation(run) || run.scopeKind !== "issue" || !run.issueId) return null;
  const [task] = await db.select().from(issues).where(and(eq(issues.companyId, run.companyId), eq(issues.id, run.issueId)));
  const [agent] = await db.select().from(agents).where(and(eq(agents.companyId, run.companyId), eq(agents.id, run.agentId))).for("share");
  if (!task || !agent || ["paused", "terminated"].includes(agent.status) || task.assigneeAgentId !== run.agentId ||
      !["todo", "in_progress", "in_review"].includes(task.status) ||
      (task.executionRunId && task.executionRunId !== run.id) || (task.checkoutRunId && task.checkoutRunId !== run.id)) return null;
  const context = parseObject(run.contextSnapshot);
  const selection = context.aiRouterSelection as AiConnectionRouterSelection;
  const configured = parseObject(agent.runtimeConfig?.aiConnection);
  if (configured.mode !== "router" || configured.connectionId !== selection.poolId || context.aiRouterTaskKey !== run.issueId) return null;
  const bootstrap = parseObject(run.resultJson?.executionRecovery);
  const admissionAuthFailure = kind === "auth" && bootstrap.kind === "bootstrap" && bootstrap.providerWorkStarted === false &&
    parseObject(run.resultJson?.configurationIncomplete).reason === "ai_connection_unavailable";
  if (!admissionAuthFailure) {
    const [receipt] = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, run.companyId),
      eq(heartbeatRunEvents.runId, run.id), eq(heartbeatRunEvents.agentId, run.agentId),
      eq(heartbeatRunEvents.eventType, `ai_connection.${kind}_attributed`), isNull(heartbeatRunEvents.sourceInstanceId),
      eq(heartbeatRunEvents.sourceEventId, `ai-connection-${kind}-attributed:${run.id}`)));
    const proof = parseObject(receipt?.payload);
    if (proof.schema !== `paperclip.ai-connection-${kind}-attribution.v1` || proof.taskKey !== run.issueId ||
        !isDeepStrictEqual(proof.selection, selection)) return null;
  }
  return aiConnectionRouterService(db).transitionQuotaPin({ companyId: run.companyId, poolId: selection.poolId,
    agentId: run.agentId, taskKey: run.issueId, expectedSelection: selection, userId: input.userId,
    adapterType: agent.adapterType, attemptedMemberIds: [], failureKind: kind,
    allowCoolingSelection: true });
}
