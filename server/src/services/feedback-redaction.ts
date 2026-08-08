import { createHash } from "node:crypto";
import { redactCurrentUserText } from "../log-redaction.js";
import { sanitizeRecord } from "../redaction.js";

export type FeedbackRedactionState = {
  redactedFields: Set<string>;
  truncatedFields: Set<string>;
  omittedFields: Set<string>;
  notes: Set<string>;
  counts: Map<string, number>;
};

type PatternReplacement = string | ((match: string, ...args: string[]) => string);

type RedactionPattern = {
  kind: string;
  regex: RegExp;
  replacement: PatternReplacement;
};

const SECRET_ASSIGNMENT_RE =
  /\b(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)\s*[:=]\s*([^\s,;]+)/gi;

const FREE_TEXT_PATTERNS: RedactionPattern[] = [
  {
    kind: "pem_block",
    regex: /-----BEGIN [^-]+-----[\s\S]+?-----END [^-]+-----/g,
    replacement: "[REDACTED_PEM_BLOCK]",
  },
  {
    kind: "secret_assignment",
    regex: SECRET_ASSIGNMENT_RE,
    replacement: (_match, key: string) => `${key}=[REDACTED]`,
  },
  {
    kind: "bearer_token",
    regex: /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
    replacement: "Bearer [REDACTED_TOKEN]",
  },
  {
    kind: "github_token",
    regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    kind: "github_pat",
    regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replacement: "[REDACTED_GITHUB_PAT]",
  },
  {
    kind: "cloudflare_token",
    regex: /\bcfut_[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[REDACTED_CF_TOKEN]",
  },
  {
    kind: "webhook_secret",
    regex: /\bwhsec_[A-Za-z0-9]{20,}\b/g,
    replacement: "[REDACTED_WEBHOOK_SECRET]",
  },
  {
    kind: "sentry_token",
    regex: /\bsntrys_[A-Za-z0-9._-]{20,}/g,
    replacement: "[REDACTED_SENTRY_TOKEN]",
  },
  {
    kind: "provider_api_key",
    regex: /\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/g,
    replacement: "[REDACTED_API_KEY]",
  },
  {
    kind: "jwt",
    regex: /\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g,
    replacement: "[REDACTED_JWT]",
  },
  {
    kind: "dsn",
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|kafka|nats|mssql):\/\/[^\s<>'")]+/gi,
    replacement: "[REDACTED_CONNECTION_STRING]",
  },
  {
    kind: "email",
    regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: "[REDACTED_EMAIL]",
  },
  {
    kind: "phone",
    regex: /(?<!\w)(?:\+?\d[\d ()-]{7,}\d)(?!\w)/g,
    replacement: "[REDACTED_PHONE]",
  },
];

// Subset of FREE_TEXT_PATTERNS safe for run-log chunks.
// Excludes patterns already covered by redactSensitiveText (github_token,
// provider_api_key, secret_assignment — the last avoids re-processing
// ***REDACTED*** markers already placed by redactSensitiveText) and patterns
// with high false-positive rates in raw agent stdout (jwt, email, phone).
// bearer_token is intentionally retained: redactSensitiveText handles
// `Authorization: Bearer xxx` via field-name match, while sanitizeRunLogText
// catches `Bearer xxx` appearing as a bare value in raw stdout.
const RUN_LOG_PATTERNS: RedactionPattern[] = FREE_TEXT_PATTERNS.filter((p) =>
  ["pem_block", "bearer_token", "github_pat", "cloudflare_token", "webhook_secret", "sentry_token", "dsn"].includes(p.kind),
);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function increment(state: FeedbackRedactionState, kind: string, count: number) {
  if (count <= 0) return;
  state.counts.set(kind, (state.counts.get(kind) ?? 0) + count);
}

function recordField(state: FeedbackRedactionState, fieldPath: string) {
  if (fieldPath.trim().length === 0) return;
  state.redactedFields.add(fieldPath);
}

function applyPattern(input: string, pattern: RedactionPattern) {
  const matches = Array.from(input.matchAll(pattern.regex)).length;
  if (matches === 0) {
    pattern.regex.lastIndex = 0;
    return { output: input, matches: 0 };
  }
  const output = input.replace(pattern.regex, pattern.replacement as never);
  pattern.regex.lastIndex = 0;
  return { output, matches };
}

export function createFeedbackRedactionState(): FeedbackRedactionState {
  return {
    redactedFields: new Set<string>(),
    truncatedFields: new Set<string>(),
    omittedFields: new Set<string>(),
    notes: new Set<string>(),
    counts: new Map<string, number>(),
  };
}

export function sanitizeFeedbackText(
  input: string,
  state: FeedbackRedactionState,
  fieldPath: string,
  maxLength: number,
) {
  let output = redactCurrentUserText(input);
  if (output !== input) {
    recordField(state, fieldPath);
    increment(state, "current_user", 1);
  }

  for (const pattern of FREE_TEXT_PATTERNS) {
    const result = applyPattern(output, pattern);
    if (result.matches > 0) {
      output = result.output;
      recordField(state, fieldPath);
      increment(state, pattern.kind, result.matches);
    }
  }

  if (output.length > maxLength) {
    output = `${output.slice(0, Math.max(0, maxLength - 1))}...`;
    state.truncatedFields.add(fieldPath);
  }

  return output;
}

/**
 * Lightweight value-based secret redactor for run-log chunks.
 *
 * Applies {@link RUN_LOG_PATTERNS} (a subset of {@link FREE_TEXT_PATTERNS})
 * without truncation, current-user redaction, or field-state tracking.
 * Designed to run after {@link redactSensitiveText} in `compactRunLogChunk`
 * to catch token prefixes not covered by the field-name-based pass
 * (github_pat_, cfut_, whsec_, sntrys_). Patterns already handled by
 * redactSensitiveText (ghp_*, sk-*, Authorization Bearer, KEY=value) and
 * patterns with high false-positive rates in raw stdout (jwt, email, phone)
 * are intentionally excluded.
 */
export function sanitizeRunLogText(input: string): string {
  let output = input;
  for (const pattern of RUN_LOG_PATTERNS) {
    output = output.replace(pattern.regex, pattern.replacement as never);
    pattern.regex.lastIndex = 0;
  }
  return output;
}

export function sanitizeFeedbackValue(
  value: unknown,
  state: FeedbackRedactionState,
  fieldPath: string,
  maxStringLength: number,
): unknown {
  if (typeof value === "string") {
    return sanitizeFeedbackText(value, state, fieldPath, maxStringLength);
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      sanitizeFeedbackValue(entry, state, `${fieldPath}[${index}]`, maxStringLength));
  }
  if (!isPlainRecord(value)) {
    return value;
  }

  const structurallySanitized = sanitizeRecord(value);
  if (stableStringify(structurallySanitized) !== stableStringify(value)) {
    recordField(state, fieldPath);
    increment(state, "structured_secret", 1);
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(structurallySanitized)) {
    output[key] = sanitizeFeedbackValue(entry, state, `${fieldPath}.${key}`, maxStringLength);
  }
  return output;
}

export function finalizeFeedbackRedactionSummary(state: FeedbackRedactionState) {
  return {
    strategy: "deterministic_feedback_v2",
    redactedFields: Array.from(state.redactedFields).sort(),
    truncatedFields: Array.from(state.truncatedFields).sort(),
    omittedFields: Array.from(state.omittedFields).sort(),
    notes: Array.from(state.notes).sort(),
    counts: Object.fromEntries(Array.from(state.counts.entries()).sort(([left], [right]) => left.localeCompare(right))),
  } satisfies Record<string, unknown>;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(",")}}`;
}

export function sha256Digest(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
