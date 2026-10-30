export const REDACTED_ENVIRONMENT_CUSTOM_IMAGE_VALUE = "[redacted]";

const SENSITIVE_KEY_PATTERNS = [
  /auth/i,
  /credential/i,
  /host/i,
  /ip/i,
  /^key$/i,
  /lease/i,
  /password/i,
  /private.?key/i,
  /sandbox.?id/i,
  /secret/i,
  /template.?ref/i,
  /token/i,
  /url/i,
];

const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const SSH_COMMAND_PATTERN = /\bssh\s+[-\w@.:/]+\b/i;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  if (key.endsWith("Redacted")) return false;
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function redactSensitivePrimitive(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (IPV4_PATTERN.test(value) || SSH_COMMAND_PATTERN.test(value)) {
    return REDACTED_ENVIRONMENT_CUSTOM_IMAGE_VALUE;
  }
  return value;
}

export function redactEnvironmentCustomImageValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => redactEnvironmentCustomImageValue(entry)) as T;
  }

  if (!isPlainRecord(value)) {
    return redactSensitivePrimitive(value) as T;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key)
      ? REDACTED_ENVIRONMENT_CUSTOM_IMAGE_VALUE
      : redactEnvironmentCustomImageValue(entry);
  }
  return redacted as T;
}

export interface EnvironmentCustomImageTemplateRedactionInput {
  templateRef?: string | null;
  sourceTemplateRef?: string | null;
  metadata?: Record<string, unknown> | null;
}

export function redactEnvironmentCustomImageTemplate<
  T extends EnvironmentCustomImageTemplateRedactionInput,
>(template: T): T {
  return {
    ...template,
    templateRef: template.templateRef == null ? template.templateRef : REDACTED_ENVIRONMENT_CUSTOM_IMAGE_VALUE,
    sourceTemplateRef: template.sourceTemplateRef == null
      ? template.sourceTemplateRef
      : REDACTED_ENVIRONMENT_CUSTOM_IMAGE_VALUE,
    metadata: template.metadata == null
      ? template.metadata
      : redactEnvironmentCustomImageValue(template.metadata),
  };
}

export interface EnvironmentCustomImageSetupSessionRedactionInput {
  providerLeaseId?: string | null;
  baseTemplateRef?: string | null;
  connectionSecretRef?: string | null;
  connectionSummary?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export function redactEnvironmentCustomImageSetupSession<
  T extends EnvironmentCustomImageSetupSessionRedactionInput,
>(session: T): T {
  const connectionSummary = session.connectionSummary == null
    ? session.connectionSummary
    : {
        ...redactEnvironmentCustomImageValue(session.connectionSummary),
        ...(
          Object.prototype.hasOwnProperty.call(session.connectionSummary, "username")
            ? { username: REDACTED_ENVIRONMENT_CUSTOM_IMAGE_VALUE }
            : {}
        ),
      };
  return {
    ...session,
    providerLeaseId: session.providerLeaseId == null
      ? session.providerLeaseId
      : REDACTED_ENVIRONMENT_CUSTOM_IMAGE_VALUE,
    baseTemplateRef: session.baseTemplateRef == null
      ? session.baseTemplateRef
      : REDACTED_ENVIRONMENT_CUSTOM_IMAGE_VALUE,
    connectionSecretRef: session.connectionSecretRef == null
      ? session.connectionSecretRef
      : REDACTED_ENVIRONMENT_CUSTOM_IMAGE_VALUE,
    connectionSummary,
    metadata: session.metadata == null
      ? session.metadata
      : redactEnvironmentCustomImageValue(session.metadata),
  };
}
