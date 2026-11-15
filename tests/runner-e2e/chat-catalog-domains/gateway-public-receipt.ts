import { nativeSha256 } from "../../../server/src/services/native-runtime/canonical.js";
import { REDACTED_EVENT_VALUE } from "../../../server/src/redaction.js";
import { isValidNativePrpEnvelope } from "../native-event-envelope.js";
type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const time = (value: unknown) => typeof value === "string" || value instanceof Date ? new Date(value).getTime() : NaN;
const operation = "GET /api/issues/{id}/comments";
export interface PublicReceiptBinding { companyId: string; leadId: string; canonicalRunId: string; workerId: string; workerTaskId: string; workerRunId: string }
function matchesPublicReceiptResponse(events: Row[], report: Row, comments: Row[], binding: PublicReceiptBinding) {
  if (!binding.companyId || !binding.leadId || !binding.canonicalRunId || !binding.workerId || !binding.workerTaskId || !binding.workerRunId
    || binding.workerId === binding.leadId || binding.workerRunId === binding.canonicalRunId || !report.id || typeof report.body !== "string"
    || report.companyId !== binding.companyId || report.issueId !== binding.workerTaskId || report.authorAgentId !== binding.workerId || report.createdByRunId !== binding.workerRunId
    || !Array.isArray(comments) || !comments.length || !comments.every(row => row.companyId === binding.companyId && row.issueId === binding.workerTaskId)
    || !comments.some(row => nativeSha256(row) === nativeSha256(report))) return false;
  const rows = events.flatMap(event => {
    const envelope = object(object(event.payload).prpEvent), payload = object(envelope.payload);
    return event.companyId === binding.companyId && event.agentId === binding.leadId && event.runId === binding.canonicalRunId
      && Number.isSafeInteger(Number(event.seq)) && Number(event.seq) > 0 && isValidNativePrpEnvelope(envelope, event.protocolSchemaVersion) && envelope.sourceKind === "runner"
      ? [{ event, payload }] : [];
  });
  return rows.some(({event, payload}) => {
    const item = object(payload.item), result = object(item.result);
    if (event.eventType !== "item.completed" || item.type !== "tool_result" || typeof item.id !== "string" || item.tool_use_id !== item.id || item.is_error === true
      || !Number.isFinite(time(report.createdAt)) || !Number.isFinite(time(event.createdAt)) || time(event.createdAt) < time(report.createdAt)
      || result.apiOperationId !== operation || result.ok !== true || result.status !== 200 || typeof result.contentType !== "string" || !result.contentType.includes("json")
      || result.data !== REDACTED_EVENT_VALUE || result.apiPayloadRedacted !== true || typeof result.apiPayloadSha256 !== "string" || !/^[a-f0-9]{64}$/.test(result.apiPayloadSha256)
      || Object.keys(result).some(key => !["ok", "status", "contentType", "apiOperationId", "data", "apiPayloadRedacted", "apiPayloadSha256"].includes(key))) return false;
    const starts = rows.filter(row => row.event.eventType === "item.started" && object(row.payload.item).id === item.id && object(row.payload.item).type === "tool_use" && Number(row.event.seq) < Number(event.seq));
    if (starts.length !== 1 || rows.filter(row => row.event.eventType === "item.completed" && object(row.payload.item).type === "tool_result" && object(row.payload.item).id === item.id && object(object(row.payload.item).result).apiOperationId === operation).length !== 1) return false;
    const start = starts[0]!, request = object(object(start.payload.item).input);
    if (!Number.isFinite(time(start.event.createdAt)) || time(start.event.createdAt) > time(event.createdAt)
      || object(start.payload.item).type !== "tool_use" || object(start.payload.item).name !== "call_api" || request.operationId !== operation
      || request.apiPayloadRedacted !== true || typeof request.apiPayloadSha256 !== "string" || !/^[a-f0-9]{64}$/.test(request.apiPayloadSha256)) return false;
    return nativeSha256({ ok: true, status: 200, contentType: result.contentType, retryAfter: null, data: comments, apiOperationId: operation }) === result.apiPayloadSha256;
  });
}

export function observedRedactedPublicReceipt(events: Row[], report: Row, comments: Row[], binding: PublicReceiptBinding, additionalPublicResponses: Row[][] = []) {
  return [comments, ...additionalPublicResponses].some(response => matchesPublicReceiptResponse(events, report, response, binding));
}
