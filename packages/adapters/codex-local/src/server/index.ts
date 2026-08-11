export { execute, ensureCodexSkillsInjected } from "./execute.js";
export {
  resolveCodexAuthPrecedence,
  CODEX_SANDBOX_AUTH_PRECEDENCE_WARNING,
  CODEX_SANDBOX_AUTH_PRECEDENCE_WARNING_LOG_LINE,
  CODEX_SANDBOX_AUTH_EXISTS_COMMAND,
  type CodexAuthPrecedenceInput,
  type CodexAuthPrecedenceResolution,
  type CodexAuthPrecedenceWinner,
} from "./auth-precedence.js";
export * from "./acp.js";
export { getConfigSchema } from "./config-schema.js";
export {
  reconcileManagedCodexHome,
  isManagedCodexHomePath,
  evaluateCodexCredentialReadiness,
  type ReconcileManagedCodexHomeInput,
  type ReconcileManagedCodexHomeResult,
  type ReconcileManagedCodexHomeStatus,
  type CodexCredentialReadiness,
  type CodexCredentialReadinessInput,
  type CodexCredentialAuthMode,
} from "./codex-home.js";
export { listCodexSkills, syncCodexSkills } from "./skills.js";
export { testEnvironment } from "./test.js";
export { parseCodexJsonl, isCodexHarnessCrash, isCodexProviderQuotaError, isCodexTransientUpstreamError, isCodexUnknownSessionError } from "./parse.js";
export {
  getQuotaWindows,
  readCodexAuthInfo,
  readCodexToken,
  fetchCodexQuota,
  fetchCodexRpcQuota,
  mapCodexRpcQuota,
  secondsToWindowLabel,
  fetchWithTimeout,
  codexHomeDir,
} from "./quota.js";
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { sessionCodec as acpxSessionCodec } from "@paperclipai/adapter-utils/acpx-engine/session-codec";
import type { AdapterChatCommand } from "@paperclipai/adapter-utils";
import { CODEX_APP_SERVER_RUNTIME, readCodexGoalConfig } from "./app-server/index.js";

export function listCodexChatCommands(ctx: { adapterConfig: Record<string, unknown> }): AdapterChatCommand[] {
  const goalConfig = readCodexGoalConfig(ctx.adapterConfig);
  if (goalConfig.runtime !== CODEX_APP_SERVER_RUNTIME || !goalConfig.goal.enabled) return [];
  return [
    {
      name: "goal",
      argHint: "<objective> | status | clear",
      description: "Set, inspect, or clear the Codex goal for this issue thread.",
    },
  ];
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId = readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
    if (!sessionId) return acpxSessionCodec.deserialize(raw);
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    const workspaceId = readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
    const repoUrl = readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
    const repoRef = readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);
    const protocol = readNonEmptyString(record.protocol);
    const goalRuntimeMode = readNonEmptyString(record.goalRuntimeMode);
    const issueId = readNonEmptyString(record.issueId);
    const objectiveFingerprint = readNonEmptyString(record.objectiveFingerprint);
    const features = Array.isArray(record.features)
      ? record.features.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
      ...(protocol ? { protocol } : {}),
      ...(features.length > 0 ? { features } : {}),
      ...(goalRuntimeMode ? { goalRuntimeMode } : {}),
      ...(issueId ? { issueId } : {}),
      ...(objectiveFingerprint ? { objectiveFingerprint } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId = readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
    if (!sessionId) return acpxSessionCodec.serialize(params);
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    const workspaceId = readNonEmptyString(params.workspaceId) ?? readNonEmptyString(params.workspace_id);
    const repoUrl = readNonEmptyString(params.repoUrl) ?? readNonEmptyString(params.repo_url);
    const repoRef = readNonEmptyString(params.repoRef) ?? readNonEmptyString(params.repo_ref);
    const protocol = readNonEmptyString(params.protocol);
    const goalRuntimeMode = readNonEmptyString(params.goalRuntimeMode);
    const issueId = readNonEmptyString(params.issueId);
    const objectiveFingerprint = readNonEmptyString(params.objectiveFingerprint);
    const features = Array.isArray(params.features)
      ? params.features.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
      ...(protocol ? { protocol } : {}),
      ...(features.length > 0 ? { features } : {}),
      ...(goalRuntimeMode ? { goalRuntimeMode } : {}),
      ...(issueId ? { issueId } : {}),
      ...(objectiveFingerprint ? { objectiveFingerprint } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      acpxSessionCodec.getDisplayId?.(params) ??
      null
    );
  },
};
