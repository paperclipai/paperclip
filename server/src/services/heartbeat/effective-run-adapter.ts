import { isDeepStrictEqual } from "node:util";
import { resolvePaperclipRunnerProviderProfile } from "../native-runtime/provider-profile.js";
import { agentTaskSessions, aiConnectionPools, aiConnectionTaskPins, agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { parseObject } from "../../adapters/utils.js";
import { applyAiConnectionRouterTaskSettings, poolExecutionAdapterType, aiConnectionRouterService, LOCAL_POOL_ADAPTERS, AiConnectionPoolExhausted } from "../ai-connection-router.js";
import { BUILTIN_AI_FAILOVER_ROUTER_KEY, type AiConnectionRouterSelection } from "@paperclipai/shared";
import { HttpError } from "../../errors.js";
import { deriveTaskKeyWithHeartbeatFallback, shouldResetTaskSessionForWake } from "./run-state.js";
import { reselectUnstartedPoolSuccessor } from "./pool-failover.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { resolveHarnessPoolExecution } from "./harness-pool-admission.js";

export async function preparePoolAdapterClaim(db: Db, run: typeof heartbeatRuns.$inferSelect,
  agent: typeof agents.$inferSelect, userId: string | null, workerManager?: PluginWorkerManager): Promise<{ adapterDispatch: Record<string, unknown>; context: Record<string, unknown> & { aiRouterSelection?: AiConnectionRouterSelection } }> {
  const existing = parseObject(parseObject(run.runnerProfileJson).adapterDispatch);
  if (typeof existing.adapterType === "string") return { adapterDispatch: existing, context: {} };
  const adapterDispatch = { adapterType: agent.adapterType, configuredAdapterType: agent.adapterType };
  if (agent.runtimeConfig.harnessPool) {
    try {
      const admitted = await resolveHarnessPoolExecution({ db, run, agent, userId });
      return { adapterDispatch: { ...adapterDispatch, poolId: admitted.selection.poolId, memberId: admitted.selection.memberId, harnessPoolProfile: admitted.profile },
        context: { aiRouterSelection: admitted.routerSelection, aiRouterTaskKey: admitted.taskKey, harnessPoolSelection: admitted.selection } };
    } catch (error) {
      return { adapterDispatch: { ...adapterDispatch, poolPreparationFailure: error instanceof AiConnectionPoolExhausted
        ? { kind: "exhausted", message: error.message, poolId: error.poolId, retryAt: error.retryAt }
        : { kind: "configuration", message: error instanceof Error ? error.message : "Pool harness preparation failed" } }, context: {} };
    }
  }
  const binding = parseObject(parseObject(agent.runtimeConfig).aiConnection);
  if (run.startedAt || binding.mode !== "router" || typeof binding.connectionId !== "string" || !LOCAL_POOL_ADAPTERS.includes(agent.adapterType))
    return { adapterDispatch, context: {} };
  const context: Record<string, unknown> = await reselectUnstartedPoolSuccessor(db, run, userId) ?? parseObject(run.contextSnapshot);
  const taskKey = typeof context.aiRouterTaskKey === "string" && context.aiRouterTaskKey.trim()
    ? context.aiRouterTaskKey : deriveTaskKeyWithHeartbeatFallback(context, null) ?? run.id;
  if (context.aiRouterTaskKey !== taskKey) {
    await db.update(heartbeatRuns).set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({ aiRouterTaskKey: taskKey })}::jsonb` })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.status, "queued")));
  }
  const [pin] = await db.select({ selection: aiConnectionTaskPins.selection }).from(aiConnectionTaskPins).where(and(
    eq(aiConnectionTaskPins.companyId, agent.companyId), eq(aiConnectionTaskPins.agentId, agent.id),
    eq(aiConnectionTaskPins.poolId, binding.connectionId), eq(aiConnectionTaskPins.taskKey, taskKey))).limit(1);
  const sessionAdapterType = pin ? poolExecutionAdapterType(pin.selection.binding, agent.adapterType) : agent.adapterType;
  const [session] = await db.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, agent.companyId),
    eq(agentTaskSessions.agentId, agent.id), eq(agentTaskSessions.adapterType, sessionAdapterType), eq(agentTaskSessions.taskKey, taskKey))).limit(1);
  const [issue] = typeof context.issueId === "string" ? await db.select({ overrides: issues.assigneeAdapterOverrides }).from(issues)
    .where(and(eq(issues.companyId, agent.companyId), eq(issues.id, context.issueId))).limit(1) : [];
  const [pool] = await db.select({ pluginKey: aiConnectionPools.pluginKey }).from(aiConnectionPools)
    .where(and(eq(aiConnectionPools.companyId, agent.companyId), eq(aiConnectionPools.id, binding.connectionId))).limit(1);
  try {
    const identity = session?.sessionParamsJson?.paperclipAiCredentialIdentity;
    const selection = await aiConnectionRouterService(db, workerManager).resolve({ companyId: agent.companyId, poolId: binding.connectionId,
      agentId: agent.id, userId, adapterType: agent.adapterType, taskKey, overrides: parseObject(parseObject(issue?.overrides).adapterConfig),
      requireExisting: Boolean(session?.sessionDisplayId) && !shouldResetTaskSessionForWake(context),
      sourceAdapterConfig: { ...parseObject(agent.adapterConfig), ...parseObject(parseObject(issue?.overrides).adapterConfig) },
      skipUsageProbe: pool?.pluginKey === BUILTIN_AI_FAILOVER_ROUTER_KEY,
      existingGrantId: typeof identity === "string" ? identity.split(":")[0] : undefined });
    return { adapterDispatch: { ...adapterDispatch, adapterType: selection.adapterType ?? poolExecutionAdapterType(selection.binding, agent.adapterType), poolId: selection.poolId, memberId: selection.memberId },
      context: { aiRouterSelection: selection, aiRouterTaskKey: taskKey } };
  } catch (error) {
    const failure = error instanceof AiConnectionPoolExhausted
      ? { kind: "exhausted", message: error.message, retryAt: error.retryAt, poolId: error.poolId }
      : { kind: error instanceof HttpError ? "configuration" : "unexpected", message: error instanceof Error ? error.message : "Connection pool preparation failed",
        ...(error instanceof HttpError ? { status: error.status, code: parseObject(error.details).code } : {}) };
    return pin ? {
      adapterDispatch: { ...adapterDispatch, adapterType: sessionAdapterType, poolId: pin.selection.poolId,
        memberId: pin.selection.memberId, poolPreparationFailure: failure },
      context: { aiRouterTaskKey: taskKey, aiRouterSelection: { ...pin.selection, adapterType: sessionAdapterType } },
    } : { adapterDispatch: { ...adapterDispatch, poolPreparationFailure: failure }, context: { aiRouterTaskKey: taskKey } };
  }
}

export function effectiveRunAgent<T extends Pick<typeof agents.$inferSelect, "adapterType" | "adapterConfig">>(
  run: Pick<typeof heartbeatRuns.$inferSelect, "runnerProfileJson" | "contextSnapshot">,
  agent: T,
): T {
  const dispatch = parseObject(parseObject(run.runnerProfileJson).adapterDispatch);
  const selected = typeof dispatch.adapterType === "string" ? dispatch.adapterType : null;
  const configured = typeof dispatch.configuredAdapterType === "string" ? dispatch.configuredAdapterType : selected;
  if (configured && configured !== agent.adapterType) throw new Error("Agent adapter changed during startup; start a new turn with the updated agent.");
  if (!selected || (selected === agent.adapterType && typeof dispatch.poolId !== "string")) return agent;
  const selection = parseObject(run.contextSnapshot).aiRouterSelection as AiConnectionRouterSelection | undefined;
  if (!selection || dispatch.poolId !== selection.poolId || dispatch.memberId !== selection.memberId || poolExecutionAdapterType(selection.binding, agent.adapterType) !== selected ||
      (selection.adapterType && selection.adapterType !== selected)) throw new Error("The admitted pool adapter does not match its selection.");
  const adapterConfig = applyAiConnectionRouterTaskSettings(parseObject(agent.adapterConfig), selection, agent.adapterType);
  if (dispatch.harnessPoolProfile && !isDeepStrictEqual(dispatch.harnessPoolProfile, resolvePaperclipRunnerProviderProfile(adapterConfig)))
    throw new Error("The admitted Pool harness profile changed before dispatch.");
  return { ...agent, adapterType: selected, adapterConfig };
}
