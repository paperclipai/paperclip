const LIVE_PROOF_TTL_MS = 5 * 60_000;
const CLOCK_SKEW_TOLERANCE_MS = 60_000;
const LIVE_PROOF_CODE = "codex_hello_probe_passed";
const BLOCKING_WARNING_CODES = new Set([
  "codex_hello_probe_timed_out",
  "codex_hello_probe_unexpected_output",
  "codex_hello_probe_auth_required",
]);

const SAFE_WARNING_LABELS: Record<string, string> = {
  codex_acp_default_fallback:
    "Codex ACP was unavailable, so the live test used the CLI lane.",
  codex_openai_api_key_missing:
    "No Codex authentication source was detected before the live probe.",
  codex_fast_mode_unsupported_model:
    "Codex Fast mode is unavailable for the selected model.",
  codex_hello_probe_timed_out: "The Codex hello probe timed out.",
  codex_hello_probe_unexpected_output:
    "The Codex hello probe returned unexpected output.",
  codex_hello_probe_auth_required:
    "Codex reported that authentication is required.",
};

const GENERIC_SAFE_WARNING =
  "Codex reported an additional warning. Review the server-side test details.";

export type CodexLiveProof =
  | { valid: true; testedAt: string; detail: "Hello."; warnings: string[] }
  | { valid: false; reason: string };

type RuntimeCheck = {
  code: string;
  level: "info" | "warn" | "error";
  message: string;
  detail?: string | null;
  hint?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function createCodexLiveProofScope(input: {
  companyId: string | null;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  environmentId: string | null;
}): string | null {
  if (!input.companyId || input.adapterType !== "codex_local") return null;
  try {
    return JSON.stringify(canonicalize(input));
  } catch {
    return null;
  }
}

export function getCodexLiveProofExpiryMs(
  result: unknown,
  now = Date.now(),
): number | null {
  const proof = evaluateCodexLiveProof(result, now);
  if (!proof.valid) return null;
  const testedAtMs = Date.parse(proof.testedAt);
  return Number.isFinite(testedAtMs) ? testedAtMs + LIVE_PROOF_TTL_MS : null;
}

function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isRuntimeCheck(value: unknown): value is RuntimeCheck {
  if (!isRecord(value)) return false;
  return (
    typeof value.code === "string" &&
    (value.level === "info" || value.level === "warn" || value.level === "error") &&
    typeof value.message === "string" &&
    isOptionalNullableString(value.detail) &&
    isOptionalNullableString(value.hint)
  );
}

export function evaluateCodexLiveProof(result: unknown, now = Date.now()): CodexLiveProof {
  if (!isRecord(result)) {
    return { valid: false, reason: "Codex did not return a valid connection result." };
  }
  if (result.adapterType !== "codex_local") {
    return { valid: false, reason: "Codex returned a result for a different adapter." };
  }
  if (result.status !== "pass" && result.status !== "warn") {
    return { valid: false, reason: "Codex did not pass the live connection test." };
  }
  if (!Array.isArray(result.checks) || !result.checks.every(isRuntimeCheck)) {
    return { valid: false, reason: "Codex returned invalid connection checks." };
  }
  if (result.checks.some((check) => check.level === "error")) {
    return { valid: false, reason: "Codex reported a connection error." };
  }
  if (
    result.checks.some(
      (check) => check.level === "warn" && BLOCKING_WARNING_CODES.has(check.code),
    )
  ) {
    return { valid: false, reason: "Codex reported an unsuccessful live reply." };
  }
  if (!result.checks.some((check) => check.code === LIVE_PROOF_CODE && check.level === "info")) {
    return { valid: false, reason: "Codex did not verify a live reply." };
  }
  if (typeof result.testedAt !== "string") {
    return { valid: false, reason: "The Codex connection proof has an invalid timestamp." };
  }

  const testedAtMs = Date.parse(result.testedAt);
  if (!Number.isFinite(testedAtMs) || testedAtMs > now + CLOCK_SKEW_TOLERANCE_MS) {
    return { valid: false, reason: "The Codex connection proof has an invalid timestamp." };
  }
  if (now - testedAtMs > LIVE_PROOF_TTL_MS) {
    return { valid: false, reason: "The Codex connection proof has expired." };
  }

  const warnings = Array.from(
    new Set(
      result.checks
        .filter((check) => check.level === "warn")
        .map((check) => SAFE_WARNING_LABELS[check.code] ?? GENERIC_SAFE_WARNING),
    ),
  );
  return { valid: true, testedAt: result.testedAt, detail: "Hello.", warnings };
}
