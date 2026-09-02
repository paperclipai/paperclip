import { redactCommandText } from "@paperclipai/adapter-utils";

const SECRET_FIELD_NAME_PATTERN =
  String.raw`[A-Za-z0-9_-]*(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring|browser[-_]?code|login[-_]?url)[A-Za-z0-9_-]*`;

const SECRET_PAYLOAD_KEY_RE = new RegExp(SECRET_FIELD_NAME_PATTERN, "i");
// Authorization reasons are policy decision codes, not credentials. They must
// remain visible in audit receipts even though the field name contains
// "authorization". JWT-shaped values are still caught by the value guard below.
const AUDIT_REASON_PAYLOAD_KEY_RE = /^authorizationReason$/;
const AUDIT_SURFACE_PAYLOAD_KEY_RE = /^surface$/;
/**
 * Cleanup counts on a connection-removal receipt (PAP-17119). Their names name
 * the thing they counted — secrets, bindings, tokens — so the key guard above
 * would blank the whole receipt and leave the operator unable to see what a
 * revocation actually tore down. They pass only while the value really is a
 * finite number, so nothing that could carry material rides through on the
 * strength of a familiar key name.
 */
const AUDIT_COUNT_PAYLOAD_KEYS = new Set([
  "secretsRevoked",
  "secretsRetainedShared",
  "credentialRefsCleared",
  "secretBindingsRemoved",
  "tokenIssuanceHashesCleared",
  "gatewayTokensRevoked",
]);

function isAuditCountField(key: string, value: unknown): boolean {
  return AUDIT_COUNT_PAYLOAD_KEYS.has(key) && typeof value === "number" && Number.isFinite(value);
}
const COMMAND_PAYLOAD_KEY_RE =
  /(^command$|^cmd$|command[-_]?line|resolved[-_]?command|PAPERCLIP_RESOLVED_COMMAND)/i;
const COMMAND_ARGS_PAYLOAD_KEY_RE = /^(commandArgs|command_?args|argv)$/i;
const JWT_VALUE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;
// Durable protocol schema identifiers share JWT's broad dotted shape but are
// public discriminators, not credentials. Exempt only the closed Paperclip
// schema namespace while retaining the existing fail-closed JWT value guard.
const PAPERCLIP_SCHEMA_ID_RE = /^paperclip\.[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.v\d+$/;
const NATIVE_RUN_SPAN_SCHEMA = "paperclip.run-performance-span.v1";
const NATIVE_RUN_SPAN_FIELDS = ["span", "parentSpan"] as const;
const NATIVE_RUN_SPAN_NAMES = new Set([
  "agent.turn",
  "environment.acquire",
  "environment.startup",
  "environment.workspace.realize",
  "native.coordinator.claim",
  "native.result.finalize",
  "native.session.execute",
  "provider.session.continuity_break",
  "provider.session.resume",
  "provider.time_to_first_agent_event",
  "provider.turn.queue",
  "runner.artifact.discover",
  "runner.artifact.prepare",
  "runner.prp.route.register",
  "runner.runtime.stage",
  "runner.session.bootstrap",
  "runner.session.resume",
  "runner.session.startup",
  "runner.transport.connect",
  "runner.transport.selected",
  "runner.turn.submit",
  "task.prepare",
  "task.run",
  "task.run.measured",
  "task.settle",
]);
const CLI_SECRET_FLAG_RE = new RegExp(String.raw`^-{1,2}${SECRET_FIELD_NAME_PATTERN}$`, "i");
const JSON_SECRET_FIELD_TEXT_RE = new RegExp(
  String.raw`((?:"|')?${SECRET_FIELD_NAME_PATTERN}(?:"|')?\s*:\s*(?:"|'))[^"'` + "`" + String.raw`\r\n]+((?:"|'))`,
  "gi",
);
const ESCAPED_JSON_SECRET_FIELD_TEXT_RE = new RegExp(
  String.raw`((?:\\")?${SECRET_FIELD_NAME_PATTERN}(?:\\")?\s*:\s*(?:\\"))[^\\\r\n]+((?:\\"))`,
  "gi",
);
const SECRET_TEXT_HINTS = [
  "api",
  "key",
  "token",
  "auth",
  "bearer",
  "secret",
  "pass",
  "credential",
  "jwt",
  "private",
  "cookie",
  "connectionstring",
  "sk-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
] as const;
export const REDACTED_EVENT_VALUE = "***REDACTED***";

function maybeContainsSecretText(input: string) {
  const lower = input.toLowerCase();
  return SECRET_TEXT_HINTS.some((hint) => lower.includes(hint)) || input.includes(".");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (isSecretRefBinding(value)) return value;
  if (isUserSecretRefBinding(value)) return value;
  if (isPlainBinding(value)) return { type: "plain", value: sanitizeValue(value.value) };
  if (!isPlainObject(value)) return value;
  return sanitizeRecord(value);
}

function isSecretRefBinding(value: unknown): value is { type: "secret_ref"; secretId: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "secret_ref" && typeof value.secretId === "string";
}

function isUserSecretRefBinding(value: unknown): value is { type: "user_secret_ref"; key: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "user_secret_ref" && typeof value.key === "string";
}

function isPlainBinding(value: unknown): value is { type: "plain"; value: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "plain" && "value" in value;
}

function sanitizeCommandArgs(args: unknown[]): unknown[] {
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return REDACTED_EVENT_VALUE;
    }
    if (typeof arg !== "string") return sanitizeValue(arg);
    if (CLI_SECRET_FLAG_RE.test(arg.trim())) {
      redactNext = true;
      return arg;
    }
    return redactSensitiveText(arg);
  });
}

export function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (COMMAND_ARGS_PAYLOAD_KEY_RE.test(key) && Array.isArray(value)) {
      redacted[key] = sanitizeCommandArgs(value);
      continue;
    }
    if (COMMAND_PAYLOAD_KEY_RE.test(key) && typeof value === "string") {
      redacted[key] = redactSensitiveText(value);
      continue;
    }
    if (
      SECRET_PAYLOAD_KEY_RE.test(key)
      && !AUDIT_REASON_PAYLOAD_KEY_RE.test(key)
      && !isAuditCountField(key, value)
    ) {
      if (isSecretRefBinding(value)) {
        redacted[key] = sanitizeValue(value);
        continue;
      }
      if (isUserSecretRefBinding(value)) {
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
    if (
      typeof value === "string"
      && JWT_VALUE_RE.test(value)
      && !PAPERCLIP_SCHEMA_ID_RE.test(value)
      && !AUDIT_SURFACE_PAYLOAD_KEY_RE.test(key)
    ) {
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
  const sanitized = sanitizeRecord(payload);
  if (payload.schema !== NATIVE_RUN_SPAN_SCHEMA) return sanitized;

  // Native run span identities are controlled diagnostics emitted by
  // createNativeRunTrace, not provider data. Their dotted names overlap the
  // broad JWT-value heuristic, so restore only these two fields on the exact
  // run-performance schema. Hostnames and JWT-shaped values on every other
  // field and schema still fail closed through sanitizeRecord above.
  for (const field of NATIVE_RUN_SPAN_FIELDS) {
    const value = payload[field];
    if (typeof value === "string" && NATIVE_RUN_SPAN_NAMES.has(value)) {
      sanitized[field] = value;
    }
  }
  return sanitized;
}

export function redactSensitiveText(input: string): string {
  if (!maybeContainsSecretText(input)) return input;
  return redactCommandText(
    input
      .replace(JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`)
      .replace(ESCAPED_JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`),
    REDACTED_EVENT_VALUE,
  );
}
