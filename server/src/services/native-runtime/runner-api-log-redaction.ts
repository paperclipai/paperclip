import { REDACTED_EVENT_VALUE } from "../../redaction.js";
import { nativeSha256 } from "./canonical.js";

const RECEIPT_FIELDS = new Set(["operationId", "apiOperationId", "callId", "ok", "status", "contentType"]);
const REDACTED_FIELDS = new Set([...RECEIPT_FIELDS, "data", "apiPayloadRedacted", "apiPayloadSha256"]);

function redactedPayload(value: unknown) {
  const entry = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const wasRedacted = entry.data === REDACTED_EVENT_VALUE && entry.apiPayloadRedacted === true
    && typeof entry.apiPayloadSha256 === "string" && /^[a-f0-9]{64}$/.test(entry.apiPayloadSha256)
    && Object.keys(entry).every(key => REDACTED_FIELDS.has(key));
  return {
    ...Object.fromEntries(Object.entries(entry).filter(([key, item]) => RECEIPT_FIELDS.has(key)
      && ["string", "number", "boolean"].includes(typeof item))),
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
  if (operation === "call_api" || (typeof operation === "string" && /^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE) \/api\//.test(operation))) {
    return redactedPayload(value) as T;
  }
  if (entry.type === "tool_use" && entry.name === "call_api") {
    return { ...entry, input: redactedPayload(entry.input) } as T;
  }
  return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, redactRunnerApiPayloads(item)])) as T;
}
