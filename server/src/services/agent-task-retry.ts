import { and, count, eq, gt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { activityLog, companyMemberships, heartbeatRuns, principalPermissionGrants } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { logActivity } from "./activity-log.js";

/** Retries one granted agent may request on one task in a rolling day. */
export const AGENT_TASK_RETRY_DAILY_CAP = 3;
export const AGENT_TASK_RETRY_ACTION = "issue.retry_requested_by_agent";

/**
 * The board actor an agent presses Retry as: the active member whose
 * tasks:retry grant names this agent. Only a grant a board user saved counts;
 * a grant row written by an agent has no granting user. The actor covers only
 * the agent's company, so every Retry gate the person meets applies unchanged.
 */
export async function agentTaskRetryActor(db: Db, agent: { companyId: string; agentId: string; runId?: string }) {
  const [grantor] = await db.select({ userId: companyMemberships.principalId, membershipRole: companyMemberships.membershipRole })
    .from(principalPermissionGrants)
    .innerJoin(companyMemberships, and(eq(companyMemberships.companyId, principalPermissionGrants.companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, principalPermissionGrants.grantedByUserId),
      eq(companyMemberships.status, "active")))
    .where(and(
      eq(principalPermissionGrants.companyId, agent.companyId),
      eq(principalPermissionGrants.principalType, "agent"),
      eq(principalPermissionGrants.principalId, agent.agentId),
      eq(principalPermissionGrants.permissionKey, "tasks:retry")));
  if (!grantor) return null;
  return {
    type: "board", userId: grantor.userId, companyIds: [agent.companyId], isInstanceAdmin: false,
    memberships: [{ companyId: agent.companyId, membershipRole: grantor.membershipRole, status: "active" }],
    source: "board_key", runId: agent.runId,
  } satisfies Express.Request["actor"];
}

/** Whether the run id the agent sent names one of its own runs in its company. */
export async function agentOwnsRun(db: Db, input: { companyId: string; agentId: string; runId: string }) {
  if (!isUuidLike(input.runId)) return false;
  const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId)));
  return Boolean(run);
}

/**
 * Count an agent's Retry toward its daily cap on the task. The activity row
 * names the agent and the grantor, and is written before the Retry so refused
 * and failed attempts count too. A replay of
 * the same idempotency key counts once.
 */
export async function recordAgentTaskRetry(db: Db, input: {
  companyId: string; issueId: string; agentId: string; runId: string; grantedByUserId: string; idempotencyKey: string;
}) {
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent-task-retry:${input.issueId}`}))`);
    const [replay] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
      eq(activityLog.companyId, input.companyId), eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, input.issueId), eq(activityLog.action, AGENT_TASK_RETRY_ACTION),
      eq(activityLog.actorId, input.agentId), sql`${activityLog.details}->>'idempotencyKey' = ${input.idempotencyKey}`)).limit(1);
    if (replay) return;
    const [{ value: recent }] = await tx.select({ value: count() }).from(activityLog).where(and(
      eq(activityLog.companyId, input.companyId), eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, input.issueId), eq(activityLog.action, AGENT_TASK_RETRY_ACTION),
      eq(activityLog.actorId, input.agentId), gt(activityLog.createdAt, sql`now() - interval '1 day'`)));
    if (recent >= AGENT_TASK_RETRY_DAILY_CAP)
      throw new HttpError(429, `An agent can request at most ${AGENT_TASK_RETRY_DAILY_CAP} Retries on a task per day`,
        { code: "agent_task_retry_cap_reached" });
    await logActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "agent", actorId: input.agentId,
      agentId: input.agentId, runId: input.runId, action: AGENT_TASK_RETRY_ACTION, entityType: "issue",
      entityId: input.issueId, details: { grantedByUserId: input.grantedByUserId, idempotencyKey: input.idempotencyKey } });
  });
}
