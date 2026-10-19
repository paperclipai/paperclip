import { sql } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";

type RunTaskBinding = {
  nativeIssueId?: string | null;
  issueId?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
};

export function boundRunIssueId(run: RunTaskBinding): string | null {
  const values = [run.nativeIssueId, run.issueId, run.contextSnapshot?.issueId, run.contextSnapshot?.taskId];
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() ?? null;
}

export function boundRunIssueIdSql() {
  return sql<string | null>`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text,
    case when jsonb_typeof(${heartbeatRuns.contextSnapshot}->'issueId') = 'string'
      then nullif(btrim(${heartbeatRuns.contextSnapshot}->>'issueId'), '') end,
    case when jsonb_typeof(${heartbeatRuns.contextSnapshot}->'taskId') = 'string'
      then nullif(btrim(${heartbeatRuns.contextSnapshot}->>'taskId'), '') end)`;
}
