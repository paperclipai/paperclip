const DEFAULT_SURFACE_ERROR_CODE = "adapter_failed";

export const ADAPTER_FAILURE_REASONS = {
  adapter_missing_command: { countsTowardBreaker: true, surfaceErrorCode: DEFAULT_SURFACE_ERROR_CODE },
  adapter_missing_url: { countsTowardBreaker: true, surfaceErrorCode: DEFAULT_SURFACE_ERROR_CODE },
  adapter_spawn_failed: { countsTowardBreaker: true, surfaceErrorCode: DEFAULT_SURFACE_ERROR_CODE },
  adapter_auth_failed: {
    countsTowardBreaker: true,
    surfaceErrorCode: DEFAULT_SURFACE_ERROR_CODE,
    surfaceErrorCodeByAdapter: {
      claude_local: "claude_auth_required",
    },
  },
  adapter_protocol_error: { countsTowardBreaker: true, surfaceErrorCode: DEFAULT_SURFACE_ERROR_CODE },
  adapter_probe_timeout: { countsTowardBreaker: true, surfaceErrorCode: DEFAULT_SURFACE_ERROR_CODE },
  adapter_quarantined: { countsTowardBreaker: false, surfaceErrorCode: "adapter_quarantined" },
  adapter_mid_run_timeout: { countsTowardBreaker: false, surfaceErrorCode: DEFAULT_SURFACE_ERROR_CODE },
} as const;

export type AdapterFailureReason = keyof typeof ADAPTER_FAILURE_REASONS;
type AdapterFailureReasonConfig = (typeof ADAPTER_FAILURE_REASONS)[AdapterFailureReason];

export type ClassifiedAdapterFailure = {
  adapterFailureReason: AdapterFailureReason;
  surfaceErrorCode: string;
};

function readStringField(
  value: unknown,
  key: "message" | "errorMessage" | "errorCode" | "adapterFailureReason" | "code",
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function normalizeText(value: string | null) {
  return value?.trim().toLowerCase() ?? "";
}

function resolveSurfaceErrorCode(reason: AdapterFailureReason, adapterType: string) {
  const config: AdapterFailureReasonConfig = ADAPTER_FAILURE_REASONS[reason];
  const overrides = "surfaceErrorCodeByAdapter" in config
    ? (config.surfaceErrorCodeByAdapter as Partial<Record<string, string>>)
    : undefined;
  return overrides?.[adapterType] ?? config.surfaceErrorCode;
}

function classifyAdapterFailureReason(input: {
  adapterType: string;
  message: string | null;
  errorCode: string | null;
  adapterFailureReason: string | null;
  code: string | null;
}): AdapterFailureReason {
  const declaredReason = input.adapterFailureReason as AdapterFailureReason | null;
  if (declaredReason && declaredReason in ADAPTER_FAILURE_REASONS) {
    return declaredReason;
  }

  const message = normalizeText(input.message);
  const errorCode = normalizeText(input.errorCode);
  const code = normalizeText(input.code);
  const adapterType = normalizeText(input.adapterType);

  if (errorCode === "adapter_quarantined" || message.includes("quarantined")) {
    return "adapter_quarantined";
  }

  if (
    message.includes("probe timed out")
    || (message.includes("probe") && (message.includes("timed out") || message.includes("timeout")))
  ) {
    return "adapter_probe_timeout";
  }

  if (errorCode === "timeout" || code === "aborterror" || message.includes("timed out") || message.includes("timeout")) {
    return "adapter_mid_run_timeout";
  }

  if (errorCode === "claude_auth_required") {
    return "adapter_auth_failed";
  }

  if (
    message.includes("auth")
    || message.includes("login required")
    || message.includes("requires login")
    || message.includes("not logged in")
    || message.includes("unauthorized")
    || message.includes("forbidden")
    || message.includes("permission denied")
  ) {
    return "adapter_auth_failed";
  }

  if (message.includes("missing command")) {
    return "adapter_missing_command";
  }

  if (message.includes("missing url")) {
    return "adapter_missing_url";
  }

  if (
    code === "enoent"
    || message.includes("failed to start command")
    || message.includes("spawn ")
  ) {
    return "adapter_spawn_failed";
  }

  if (
    adapterType === "http"
    || errorCode.startsWith("http_")
    || message.includes("http invoke failed")
    || /http\s+\d{3}/.test(message)
  ) {
    return "adapter_protocol_error";
  }

  return "adapter_protocol_error";
}

export function classifyAdapterFailure(err: unknown, adapterType: string): ClassifiedAdapterFailure {
  const errCode = err instanceof Error ? (err as NodeJS.ErrnoException).code : null;
  const adapterFailureReason = classifyAdapterFailureReason({
    adapterType,
    message: err instanceof Error ? err.message : (readStringField(err, "message") ?? readStringField(err, "errorMessage")),
    errorCode: readStringField(err, "errorCode"),
    adapterFailureReason: readStringField(err, "adapterFailureReason"),
    code: typeof errCode === "string" ? errCode : (readStringField(err, "code") ?? null),
  });

  return {
    adapterFailureReason,
    surfaceErrorCode: resolveSurfaceErrorCode(adapterFailureReason, adapterType),
  };
}

