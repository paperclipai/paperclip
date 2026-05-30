import type { CreateConfigValues } from "../../components/AgentConfigForm";

const DEFAULT_HTTP_METHOD = "POST";
const DEFAULT_HTTP_TIMEOUT_MS = 15000;
const MAX_HTTP_TIMEOUT_MS = 900000;
const ALLOWED_HTTP_METHODS = new Set(["DELETE", "OPTIONS", "PATCH", "POST", "PUT"]);
const SENSITIVE_HTTP_HEADER_RE = /^(authorization|cookie|proxy-authorization|x-api-key|x-auth-token|x-access-token)$/i;
const ENV_REFERENCE_RE = /\$\{env:[A-Za-z_][A-Za-z0-9_]*\}/;
const SENSITIVE_HEADER_TEMPLATE_RE = /^(?:Bearer\s+)?\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function normalizeHttpMethod(value: string | undefined): string {
  const method = value?.trim().toUpperCase() || DEFAULT_HTTP_METHOD;
  if (!ALLOWED_HTTP_METHODS.has(method)) {
    throw new Error(`HTTP method must be one of ${Array.from(ALLOWED_HTTP_METHODS).join(", ")}`);
  }
  return method;
}

export function parseJsonObject(value: string | undefined, fieldName: string): Record<string, unknown> | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${fieldName} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function parseHeadersObject(value: string | undefined): Record<string, string> | undefined {
  const headers = parseJsonObject(value, "HTTP headers");
  if (!headers) return undefined;
  for (const [key, headerValue] of Object.entries(headers)) {
    if (typeof headerValue !== "string") {
      throw new Error(`HTTP header ${key} must be a string`);
    }
    if (SENSITIVE_HTTP_HEADER_RE.test(key) && !SENSITIVE_HEADER_TEMPLATE_RE.test(headerValue.trim())) {
      throw new Error(`Sensitive HTTP header ${key} must use an env reference such as \${env:BRIDGE_TOKEN}`);
    }
  }
  return headers as Record<string, string>;
}

function parseEnvBindings(bindings: unknown): Record<string, unknown> {
  if (typeof bindings !== "object" || bindings === null || Array.isArray(bindings)) return {};
  const env: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(bindings)) {
    if (!ENV_KEY_RE.test(key)) continue;
    if (typeof raw === "string") {
      env[key] = { type: "plain", value: raw };
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    if (rec.type === "plain" && typeof rec.value === "string") {
      env[key] = { type: "plain", value: rec.value };
      continue;
    }
    if (rec.type === "secret_ref" && typeof rec.secretId === "string") {
      env[key] = {
        type: "secret_ref",
        secretId: rec.secretId,
        ...(typeof rec.version === "number" || rec.version === "latest"
          ? { version: rec.version }
          : {}),
      };
    }
  }
  return env;
}

function parseEnvBindingsFromValues(v: CreateConfigValues): Record<string, unknown> {
  const parsedJson = parseJsonObject(v.envBindingsJson, "Env bindings");
  if (parsedJson) return parseEnvBindings(parsedJson);
  return parseEnvBindings(v.envBindings);
}

function collectHeaderEnvReferences(headers: Record<string, string> | undefined): string[] {
  const refs = new Set<string>();
  if (!headers) return [];
  const referenceRe = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
  for (const value of Object.values(headers)) {
    referenceRe.lastIndex = 0;
    let match = referenceRe.exec(value);
    while (match) {
      if (match[1]) refs.add(match[1]);
      match = referenceRe.exec(value);
    }
  }
  return Array.from(refs);
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value <= 0) return DEFAULT_HTTP_TIMEOUT_MS;
  return Math.min(Math.floor(value), MAX_HTTP_TIMEOUT_MS);
}

export function buildHttpConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.url = v.url;
  ac.method = normalizeHttpMethod(v.httpMethod);
  ac.timeoutMs = normalizeTimeoutMs(v.httpTimeoutMs);

  const headers = parseHeadersObject(v.httpHeadersJson);
  if (headers && Object.keys(headers).length > 0) ac.headers = headers;

  const env = parseEnvBindingsFromValues(v);
  for (const key of collectHeaderEnvReferences(headers)) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) {
      throw new Error(`HTTP header references missing environment variable: ${key}`);
    }
  }
  if (Object.keys(env).length > 0) ac.env = env;

  const payloadTemplate = parseJsonObject(v.payloadTemplateJson, "Payload template");
  if (payloadTemplate && Object.keys(payloadTemplate).length > 0) ac.payloadTemplate = payloadTemplate;

  return ac;
}
