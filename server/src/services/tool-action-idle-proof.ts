import { finishedIdleRun } from "./idle-work-proof.js";

function completedRequest(a: string): string {
  return `${a}.status IN ('executed', 'failed', 'rejected', 'expired', 'cancelled') AND ${a}.resolved_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM tool_invocations v WHERE v.id = ${a}.invocation_id AND v.company_id = ${a}.company_id
      AND v.issue_id IS NOT DISTINCT FROM ${a}.issue_id AND v.completed_at IS NOT NULL
      AND v.status IN ('succeeded', 'failed', 'denied', 'cancelled', 'timed_out', 'rate_limited')
      AND (v.run_id IS NULL OR EXISTS (SELECT 1 FROM heartbeat_runs r WHERE r.id = v.run_id
        AND r.company_id = v.company_id AND ${finishedIdleRun('r')})))
    AND (${a}.interaction_id IS NULL OR EXISTS (SELECT 1 FROM issue_thread_interactions i WHERE i.id = ${a}.interaction_id
      AND i.company_id = ${a}.company_id AND i.issue_id = ${a}.issue_id AND i.resolved_at IS NOT NULL
      AND i.payload->'toolAction'->>'actionRequestId' = ${a}.id::text
      AND i.payload->'toolAction'->>'invocationId' = ${a}.invocation_id::text
      AND i.status IN ('accepted', 'rejected', 'expired', 'cancelled')
      AND (${a}.status = 'rejected' OR i.result->'toolAction'->>'status' = CASE
        WHEN ${a}.status = 'cancelled' THEN 'expired' ELSE ${a}.status END)))`;
}

export const idleToolActionHistoryChecks = [
  { reason: "tool_action_requests", query: `SELECT 1 FROM tool_action_requests a WHERE (${completedRequest('a')}) IS NOT TRUE` },
  // delivered_at is the domain's acknowledgment. It also retires outcomes
  // after issue completion/reassignment. Accepted continuations stay covered by
  // the global wake/run checks, including coalesced run accounting.
  { reason: "tool_action_deliveries", query: `SELECT 1 FROM tool_action_deliveries d WHERE (
    d.delivered_at IS NOT NULL AND EXISTS (SELECT 1 FROM tool_action_requests a
      WHERE a.id = d.action_request_id AND a.company_id = d.company_id
        AND a.issue_id = d.issue_id AND a.interaction_id = d.interaction_id AND (${completedRequest('a')}))) IS NOT TRUE` },
] as const;
