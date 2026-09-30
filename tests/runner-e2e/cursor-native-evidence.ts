import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

export interface CursorToolNotice {
  runId: string; sessionId: string; turnId: string; toolCallId: string; seq: number;
  stage: "tool" | "permission_requested" | "permission_delivered";
  status?: string; operation?: string; commandSha256?: string; requestId?: string; declineOffered?: boolean; outcome?: string;
}
const rec = (v: unknown): Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(v) && !v.includes("[REDACTED]");
const enums = { stage: ["tool", "permission_requested", "permission_delivered"], status: ["pending", "in_progress", "completed", "failed"], operation: ["execute"], outcome: ["allow_once", "allow_always", "reject_once", "cancel"] };
const names = new Set(["stage", "toolCallId", "status", "operation", "commandSha256", "requestId", "declineOffered", "outcome"]);
export function readCursorToolEvidence(rows: readonly unknown[], runId: string): CursorToolNotice[] {
  const result: CursorToolNotice[] = [];
  for (const value of rows) {
    const row = rec(value), event = rec(rec(row.payload).prpEvent), p = rec(event.payload);
    if (p.category !== "cursor_tool_evidence_v1") continue;
    const origin = rec(p.provenance);
    if (row.eventType !== "provider.notice.recorded" || row.runId !== runId || row.protocolSchemaVersion !== 1 || event.schemaVersion !== 1 || p.schema !== "paperclip.provider.notice.v1" || p.scope !== "turn" || event.schema !== "paperclip.prp.event.v1" || event.sourceKind !== "runner" || event.eventType !== row.eventType || event.runId !== runId || !id(origin.sessionId) || !id(origin.turnId) || origin.turnId !== event.turnId || !Array.isArray(p.details) || p.details.length > 12 || !Number.isSafeInteger(row.seq) || row.seq < 0 || !Number.isFinite(Date.parse(event.emittedAt))) throw new Error("Invalid Cursor evidence binding");
    const fields: Record<string, string> = {};
    for (const value of p.details) {
      const d = rec(value);
      if (d.name === "stage" && d.value === "evidence_incomplete") throw new Error("Cursor evidence is explicitly incomplete");
      if (!names.has(d.name) || Object.hasOwn(fields, d.name) || typeof d.value !== "string" || d.value.length > 1024 || d.value.includes("[REDACTED]")) throw new Error("Invalid Cursor evidence detail");
      fields[d.name] = d.value;
    }
    if (!id(fields.toolCallId) || !enums.stage.includes(fields.stage!) || origin.eventType !== fields.stage || origin.method !== (fields.stage === "tool" ? "session/update" : "session/request_permission")) throw new Error("Invalid Cursor evidence origin");
    for (const [key, values] of Object.entries(enums)) if (fields[key] !== undefined && !values.includes(fields[key]!)) throw new Error("Invalid Cursor evidence enum");
    if (fields.requestId !== undefined && !id(fields.requestId)) throw new Error("Invalid Cursor request identity");
    if (fields.commandSha256 !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(fields.commandSha256)) throw new Error("Invalid Cursor command digest");
    if (fields.declineOffered !== undefined && !["true", "false"].includes(fields.declineOffered)) throw new Error("Invalid Cursor offered choice");
    result.push({ ...fields, runId, sessionId: origin.sessionId, turnId: origin.turnId, seq: row.seq, declineOffered: fields.declineOffered === "true" } as CursorToolNotice);
  }
  if (new Set(result.map(row => row.seq)).size !== result.length) throw new Error("Duplicate Cursor evidence sequence");
  return result;
}

/** Exact absolute target removes any dependency on implicit native shell cwd. */
export function cursorDeniedCommand(path: string) {
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) throw new Error("Invalid denial target");
  const command = `printf 'MUST_NOT_EXIST' > '${path.replaceAll("'", "'\\''")}'`;
  return { command, commandSha256: `sha256:${createHash("sha256").update(command).digest("hex")}` };
}
export function hasCursorDeniedCommand(input: {
  notices: readonly CursorToolNotice[]; runId: string; turnId: string; requestId: string; toolCallId: string; commandSha256: string;
}): boolean {
  const notices = input.notices;
  const requests = notices.filter(row => row.stage === "permission_requested");
  if (requests.length !== 1) return false;
  const request = requests[0]!;
  const same = (row: CursorToolNotice) => row.runId === input.runId && row.turnId === input.turnId && row.toolCallId === input.toolCallId && row.sessionId === request.sessionId && row.commandSha256 === input.commandSha256 && row.operation === "execute";
  if (!same(request) || request.requestId !== input.requestId || !request.declineOffered) return false;
  const origins = notices.filter(row => row.stage === "tool" && row.status === "pending");
  const delivered = notices.filter(row => row.stage === "permission_delivered");
  const failed = notices.filter(row => row.stage === "tool" && row.status === "failed");
  return origins.length === 1 && same(origins[0]!) && delivered.length === 1 && same(delivered[0]!)
    && delivered[0]!.requestId === input.requestId && delivered[0]!.outcome === "reject_once"
    && failed.length === 1 && same(failed[0]!) && origins[0]!.seq < request.seq && request.seq < delivered[0]!.seq && delivered[0]!.seq < failed[0]!.seq
    && notices.every(row => same(row) && row.status !== "completed");
}

export function hasCursorCancellation(input: { run: unknown; issue: unknown; events: readonly unknown[]; runId: string; turnId: string; requestedAt: number }): boolean {
  const run = rec(input.run), cancellation = rec(rec(run.resultJson).nativeCancellation);
  const terminals = input.events.map(rec).map(row => ({ row, event: rec(rec(row.payload).prpEvent) })).filter(({ event }) => ["turn.cancelled", "turn.interrupted"].includes(event.eventType));
  return run.id === input.runId && run.status === "cancelled" && rec(input.issue).status === "in_progress"
    && cancellation.dispatchState === "acknowledged" && cancellation.dispatched === true && cancellation.scope === "run"
    && terminals.length === 1 && terminals.every(({ row, event }) => row.runId === input.runId && event.runId === input.runId && event.turnId === input.turnId
      && event.schema === "paperclip.prp.event.v1" && event.schemaVersion === 1 && row.protocolSchemaVersion === 1 && event.sourceKind === "runner"
      && Number.isFinite(input.requestedAt) && Date.parse(event.emittedAt) >= input.requestedAt);
}
