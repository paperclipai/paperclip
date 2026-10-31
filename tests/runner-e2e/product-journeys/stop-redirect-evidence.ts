import { createHash } from "node:crypto";
import { isBoundNativePrpEventRow } from "../native-event-envelope.js";
import { activeFollowupBoundary, type ActiveFollowupBoundary } from "./active-followup-evidence.js";

type Row = Record<string, any>;
export interface StopWorkBoundary extends ActiveFollowupBoundary {
  companyId: string;
  agentId: string;
  issueId: string;
  turnId: string;
  usageSeq: number;
  usageRowSha256: string;
  accountingSourceId: string;
  accountingSequence: number;
}
const text = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
const time = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;

/** A model turn starting does not prove work or a provider usage observation. */
export function activeStopWorkBoundary(run: Row, events: Row[]): StopWorkBoundary | null {
  const command = activeFollowupBoundary(run, events);
  if (!command) return null;
  const commandRow = events.find(row => row.seq === command.startedSeq)!;
  const turnId = commandRow.payload.prpEvent.turnId;
  const issueId = run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId;
  const accounting = run.usageJson;
  if (!text(turnId) || !text(issueId) || !text(accounting?.accountingReceiptSourceId)
    || !Number.isSafeInteger(accounting.accountingReceiptSequence) || accounting.accountingReceiptSequence <= 0) return null;
  const binding = { runId: run.id, companyId: run.companyId, agentId: run.agentId };
  const bound = (row: Row) => isBoundNativePrpEventRow(row, binding, command.sourceInstanceId);
  const turnStart = events.findLast(row => bound(row) && row.eventType === "turn.started");
  if (!turnStart || turnStart.payload.prpEvent.turnId !== turnId || turnStart.seq >= command.startedSeq) return null;
  const usage = events.findLast(row => bound(row) && row.seq > turnStart.seq && row.eventType === "item.completed"
    && row.payload.prpEvent.turnId === turnId && row.payload.prpEvent.payload?.kind === "usage");
  const report = usage?.payload.prpEvent.payload.usage;
  const delta = report?.runDelta;
  if (!usage || report?.runDeltaComplete !== true || report.usageBasis === "session_cumulative"
    || report.usageSource === "session_cumulative" || !delta || typeof delta !== "object" || Array.isArray(delta)
    || ![delta.inputTokens, delta.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)
    || !Object.entries(delta).every(([key, value]) => !key.endsWith("Tokens") || Number.isSafeInteger(value) && Number(value) >= 0)
    || !Object.entries(delta).some(([key, value]) => key.endsWith("Tokens") && Number(value) > 0)) return null;
  return { ...command, companyId: run.companyId, agentId: run.agentId, issueId, turnId,
    usageSeq: usage.seq, usageRowSha256: createHash("sha256").update(JSON.stringify(usage)).digest("hex"),
    accountingSourceId: accounting.accountingReceiptSourceId, accountingSequence: accounting.accountingReceiptSequence };
}

/**
 * Require this stopped run's actual settled accounting state, not a new receipt.
 * A receipt can already be ready before Stop, and reconciliation can change its
 * source without advancing its sequence. Neither proves or disproves settlement.
 */
export function stoppedRunAccountingFinalized(run: Row, before: StopWorkBoundary): boolean {
  const usage = run.usageJson;
  return run.id === before.runId && run.companyId === before.companyId && run.agentId === before.agentId
    && (run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId) === before.issueId
    && run.runtimeMode === "native" && run.status === "cancelled"
    && run.costAccountingPending === false && Number.isFinite(time(run.costAccountedAt))
    && usage?.accountingReceiptReady === true && text(usage.accountingReceiptId)
    && text(usage.accountingReceiptSourceId)
    && Number.isSafeInteger(usage.accountingReceiptSequence) && usage.accountingReceiptSequence > 0;
}

export const STOP_REVISION_WAIT = "Before changing any file, first run the harmless shell command printf 'Ready for revision\\n' once. Wait for that command's result. Then, in a separate shell tool call, run sleep 90 exactly once. Wait for the sleep command to finish before making the requested change. This gives me time to stop the revision while you work.";
