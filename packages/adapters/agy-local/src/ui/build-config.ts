import { buildAdapterEnvConfig, type CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_AGY_LOCAL_MODEL } from "../index.js";

function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildAgyConfig(v: CreateConfigValues): Record<string, unknown> {
  const raw = v as unknown as Record<string, unknown>;
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  ac.model = v.model || DEFAULT_AGY_LOCAL_MODEL;
  if (v.thinkingEffort) ac.effort = v.thinkingEffort;
  if (raw.mode) ac.mode = raw.mode;
  if (raw.agent) ac.agent = raw.agent;
  if (raw.agentPersona) ac.agent = raw.agentPersona;
  if (raw.jsonSchema) ac.jsonSchema = raw.jsonSchema;
  if (typeof raw.sandbox === "boolean") ac.sandbox = raw.sandbox;
  if (raw.addDirs) ac.addDirs = Array.isArray(raw.addDirs) ? raw.addDirs : parseCommaArgs(String(raw.addDirs));
  if (raw.project) ac.project = String(raw.project).trim();
  if (raw.printTimeout) ac.printTimeout = String(raw.printTimeout).trim();
  if (typeof raw.disableSlashCommands === "boolean") ac.disableSlashCommands = raw.disableSlashCommands;
  ac.dangerouslySkipPermissions = Boolean(v.dangerouslySkipPermissions);
  ac.timeoutSec = 0;
  ac.graceSec = 15;
  if (v.workspaceStrategyType === "git_worktree") {
    ac.workspaceStrategy = {
      type: "git_worktree",
      ...(v.workspaceBaseRef ? { baseRef: v.workspaceBaseRef } : {}),
      ...(v.workspaceBranchTemplate ? { branchTemplate: v.workspaceBranchTemplate } : {}),
      ...(v.worktreeParentDir ? { worktreeParentDir: v.worktreeParentDir } : {}),
    };
  }
  const env = buildAdapterEnvConfig(v.envBindings, v.envVars);
  if (Object.keys(env).length > 0) ac.env = env;
  if (v.command) ac.command = v.command;
  if (v.extraArgs) ac.extraArgs = parseCommaArgs(v.extraArgs);
  return ac;
}
