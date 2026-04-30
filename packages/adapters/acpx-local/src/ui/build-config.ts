import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import {
  DEFAULT_ACPX_LOCAL_AGENT,
  DEFAULT_ACPX_LOCAL_MODE,
  DEFAULT_ACPX_LOCAL_NON_INTERACTIVE_PERMISSIONS,
  DEFAULT_ACPX_LOCAL_PERMISSION_MODE,
  DEFAULT_ACPX_LOCAL_TIMEOUT_SEC,
} from "../index.js";

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
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = value;
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
    const rec = raw as Record<string, unknown>;
    if (rec.type === "plain" && typeof rec.value === "string") {
      env[key] = { type: "plain", value: rec.value };
      continue;
    }
    if (rec.type === "secret_ref" && typeof rec.secretId === "string") {
      env[key] = {
        type: "secret_ref",
        secretId: rec.secretId,
        ...(typeof rec.version === "number" || rec.version === "latest"
          ? { version: rec.version }
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
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function buildAcpxLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const schemaValues = v.adapterSchemaValues ?? {};
  const ac: Record<string, unknown> = {
    agent: schemaValues.agent || DEFAULT_ACPX_LOCAL_AGENT,
    mode: schemaValues.mode || DEFAULT_ACPX_LOCAL_MODE,
    permissionMode: schemaValues.permissionMode || DEFAULT_ACPX_LOCAL_PERMISSION_MODE,
    nonInteractivePermissions:
      schemaValues.nonInteractivePermissions || DEFAULT_ACPX_LOCAL_NON_INTERACTIVE_PERMISSIONS,
    timeoutSec: readNumber(schemaValues.timeoutSec, DEFAULT_ACPX_LOCAL_TIMEOUT_SEC),
  };

  for (const key of [
    "agentCommand",
    "cwd",
    "stateDir",
    "instructionsFilePath",
    "promptTemplate",
    "bootstrapPromptTemplate",
  ]) {
    const value = schemaValues[key];
    if (typeof value === "string" && value.trim()) ac[key] = value.trim();
  }

  if (!ac.cwd && v.cwd) ac.cwd = v.cwd;
  if (!ac.instructionsFilePath && v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (!ac.promptTemplate && v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (!ac.bootstrapPromptTemplate && v.bootstrapPrompt) ac.bootstrapPromptTemplate = v.bootstrapPrompt;

  const env = parseEnvBindings(v.envBindings);
  const legacy = parseEnvVars(v.envVars);
  for (const [key, value] of Object.entries(legacy)) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) {
      env[key] = { type: "plain", value };
    }
  }
  if (typeof schemaValues.env === "string") {
    const schemaEnv = parseJsonObject(schemaValues.env);
    if (schemaEnv) Object.assign(env, schemaEnv);
  } else if (typeof schemaValues.env === "object" && schemaValues.env !== null && !Array.isArray(schemaValues.env)) {
    Object.assign(env, schemaValues.env as Record<string, unknown>);
  }
  if (Object.keys(env).length > 0) ac.env = env;

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
