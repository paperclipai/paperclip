const SECRET_PAYLOAD_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;
const JWT_VALUE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;
export const REDACTED_EVENT_VALUE = "***REDACTED***";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (isSecretRefBinding(value)) return value;
  if (isPlainBinding(value)) return { type: "plain", value: sanitizeValue(value.value) };
  if (!isPlainObject(value)) return value;
  return sanitizeRecord(value);
}

function isSecretRefBinding(value: unknown): value is { type: "secret_ref"; secretId: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "secret_ref" && typeof value.secretId === "string";
}

function isPlainBinding(value: unknown): value is { type: "plain"; value: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "plain" && "value" in value;
}

export function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (SECRET_PAYLOAD_KEY_RE.test(key)) {
      if (isSecretRefBinding(value)) {
        redacted[key] = sanitizeValue(value);
        continue;
      }
      if (isPlainBinding(value)) {
        redacted[key] = { type: "plain", value: REDACTED_EVENT_VALUE };
        continue;
      }
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    if (typeof value === "string" && JWT_VALUE_RE.test(value)) {
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    redacted[key] = sanitizeValue(value);
  }
  return redacted;
}

export function redactEventPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) return null;
  if (!isPlainObject(payload)) return payload;
  return sanitizeRecord(payload);
}

export function redactAdapterConfigEnvForApi(env: unknown): Record<string, unknown> {
  if (!isPlainObject(env)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(env)) {
    if (typeof raw === "string") {
      out[key] = { type: "plain", hasValue: raw.length > 0 };
      continue;
    }
    if (isSecretRefBinding(raw)) {
      out[key] = { type: "secret_ref", hasValue: true };
      continue;
    }
    if (isPlainBinding(raw)) {
      const has = raw.value !== undefined && raw.value !== null && String(raw.value).length > 0;
      out[key] = { type: "plain", hasValue: has };
      continue;
    }
    const has = raw !== undefined && raw !== null;
    out[key] = { type: "unknown", hasValue: has };
  }
  return out;
}

export function redactAdapterConfigForApiResponse(
  adapterConfig: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const base = adapterConfig && isPlainObject(adapterConfig) ? { ...adapterConfig } : {};
  if (Object.prototype.hasOwnProperty.call(base, "env")) {
    base.env = redactAdapterConfigEnvForApi(base.env);
  }
  return redactEventPayload(base) ?? {};
}
