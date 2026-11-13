import { and, eq } from "drizzle-orm";
import { agentTaskSessions, heartbeatRuns, nativeRunResults, type Db, type issues } from "@paperclipai/db";
import { validatePrpStructuredRunResult, type PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";
import type { PaperclipControlPlaneBinding } from "./paperclip-control-plane-port.js";
import { readRunCancellation } from "../run-cancellation.js";

/** Prepared once by heartbeat; never copied into recovery metadata or receipts. */
export interface NativeTaskSessionPublicationContext {
  taskKey: string;
  adapterType: string;
  sessionParamsJson: Record<string, unknown> | null;
}

export const NATIVE_TASK_SESSION_PUBLICATION_KEY = "nativeTaskSessionPublication";
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Outcome = "published" | "suppressed_reset" | "suppressed_newer" | "suppressed_authority" | "missing_stub" | "unsupported";
interface Receipt {
  schema: "paperclip.native-task-session-publication.v1";
  companyId: string;
  issueId: string;
  agentId: string;
  runId: string;
  taskKey: string;
  adapterType: string;
  sessionId: string;
  resultId: string;
  outcome: Outcome;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const outcomes: readonly string[] = ["published", "suppressed_reset", "suppressed_newer", "suppressed_authority", "missing_stub", "unsupported"];

function receiptFromProfile(profile: unknown): Receipt | null {
  const root = record(profile), value = record(root[NATIVE_TASK_SESSION_PUBLICATION_KEY]);
  if (value.schema !== "paperclip.native-task-session-publication.v1"
      || ![value.companyId, value.issueId, value.agentId, value.runId, value.sessionId, value.resultId].every(uuid)
      || typeof value.taskKey !== "string" || value.taskKey.length > 512
      || typeof value.adapterType !== "string" || !value.adapterType.length || value.adapterType.length > 128
      || !outcomes.includes(String(value.outcome)) || Object.keys(value).length !== 10) return null;
  const snapshot = record(root.sessionCheckpoint), identity = record(snapshot.identity);
  if (identity.runId !== value.runId || identity.companyId !== value.companyId || identity.issueId !== value.issueId
      || identity.agentId !== value.agentId || identity.sessionId !== value.sessionId) return null;
  return value as unknown as Receipt;
}

/** Only the exact server-written outcome may suppress heartbeat's late fallback. */
export function nativeTaskSessionPublicationHandled(profile: unknown, binding: {
  companyId: string; agentId: string; runId: string; taskKey: string; adapterType: string;
}): boolean {
  const receipt = receiptFromProfile(profile);
  return !!receipt && receipt.companyId === binding.companyId && receipt.agentId === binding.agentId
    && receipt.runId === binding.runId && receipt.taskKey === binding.taskKey
    && receipt.adapterType === binding.adapterType && ["published", "suppressed_reset", "suppressed_newer", "suppressed_authority", "missing_stub"].includes(receipt.outcome);
}

export function eligibleNativeTaskSessionPublication(snapshot: PersistedNativeSession): boolean {
  return snapshot.goal == null && snapshot.semanticResult != null && snapshot.terminal?.runTerminalState === "succeeded"
    && snapshot.activeTurnId == null && !(snapshot.pendingRuntimeRequests?.length);
}

export type NativeTaskSessionPublicationRun = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "nativeIssueId" | "nativeSessionId" | "status" | "resultJson" | "contextSnapshot" | "startedAt" | "createdAt" | "runnerProfileJson">;
export type NativeTaskSessionPublicationIssue = Pick<typeof issues.$inferSelect,
  "id" | "companyId" | "executionRunId" | "conversationAgentId" | "conversationSessionGeneration">;

/** Caller holds coordinator → issue NO KEY UPDATE → run. This helper owns only
 * the task-row lock and UPDATE; never starts a transaction or creates a stub. */
export async function publishNativeTaskSessionInTransaction(tx: Transaction, input: {
  binding: PaperclipControlPlaneBinding;
  context: NativeTaskSessionPublicationContext;
  snapshot: PersistedNativeSession;
  run: NativeTaskSessionPublicationRun;
  issue: NativeTaskSessionPublicationIssue | null;
  resultId: string | null;
  recoveryReady?: boolean;
}): Promise<Receipt> {
  const { binding, context, snapshot, run, issue } = input;
  const existingReceipt = receiptFromProfile(run.runnerProfileJson);
  if (existingReceipt) {
    if (existingReceipt.companyId !== binding.companyId || existingReceipt.issueId !== binding.issueId
        || existingReceipt.agentId !== binding.agentId || existingReceipt.runId !== binding.runId
        || existingReceipt.sessionId !== snapshot.identity.sessionId || existingReceipt.taskKey !== context.taskKey
        || existingReceipt.adapterType !== context.adapterType || existingReceipt.resultId !== input.resultId) {
      throw new Error("native_task_session_publication_receipt_mismatch");
    }
    return existingReceipt;
  }
  if (record(run.runnerProfileJson)[NATIVE_TASK_SESSION_PUBLICATION_KEY] !== undefined) {
    throw new Error("native_task_session_publication_receipt_invalid");
  }
  if (!input.resultId) throw new Error("native_task_session_publication_result_missing");
  const [accepted] = await tx.select({ id: nativeRunResults.id, canonicalSha256: nativeRunResults.canonicalSha256,
    turnId: nativeRunResults.turnId }).from(nativeRunResults).where(and(
    eq(nativeRunResults.id, input.resultId), eq(nativeRunResults.runId, binding.runId),
    eq(nativeRunResults.companyId, binding.companyId), eq(nativeRunResults.issueId, binding.issueId),
    eq(nativeRunResults.completionContractId, binding.completionContractId), eq(nativeRunResults.schemaStatus, "accepted"),
  )).limit(1);
  const validated = validatePrpStructuredRunResult(snapshot.semanticResult);
  if (!accepted || !validated.ok || accepted.canonicalSha256 !== nativeSha256({
    binding, result: validated.result, terminal: snapshot.terminal, turnId: accepted.turnId ?? null,
  })) throw new Error("native_task_session_publication_result_mismatch");
  const receipt = (outcome: Outcome): Receipt => ({ schema: "paperclip.native-task-session-publication.v1",
    companyId: binding.companyId, issueId: binding.issueId, agentId: binding.agentId, runId: binding.runId,
    taskKey: context.taskKey, adapterType: context.adapterType, sessionId: snapshot.identity.sessionId,
    resultId: accepted.id, outcome });
  if (context.taskKey !== binding.issueId || input.recoveryReady === false) return receipt("unsupported");
  const cancellation = record(run.resultJson?.nativeCancellation), stop = readRunCancellation(run.resultJson);
  if (!issue || ["cancelled", "interrupted", "failed", "timed_out"].includes(run.status) || issue.companyId !== binding.companyId
      || run.resultJson?.startupCancellation || (stop?.source === "operator" && stop.expected)
      || (["run", "issue"].includes(String(cancellation.scope)) && ["pending", "acknowledged"].includes(String(cancellation.dispatchState)))
      || (issue.conversationAgentId && issue.conversationAgentId !== binding.agentId)) return receipt("suppressed_authority");
  if (issue.conversationAgentId
      && run.contextSnapshot?.conversationSessionGeneration !== issue.conversationSessionGeneration) return receipt("suppressed_reset");
  if (issue.executionRunId && issue.executionRunId !== binding.runId) return receipt("suppressed_newer");
  const [session] = await tx.select({ id: agentTaskSessions.id, goalSourceId: agentTaskSessions.goalSourceId,
    lastRunId: agentTaskSessions.lastRunId }).from(agentTaskSessions).where(and(
    eq(agentTaskSessions.companyId, binding.companyId), eq(agentTaskSessions.agentId, binding.agentId),
    eq(agentTaskSessions.adapterType, context.adapterType), eq(agentTaskSessions.taskKey, context.taskKey),
  )).for("update").limit(1);
  // Supported native turns synchronously project a stub before this terminal
  // snapshot. Absence can be an operator deletion; never recreate it later.
  if (!session) return receipt("missing_stub");
  const boundSources = [binding.sourceInstanceId, binding.controlPlaneSourceInstanceId]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(source => `${source}:${binding.runId}`);
  if (!session.goalSourceId || !boundSources.includes(session.goalSourceId)) return receipt("suppressed_newer");
  if (session.lastRunId && session.lastRunId !== binding.runId) {
    const [prior] = await tx.select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
      issueId: heartbeatRuns.issueId, nativeIssueId: heartbeatRuns.nativeIssueId, finishedAt: heartbeatRuns.finishedAt,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.id, session.lastRunId)).limit(1);
    if (!prior || prior.companyId !== binding.companyId || prior.agentId !== binding.agentId
        || (prior.nativeIssueId ?? prior.issueId) !== binding.issueId || !prior.finishedAt || !run.startedAt
        || prior.finishedAt > run.startedAt) return receipt("suppressed_newer");
  }
  await tx.update(agentTaskSessions).set({
    sessionParamsJson: { ...context.sessionParamsJson, sessionId: snapshot.identity.sessionId },
    sessionDisplayId: snapshot.providerSessionId ?? snapshot.sessionId, lastRunId: binding.runId,
    lastError: null, updatedAt: new Date(),
  }).where(eq(agentTaskSessions.id, session.id));
  return receipt("published");
}
