import { IncomingMessage, ServerResponse } from "node:http";

export const HEADER_REDACTION_MARKER = "[Redacted]";
const VALUE_REDACTION_MARKER = "[REDACTED]";

const CIRCULAR_MARKER = "[Circular]";
const HTTP_OBJECT_MARKER = "[HttpObject]";
const UNREADABLE_MARKER = "[Unreadable]";

const REDACTION_MAX_DEPTH = 6;

const CREDENTIAL_HEADER_NAMES = [
  "authorization",
  "x-paperclip-source-run-token",
  "proxy-authorization",
  "cookie",
  // "set-cookie" is normally a response header; keep the request-side
  // path as defensive coverage in case a proxy forwards it inbound.
  "set-cookie",
  // Credential- and session-paired headers with no debugging value.
  "x-csrf-token",
  "x-xsrf-token",
  "x-api-key",
  // Cloud proxy credentials and signed assertions authorize tenant access.
  "x-paperclip-cloud-tenant-token",
  "x-paperclip-cloud-session-id",
  "x-paperclip-cloud-runtime-identity",
  "x-paperclip-cloud-control",
  "x-paperclip-cloud-inspection",
  // Runtime GitHub capabilities authorize credential acquisition for a live run.
  "x-paperclip-github-capability",
  "x-paperclip-runner-scope-token",
  // Telegram's optional webhook verification header is a reusable bearer
  // secret sent on every provider callback.
  "x-telegram-bot-api-secret-token",
  "x-paperclip-tool-gateway-token",
] as const;

const CREDENTIAL_LOG_FIELD_NAMES = [
  "gatewayToken",
  "gateway_token",
  "toolGatewayToken",
  "tool_gateway_token",
  "sessionToken",
  "session_token",
] as const;

function redactPath(container: string, name: string): string {
  const segment = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? container === ""
      ? name
      : `.${name}`
    : `["${name}"]`;
  return `${container}${segment}`;
}

export const HTTP_LOG_REDACT_PATHS: readonly string[] = [
  ...CREDENTIAL_HEADER_NAMES.flatMap((name) => [
    redactPath("req.headers", name),
    redactPath("res.headers", name),
  ]),
  ...CREDENTIAL_HEADER_NAMES.map((name) => redactPath("", name)),
  ...CREDENTIAL_LOG_FIELD_NAMES.map((name) => redactPath("", name)),
  // The structured failure logger adds a sanitized request-body copy under
  // `reqBody`. Keep the standard connector credential envelope covered again
  // at the final serialization boundary in case a future custom serializer
  // bypasses the recursive redactor.
  "reqBody.credentials",
  "errorContext.details.credentials",
  "res.headers.location",
];

function isHttpObject(val: unknown): boolean {
  if (!val || typeof val !== "object") return false;
  if (val instanceof IncomingMessage || val instanceof ServerResponse) {
    return true;
  }
  const v = val as Record<string, unknown>;
  if (typeof v.setHeader === "function" && typeof v.end === "function") {
    return true;
  }
  if (
    typeof v.pipe === "function" &&
    (v.headers || v.socket || v._readableState)
  ) {
    return true;
  }
  return false;
}

function summarizeHttpObject(value: unknown): Record<string, unknown> {
  const v = (value ?? {}) as Record<string, unknown>;
  const summary: Record<string, unknown> = { type: HTTP_OBJECT_MARKER };
  if (typeof v.method === "string") summary.method = v.method;
  if (typeof v.statusCode === "number") summary.statusCode = v.statusCode;
  return summary;
}

function normalizeCredentialName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_]/g, "");
}

const KNOWN_CREDENTIAL_NAMES: ReadonlySet<string> = new Set<string>(
  [...CREDENTIAL_HEADER_NAMES, ...CREDENTIAL_LOG_FIELD_NAMES].map(
    normalizeCredentialName,
  ),
);

function isKnownCredentialName(name: string): boolean {
  return KNOWN_CREDENTIAL_NAMES.has(normalizeCredentialName(name));
}

const CREDENTIAL_HEADER_PATTERN =
  /(^|[-_])(authorization|cookie|secret|session[-_]?token|auth[-_]?token|token|capability|signature|credential)([-_]|$)|(^|[-_])api[-_]?key([-_]|$)/i;

function isCredentialBearingHeader(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (isKnownCredentialName(normalized)) return true;
  return CREDENTIAL_HEADER_PATTERN.test(normalized);
}

export function redactSensitiveHeaders(
  headers: Record<string, unknown>,
): Record<string, unknown> {
  if (!headers || typeof headers !== "object") return headers;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = isCredentialBearingHeader(key) ? HEADER_REDACTION_MARKER : value;
  }
  return out;
}

const AUTH_VALUE = String.raw`(<[^>\s]*>|\[[^\]\s]*\]|[A-Za-z0-9_~+/=-]+(?:\.[A-Za-z0-9_~+/=-]+)*)`;

const BEARER_PATTERN = new RegExp(String.raw`\b(Bearer)(\s+)${AUTH_VALUE}`, "gi");

const LABELLED_AUTH_PATTERN = new RegExp(
  String.raw`(\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:Basic|Digest))(\s+)${AUTH_VALUE}`,
  "gi",
);

const GATEWAY_TOKEN_PATTERN = /\bpcg[wt]_[A-Za-z0-9-]+\.[A-Za-z0-9_-]{8,}/g;

