import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_COPILOT_LOCAL_MODEL } from "../index.js";

function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseEnvVars(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = value;
  }
  return env;
}

function parseEnvBindings(bindings: unknown): Record<string, unknown> {
  if (typeof bindings !== "object" || bindings === null || Array.isArray(bindings)) return {};
  const env: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(bindings)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (typeof raw === "string") {
      env[key] = { type: "plain", value: raw };
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    if (record.type === "plain" && typeof record.value === "string") {
      env[key] = { type: "plain", value: record.value };
    } else if (record.type === "secret_ref" && typeof record.secretId === "string") {
      env[key] = {
        type: "secret_ref",
        secretId: record.secretId,
        ...(typeof record.version === "number" || record.version === "latest"
          ? { version: record.version }
          : {}),
      };
    }
  }
  return env;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function buildCopilotLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = {
    model: v.model || DEFAULT_COPILOT_LOCAL_MODEL,
    timeoutSec: 0,
    graceSec: 15,
    mode: v.copilotAcpMode ?? "persistent",
    permissionMode: v.copilotAcpPermissionMode ?? "approve-all",
    nonInteractivePermissions: v.copilotAcpNonInteractivePermissions ?? "deny",
    warmHandleIdleMs: v.copilotAcpWarmHandleIdleMs ?? 0,
  };
  if (v.cwd) config.cwd = v.cwd;
  if (v.instructionsFilePath) config.instructionsFilePath = v.instructionsFilePath;
  if (v.thinkingEffort) config.reasoningEffort = v.thinkingEffort;
  if (v.copilotAcpStateDir) config.stateDir = v.copilotAcpStateDir;
  if (v.command) config.command = v.command;
  if (v.extraArgs) config.extraArgs = parseCommaArgs(v.extraArgs);

  const env = parseEnvBindings(v.envBindings);
  for (const [key, value] of Object.entries(parseEnvVars(v.envVars))) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) {
      env[key] = { type: "plain", value };
    }
  }
  if (Object.keys(env).length > 0) config.env = env;

  if (v.workspaceStrategyType === "git_worktree") {
    config.workspaceStrategy = {
      type: "git_worktree",
      ...(v.workspaceBaseRef ? { baseRef: v.workspaceBaseRef } : {}),
      ...(v.workspaceBranchTemplate ? { branchTemplate: v.workspaceBranchTemplate } : {}),
      ...(v.worktreeParentDir ? { worktreeParentDir: v.worktreeParentDir } : {}),
    };
  }
  const runtimeServices = parseJsonObject(v.runtimeServicesJson ?? "");
  if (runtimeServices && Array.isArray(runtimeServices.services)) {
    config.workspaceRuntime = runtimeServices;
  }
  return config;
}
