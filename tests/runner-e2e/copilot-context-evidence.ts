import { createHash } from "node:crypto";
import { readCopilotToolEvidence, type CopilotToolNotice } from "./copilot-evidence.js";
import { hasAcpxNativeOrigin } from "./acpx-native-origin.js";

type Row = Record<string, any>;
const rec = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const receiptKeys = ["callIdentitySha256", "inputSha256", "normalizedInputSha256", "operationId", "outcome", "resultSha256", "schema", "stage"].sort().join(",");
export interface CopilotBootstrapReadProof {
  toolCallId: string; pendingSeq: number; receiptSeq: number; completedSeq: number;
  canonicalSeqs: number[]; callIdentitySha256: string;
  permissionRequestId?: string;
}

export interface CopilotContextReadProof extends CopilotBootstrapReadProof { discoveries: CopilotBootstrapReadProof[] }

export const COPILOT_CONTEXT_DISCOVERY_LIMIT = 4;
/** Metadata discovery only. Keep a small lexical scope and require the context
 * identifier; arbitrary API searches, pagination loops and mutations are not
 * bootstrap actions for these authored permission/settlement cases. */
export function isCopilotContextDiscoveryProgress(value: unknown): boolean {
  const prefix = "paperclip-search_api (pending): ";
  if (typeof value !== "string" || !value.startsWith(prefix) || value.length > 120) return false;
  // Retained v17 native discovery used this exact context-only natural spelling.
  if (value === `${prefix}get task context`) return true;
  const terms = value.slice(prefix.length).split(/\s+/u);
  return terms.length > 0 && terms.length <= 4 && terms.includes("get_task_context")
    && new Set(terms).size === terms.length && terms.every(t => ["get_task_context", "paperclip_finish", "dedicated", "tool"].includes(t));
}

