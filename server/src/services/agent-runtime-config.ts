import { unprocessable } from "../errors.js";

export const HEARTBEAT_AUTOPAUSE_GUARD_VERSION = "heartbeat-error-autopause/v1" as const;
export const HEARTBEAT_AUTOPAUSE_SOURCE_ISSUE_ID = "ARI-103" as const;

export const HEARTBEAT_AUTOPAUSE_CODES = [
  "monthly_usage_limit",
  "quota_exceeded",
  "rate_limit_exceeded",
  "invalid_api_key",
  "auth_failed",
  "adapter_bootstrap_failed",
] as const;

export type HeartbeatAutoPauseCode = (typeof HEARTBEAT_AUTOPAUSE_CODES)[number];

export interface HeartbeatAutoPauseReason {
  code: HeartbeatAutoPauseCode;
  adapter: string;
  consecutiveErrorCount: number;
  firstRunId: string;
  lastRunId: string;
  sampleDigest: string;
  createdAt: string;
  guardVersion: typeof HEARTBEAT_AUTOPAUSE_GUARD_VERSION;
  sourceIssueId: typeof HEARTBEAT_AUTOPAUSE_SOURCE_ISSUE_ID;
  fingerprint?: string;
  previousHeartbeatEnabled?: boolean;
}

export interface HeartbeatAutoPauseInput {
  code: HeartbeatAutoPauseCode;
  adapter: string;
  consecutiveErrorCount: number;
  firstRunId: string;
  lastRunId: string;
  sampleDigest: string;
  createdAt: string | Date;
  fingerprint?: string;
}

export interface HeartbeatAutoResumeInput {
  resumeReason: string;
  resumedBy: {
    type: "agent" | "user" | "system";
    id: string;
  };
  resumedAt: string | Date;
}

export interface AgentRuntimeConfigBuildResult {
  runtimeConfig: Record<string, unknown>;
  changed: boolean;
}

const sha256DigestPattern = /^sha256:[a-f0-9]{64}$/i;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const runtimeTokenPattern = /^[A-Za-z0-9:_-]{1,128}$/;
const autoPauseInputKeys = new Set([
  "code",
  "adapter",
  "consecutiveErrorCount",
  "firstRunId",
  "lastRunId",
  "sampleDigest",
  "createdAt",
  "fingerprint",
]);
const resumeInputKeys = new Set(["resumeReason", "resumedBy", "resumedAt"]);
const sensitiveKeyPattern = /(authorization|bearer|credential|raw|secret|stack|token|api[_-]?key)/i;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNoUnexpectedSensitiveKeys(input: Record<string, unknown>, allowedKeys: Set<string>, path: string) {
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key) || sensitiveKeyPattern.test(key)) {
      throw unprocessable(`${path}.${key} is not allowed in heartbeat auto-pause runtimeConfig metadata`);
    }
  }
}

function normalizeRuntimeToken(value: unknown, field: string) {
  if (typeof value !== "string" || !runtimeTokenPattern.test(value.trim())) {
    throw unprocessable(`${field} must be a short non-secret token`);
  }
  return value.trim();
}

function normalizeDigest(value: unknown, field: string) {
  if (typeof value !== "string" || !sha256DigestPattern.test(value)) {
    throw unprocessable(`${field} must be a sha256 digest`);
  }
  return value.toLowerCase();
}

function normalizeRunId(value: unknown, field: string) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw unprocessable(`${field} must be a UUID run id`);
  }
  return value;
}

function normalizeIsoTimestamp(value: string | Date, field: string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw unprocessable(`${field} must be an ISO timestamp`);
  }
  return date.toISOString();
}

function jsonEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readExistingPauseReason(runtimeConfig: Record<string, unknown>): Partial<HeartbeatAutoPauseReason> | null {
  const raw = runtimeConfig.pauseReason;
  return isPlainRecord(raw) ? raw as Partial<HeartbeatAutoPauseReason> : null;
}

function isSamePauseWindow(existing: Partial<HeartbeatAutoPauseReason> | null, next: HeartbeatAutoPauseReason) {
  return existing?.guardVersion === next.guardVersion &&
    existing.sourceIssueId === next.sourceIssueId &&
    existing.code === next.code &&
    existing.adapter === next.adapter &&
    existing.lastRunId === next.lastRunId &&
    existing.sampleDigest === next.sampleDigest;
}