const URL_CREDENTIAL_QUERY_PATTERN =
  /([?&](?:token|sessionToken|gatewayToken|gateway_token|toolGatewayToken|tool_gateway_token|x-paperclip-tool-gateway-token|access_token|refresh_token|secret|api_key)=)[^&#\s]+/gi;

const NON_CREDENTIAL_AUTH_VALUES: ReadonlySet<string> = new Set([
  "absent",
  "auth",
  "authentication",
  "authorization",
  "credential",
  "credentials",
  "expired",
  "header",
  "headers",
  "invalid",
  "missing",
  "present",
  "required",
  "scheme",
  "secret",
  "token",
  "tokens",
  "value",
]);

function isCredentialLikeAuthValue(value: string): boolean {
  if (/^<[^>]*>$/.test(value) || /^\[[^\]]*\]$/.test(value)) return false;
  return !NON_CREDENTIAL_AUTH_VALUES.has(value.toLowerCase());
}

export function sanitizeCredentialText(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  const redactAuthValue = (match: string, prefix: string, gap: string, value: string) =>
    isCredentialLikeAuthValue(value) ? `${prefix}${gap}${VALUE_REDACTION_MARKER}` : match;
  return text
    .replace(BEARER_PATTERN, redactAuthValue)
    .replace(LABELLED_AUTH_PATTERN, redactAuthValue)
    .replace(GATEWAY_TOKEN_PATTERN, VALUE_REDACTION_MARKER)
    .replace(URL_CREDENTIAL_QUERY_PATTERN, `$1${VALUE_REDACTION_MARKER}`);
}

export function sanitizeErrorObject(err: unknown): unknown {
  try {
    return sanitizeErrorValue(err, 0, new WeakSet());
  } catch {
    return UNREADABLE_ERROR;
  }
}

export const UNREADABLE_ERROR = Object.freeze({ type: "Error", message: UNREADABLE_MARKER });

function sanitizeErrorValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return sanitizeCredentialText(value);
  if (!value || typeof value !== "object") return value;
  if (isHttpObject(value)) return summarizeHttpObject(value);
  if (seen.has(value)) return CIRCULAR_MARKER;
  if (depth > REDACTION_MAX_DEPTH) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => sanitizeErrorValue(entry, depth + 1, seen));
    }
    return sanitizeErrorRecord(value, depth, seen);
  } finally {
    seen.delete(value);
  }
}

function sanitizeErrorRecord(
  err: object,
  depth: number,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const error = err as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (err instanceof Error) {
    out.type = error.name || "Error";
    out.message =
      typeof err.message === "string"
        ? sanitizeCredentialText(err.message)
        : err.message;
    if (typeof err.stack === "string") {
      out.stack = sanitizeCredentialText(err.stack);
    }
  } else {
    if (typeof error.type === "string") {
      out.type = error.type;
    } else if (typeof error.name === "string") {
      out.type = error.name;
    }
    if (typeof error.message === "string") {
      out.message = sanitizeCredentialText(error.message);
    }
    if (typeof error.stack === "string") {
      out.stack = sanitizeCredentialText(error.stack);
    }
  }

  for (const [key, value] of Object.entries(error)) {
    if (
      key === "message" ||
      key === "stack" ||
      key === "type" ||
      key === "name"
    ) {
      continue;
    }
    out[key] = isCredentialBearingHeader(key)
      ? VALUE_REDACTION_MARKER
      : sanitizeErrorValue(value, depth + 1, seen);
  }
  return out;
}

const SERIALIZER_OWNED_KEYS: ReadonlySet<string> = new Set(["req", "res", "err"]);

export function redactCredentialFields(value: unknown): unknown {
  try {
    return redactFieldsValue(value, 0, new WeakSet());
  } catch {
    return value;
  }
}

function readFieldValue(source: object, key: string | number): unknown {
  try {
    return (source as Record<string | number, unknown>)[key];
  } catch {
    return UNREADABLE_MARKER;
  }
}

function redactFieldsEntry(
  entry: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  try {
    return redactFieldsValue(entry, depth, seen);
  } catch {
    return UNREADABLE_MARKER;
  }
}

function probeType(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

function redactFieldsValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return sanitizeCredentialText(value);
  if (!value || typeof value !== "object") return value;
  if (probeType(() => value instanceof Error)) return value;
  if (probeType(() => isHttpObject(value))) {
    try {
      return summarizeHttpObject(value);
    } catch {
      return UNREADABLE_MARKER;
    }
  }
  if (seen.has(value)) return CIRCULAR_MARKER;
  if (depth >= REDACTION_MAX_DEPTH) return HEADER_REDACTION_MARKER;

  let keys: readonly (string | number)[];
  try {
    keys = Array.isArray(value)
      ? Array.from({ length: value.length }, (_unused, index) => index)
      : Object.keys(value);
  } catch {
    return depth === 0 ? value : UNREADABLE_MARKER;
  }

  seen.add(value);
  try {
    let changed = false;
    const out: Record<string | number, unknown> = Array.isArray(value)
      ? ([] as unknown as Record<string | number, unknown>)
      : {};
    for (const key of keys) {
      if (typeof key === "string" && isKnownCredentialName(key)) {
        const entry = readFieldValue(value, key);
        out[key] = entry === VALUE_REDACTION_MARKER
          ? VALUE_REDACTION_MARKER
          : HEADER_REDACTION_MARKER;
        if (out[key] !== entry) changed = true;
        continue;
      }
      const entry = readFieldValue(value, key);
      if (entry === UNREADABLE_MARKER) {
        out[key] = UNREADABLE_MARKER;
        changed = true;
        continue;
      }
      if (
        depth === 0 &&
        typeof key === "string" &&
        SERIALIZER_OWNED_KEYS.has(key) &&
        probeType(() => isHttpObject(entry))
      ) {
        out[key] = entry;
        continue;
      }
      const next = redactFieldsEntry(entry, depth + 1, seen);
      if (next !== entry) changed = true;
      out[key] = next;
    }
    return changed ? out : value;
  } finally {
    seen.delete(value);
  }
}
