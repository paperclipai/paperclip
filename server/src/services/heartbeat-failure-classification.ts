export const HEARTBEAT_RUN_FAILURE_TYPES = [
  "timeout",
  "permission",
  "invalid_config",
  "provider_error",
  "quota_exhausted",
  "rate_limited",
  "process_lost",
  "max_turns_exhausted",
  "control_plane_cancelled",
  "adapter_error",
  "unknown",
] as const;

export type HeartbeatRunFailureType = (typeof HEARTBEAT_RUN_FAILURE_TYPES)[number];

export interface HeartbeatRunFailureClassification {
  failureType: HeartbeatRunFailureType;
  failureClassifiedFrom: string;
}

export interface HeartbeatRunFailureClassificationInput {
  status?: string | null;
  timedOut?: boolean | null;
  errorCode?: string | null;
  errorFamily?: string | null;
  errorMessage?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  resultJson?: Record<string, unknown> | null;
}

const FAILURE_TYPES = new Set<string>(HEARTBEAT_RUN_FAILURE_TYPES);

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeFailureType(value: unknown): HeartbeatRunFailureType | null {
  const normalized = readNonEmptyString(value);
  return normalized && FAILURE_TYPES.has(normalized)
    ? normalized as HeartbeatRunFailureType
    : null;
}

function includesAny(value: string, needles: readonly string[]) {
  return needles.some((needle) => value.includes(needle));
}

export function classifyHeartbeatRunFailure(
  input: HeartbeatRunFailureClassificationInput,
): HeartbeatRunFailureClassification | null {
  const existingType = normalizeFailureType(input.resultJson?.failureType);
  if (existingType) {
    return {
      failureType: existingType,
      failureClassifiedFrom: "existing_result_json",
    };
  }

  const status = readNonEmptyString(input.status)?.toLowerCase() ?? null;
  const errorCode = readNonEmptyString(input.errorCode)?.toLowerCase() ?? "";
  const errorFamily = readNonEmptyString(input.errorFamily)?.toLowerCase() ?? "";
  const message = readNonEmptyString(input.errorMessage)?.toLowerCase() ?? "";
  const signal = readNonEmptyString(input.signal)?.toUpperCase() ?? "";
  const haystack = [errorCode, errorFamily, message].filter(Boolean).join(" ");

  if (!input.timedOut && status !== "failed" && status !== "timed_out" && !haystack && !signal) {
    return null;
  }

  if (input.timedOut || status === "timed_out" || includesAny(haystack, ["timeout", "timed out", "etimedout"])) {
    return { failureType: "timeout", failureClassifiedFrom: "timeout_signal" };
  }

  if (includesAny(haystack, ["max_turn", "max turns", "turn_limit", "turn limit"])) {
    return { failureType: "max_turns_exhausted", failureClassifiedFrom: "turn_limit" };
  }

  if (includesAny(haystack, ["process_lost", "process lost", "lost process", "orphaned"])) {
    return { failureType: "process_lost", failureClassifiedFrom: "process_lost" };
  }

  if (signal === "SIGKILL" || signal === "SIGTERM" || signal === "SIGHUP" || input.exitCode === 143) {
    return { failureType: "process_lost", failureClassifiedFrom: "process_signal" };
  }

  if (status === "cancelled" || includesAny(haystack, ["control plane", "control-plane", "cancelled-by-control-plane"])) {
    return { failureType: "control_plane_cancelled", failureClassifiedFrom: "control_plane_cancelled" };
  }

  if (
    includesAny(haystack, [
      "quota",
      "terminalquotaerror",
      "terminal quota",
      "usage limit",
      "out of usage",
      "insufficient credits",
      "credit exhausted",
    ])
  ) {
    return { failureType: "quota_exhausted", failureClassifiedFrom: "quota" };
  }

  if (includesAny(haystack, ["rate limit", "rate_limit", "429", "too many requests"])) {
    return { failureType: "rate_limited", failureClassifiedFrom: "rate_limit" };
  }

  if (
    includesAny(haystack, [
      "unauthorized",
      "forbidden",
      "permission denied",
      "access_denied",
      "access denied",
      "authentication",
      "auth failed",
      "api key",
      "invalid key",
      "eacces",
      "eperm",
    ])
  ) {
    return { failureType: "permission", failureClassifiedFrom: "permission_or_auth" };
  }

  if (
    includesAny(haystack, [
      "invalid config",
      "invalid_request",
      "invalid request",
      "invalid adapter",
      "not configured",
      "missing config",
      "missing command",
      "missing url",
      "requires ",
      "required ",
      "no gateway credentials",
      "command not found",
      "not found",
      "enoent",
      "path",
      "unsupported adapter",
      "unsupported model",
      "unsupported route",
      "model unsupported",
      "adapter unsupported",
    ])
  ) {
    return { failureType: "invalid_config", failureClassifiedFrom: "configuration" };
  }

  if (
    errorFamily === "transient_upstream" ||
    includesAny(haystack, [
      "provider",
      "upstream",
      "overloaded",
      "unavailable",
      "service unavailable",
      "gateway",
      "5xx",
      "500",
      "502",
      "503",
      "504",
    ])
  ) {
    return { failureType: "provider_error", failureClassifiedFrom: "provider_or_upstream" };
  }

  if (status === "failed" || errorCode || message || input.exitCode !== null) {
    return { failureType: "adapter_error", failureClassifiedFrom: "adapter_failure" };
  }

  return { failureType: "unknown", failureClassifiedFrom: "fallback" };
}

export function mergeHeartbeatRunFailureClassification(
  resultJson: Record<string, unknown> | null | undefined,
  classification: HeartbeatRunFailureClassification | null,
): Record<string, unknown> | null {
  if (!classification) return resultJson ?? null;
  return {
    ...(resultJson ?? {}),
    failureType: classification.failureType,
    failureClassifiedFrom: classification.failureClassifiedFrom,
  };
}
