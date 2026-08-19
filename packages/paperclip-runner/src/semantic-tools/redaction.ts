import type { CapabilityJsonValue } from "../mock-core/capability-control-plane-types.js";

const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|passwd|private.?key|secret|token|api.?key|connection.?string)/i;
const SECRET_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\b(?:sk|pk|pcgw|ghp|github_pat)_[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;
const SECRET_QUERY_DETECT = /[?&](?:code|key|secret|state|token|api[_-]?key|access[_-]?token)=[^&#\s]+/i;
const SECRET_QUERY = /([?&](?:code|key|secret|state|token|api[_-]?key|access[_-]?token)=)[^&#\s]+/gi;

export const CAPABILITY_REDACTED = "[REDACTED]";

export function containsProtectedSemanticData(value: unknown, key = ""): boolean {
  if (SENSITIVE_KEY.test(key)) return true;
  if (typeof value === "string") {
    return SECRET_VALUE.test(value) || SECRET_QUERY_DETECT.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((child) => containsProtectedSemanticData(child));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([childKey, child]) =>
      containsProtectedSemanticData(child, childKey),
    );
  }
  return false;
}

export function redactSemanticValue(value: unknown, key = ""): CapabilityJsonValue {
  if (SENSITIVE_KEY.test(key)) return CAPABILITY_REDACTED;
  if (typeof value === "string") {
    return value
      .replace(SECRET_VALUE, CAPABILITY_REDACTED)
      .replace(SECRET_QUERY, `$1${CAPABILITY_REDACTED}`);
  }
  if (Array.isArray(value)) return value.map((child) => redactSemanticValue(child));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        redactSemanticValue(child, childKey),
      ]),
    );
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  return String(value);
}
