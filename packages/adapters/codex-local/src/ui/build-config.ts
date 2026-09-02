import {
  buildAdapterEnvConfig,
  isPaperclipRunnerProvider,
  resolvePaperclipRunnerIdleTimeoutMs,
  resolvePaperclipRunnerPermissionMode,
  type CreateConfigValues,
} from "@paperclipai/adapter-utils";
import { DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX } from "../index.js";

function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function buildCodexLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.model) ac.model = v.model;
  if (v.thinkingEffort) ac.modelReasoningEffort = v.thinkingEffort;
  if (v.codexEngine === "cli" || v.codexEngine === "acp") ac.engine = v.codexEngine;
  if (v.codexEngine === "acp") {
    if (v.codexAcpAgentCommand) ac.agentCommand = v.codexAcpAgentCommand;
    ac.mode = v.codexAcpMode ?? "persistent";
    ac.nonInteractivePermissions = v.codexAcpNonInteractivePermissions ?? "deny";
    if (v.codexAcpStateDir) ac.stateDir = v.codexAcpStateDir;
    ac.warmHandleIdleMs = v.codexAcpWarmHandleIdleMs ?? 0;
  }
  ac.timeoutSec = 0;
  ac.graceSec = 15;
  const env = buildAdapterEnvConfig(v.envBindings, v.envVars);
  if (Object.keys(env).length > 0) ac.env = env;
  ac.search = v.search;
  ac.fastMode = v.fastMode;
  ac.dangerouslyBypassApprovalsAndSandbox =
    typeof v.dangerouslyBypassSandbox === "boolean"
      ? v.dangerouslyBypassSandbox
      : DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
  if (v.workspaceStrategyType === "git_worktree") {
    ac.workspaceStrategy = {
      type: "git_worktree",
      ...(v.workspaceBaseRef ? { baseRef: v.workspaceBaseRef } : {}),
      ...(v.workspaceBranchTemplate ? { branchTemplate: v.workspaceBranchTemplate } : {}),
      ...(v.worktreeParentDir ? { worktreeParentDir: v.worktreeParentDir } : {}),
    };
  }
  const runtimeServices = parseJsonObject(v.runtimeServicesJson ?? "");
  if (runtimeServices && Array.isArray(runtimeServices.services)) {
    ac.workspaceRuntime = runtimeServices;
  }
  if (v.command) ac.command = v.command;
  if (v.extraArgs) ac.extraArgs = parseCommaArgs(v.extraArgs);
  return ac;
}

