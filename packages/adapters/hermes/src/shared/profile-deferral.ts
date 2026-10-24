export const PROFILE_DEFERRED_CAPACITY_REASON_CODE = "profile_deferred_capacity";

export const PROFILE_DEFERRED_CAPACITY_ERROR_CODE = "hermes_profile_deferred_capacity";

export const TURN_NOT_ADMITTED_EXIT_CODE = 75;

export const DEFAULT_PROFILE_DEFERRED_RETRY_AFTER_S = 300;
export const MAX_PROFILE_DEFERRED_RETRY_AFTER_S = 3600;

const REASON_CODE_REGEX = /profile_deferred_capacity/;
const RETRY_AFTER_REGEX = /retryAfterS["']?\s*[:=]\s*["']?(\d+)/;
const PROFILE_NAME_REGEX = /\bprofile["']?\s*[:=]\s*["']?([A-Za-z0-9_.:-]+)/;

const TURN_NOT_ADMITTED_RECORD_PATTERNS: readonly RegExp[] = [
  /\bGatewayProfileDeferredError\b/,
  /(?:^|[\s,{[(])["']?reason_code["']?\s*[:=]\s*["']?profile_deferred_capacity(?![\w])/,
  /^\s*(?:\[[^\]\n]{0,64}\]\s*)?(?:ERROR\s+|WARN\s+)?Gateway deferred:\s*profile_deferred_capacity(?![\w])/m,
];

function hasTurnNotAdmittedRecord(text: string): boolean {
  return TURN_NOT_ADMITTED_RECORD_PATTERNS.some((pattern) => pattern.test(text));
}

function firstAnchoredLine(text: string): string | null {
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && hasTurnNotAdmittedRecord(entry));
  return line ? line.slice(0, 1_000) : null;
}

export interface ProfileDeferral {
  errorCode: typeof PROFILE_DEFERRED_CAPACITY_ERROR_CODE;
  reasonCode: typeof PROFILE_DEFERRED_CAPACITY_REASON_CODE;
  retryAfterS: number;
  retryable: true;
  profile: string | null;
  exitCode: number;
  message: string;
}

function firstMatchingLine(text: string): string | null {
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && REASON_CODE_REGEX.test(entry));
  return line ? line.slice(0, 1_000) : null;
}

export function readProfileDeferral(input: {
  exitCode: number | null;
  stdout?: string | null;
  stderr?: string | null;
}): ProfileDeferral | null {
  const exitCode = typeof input.exitCode === "number" ? input.exitCode : null;
  const stdout = typeof input.stdout === "string" ? input.stdout : "";
  const stderr = typeof input.stderr === "string" ? input.stderr : "";
  const text = `${stdout}\n${stderr}`;

  if (exitCode === 0) return null;
  if (exitCode !== TURN_NOT_ADMITTED_EXIT_CODE && !hasTurnNotAdmittedRecord(text)) return null;

  const retryMatch = text.match(RETRY_AFTER_REGEX);
  const parsedRetryAfter = retryMatch ? Number.parseInt(retryMatch[1], 10) : Number.NaN;
  const retryAfterS =
    Number.isFinite(parsedRetryAfter) && parsedRetryAfter > 0
      ? Math.min(MAX_PROFILE_DEFERRED_RETRY_AFTER_S, Math.max(1, parsedRetryAfter))
      : DEFAULT_PROFILE_DEFERRED_RETRY_AFTER_S;
  const profileMatch = text.match(PROFILE_NAME_REGEX);

  const message =
    firstAnchoredLine(stderr) ??
    firstAnchoredLine(stdout) ??
    firstMatchingLine(stderr) ??
    firstMatchingLine(stdout) ??
    `Gateway deferred: ${PROFILE_DEFERRED_CAPACITY_REASON_CODE} (retryAfterS=${retryAfterS}, retryable=true)`;

  return {
    errorCode: PROFILE_DEFERRED_CAPACITY_ERROR_CODE,
    reasonCode: PROFILE_DEFERRED_CAPACITY_REASON_CODE,
    retryAfterS,
    retryable: true,
    profile: profileMatch ? profileMatch[1] : null,
    exitCode: exitCode ?? TURN_NOT_ADMITTED_EXIT_CODE,
    message,
  };
}
