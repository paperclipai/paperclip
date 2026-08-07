/**
 * Terminal adapter failure classes that must never enqueue scheduled_retry /
 * transient_failure_retry / provider_quota_recovery.
 *
 * Precedence: billing_402 > auth_eacces > auth_key.
 * Billing (HTTP 402 / insufficient balance) must never classify as provider_quota.
 */

export type TerminalAdapterFailureFamily = "billing_402" | "auth_key" | "auth_eacces";

export const TERMINAL_ADAPTER_FAILURE_FAMILIES = [
  "billing_402",
  "auth_key",
  "auth_eacces",
] as const satisfies readonly TerminalAdapterFailureFamily[];

const TERMINAL_FAMILY_SET = new Set<string>(TERMINAL_ADAPTER_FAILURE_FAMILIES);

/** HTTP 402 / payment / balance — not usage-limit or session-cap (provider_quota). */
const BILLING_402_RE =
  /(?:\bHTTP[/ ]?402\b|\bstatus(?:Code)?[:\s]*402\b|\b402\b(?:\s*[-:])?\s*(?:Payment Required|Insufficient)|Insufficient Balance|payment required|credits?(?:\s+are|\s+have been)?\s+(?:exhausted|depleted|insufficient)|wallet (?:balance )?(?:exhausted|empty|depleted|insufficient)|insufficient (?:credits?|balance|funds)|billing (?:error|failure)|out of credits)/i;

/** EACCES / permission denied on credential or auth-related paths. */
const AUTH_EACCES_RE =
  /(?:\bEACCES\b|permission denied)(?:[^.\n]{0,120})(?:credential|\.env\b|api[_ -]?key|auth(?:entication|orization)?|token|secret|\.ssh\b|\/(?:\.config|\.local)\/|key(?:file|ring)?)/i;

const AUTH_EACCES_REVERSE_RE =
  /(?:credential|\.env\b|api[_ -]?key|auth(?:entication|orization)?|token|secret|\.ssh\b)(?:[^.\n]{0,80})(?:\bEACCES\b|permission denied)/i;

/** Invalid / expired / missing provider API key (env *names* only — never values). */
const AUTH_KEY_RE =
  /(?:invalid (?:api[_ -]?|provider )?key|expired (?:api[_ -]?|provider )?key|unauthorized (?:api[_ -]?|provider )?key|api[_ -]?key (?:is )?(?:invalid|expired|revoked|unauthorized)|(?:missing|required) (?:env(?:ironment)? )?(?:var(?:iable)? )?[`'"]?[A-Z][A-Z0-9_]*(?:_API_KEY|_TOKEN|_SECRET|API_KEY)|(?:API[_ -]?KEY|provider key) (?:not (?:set|configured|found)|missing|unset))/i;

export type TerminalAdapterFailureClassification = {
  family: TerminalAdapterFailureFamily;
  errorCode?: string;
};

export type TerminalAdapterFailureClassifierInput = {
  errorCode?: string | null;
  errorMessage?: string | null;
  errorFamily?: string | null;
  resultJson?: unknown;
  stderr?: string | null;
  stdout?: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function collectClassifierText(input: TerminalAdapterFailureClassifierInput): string {
  const result = asRecord(input.resultJson);
  const parts = [
    input.errorCode,
    input.errorFamily,
    input.errorMessage,
    input.stderr,
    input.stdout,
    result ? readNonEmptyString(result.errorMessage) : null,
    result ? readNonEmptyString(result.message) : null,
    result ? readNonEmptyString(result.error) : null,
    result ? readNonEmptyString(result.stderr) : null,
    result ? readNonEmptyString(result.stdout) : null,
    result ? JSON.stringify(result) : null,
  ];
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");
}

export function isTerminalAdapterFailureFamily(
  family: string | null | undefined,
): family is TerminalAdapterFailureFamily {
  return typeof family === "string" && TERMINAL_FAMILY_SET.has(family);
}

/**
 * Classify terminal adapter failures from sanitized error cues.
 * Returns null when the failure is retryable or unrecognized as terminal.
 */
export function classifyTerminalAdapterFailure(
  input: TerminalAdapterFailureClassifierInput,
): TerminalAdapterFailureClassification | null {
  const text = collectClassifierText(input);

  // Billing cues always win — including over mis-tagged provider_quota / other families.
  if (text && BILLING_402_RE.test(text)) {
    return { family: "billing_402", errorCode: "billing_402" };
  }

  const explicitFamily =
    readNonEmptyString(input.errorFamily) ??
    readNonEmptyString(asRecord(input.resultJson)?.errorFamily) ??
    null;
  if (isTerminalAdapterFailureFamily(explicitFamily)) {
    return { family: explicitFamily, errorCode: explicitFamily };
  }

  const explicitCode = readNonEmptyString(input.errorCode);
  if (isTerminalAdapterFailureFamily(explicitCode)) {
    return { family: explicitCode, errorCode: explicitCode };
  }

  if (!text) return null;

  if (AUTH_EACCES_RE.test(text) || AUTH_EACCES_REVERSE_RE.test(text)) {
    return { family: "auth_eacces", errorCode: "auth_eacces" };
  }
  if (AUTH_KEY_RE.test(text)) {
    return { family: "auth_key", errorCode: "auth_key" };
  }
  return null;
}
