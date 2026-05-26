const DAY_MS = 24 * 60 * 60 * 1000;
const DEBUG_RETENTION_DAYS = 30;
const PROBE_RETENTION_DAYS = 90;
const MIN_PROBES_RETAINED_PER_AGENT = 50;

const AUDIT_CRITICAL_TABLES = new Set([
  "weekly_reviews",
  "weekly_review_versions",
  "weekly_review_findings",
  "weekly_review_citations",
  "weekly_review_recommendations",
  "weekly_review_actions",
  "activity_log",
]);

const ALLOWED_DEBUG_KEYS = new Set([
  "validationErrors",
  "ruleNames",
  "entityIds",
  "counts",
  "errorCode",
  "failureReason",
]);

const DANGEROUS_NESTED_KEYS = new Set([
  "prompt",
  "transcript",
  "env",
  "url",
  "uri",
  "signedurl",
  "signed_url",
  "token",
  "authtoken",
  "auth_token",
  "authorization",
  "apikey",
  "api_key",
  "key",
  "password",
  "databaseurl",
  "database_url",
  "connectionstring",
  "connection_string",
  "credential",
  "credentials",
  "secret",
  "content",
  "text",
  "log",
  "workproduct",
  "work_product",
  "filecontents",
  "file_contents",
]);

const MAX_DEBUG_STRING_LENGTH = 160;
const MAX_DEBUG_ARRAY_ITEMS = 10;
const MAX_DEBUG_OBJECT_KEYS = 20;
const MAX_DEBUG_DEPTH = 2;
const REDACTED_DEBUG_VALUE = "[redacted]";

export function computeDebugEventExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + DEBUG_RETENTION_DAYS * DAY_MS);
}

export function computeProbeExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + PROBE_RETENTION_DAYS * DAY_MS);
}

export function isAuditCriticalWeeklyReviewTable(tableName: string): boolean {
  return AUDIT_CRITICAL_TABLES.has(tableName);
}

export function canPurgeExpiredWeeklyReviewTable(tableName: string): boolean {
  if (isAuditCriticalWeeklyReviewTable(tableName)) return false;
  return tableName === "weekly_review_events" || tableName === "adapter_readiness_probes";
}

export function isExpiredRetentionTimestamp(
  expiresAt: Date | null | undefined,
  now = new Date(),
): boolean {
  return Boolean(expiresAt && expiresAt.getTime() <= now.getTime());
}

export function shouldPurgeWeeklyReviewDebugEvent(input: {
  expiresAt: Date | null | undefined;
  now?: Date;
}): boolean {
  return isExpiredRetentionTimestamp(input.expiresAt, input.now);
}

export function shouldPurgeAdapterReadinessProbe(input: {
  expiresAt: Date | null | undefined;
  newerProbeCountForAgent: number;
  now?: Date;
}): boolean {
  if (!isExpiredRetentionTimestamp(input.expiresAt, input.now)) return false;
  return input.newerProbeCountForAgent >= MIN_PROBES_RETAINED_PER_AGENT;
}

function normalizeDebugKey(key: string): string {
  return key.replace(/[^a-z0-9_]/gi, "").toLowerCase();
}

function isDangerousNestedKey(key: string): boolean {
  const normalized = normalizeDebugKey(key);
  return (
    DANGEROUS_NESTED_KEYS.has(normalized) ||
    /(?:password|authorization|token|apikey|api_key|credential|secret|signedurl|databaseurl|connectionstring)/.test(
      normalized,
    ) ||
    /(?:private|public|ssh|access|secret|session|auth|api|client|signing).*key/.test(normalized) ||
    /key(?:id|secret|token|pair|pem|file|path)$/.test(normalized)
  );
}

function isDangerousDebugString(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;

  return [
    /\b(?:https?|postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?|s3|gs|file|ssh|git):\/\/\S+/i,
    /\bwww\.[^\s]+/i,
    /\bgit@[a-z0-9.-]+:[^\s]+/i,
    /\b(?:api[_-]?key|token|secret|credential|password)\b\s*[:=]/i,
    /\b(?:authorization|auth[_-]?token|database[_-]?url|connection[_-]?string)\b\s*[:=]/i,
    /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}/i,
    /\b(?:OPENAI|ANTHROPIC|AWS|GITHUB|GH|DATABASE|SUPABASE|STRIPE)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=/,
    /(?:^|\n)\s*[A-Z][A-Z0-9_]{2,}\s*=/,
    /\b(?:sk|ghp|gho|github_pat)_[a-z0-9_=-]{8,}/i,
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
    /\b(?:prompt|transcript|conversation|stdout|stderr|stack trace|file contents?|work[-_\s]?product)\b/i,
    /(?:^|\/)(?:server\/work|work-products?|workspaces?)\//i,
  ].some((pattern) => pattern.test(trimmed));
}

function boundDebugString(value: string): string {
  return value.length > MAX_DEBUG_STRING_LENGTH
    ? `${value.slice(0, MAX_DEBUG_STRING_LENGTH - 3)}...`
    : value;
}

function sanitizeDebugValue(value: unknown, depth = 0): unknown | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    if (isDangerousDebugString(value)) return REDACTED_DEBUG_VALUE;
    const bounded = boundDebugString(value);
    return bounded.length > 0 ? bounded : null;
  }
  if (Array.isArray(value)) {
    const sanitized = value
      .slice(0, MAX_DEBUG_ARRAY_ITEMS)
      .map((item) => sanitizeDebugValue(item, depth + 1))
      .filter((item): item is NonNullable<typeof item> => item !== null);
    return sanitized.length > 0 ? sanitized : null;
  }
  if (value && typeof value === "object") {
    if (depth >= MAX_DEBUG_DEPTH) return null;

    const sanitized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value).slice(0, MAX_DEBUG_OBJECT_KEYS)) {
      if (isDangerousNestedKey(key)) continue;

      const safeValue = sanitizeDebugValue(nestedValue, depth + 1);
      if (safeValue !== null) {
        sanitized[key] = safeValue;
      }
    }

    return Object.keys(sanitized).length > 0 ? sanitized : null;
  }

  return null;
}

export function redactWeeklyReviewDebugMetadata(
  input: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!input) return null;

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (ALLOWED_DEBUG_KEYS.has(key)) {
      const sanitized = sanitizeDebugValue(value);
      if (sanitized !== null) {
        output[key] = sanitized;
      }
    }
  }

  return Object.keys(output).length > 0 ? output : null;
}

export function redactWeeklyReviewDiagnosticString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;

  const sanitized = sanitizeDebugValue(value);
  return typeof sanitized === "string" ? sanitized : null;
}
