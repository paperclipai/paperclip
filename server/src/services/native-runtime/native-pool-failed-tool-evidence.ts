import { sql } from "drizzle-orm";
import { activityLog, type heartbeatRunEvents, type heartbeatRuns, type Db } from "@paperclipai/db";
import { nativeSha256 } from "./canonical.js";

type SourceRun = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "runnerInstanceId" | "nativeSessionId">;
type ToolEvent = Pick<typeof heartbeatRunEvents.$inferSelect, "agentId" | "seq" | "eventType" | "payload" |
  "protocolSchemaVersion" | "sourceInstanceId" | "sourceEventId" | "sourceSeq" | "sourcePayloadSha256">;
type ReplacementDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Claude's admitted runner reserves the paperclip MCP namespace. Prove both
 * events came from the same owned session, and match a specific built-in. */
export function failedClaudePaperclipTool(
  run: SourceRun,
  started: ToolEvent,
  completed: ToolEvent,
): "list_task_documents" | "download_artifact" | null {
  const admittedEvent = (row: ToolEvent) => {
    const event = record(record(row.payload).prpEvent);
    if (!run.runnerInstanceId || !run.nativeSessionId || row.agentId !== run.agentId || row.protocolSchemaVersion !== 1 ||
        event.schema !== "paperclip.prp.event.v1" || event.schemaVersion !== 1 || event.sourceKind !== "runner" ||
        event.runId !== run.id || event.normalizedSessionId !== run.nativeSessionId ||
        event.sourceInstanceId !== run.runnerInstanceId || row.sourceInstanceId !== run.runnerInstanceId ||
        !row.sourceEventId || row.sourceEventId !== event.sourceEventId || row.sourceSeq == null ||
        row.sourceSeq < 1 || row.sourceSeq !== event.sourceSeq || event.eventType !== row.eventType ||
        row.sourcePayloadSha256 !== nativeSha256(event)) return null;
    return event;
  };
  if (started.eventType !== "tool.execution.started" || completed.eventType !== "tool.execution.completed" ||
      completed.seq <= started.seq) return null;
  const start = admittedEvent(started);
  const end = admittedEvent(completed);
  if (!start || !end || completed.sourceSeq! <= started.sourceSeq! ||
      typeof start.turnId !== "string" || !start.turnId || start.turnId !== end.turnId) return null;
  const a = record(start.payload);
  const b = record(end.payload);
  if (a.schema !== "paperclip.tool.execution.v1" || b.schema !== a.schema ||
      a.transport !== "mcp" || b.transport !== a.transport || a.namespace !== "paperclip" || b.namespace !== a.namespace ||
      a.status !== "running" || b.status !== "failed" ||
      typeof a.executionId !== "string" || !a.executionId || a.executionId !== b.executionId || a.name !== b.name) return null;
  return a.name === "list_task_documents" || a.name === "download_artifact" ? a.name : null;
}

/** The artifact authority awaits a durable start before invoking the installer
 * and records completion only after verifying the file and its authority.
 * Older receipts carry install identity but no call ID. Require all starts in
 * this run to reconcile against the same identity, with no unconfirmed audit. */
export async function artifactInstallHistorySettled(db: ReplacementDb, run: SourceRun, issueId: string) {
  const outcome = sql`${activityLog.details}->>'outcome'`;
  const started = sql`count(*) filter (where ${outcome} = 'started')`;
  const completed = sql`count(*) filter (where ${outcome} = 'completed')`;
  const [row] = await db.execute<{ settled: boolean }>(sql`select not exists (
    select 1 from ${activityLog}
    where ${activityLog.companyId} = ${run.companyId} and ${activityLog.runId} = ${run.id}
      and ${activityLog.action} = 'runner.artifact_install'
    group by ${activityLog.details} - 'outcome'
    having ${started} <> ${completed} or count(*) <> ${started} + ${completed}
      or bool_or(${activityLog.entityType} <> 'issue' or ${activityLog.entityId} <> ${issueId}
        or ${activityLog.actorType} <> 'agent' or ${activityLog.actorId} <> ${run.agentId})
      or min(${activityLog.createdAt}) filter (where ${outcome} = 'completed')
        < min(${activityLog.createdAt}) filter (where ${outcome} = 'started')
      or max(${activityLog.createdAt}) filter (where ${outcome} = 'completed')
        < max(${activityLog.createdAt}) filter (where ${outcome} = 'started')
  ) as settled`);
  return row?.settled === true;
}
