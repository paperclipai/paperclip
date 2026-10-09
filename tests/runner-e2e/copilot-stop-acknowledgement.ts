import { createHash } from "node:crypto";
import { canonicalJson } from "../../packages/shared/src/portability-hash.js";

type Row = Record<string, any>;
export interface CopilotStopScope { companyId: string; runId: string; issueId: string; callerUserId: string }
export interface CopilotStopAcknowledgement extends CopilotStopScope {
  schema: "paperclip.e2e.copilot-stop-acknowledgement.v1";
  fixtureCorrelationId: string; dispatchMonotonicNs: string; apiResponseObservedMonotonicNs: string;
  intentId: string; intentAuditId: string; acknowledgementAuditId: string; responseMetadataSha256: string;
}
const rec = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v);
const mono = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,29}$/u.test(v);

/** Current mainline's board-only cancel API generates the intent itself. Record
 * its response after the retained pre-Stop observation; never invent support
 * for a caller-supplied cancellation UUID or infer a response from later rows. */
export function readCopilotStopAcknowledgement(runInput: unknown, scope: CopilotStopScope, fixtureCorrelationId: string,
  dispatchMonotonicNs: string, apiResponseObservedMonotonicNs = process.hrtime.bigint().toString()): CopilotStopAcknowledgement {
  const invalid = () => new Error("Copilot Stop acknowledgement lacks exact current-mainline caller and scope");
  const run = rec(runInput), result = rec(run.resultJson), stop = rec(result.nativeCancellation), startup = rec(result.startupCancellation), cancellation = rec(result.cancellation);
  if (!Object.values(scope).every(id) || !uuid(fixtureCorrelationId) || !mono(dispatchMonotonicNs) || !mono(apiResponseObservedMonotonicNs)
    || BigInt(apiResponseObservedMonotonicNs) <= BigInt(dispatchMonotonicNs)
    || run.id !== scope.runId || run.companyId !== scope.companyId || run.nativeIssueId !== scope.issueId || run.runtimeMode !== "native" || run.status !== "cancelled"
    || result.cancelledByActorType !== "user" || result.cancelledByUserId !== scope.callerUserId
    || cancellation.source !== "operator" || cancellation.expected !== true || rec(cancellation.initiator).type !== "user" || rec(cancellation.initiator).id !== scope.callerUserId
    || typeof startup.requestedAt !== "string" || !Number.isFinite(Date.parse(startup.requestedAt)) || startup.beforeNativeSelection !== false
    || stop.schema !== "paperclip.native-cancellation.v1" || stop.runId !== scope.runId || stop.companyId !== scope.companyId || stop.issueId !== scope.issueId
    || typeof stop.intentId !== "string" || !stop.intentId.startsWith("native-cancellation:") || !uuid(stop.intentId.slice("native-cancellation:".length))
    || stop.scope !== "run" || stop.dispatched !== true || stop.dispatchState !== "acknowledged" || stop.reasonCode !== "cancellation_run_only"
    || !Array.isArray(stop.effects) || stop.effects.length !== 1 || stop.effects[0] !== "release_run_resources"
    || !id(stop.intentAuditId) || !id(stop.acknowledgementAuditId) || stop.intentAuditId === stop.acknowledgementAuditId) throw invalid();
  const metadata = { id: run.id, companyId: run.companyId, nativeIssueId: run.nativeIssueId, runtimeMode: run.runtimeMode, status: run.status,
    cancelledByActorType: result.cancelledByActorType, cancelledByUserId: result.cancelledByUserId, cancellation, startupCancellation: startup, nativeCancellation: stop };
  return { schema: "paperclip.e2e.copilot-stop-acknowledgement.v1", ...scope, fixtureCorrelationId, dispatchMonotonicNs, apiResponseObservedMonotonicNs,
    intentId: stop.intentId, intentAuditId: stop.intentAuditId, acknowledgementAuditId: stop.acknowledgementAuditId,
    responseMetadataSha256: `sha256:${createHash("sha256").update(canonicalJson(metadata)).digest("hex")}` };
}

export function assertCopilotStopAcknowledgement(proof: CopilotStopAcknowledgement, run: unknown, scope: CopilotStopScope,
  fixtureCorrelationId: string, dispatchMonotonicNs: string): void {
  if (!proof || proof.schema !== "paperclip.e2e.copilot-stop-acknowledgement.v1") throw new Error("Copilot Stop acknowledgement response was not retained");
  const current = readCopilotStopAcknowledgement(run, scope, fixtureCorrelationId, dispatchMonotonicNs, proof.apiResponseObservedMonotonicNs);
  if (canonicalJson(proof) !== canonicalJson(current)) throw new Error("Copilot Stop acknowledgement changed after the API response");
}
