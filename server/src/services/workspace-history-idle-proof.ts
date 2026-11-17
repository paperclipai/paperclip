import { finishedIdleRun } from "./idle-work-proof.js";

export const idleWorkspaceHistoryChecks = [
  // Failed imports are intentionally resumable. Completed/cancelled rows can
  // still owe spool deletion, independently inspected by idle-local-work.
  { reason: "company_transfer_runs", query: `SELECT 1 FROM company_transfer_runs t WHERE (
    t.status IN ('completed', 'cancelled') AND t.finished_at IS NOT NULL
    AND t.direction IN ('import', 'export') AND jsonb_typeof(t.container_ref) = 'object'
    AND jsonb_typeof(t.completed_parts) = 'array'
    AND (t.status = 'cancelled' OR (t.error IS NULL AND t.manifest_sha256 ~ '^[a-f0-9]{64}$'
      AND CASE WHEN jsonb_typeof(t.manifest->'chunks') = 'array' AND jsonb_typeof(t.manifest->'blobs') = 'array' THEN
        t.chunk_count = jsonb_array_length(t.manifest->'chunks') AND t.blob_count = jsonb_array_length(t.manifest->'blobs')
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements((t.manifest->'chunks') || (t.manifest->'blobs')) part
          WHERE jsonb_typeof(part->'name') IS DISTINCT FROM 'string' OR NOT t.completed_parts ? (part->>'name'))
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(t.completed_parts) done
          WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements((t.manifest->'chunks') || (t.manifest->'blobs')) part WHERE part->>'name' = done))
      WHEN jsonb_typeof(t.manifest->'parts') = 'array' THEN
        t.chunk_count = jsonb_array_length(t.manifest->'parts') AND t.blob_count = 0
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.manifest->'parts') WITH ORDINALITY part(value, ordinal)
          WHERE NOT t.completed_parts ? ('part-' || (ordinal - 1)::text))
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(t.completed_parts) done
          WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.manifest->'parts') WITH ORDINALITY part(value, ordinal)
            WHERE done = 'part-' || (ordinal - 1)::text))
      ELSE false END))
    AND (t.company_id IS NOT NULL OR (t.direction = 'import' AND t.status = 'cancelled'))
    AND (t.company_id IS NULL OR EXISTS (SELECT 1 FROM companies c WHERE c.id = t.company_id))) IS NOT TRUE` },
  { reason: "workspace_runtime_services", query: `SELECT 1 FROM workspace_runtime_services s WHERE (
    s.status = 'stopped' AND s.stopped_at IS NOT NULL AND s.provider = 'local_process'
    AND s.exposure_handle IS NULL
    AND (s.exposure IS NULL OR (jsonb_typeof(s.exposure) = 'object'
      AND s.exposure->>'state' = 'removed' AND s.url IS NULL
      AND COALESCE(s.exposure->'publicUrl', 'null'::jsonb) = 'null'::jsonb))
    AND (s.execution_workspace_id IS NULL OR EXISTS (SELECT 1 FROM execution_workspaces w
      WHERE w.id = s.execution_workspace_id AND w.company_id = s.company_id))
    AND (s.issue_id IS NULL OR EXISTS (SELECT 1 FROM issues i WHERE i.id = s.issue_id AND i.company_id = s.company_id))
    AND (s.started_by_run_id IS NULL OR EXISTS (SELECT 1 FROM heartbeat_runs r
      WHERE r.id = s.started_by_run_id AND r.company_id = s.company_id AND ${finishedIdleRun('r')}))) IS NOT TRUE` },
  // This is an exclusivity row, not a provider lease. The domain only
  // evaluates staleness on the next claim; no expiry job is owed by history.
  { reason: "execution_workspace_runtime_leases", query: `SELECT 1 FROM execution_workspace_runtime_leases l WHERE (
    EXISTS (SELECT 1 FROM execution_workspaces w WHERE w.id = l.execution_workspace_id AND w.company_id = l.company_id)
    AND ((l.owner_issue_id IS NOT NULL AND l.owner_key = 'issue:' || l.owner_issue_id::text
      AND EXISTS (SELECT 1 FROM issues i WHERE i.id = l.owner_issue_id AND i.company_id = l.company_id
        AND i.status IN ('done', 'cancelled')))
      OR (l.owner_issue_id IS NULL AND l.owner_run_id IS NOT NULL AND l.owner_key = 'run:' || l.owner_run_id::text
        AND EXISTS (SELECT 1 FROM heartbeat_runs r WHERE r.id = l.owner_run_id AND r.company_id = l.company_id
          AND r.agent_id = l.owner_agent_id AND ${finishedIdleRun('r')})))
    AND (l.owner_run_id IS NULL OR EXISTS (SELECT 1 FROM heartbeat_runs r WHERE r.id = l.owner_run_id
      AND r.company_id = l.company_id AND r.agent_id = l.owner_agent_id AND ${finishedIdleRun('r')}))
    AND NOT EXISTS (SELECT 1 FROM workspace_runtime_services s WHERE s.execution_workspace_id = l.execution_workspace_id
      AND (s.company_id <> l.company_id OR s.status <> 'stopped' OR s.stopped_at IS NULL))) IS NOT TRUE` },
] as const;
