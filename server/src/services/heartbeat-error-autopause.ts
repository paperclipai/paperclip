import { createHash } from "node:crypto";
import {
  HEARTBEAT_AUTOPAUSE_CODES,
  type HeartbeatAutoPauseCode,
} from "./agent-runtime-config.js";

export const HEARTBEAT_ERROR_AUTOPAUSE_DEFAULT_THRESHOLD = 3;
export const HEARTBEAT_ERROR_AUTOPAUSE_FLAG = "HEARTBEAT_ERROR_AUTOPAUSE_ENABLED";

export interface HeartbeatAutoPauseRunInput {
  id: string;
  status: string;
  error?: string | null;
  errorCode?: string | null;
  resultJson?: Record<string, unknown> | null;
}

export interface HeartbeatErrorAutoPausePolicy {
  enabled: boolean;
  threshold: number;
}

const targetCodes = new Set<string>(HEARTBEAT_AUTOPAUSE_CODES);
const falseFlagValues = new Set(["0", "false", "off", "no", "disabled"]);
const monthlyUsageRe =
  /(?:monthly\s+(?:usage|spend|limit)|out\s+of\s+extra\s+usage|extra\s+usage|usage\s+(?:limit|cap)\s+reached|(?:5[-\s]?hour|weekly)\s+limit\s+reached|you(?:'|’)ve\s+hit\s+your\s+usage\s+limit)/i;
const quotaExceededRe =
  /(?:quota(?:\s+|_)?(?:exceeded|exhausted)|resource[_\s-]?exhausted|servicequotaexceededexception|free\s+usage\s+exceeded|billing\s+details)/i;
const rateLimitRe =
  /(?:rate[_\s-]?limit(?:ed|er|ing)?|too\s+many\s+requests|\b429\b|throttl(?:ed|ing|ingexception)?)/i;
const invalidApiKeyRe =
  /(?:(?:invalid|incorrect|malformed|revoked|expired)\s+(?:api\s*)?key|api[_\s-]?key[_\s-]?(?:invalid|revoked|expired)|bad\s+(?:api\s*)?key)/i;
const authFailedRe =
  /(?:auth(?:entication|orization)?\s+(?:failed|required)|unauthori[sz]ed|invalid\s+credentials|not\s+logged\s+in|login\s+required|please\s+(?:log\s+in|authenticate)|requires\s+login|access\s+denied)/i;
const adapterBootstrapRe =
  /(?:adapter[_\s-]?bootstrap[_\s-]?failed|failed\s+to\s+start\s+command|spawn\s+.+\s+enoent|command\s+not\s+found|no\s+such\s+file\s+or\s+directory|verify\s+adapter\s+command|working\s+directory\s+and\s+path|adapter\s+.+not\s+(?:registered|found)|failed\s+to\s+(?:load|resolve)\s+adapter|bootstrap\s+failed)/i;

function normalizeToken(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectStrings(value: unknown, depth = 0, out: string[] = []): string[] {
  if (out.join("\n").length > 20_000 || depth > 4) return out;
  if (typeof value === "string") {
    if (value.trim()) out.push(value.trim());
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) collectStrings(item, depth + 1, out);
    return out;
  }
  if (!isRecord(value)) return out;
  for (const entry of Object.entries(value).slice(0, 80)) {
    collectStrings(entry[1], depth + 1, out);
  }
  return out;
}

function buildErrorHaystack(run: HeartbeatAutoPauseRunInput) {
  return [
    run.errorCode ?? "",
    run.error ?? "",
    ...collectStrings(run.resultJson),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 40_000);
}

function mapDirectErrorCode(code: string): HeartbeatAutoPauseCode | null {
  if (targetCodes.has(code)) return code as HeartbeatAutoPauseCode;
  if (/(?:invalid|bad|incorrect).*api.*key|api.*key.*(?:invalid|revoked|expired)/i.test(code)) {
    return "invalid_api_key";
  }
  if (/(?:auth_required|authentication_required|auth_failed|login_required|unauthorized)/i.test(code)) {
    return "auth_failed";
  }
  if (/(?:quota|resource_exhausted)/i.test(code)) return "quota_exceeded";
  if (/(?:rate_limit|too_many_requests|throttl)/i.test(code)) return "rate_limit_exceeded";
  if (/(?:bootstrap|command_not_found|spawn_enoent)/i.test(code)) return "adapter_bootstrap_failed";
  return null;
}

export function normalizeHeartbeatAutoPauseErrorClass(
  run: HeartbeatAutoPauseRunInput,
): HeartbeatAutoPauseCode | null {
  if (run.status !== "failed") return null;

  const resultJson = isRecord(run.resultJson) ? run.resultJson : {};
  const stopReason = normalizeToken(resultJson.stopReason ?? resultJson.stop_reason);
  const errorCode = normalizeToken(run.errorCode ?? resultJson.errorCode ?? resultJson.error_code);
  if (
    stopReason === "completed" ||
    stopReason === "max_turns_exhausted" ||
    stopReason === "turn_limit_exhausted" ||
    errorCode === "max_turns_exhausted" ||
    errorCode === "turn_limit_exhausted" ||
    errorCode === "process_lost"
  ) {
    return null;
  }

  const direct = mapDirectErrorCode(errorCode);
  if (direct) return direct;

  const haystack = buildErrorHaystack(run);
  if (!haystack.trim()) return null;
  if (invalidApiKeyRe.test(haystack)) return "invalid_api_key";
  if (authFailedRe.test(haystack)) return "auth_failed";
  if (monthlyUsageRe.test(haystack)) return "monthly_usage_limit";
  if (rateLimitRe.test(haystack)) return "rate_limit_exceeded";
  if (quotaExceededRe.test(haystack)) return "quota_exceeded";
  if (adapterBootstrapRe.test(haystack)) return "adapter_bootstrap_failed";
  return null;
}

export function buildHeartbeatAutoPauseDigest(input: {
  run: HeartbeatAutoPauseRunInput;
  code: HeartbeatAutoPauseCode;
  adapterType: string;
}) {
  const sample = [
    input.adapterType,
    input.code,
    input.run.errorCode ?? "",
    buildErrorHaystack(input.run),
  ]
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16_000);
  return `sha256:${createHash("sha256").update(sample).digest("hex")}`;
}

export function buildHeartbeatAutoPauseFingerprint(input: {
  adapterType: string;
  code: HeartbeatAutoPauseCode;
  sampleDigest: string;
}) {
  return `sha256:${createHash("sha256").update([
    "heartbeat-error-autopause/v1",
    input.adapterType,
    input.code,
    input.sampleDigest,
  ].join(":")).digest("hex")}`;
}

export function resolveHeartbeatErrorAutoPausePolicy(
  env: NodeJS.ProcessEnv = process.env,
): HeartbeatErrorAutoPausePolicy {
  const flagValue = env[HEARTBEAT_ERROR_AUTOPAUSE_FLAG];
  const enabled = flagValue ? !falseFlagValues.has(flagValue.trim().toLowerCase()) : true;
  return {
    enabled,
    threshold: HEARTBEAT_ERROR_AUTOPAUSE_DEFAULT_THRESHOLD,
  };
}

