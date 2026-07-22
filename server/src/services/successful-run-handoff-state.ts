import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agentWakeupRequests, heartbeatRuns } from "@paperclipai/db";
import type { SuccessfulRunHandoffState } from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";

export const SUCCESSFUL_RUN_HANDOFF_LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
export const SUCCESSFUL_RUN_HANDOFF_LIVE_WAKE_STATUSES = ["queued", "deferred_issue_execution", "claimed"] as const;

const heartbeatRunIssueId = sql<string>`coalesce(
  ${heartbeatRuns.contextSnapshot} ->> 'issueId',
  ${heartbeatRuns.contextSnapshot} ->> 'taskId'
)`;

const wakeRequestIssueId = sql<string>`coalesce(
  ${agentWakeupRequests.payload} ->> 'issueId',
  ${agentWakeupRequests.payload} ->> 'taskId',
  ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'issueId',
  ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'taskId'
)`;

export async function hydrateSuccessfulRunHandoffLiveness(
  dbOrTx: any,
  companyId: string,
  states: Map<string, SuccessfulRunHandoffState>,
) {
  const requiredIssueIds = [...states.entries()]
    .filter(([, state]) => state.state === "required")
    .map(([issueId]) => issueId);
  if (requiredIssueIds.length === 0) return states;

  const [activeRuns, activeWakes] = await Promise.all([
    dbOrTx
      .select({ id: heartbeatRuns.id, issueId: heartbeatRunIssueId })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, [...SUCCESSFUL_RUN_HANDOFF_LIVE_RUN_STATUSES]),
        inArray(heartbeatRunIssueId, requiredIssueIds),
      )),
    dbOrTx
      .select({ issueId: wakeRequestIssueId })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        inArray(agentWakeupRequests.status, [...SUCCESSFUL_RUN_HANDOFF_LIVE_WAKE_STATUSES]),
        inArray(wakeRequestIssueId, requiredIssueIds),
      )),
  ]);

  const liveRunByIssueId = new Map<string, string>();
  for (const row of activeRuns as Array<{ id: string; issueId: string | null }>) {
    if (row.issueId && !liveRunByIssueId.has(row.issueId)) liveRunByIssueId.set(row.issueId, row.id);
  }
  const liveWakeIssueIds = new Set(
    (activeWakes as Array<{ issueId: string | null }>)
      .map((row) => row.issueId)
      .filter((issueId): issueId is string => Boolean(issueId)),
  );

  for (const issueId of requiredIssueIds) {
    const state = states.get(issueId);
    if (!state) continue;
    const liveRunId = liveRunByIssueId.get(issueId);
    states.set(issueId, {
      ...state,
      hasLiveContinuation: Boolean(liveRunId || liveWakeIssueIds.has(issueId)),
      ...(liveRunId ? { liveRunId } : {}),
    });
  }

  return states;
}

export async function resolveRequiredSuccessfulRunHandoffOnValidPath(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    issueIdentifier: string | null;
    agentId: string;
    runId: string;
    skipReason: string;
  },
) {
  const latestHandoff = await db
    .select({ action: activityLog.action, runId: activityLog.runId, details: activityLog.details })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, input.companyId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, input.issueId),
      inArray(activityLog.action, [
        "issue.successful_run_handoff_required",
        "issue.successful_run_handoff_resolved",
        "issue.successful_run_handoff_escalated",
      ]),
    ))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (latestHandoff?.action !== "issue.successful_run_handoff_required") return false;

  const details = latestHandoff.details && typeof latestHandoff.details === "object"
    ? latestHandoff.details as Record<string, unknown>
    : {};
  const sourceRunId = [details.sourceRunId, details.source_run_id, details.resumeFromRunId]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim() ?? latestHandoff.runId;
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "heartbeat",
    agentId: input.agentId,
    runId: input.runId,
    action: "issue.successful_run_handoff_resolved",
    entityType: "issue",
    entityId: input.issueId,
    details: {
      label: "Successful run handoff continuation confirmed",
      sourceRunId,
      resolvedByRunId: input.runId,
      resolvedBySkipReason: input.skipReason,
      issue: { id: input.issueId, identifier: input.issueIdentifier },
    },
  });
  return true;
}
