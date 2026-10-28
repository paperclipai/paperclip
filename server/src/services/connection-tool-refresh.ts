import { and, eq, isNull, ne, notInArray, or } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, toolMcpGateways, toolMcpGatewayTokens, type Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import type { RuntimeToolsTokenClaims } from "../runtime-tools-token.js";
import type { heartbeatService } from "./heartbeat.js";
import { boundRunIssueIdSql } from "./run-task-binding.js";
import { resolveNativeRuntimeMcpSnapshot } from "./native-runtime/runtime-context.js";

type Heartbeat = ReturnType<typeof heartbeatService>;

export type ConnectionToolRefresh = "not_needed" | "requested" | "deduplicated" | "unavailable";

type ReadyCandidate = { state: string; interactionId: string | null; connectionId: string | null; instruction: string };

const QUEUED_NOTE = "This run started without these tools. A continuation with updated tools is queued; finish independent work, then yield.";
const UNAVAILABLE_NOTE = "This run started without these tools and no continuation could be scheduled; report this to the responsible user.";

export async function refreshReadyConnectionTools<T extends ReadyCandidate>(
  db: Db,
  heartbeat: Pick<Heartbeat, "wakeup">,
  claims: RuntimeToolsTokenClaims,
  result: T,
): Promise<T | (T & { toolRefresh: ConnectionToolRefresh })> {
  if (result.state !== "ready" || result.interactionId !== null || !result.connectionId) return result;
  const current = await resolveNativeRuntimeMcpSnapshot({ db, agent: { id: claims.sub, companyId: claims.company_id }, runId: claims.run_id });
  if (!current.bindingId) return { ...result, toolRefresh: "not_needed" };
  const delivered = await db.select({ metadata: toolMcpGateways.metadata }).from(toolMcpGatewayTokens)
    .innerJoin(toolMcpGateways, eq(toolMcpGateways.id, toolMcpGatewayTokens.gatewayId))
    .where(and(
      eq(toolMcpGatewayTokens.companyId, claims.company_id),
      eq(toolMcpGatewayTokens.subjectType, "heartbeat_run"),
      eq(toolMcpGatewayTokens.subjectId, claims.run_id),
      eq(toolMcpGateways.agentId, claims.sub),
    ));
  const withNote = (toolRefresh: ConnectionToolRefresh, note: string) => ({ ...result, toolRefresh, instruction: `${result.instruction} ${note}` });
  if (delivered.some(row => row.metadata?.nativeRuntimeAssignmentDigest === current.digest)) {
    return { ...result, toolRefresh: "not_needed" };
  }
  const idempotencyKey = `connection-intent:tools:${claims.run_id}:${current.digest}`;
  const queued = async () => (await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, claims.company_id),
    eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
    notInArray(agentWakeupRequests.status, ["skipped", "failed", "cancelled"]),
    or(isNull(agentWakeupRequests.runId), ne(agentWakeupRequests.runId, claims.run_id)),
  )).limit(1)).length > 0;
  if (await queued()) return withNote("deduplicated", QUEUED_NOTE);
  const [run] = await db.select({ issueId: boundRunIssueIdSql() }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, claims.run_id),
    eq(heartbeatRuns.companyId, claims.company_id),
    eq(heartbeatRuns.agentId, claims.sub),
  )).limit(1);
  const issueId = run?.issueId;
  if (!issueId) return withNote("unavailable", UNAVAILABLE_NOTE);
  try {
    await heartbeat.wakeup(claims.sub, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId, mutation: "connection_tools_refreshed" },
      idempotencyKey,
      allowRunCoalescing: false,
      issueStateGuard: { statuses: ["in_progress", "in_review"], assigneeAgentId: claims.sub },
      requestedByActorType: "agent", requestedByActorId: claims.sub,
      contextSnapshot: { issueId, taskId: issueId, refreshTools: true, wakeReason: "issue_commented", source: "connection_tools.refreshed" },
    });
  } catch (error) {
    if (!(await queued()) && !(error instanceof HttpError && error.status === 409)) throw error;
  }
  return await queued()
    ? withNote("requested", QUEUED_NOTE)
    : withNote("unavailable", UNAVAILABLE_NOTE);
}
