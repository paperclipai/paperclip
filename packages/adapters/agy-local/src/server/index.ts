export { execute } from "./execute.js";
export { prepareAgyRuntimeMcpConfig } from "./runtime-config.js";
export {
  listAgySkills,
  syncAgySkills,
  listAntigravitySkills,
  syncAntigravitySkills,
  resolveAgySkillsHome,
  resolveAntigravitySkillsHome,
} from "./skills.js";
export { testEnvironment } from "./test.js";
export {
  parseAgyOutput,
  parseAntigravityOutput,
  isAgyUnknownSessionError,
  isAntigravityUnknownSessionError,
  describeAgyFailure,
  describeAntigravityFailure,
  detectAgyAuthRequired,
  detectAntigravityAuthRequired,
  detectAgyQuotaExhausted,
  detectAntigravityQuotaExhausted,
  parseAgyResetDurationMs,
  isAgyTurnLimitResult,
  isAntigravityTurnLimitResult,
} from "./parse.js";
import type { AdapterSessionCodec, UsageSummary } from "@paperclipai/adapter-utils";
import { agyUsage, hasAgyUsage } from "../events.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readCumulativeUsage(value: unknown): UsageSummary | undefined {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  return hasAgyUsage(parsed) ? agyUsage(parsed) : undefined;
}

function normalizeAgySessionParams(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const sessionId =
    readNonEmptyString(record.sessionId) ??
    readNonEmptyString(record.session_id) ??
    readNonEmptyString(record.sessionID);
  if (!sessionId) return null;
  const cwd =
    readNonEmptyString(record.cwd) ??
    readNonEmptyString(record.workdir) ??
    readNonEmptyString(record.folder);
  const workspaceId = readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
  const repoUrl = readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
  const repoRef = readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);
  const rawRemoteExecution = record.remoteExecution ?? record.remote_execution;
  const remoteExecution =
    typeof rawRemoteExecution === "object" && rawRemoteExecution !== null && !Array.isArray(rawRemoteExecution)
      ? (rawRemoteExecution as Record<string, unknown>)
      : undefined;
  const rawCumulativeUsage = record.cumulativeUsage ?? record.cumulative_usage;
  const cumulativeUsage = readCumulativeUsage(rawCumulativeUsage);
  return {
    sessionId,
    ...(cwd ? { cwd } : {}),
    ...(cumulativeUsage ? { cumulativeUsage } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(repoUrl ? { repoUrl } : {}),
    ...(repoRef ? { repoRef } : {}),
    ...(remoteExecution ? { remoteExecution } : {}),
  };
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    return normalizeAgySessionParams(raw);
  },
  serialize(params: Record<string, unknown> | null) {
    return normalizeAgySessionParams(params);
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.sessionID)
    );
  },
};
