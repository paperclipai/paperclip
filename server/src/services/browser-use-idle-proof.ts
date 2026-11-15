import { finishedIdleRun } from "./idle-work-proof.js";

/** Mirrors sweep/account: terminal provider status cannot settle usage. */
export function completedBrowserRun(run: string): string {
  const hold = `${run}.result->'paperclipBudgetHold'`;
  return `${run}.status IN ('completed', 'failed', 'cancelled')
    AND ${run}.events_drained = 1 AND ${run}.recovery_cursor IS NULL
    AND jsonb_typeof(${hold}) = 'object' AND ${hold}->>'invocationId' = ${run}.invocation_id::text
    AND ((${run}.provider_run_id IS NOT NULL AND ${hold}->>'state' = 'settled'
        AND ${hold}->>'accountedCentsExact' ~ '^[0-9]+([.][0-9]+)?$')
      OR (${run}.provider_run_id IS NULL AND ${run}.status = 'failed' AND ${hold}->>'state' = 'released'))
    -- account() replaces held authority with the authoritative terminal
    -- summary and ledger charge. It retains prior diagnostic flags in JSON.
    AND (${hold}->>'state' = 'settled' OR COALESCE(${hold}->>'billingUnknown', 'false') = 'false')
    AND EXISTS (SELECT 1 FROM browser_use_sessions browser_parent_session JOIN heartbeat_runs browser_parent_run
      ON browser_parent_run.id = ${run}.heartbeat_run_id AND browser_parent_run.company_id = browser_parent_session.company_id
        AND browser_parent_run.agent_id = browser_parent_session.agent_id
      WHERE browser_parent_session.id = ${run}.session_id AND browser_parent_session.company_id = ${run}.company_id
        AND (browser_parent_run.native_issue_id = browser_parent_session.issue_id
          OR browser_parent_run.context_snapshot->>'issueId' = browser_parent_session.issue_id::text
          OR browser_parent_run.context_snapshot->>'taskId' = browser_parent_session.issue_id::text)
        AND (browser_parent_run.native_issue_id IS NULL OR browser_parent_run.native_issue_id = browser_parent_session.issue_id)
        AND (browser_parent_run.context_snapshot->>'issueId' IS NULL
          OR browser_parent_run.context_snapshot->>'issueId' = browser_parent_session.issue_id::text)
        AND (browser_parent_run.context_snapshot->>'taskId' IS NULL
          OR browser_parent_run.context_snapshot->>'taskId' = browser_parent_session.issue_id::text)
        AND ${finishedIdleRun('browser_parent_run')})`;
}

export const idleBrowserHistoryChecks = [
  { reason: "browser_use_sessions", query: `SELECT 1 FROM browser_use_sessions s WHERE (
    (s.status = 'closed' OR (s.status = 'failed' AND s.provider_session_id IS NULL))
    AND s.lease_token IS NULL AND s.lease_until IS NULL AND s.stop_requested IS NULL
    AND EXISTS (SELECT 1 FROM issues i JOIN agents a ON a.id = s.agent_id AND a.company_id = i.company_id
      JOIN tool_connections c ON c.id = s.connection_id AND c.company_id = i.company_id
      JOIN connection_grants g ON g.id = s.grant_id AND g.company_id = i.company_id AND g.connection_id = c.id
      WHERE i.id = s.issue_id AND i.company_id = s.company_id)
    AND NOT EXISTS (SELECT 1 FROM browser_use_runs r WHERE r.session_id = s.id
      AND (r.company_id <> s.company_id OR (${completedBrowserRun('r')}) IS NOT TRUE))
    AND NOT EXISTS (SELECT 1 FROM browser_use_browsers b WHERE b.session_id = s.id
      AND (b.company_id <> s.company_id OR b.status <> 'stopped'))) IS NOT TRUE` },
  { reason: "browser_use_runs", query: `SELECT 1 FROM browser_use_runs r WHERE (${completedBrowserRun('r')}) IS NOT TRUE` },
  // stopped is written only after client.stop followed by client.browser
  // confirms stopped. Parent/session/run checks remain independent barriers.
  { reason: "browser_use_browsers", query: `SELECT 1 FROM browser_use_browsers b WHERE (
    b.status = 'stopped' AND EXISTS (SELECT 1 FROM browser_use_sessions s
      WHERE s.id = b.session_id AND s.company_id = b.company_id AND s.status = 'closed'
        AND s.stop_requested IS NULL AND s.lease_token IS NULL AND s.lease_until IS NULL)) IS NOT TRUE` },
] as const;