export function buildHeartbeatAutoPauseRuntimeConfig(
  currentRuntimeConfig: unknown,
  input: HeartbeatAutoPauseInput,
): AgentRuntimeConfigBuildResult {
  assertNoUnexpectedSensitiveKeys(input as unknown as Record<string, unknown>, autoPauseInputKeys, "pauseReason");

  if (!HEARTBEAT_AUTOPAUSE_CODES.includes(input.code)) {
    throw unprocessable("pauseReason.code is not a heartbeat auto-pause code");
  }
  if (!Number.isInteger(input.consecutiveErrorCount) || input.consecutiveErrorCount < 1) {
    throw unprocessable("pauseReason.consecutiveErrorCount must be a positive integer");
  }

  const runtimeConfig = isPlainRecord(currentRuntimeConfig) ? { ...currentRuntimeConfig } : {};
  const heartbeat = isPlainRecord(runtimeConfig.heartbeat) ? { ...runtimeConfig.heartbeat } : {};
  const existingPauseReason = readExistingPauseReason(runtimeConfig);
  const previousHeartbeatEnabled = typeof heartbeat.enabled === "boolean" ? heartbeat.enabled : undefined;
  const pauseReason: HeartbeatAutoPauseReason = {
    code: input.code,
    adapter: normalizeRuntimeToken(input.adapter, "pauseReason.adapter"),
    consecutiveErrorCount: input.consecutiveErrorCount,
    firstRunId: normalizeRunId(input.firstRunId, "pauseReason.firstRunId"),
    lastRunId: normalizeRunId(input.lastRunId, "pauseReason.lastRunId"),
    sampleDigest: normalizeDigest(input.sampleDigest, "pauseReason.sampleDigest"),
    createdAt: normalizeIsoTimestamp(input.createdAt, "pauseReason.createdAt"),
    guardVersion: HEARTBEAT_AUTOPAUSE_GUARD_VERSION,
    sourceIssueId: HEARTBEAT_AUTOPAUSE_SOURCE_ISSUE_ID,
    ...(input.fingerprint ? { fingerprint: normalizeDigest(input.fingerprint, "pauseReason.fingerprint") } : {}),
    ...(previousHeartbeatEnabled === undefined ? {} : { previousHeartbeatEnabled }),
  };

  const nextPauseReason = isSamePauseWindow(existingPauseReason, pauseReason)
    ? existingPauseReason
    : pauseReason;

  const nextRuntimeConfig: Record<string, unknown> = {
    ...runtimeConfig,
    heartbeat: {
      ...heartbeat,
      enabled: false,
    },
    pauseReason: nextPauseReason,
  };

  return {
    runtimeConfig: nextRuntimeConfig,
    changed: !jsonEqual(runtimeConfig, nextRuntimeConfig),
  };
}

export function buildHeartbeatAutoResumeRuntimeConfig(
  currentRuntimeConfig: unknown,
  input: HeartbeatAutoResumeInput,
): AgentRuntimeConfigBuildResult {
  assertNoUnexpectedSensitiveKeys(input as unknown as Record<string, unknown>, resumeInputKeys, "resume");
  if (!input.resumedBy || !["agent", "user", "system"].includes(input.resumedBy.type)) {
    throw unprocessable("resumedBy.type must be agent, user, or system");
  }
  const runtimeConfig = isPlainRecord(currentRuntimeConfig) ? { ...currentRuntimeConfig } : {};
  const heartbeat = isPlainRecord(runtimeConfig.heartbeat) ? { ...runtimeConfig.heartbeat } : {};
  const pauseReason = readExistingPauseReason(runtimeConfig);
  const isAutoPauseReason = pauseReason?.guardVersion === HEARTBEAT_AUTOPAUSE_GUARD_VERSION &&
    pauseReason.sourceIssueId === HEARTBEAT_AUTOPAUSE_SOURCE_ISSUE_ID;

  if (!isAutoPauseReason) {
    return {
      runtimeConfig,
      changed: false,
    };
  }

  const nextRuntimeConfig: Record<string, unknown> = {
    ...runtimeConfig,
    heartbeat: {
      ...heartbeat,
      enabled: true,
    },
    lastPauseReason: pauseReason,
    resumeReason: normalizeRuntimeToken(input.resumeReason, "resumeReason"),
    resumedBy: {
      type: input.resumedBy.type,
      id: normalizeRuntimeToken(input.resumedBy.id, "resumedBy.id"),
    },
    resumedAt: normalizeIsoTimestamp(input.resumedAt, "resumedAt"),
  };
  delete nextRuntimeConfig.pauseReason;

  return {
    runtimeConfig: nextRuntimeConfig,
    changed: !jsonEqual(runtimeConfig, nextRuntimeConfig),
  };
}
