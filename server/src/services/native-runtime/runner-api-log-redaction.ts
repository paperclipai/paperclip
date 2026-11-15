import { REDACTED_EVENT_VALUE } from "../../redaction.js";
import { nativeSha256 } from "./canonical.js";

const RECEIPT_FIELDS = new Set(["operationId", "apiOperationId", "callId", "ok", "status", "contentType"]);
const REDACTED_FIELDS = new Set([...RECEIPT_FIELDS, "data", "apiPayloadRedacted", "apiPayloadSha256", "costRange"]);
// Company cost reports accept only a date range (from, to) or a period. Those values name no record and carry no
// secret, so the saved receipt keeps them: a reader can then tell which accounting window a redacted read covered.
const COST_REPORT_OPERATION = /^GET \/api\/companies\/\{companyId\}\/costs\/[a-z-]+$/;
const REPORT_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const CASE_OPERATIONS = new Set(["create_case", "read_case", "update_case", "read_case_document", "write_case_document", "list_workflows", "read_workflow", "create_workflow", "update_workflow"]);
// Generic API tools whose arguments can carry request values even when malformed.
const API_TOOLS = new Set(["call_api", "save_api_response"]);
const SCHEMA_DENIAL_STRINGS = ["provider", "operationId", "callId", "message", "inputSchemaGuidance"];
const SCHEMA_DENIAL_FIELDS = new Set([...SCHEMA_DENIAL_STRINGS, "code", "paperclipExecuted"]);

/** Only use after the PRP event's run and source bindings have been checked. */
export function redactRunnerApiEvent<T extends { eventType: string; sourceKind: string; payload: unknown }>(event: T): T {
  const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
  // These scalar fields are authored by the runner's validation boundary, not
  // an API request or result. Never apply this exception inside arbitrary data.
  if (event.sourceKind === "runner" && event.eventType === "harness.diagnostic"
    && payload.code === "semantic_tool_denied" && payload.paperclipExecuted === false
    && Object.keys(payload).every(key => SCHEMA_DENIAL_FIELDS.has(key))
    && SCHEMA_DENIAL_STRINGS.every(key => typeof payload[key] === "string"
      && payload[key].length > 0 && payload[key].length <= 512 && /^[\x20-\x7e]+$/.test(payload[key]))) {
    return { ...redactRunnerApiPayloads(event), payload: event.payload };
  }
  return redactRunnerApiPayloads(event);
}

function costRangeReceipt(entry: Record<string, unknown>): Record<string, string> | undefined {
  const source = "costRange" in entry ? entry.costRange : COST_REPORT_OPERATION.test(String(entry.operationId ?? "")) ? entry.query ?? {} : undefined;
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  const range: Record<string, string> = {};
  for (const key of ["from", "to", "period"] as const) {
    const item = (source as Record<string, unknown>)[key];
    if (item === undefined) continue;
    if (typeof item !== "string" || (key === "period" ? item !== "all" && item !== "month" : !REPORT_DATE.test(item))) return undefined;
    range[key] = item;
  }
  return range;
}

function redactedPayload(value: unknown) {
  const entry = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const wasRedacted = entry.data === REDACTED_EVENT_VALUE && entry.apiPayloadRedacted === true
    && typeof entry.apiPayloadSha256 === "string" && /^[a-f0-9]{64}$/.test(entry.apiPayloadSha256)
    && Object.keys(entry).every(key => REDACTED_FIELDS.has(key));
  const costRange = costRangeReceipt(entry);
  return {
    ...Object.fromEntries(Object.entries(entry).filter(([key, item]) => RECEIPT_FIELDS.has(key)
      && ["string", "number", "boolean"].includes(typeof item))),
    ...(costRange ? { costRange } : {}),
    data: REDACTED_EVENT_VALUE,
    apiPayloadRedacted: true,
    apiPayloadSha256: wasRedacted ? entry.apiPayloadSha256 : nativeSha256(value),
  };
}

export function redactRunnerApiPayloads<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactRunnerApiPayloads) as T;
  if (typeof value === "string" && /^[\s]*[\[{]/.test(value)) {
    try {
      const parsed = JSON.parse(value);
      const redacted = redactRunnerApiPayloads(parsed);
      return (JSON.stringify(parsed) === JSON.stringify(redacted) ? value : JSON.stringify(redacted)) as T;
    } catch { return value; }
  }
  if (!value || typeof value !== "object") return value;
  const entry = value as Record<string, unknown>;
  const operation = entry.apiOperationId ?? entry.operationId;
  if (API_TOOLS.has(String(operation)) || CASE_OPERATIONS.has(String(operation)) || (typeof operation === "string" && /^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE) \/api\//.test(operation))) {
    return redactedPayload(value) as T;
  }
  if (entry.type === "tool_use" && (API_TOOLS.has(String(entry.name)) || CASE_OPERATIONS.has(String(entry.name)))) {
    return { ...entry, input: redactedPayload(entry.input) } as T;
  }
  return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, redactRunnerApiPayloads(item)])) as T;
}
