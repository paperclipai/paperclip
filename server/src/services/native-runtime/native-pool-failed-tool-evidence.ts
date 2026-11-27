import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { activityLog, type heartbeatRunEvents, type heartbeatRuns, type Db } from "@paperclipai/db";
import { nativeSha256 } from "./canonical.js";
import { isUndispatchedRunnerApiReceipt } from "../recovery-effect-receipts.js";
import { DOWNLOAD_ARTIFACT } from "./artifact-transfer.js";
import { runnerToolMutationJournal, isRecoverableRunnerRead } from "./paperclip-runner-tool-authority.js";

type SourceRun = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "runnerInstanceId" | "nativeSessionId">;
type ToolEvent = Pick<typeof heartbeatRunEvents.$inferSelect, "agentId" | "seq" | "eventType" | "payload" |
  "protocolSchemaVersion" | "sourceInstanceId" | "sourceEventId" | "sourceSeq" | "sourcePayloadSha256">;
type ReplacementDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function admittedEvent(run: SourceRun, row: ToolEvent) {
  const event = record(record(row.payload).prpEvent);
  if (!run.runnerInstanceId || !run.nativeSessionId || row.agentId !== run.agentId || row.protocolSchemaVersion !== 1 ||
      event.schema !== "paperclip.prp.event.v1" || event.schemaVersion !== 1 || event.sourceKind !== "runner" ||
      event.runId !== run.id || event.normalizedSessionId !== run.nativeSessionId ||
      event.sourceInstanceId !== run.runnerInstanceId || row.sourceInstanceId !== run.runnerInstanceId ||
      !row.sourceEventId || row.sourceEventId !== event.sourceEventId || row.sourceSeq == null ||
      row.sourceSeq < 1 || row.sourceSeq !== event.sourceSeq || event.eventType !== row.eventType ||
      row.sourcePayloadSha256 !== nativeSha256(event)) return null;
  return event;
}

/** Claude's admitted runner reserves the paperclip MCP namespace. Prove both
 * events came from the same owned session before using the tool contract. */
function failedClaudePaperclipTool(
  run: SourceRun,
  started: ToolEvent,
  completed: ToolEvent,
) {
  if (started.eventType !== "tool.execution.started" || completed.eventType !== "tool.execution.completed" ||
      completed.seq <= started.seq) return null;
  const start = admittedEvent(run, started);
  const end = admittedEvent(run, completed);
  if (!start || !end || completed.sourceSeq! <= started.sourceSeq! ||
      typeof start.turnId !== "string" || !start.turnId || start.turnId !== end.turnId) return null;
  const a = record(start.payload);
  const b = record(end.payload);
  if (a.schema !== "paperclip.tool.execution.v1" || b.schema !== a.schema ||
      a.transport !== "mcp" || b.transport !== a.transport || a.namespace !== "paperclip" || b.namespace !== a.namespace ||
      a.status !== "running" || b.status !== "failed" ||
      typeof a.executionId !== "string" || !a.executionId || a.executionId !== b.executionId ||
      typeof a.name !== "string" || a.name !== b.name) return null;
  return { name: a.name, callId: a.executionId, completion: b };
}

/** A failed first-party MCP call can be discarded only if the owning tool
 * contract rules out a mutation or its effect journal settles the attempt. */
export function failedPaperclipToolEffectSettled(
  run: SourceRun,
  started: ToolEvent,
  completed: ToolEvent,
  input: { apiReceipts: Record<string, unknown>; artifactInstallsSettled: boolean },
): boolean {
  const call = failedClaudePaperclipTool(run, started, completed);
  if (!call) return false;
  if (isRecoverableRunnerRead(call.name)) return true;
  if (call.name === DOWNLOAD_ARTIFACT) return input.artifactInstallsSettled;

  const journal = runnerToolMutationJournal(call.name);
  if (!journal) return false;
  const receipt = input.apiReceipts[createHash("sha256").update(`tool-use:${call.callId}`).digest("hex")];
  if (receipt !== undefined) {
    const result = record(receipt);
    return (journal.operationId === null || result.operationId === journal.operationId) &&
      (isUndispatchedRunnerApiReceipt(receipt) || (result.state === "completed" &&
        typeof result.digest === "string" && /^[a-f0-9]{64}$/.test(result.digest) &&
        typeof result.operationId === "string" && record(result.result).ok === true));
  }

  // Historic ACP bridge events record schema rejection in the display result.
  // Only use it when this tool's mutation path requires a durable reservation
  // before dispatch. A generic failed tool result supplies no such proof.
  return call.completion.outputTruncated === false &&
    typeof call.completion.output === "string" &&
    call.completion.output.startsWith("Invalid tool input: ");
}

/** An admitted MCP execution and the semantic call can describe the same tool
 * use. Only reuse its effect proof for the exact correlated terminal result. */
export function failedSemanticProjectionMatchesSettledMcp(
  run: SourceRun,
  input: ToolEvent,
  result: ToolEvent,
  settledMcpStarts: readonly ToolEvent[],
): boolean {
  if (input.eventType !== "semantic_tool.input" || result.eventType !== "semantic_tool.result" ||
      result.seq <= input.seq || !input.sourceSeq || !result.sourceSeq || result.sourceSeq <= input.sourceSeq) return false;
  const start = admittedEvent(run, input);
  const end = admittedEvent(run, result);
  if (!start || !end || typeof start.turnId !== "string" || !start.turnId || start.turnId !== end.turnId ||
      typeof start.itemId !== "string" || !start.itemId || start.itemId !== end.itemId) return false;
  const semantic = (event: Record<string, unknown>, phase: string) => {
    const tool = record(record(event.payload).semantic_tool);
    const scope = record(tool.correlation);
    return tool.schema === "paperclip.prp.semantic_tool.v1" && tool.schemaVersion === 1 && tool.phase === phase &&
      scope.runId === run.id && scope.normalizedSessionId === run.nativeSessionId &&
      scope.turnId === event.turnId && scope.itemId === event.itemId ? tool : null;
  };
  const call = semantic(start, "input");
  const outcome = semantic(end, "result");
  if (!call || typeof call.callId !== "string" || typeof call.operationId !== "string" ||
      !outcome || outcome.callId !== call.callId || outcome.operationId !== call.operationId ||
      outcome.outcome !== "failed" || outcome.operationReceiptId !== "operation_" + call.callId) return false;
  return settledMcpStarts.some(row => {
    // The caller admitted this display start and its terminal result together.
    const prp = record(record(row.payload).prpEvent);
    const tool = record(prp.payload);
    return prp.turnId === start.turnId && typeof tool.executionId === "string" &&
      "tool-use:" + tool.executionId === call.callId && tool.name === call.operationId;
  });
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
