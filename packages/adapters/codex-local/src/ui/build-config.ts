import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { parseCommaArgs, parseEnvVars, parseEnvBindings, parseJsonObject } from "@paperclipai/adapter-utils";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
} from "../index.js";

export function buildCodexLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (v.bootstrapPrompt) ac.bootstrapPromptTemplate = v.bootstrapPrompt;
  ac.model = v.model || DEFAULT_CODEX_LOCAL_MODEL;
  if (v.thinkingEffort) ac.modelReasoningEffort = v.thinkingEffort;
  ac.timeoutSec = 0;
  ac.graceSec = 15;
  const env = parseEnvBindings(v.envBindings);
  const legacy = parseEnvVars(v.envVars);
  for (const [key, value] of Object.entries(legacy)) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) {
      env[key] = { type: "plain", value };
    }
  }
  if (Object.keys(env).length > 0) ac.env = env;
  ac.search = v.search;
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
