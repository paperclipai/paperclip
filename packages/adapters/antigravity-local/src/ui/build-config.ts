// UI configuration builder for Antigravity local adapter

import { buildAdapterEnvConfig, type CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_ANTIGRAVITY_LOCAL_MODEL } from "../index.js";

// Parses comma-separated arguments string into trimmed array
function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// Builds the persistent adapterConfig record from create/edit form values
export function buildAntigravityLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};

  if (v.command) ac.command = v.command;
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;

  ac.model = v.model || DEFAULT_ANTIGRAVITY_LOCAL_MODEL;
  if (v.antigravityAgent) ac.agent = v.antigravityAgent;
  const effort = v.antigravityEffort || v.thinkingEffort;
  if (effort) ac.effort = effort;
  if (v.antigravityPrintTimeout) ac.printTimeout = v.antigravityPrintTimeout;

  ac.sandbox = Boolean(v.antigravitySandbox);
  const skipPerms = (v as unknown as Record<string, unknown>).antigravityDangerouslySkipPermissions ?? v.dangerouslySkipPermissions;
  ac.dangerouslySkipPermissions = skipPerms !== false;

  ac.timeoutSec = 0;
  ac.graceSec = 15;

  const env = buildAdapterEnvConfig(v.envBindings, v.envVars);
  if (Object.keys(env).length > 0) ac.env = env;

  if (v.extraArgs) {
    ac.extraArgs = typeof v.extraArgs === "string" ? parseCommaArgs(v.extraArgs) : v.extraArgs;
  }

  return ac;
}