/** Attest context and any exact read-only tool discovery before the native action. */
export function readCopilotContextRead(rows: readonly unknown[], origin: CopilotToolNotice, required = false): CopilotContextReadProof | undefined {
  const context = readSemanticBootstrap(rows, origin, required, "get_task_context");
  if (!context) return undefined;
  const pending = readCopilotToolEvidence(rows, origin.runId).find(n => n.seq === context.pendingSeq)!;
  const searchReceipts = rows.map(rec).filter(r => {
    const p = rec(rec(rec(r.payload).prpEvent).payload);
    return p.category === "paperclip_semantic_tool_receipt_v2" && Array.isArray(p.details)
      && p.details.some((d: Row) => d.name === "operationId" && d.value === "search_api");
  });
  const nativeSearches = readCopilotToolEvidence(rows, origin.runId).filter(n => n.semanticOperationId === "search_api");
  if (searchReceipts.length > COPILOT_CONTEXT_DISCOVERY_LIMIT || searchReceipts.length !== nativeSearches.length) throw new Error("Copilot context discovery is unbounded or incomplete");
  const discoveries = searchReceipts.map(r => {
    const fields = rec(rec(rec(r.payload).prpEvent).payload).details as Row[];
    const identity = fields.find(d => d.name === "callIdentitySha256")?.value;
    if (typeof identity !== "string") throw new Error("Copilot discovery lacks its invocation identity");
    return readSemanticBootstrap(rows, pending, true, "search_api", identity)!;
  }).sort((a, b) => a.pendingSeq - b.pendingSeq);
  const identities = [context.callIdentitySha256, ...discoveries.map(d => d.callIdentitySha256)];
  if (new Set(identities).size !== identities.length) throw new Error("Copilot discovery cannot borrow another call identity");
  return { ...context, discoveries };
}
function readSemanticBootstrap(rows: readonly unknown[], origin: CopilotToolNotice, required: boolean, operationId: "get_task_context" | "search_api", selectedIdentity?: string): CopilotBootstrapReadProof | undefined {
  const discovery = operationId === "search_api";
  const fail = (): never => { throw new Error("Copilot context read lacks exact successful pre-action proof"); };
  const all = rows.map(rec), notices = readCopilotToolEvidence(rows, origin.runId);
  const matches = all.filter(r => {
    const p = rec(rec(rec(r.payload).prpEvent).payload);
    return p.category === "paperclip_semantic_tool_receipt_v2" && Array.isArray(p.details)
      && p.details.some((d: any) => d?.name === "operationId" && d.value === operationId)
      && (!selectedIdentity || p.details.some((d: any) => d?.name === "callIdentitySha256" && d.value === selectedIdentity));
  });
  const native = notices.filter(n => n.semanticOperationId === operationId && (!selectedIdentity || n.semanticCallIdentitySha256 === selectedIdentity));
  if (!matches.length && !native.length && !required) return undefined;
  if (matches.length !== 1 || native.length !== 1) fail();
  const roots = all.filter(r => r.seq === origin.seq);
  if (roots.length !== 1) fail();
  const root = roots[0]!, base = rec(rec(root.payload).prpEvent);
  const frame = (r: Row) => {
    const e = rec(rec(r.payload).prpEvent);
    if (r.companyId !== root.companyId || r.runId !== origin.runId || !Number.isSafeInteger(r.seq) || r.seq < 1
      || e.schema !== "paperclip.prp.event.v1" || e.sourceKind !== "runner" || e.eventType !== r.eventType
      || e.runId !== origin.runId || e.turnId !== origin.turnId || e.normalizedSessionId !== base.normalizedSessionId
      || typeof base.normalizedSessionId !== "string" || !base.normalizedSessionId || e.sourceInstanceId !== base.sourceInstanceId
      || typeof base.sourceInstanceId !== "string" || !base.sourceInstanceId || r.sourceInstanceId !== e.sourceInstanceId
      || r.sourceSeq !== e.sourceSeq || !Number.isSafeInteger(e.sourceSeq) || e.sourceSeq < 1) fail();
    return e;
  };
  frame(root);
  const authority = matches[0]!, receipt = rec(frame(authority).payload), provenance = rec(receipt.provenance);
  if (authority.eventType !== "provider.notice.recorded" || receipt.schema !== "paperclip.provider.notice.v1" || receipt.scope !== "turn"
    || provenance.method !== "paperclip/semantic_tool_result" || provenance.eventType !== "semantic_result"
    || provenance.sessionId !== origin.sessionId || provenance.turnId !== origin.turnId || receipt.details.length !== 8) fail();
  const fields: Record<string, string> = {};
  for (const d of receipt.details) {
    if (Object.keys(rec(d)).sort().join(",") !== "name,value" || typeof d.name !== "string" || typeof d.value !== "string" || d.value.length > 256 || Object.hasOwn(fields, d.name)) fail();
    fields[d.name] = d.value;
  }
  if (Object.keys(fields).sort().join(",") !== receiptKeys || fields.stage !== "semantic_result" || fields.schema !== "paperclip.semantic_tool_receipt.v2"
    || fields.operationId !== operationId || fields.outcome !== "returned" || fields.normalizedInputSha256 !== "null"
    || (discovery ? !/^[a-f0-9]{64}$/.test(fields.inputSha256!) : fields.inputSha256 !== createHash("sha256").update("{}").digest("hex"))
    || ![fields.callIdentitySha256, fields.resultSha256].every(v => /^[a-f0-9]{64}$/.test(v!))) fail();
  const completed = native[0]!, contextNotices = notices.filter(n => n.toolCallId === completed.toolCallId);
  const group = contextNotices.filter(n => n.stage === "tool").sort((a, b) => a.seq - b.seq);
  const permissions = contextNotices.filter(n => n.stage !== "tool");
  let permissionRequestId: string | undefined;
  if (permissions.length) {
    const requested = permissions.filter(n => n.stage === "permission_requested"), delivered = permissions.filter(n => n.stage === "permission_delivered");
    if (permissions.length !== 2 || requested.length !== 1 || delivered.length !== 1 || !requested[0]!.requestId
      || delivered[0]!.requestId !== requested[0]!.requestId || delivered[0]!.outcome !== "allow_once"
      || requested[0]!.seq >= delivered[0]!.seq || delivered[0]!.seq >= authority.seq) fail();
    permissionRequestId = requested[0]!.requestId;
    for (const n of permissions) {
      const rs = all.filter(r => r.seq === n.seq);
      if (rs.length !== 1 || n.runId !== origin.runId || n.sessionId !== origin.sessionId || n.turnId !== origin.turnId
        || n.operation !== undefined || n.target !== undefined || n.commandSha256 !== undefined || n.shellId !== undefined) fail();
      frame(rs[0]!);
    }
    const requests = all.filter(r => r.eventType === "runtime_request.created" && rec(rec(rec(r.payload).prpEvent).payload).request?.requestId === permissionRequestId);
    const closures = all.filter(r => ["runtime_request.resolved", "runtime_request.cancelled", "runtime_request.expired"].includes(r.eventType)
      && rec(rec(rec(r.payload).prpEvent).payload).requestId === permissionRequestId);
    if (requests.length !== 1 || closures.length !== 1) fail();
    // The current sidecar emits its native notice before the durable card.
    // Both origins must precede the exact closure; neither can borrow a later decision.
    const request = rec(rec(frame(requests[0]!).payload).request), resolution = rec(frame(closures[0]!).payload);
    if (request.schema !== "paperclip.runtime_request.v2" || request.type !== "permission" || request.requestKind !== "permission_approval"
      || request.prompt !== operationId || request.turnId !== origin.turnId || request.status !== "pending"
      || !(hasAcpxNativeOrigin(request.origin, "copilot", "session/request_permission") || hasAcpxNativeOrigin(request.origin, "acpx", "session/request_permission")) || resolution.action !== "accept"
      || resolution.requestKind !== "permission_approval" || resolution.turnId !== origin.turnId || closures[0]!.eventType !== "runtime_request.resolved"
      || requests[0]!.seq >= closures[0]!.seq || requested[0]!.seq >= closures[0]!.seq || closures[0]!.seq >= delivered[0]!.seq) fail();
  }
  if (group.length < 2 || group.length > 16 || completed.status !== "completed" || group.at(-1) !== completed
    || completed.semanticOutcome !== "returned" || completed.semanticCallIdentitySha256 !== fields.callIdentitySha256
    || completed.semanticInputSha256 !== fields.inputSha256 || completed.semanticResultSha256 !== fields.resultSha256 || completed.semanticNormalizedInputSha256 !== null
    || group.some((n, i) => n.stage !== "tool" || n.runId !== origin.runId || n.sessionId !== origin.sessionId || n.turnId !== origin.turnId
      || n.operation !== (discovery ? undefined : "read") || n.target !== undefined || n.commandSha256 !== undefined || n.readTargetSha256 !== undefined || n.shellId !== undefined
      || n.commandToolCallId !== undefined || n.seq >= origin.seq || (i === 0 ? n.status !== "pending" : i === group.length - 1 ? n.status !== "completed" : n.status !== "in_progress"))) fail();
  for (const n of group) {
    const rs = all.filter(r => r.seq === n.seq); if (rs.length !== 1) fail(); frame(rs[0]!);
  }
  const canonical = all.filter(r => r.eventType?.startsWith("tool.execution.") && rec(rec(rec(r.payload).prpEvent).payload).executionId === completed.toolCallId).sort((a, b) => a.seq - b.seq);
  if (canonical.length < 2 || canonical.length > 16 || new Set(canonical.map(r => r.seq)).size !== canonical.length) fail();
  for (let i = 0; i < canonical.length; i++) {
    const r = canonical[i]!, p = rec(frame(r).payload), last = i === canonical.length - 1;
    if (r.seq >= origin.seq || p.schema !== "paperclip.tool.execution.v1" || p.transport !== "builtin" || p.target !== null
      || p.name !== `paperclip-${operationId}` || p.operation !== (discovery ? "search" : "read") || p.readOnly !== true
      || (last ? r.eventType !== "tool.execution.completed" || p.status !== "completed"
        : p.status !== "running" || r.eventType !== (i === 0 ? "tool.execution.started" : "tool.execution.progressed"))) fail();
  }
  if (discovery && !isCopilotContextDiscoveryProgress(rec(frame(canonical[0]!).payload).progress)) fail();
  const pending = group[0]!;
  if (!(pending.seq < canonical[0]!.seq && canonical[0]!.seq < authority.seq && authority.seq < completed.seq && completed.seq < canonical.at(-1)!.seq
    && canonical.at(-1)!.seq < origin.seq) || !(frame(all.find(r => r.seq === pending.seq)!).sourceSeq < frame(authority).sourceSeq
      && frame(authority).sourceSeq < frame(all.find(r => r.seq === completed.seq)!).sourceSeq && frame(canonical.at(-1)!).sourceSeq < base.sourceSeq)) fail();
  return { toolCallId: completed.toolCallId, pendingSeq: pending.seq, receiptSeq: authority.seq, completedSeq: completed.seq,
    canonicalSeqs: canonical.map(r => r.seq), callIdentitySha256: fields.callIdentitySha256!, ...(permissionRequestId ? { permissionRequestId } : {}) };
}
