import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests } from "@paperclipai/db";

export const ISSUE_MANAGER_HANDOFF_WAKE_REASON = "issue_manager_handoff";

const IDEMPOTENT_MANAGER_HANDOFF_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
  "completed",
  "coalesced",
] as const;

export function buildIssueManagerHandoffWakeIdempotencyKey(input: {
  initiatingRunId: string;
  issueId: string;
}) {
  return ["issue-manager-handoff", input.initiatingRunId, input.issueId].join(":");
}

export async function findExistingIssueManagerHandoffWake(
  db: Db,
  input: { companyId: string; targetAgentId: string; idempotencyKey: string },
) {
  return db
    .select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      runId: agentWakeupRequests.runId,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.agentId, input.targetAgentId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        inArray(agentWakeupRequests.status, [...IDEMPOTENT_MANAGER_HANDOFF_WAKE_STATUSES]),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}