/** Build a provider profile accepted by the experimental Rust runner. */
export function buildPaperclipRunnerConfig(v: CreateConfigValues): Record<string, unknown> {
  const config = buildCodexLocalConfig(v);
  const schemaValues = { ...(v.adapterSchemaValues ?? {}) };
  for (const unsupportedKey of [
    "engine",
    "agentCommand",
    "mode",
    "nonInteractivePermissions",
    "stateDir",
    "warmHandleIdleMs",
    "dangerouslyBypassApprovalsAndSandbox",
    "dangerouslyBypassSandbox",
    "instructionsFilePath",
    "modelReasoningEffort",
    "search",
    "fastMode",
    "command",
    "extraArgs",
  ]) {
    delete config[unsupportedKey];
    delete schemaValues[unsupportedKey];
  }
  const providerCandidate = schemaValues.provider;
  const provider = isPaperclipRunnerProvider(providerCandidate)
    ? providerCandidate
    : "codex";
  const acpxAgent = schemaValues.acpxAgent === "codex" ? "codex" : "claude";
  const schemaModel = typeof schemaValues.model === "string"
    ? schemaValues.model.trim()
    : "";
  const configuredModel = typeof config.model === "string"
    ? config.model.trim()
    : "";
  const managedProfileId = typeof schemaValues.managedProfileId === "string"
    ? schemaValues.managedProfileId.trim()
    : "";
  const agentCoreProfileId = typeof schemaValues.agentCoreProfileId === "string"
    ? schemaValues.agentCoreProfileId.trim()
    : "";
  const maxSessionListCostUsd = Number(schemaValues.maxSessionListCostUsd ?? 1);
  const maxEstimatedSessionCostUsd = Number(
    schemaValues.maxEstimatedSessionCostUsd ?? 1,
  );
  const managedAgentsRetentionAcknowledged =
    schemaValues.managedAgentsRetentionAcknowledged === true;
  const agentCoreRetentionAcknowledged =
    schemaValues.agentCoreRetentionAcknowledged === true;
  const boundedLimit = (
    value: unknown,
    fallback: number,
    maximum: number,
    label: string,
  ) => {
    if (value === undefined || value === null || value === "") return fallback;
    if (
      typeof value !== "number"
      || !Number.isSafeInteger(value)
      || value <= 0
      || value > maximum
    ) {
      throw new Error(`${label} must be an integer between 1 and ${maximum}.`);
    }
    return value;
  };
  const maxIterations = boundedLimit(
    schemaValues.maxIterations,
    8,
    8,
    "AWS AgentCore maxIterations",
  );
  const maxOutputTokens = boundedLimit(
    schemaValues.maxOutputTokens,
    4_096,
    4_096,
    "AWS AgentCore maxOutputTokens",
  );
  const timeoutSeconds = boundedLimit(
    schemaValues.timeoutSeconds,
    300,
    300,
    "AWS AgentCore timeoutSeconds",
  );
  const lifecycleCandidate = v.paperclipRunnerLifecycleMode ?? schemaValues.lifecycleMode;
  const lifecycleMode = lifecycleCandidate === "warm" ? "warm" : "per_turn";
  const configuredIdleTimeoutMs =
    v.paperclipRunnerIdleTimeoutMs ?? schemaValues.idleTimeoutMs;
  const idleTimeoutMs = resolvePaperclipRunnerIdleTimeoutMs(
    configuredIdleTimeoutMs,
  );
  for (const normalizedKey of [
    "provider",
    "model",
    "acpxAgent",
    "codexPermissionMode",
    "opencodePermissionMode",
    "acpxPermissionMode",
    "managedProfileId",
    "managedAgentsRetentionAcknowledged",
    "maxSessionListCostUsd",
    "anthropicAgentId",
    "agentVersion",
    "anthropicEnvironmentId",
    "agentCoreProfileId",
    "agentCoreRetentionAcknowledged",
    "maxEstimatedSessionCostUsd",
    "maxIterations",
    "maxOutputTokens",
    "timeoutSeconds",
    "awsRegion",
    "awsAccountId",
    "harnessArn",
    "harnessId",
    "harnessVersion",
    "endpointArn",
    "endpointQualifier",
    "agentRuntimeArn",
    "memoryArn",
    "memoryId",
    "invocationRoleArn",
    "contextBucket",
    "contextPrefix",
    "contextKmsKeyArn",
    "qualificationRevision",
    "lifecycleMode",
    "idleTimeoutMs",
  ]) {
    delete schemaValues[normalizedKey];
  }
  return {
    ...config,
    ...schemaValues,
    provider,
    codexPermissionMode: resolvePaperclipRunnerPermissionMode(
      "codex",
      v.adapterSchemaValues?.codexPermissionMode ?? v.codexPermissionMode,
    ),
    opencodePermissionMode: resolvePaperclipRunnerPermissionMode(
      "opencode",
      v.adapterSchemaValues?.opencodePermissionMode,
    ),
    acpxPermissionMode: resolvePaperclipRunnerPermissionMode(
      "acpx",
      v.adapterSchemaValues?.acpxPermissionMode,
    ),
    ...(provider === "opencode"
      ? {
          model: schemaModel
            || configuredModel
            || "openrouter/deepseek/deepseek-v4-flash-0731",
        }
      : {}),
    ...(provider === "acpx"
      ? {
          acpxAgent,
          model: acpxAgent === "claude" ? "claude-sonnet-5" : "gpt-5.6-sol",
        }
      : {}),
    ...(provider === "claude_managed"
      ? {
          ...(managedProfileId ? { managedProfileId } : {}),
          model: configuredModel || "claude-sonnet-5",
          maxSessionListCostUsd:
            Number.isFinite(maxSessionListCostUsd) && maxSessionListCostUsd > 0
              ? maxSessionListCostUsd
              : 1,
          managedAgentsRetentionAcknowledged:
            managedAgentsRetentionAcknowledged,
        }
      : {}),
    ...(provider === "aws_agentcore"
      ? {
          ...(agentCoreProfileId ? { agentCoreProfileId } : {}),
          model: configuredModel || "global.anthropic.claude-sonnet-4-6",
          maxEstimatedSessionCostUsd:
            Number.isFinite(maxEstimatedSessionCostUsd)
              && maxEstimatedSessionCostUsd > 0
              ? maxEstimatedSessionCostUsd
              : 1,
          agentCoreRetentionAcknowledged:
            agentCoreRetentionAcknowledged,
          maxIterations,
          maxOutputTokens,
          timeoutSeconds,
        }
      : {}),
    lifecycleMode,
    ...(lifecycleMode === "warm" ? { idleTimeoutMs } : {}),
  };
}
