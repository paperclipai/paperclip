import { buildAdapterEnvConfig, type CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_DISTILL_LOCAL_MODEL } from "../index.js";

/** Distill-only create-form values the config fields store in `adapterSchemaValues`. */
export const DISTILL_SCHEMA_KEYS = ["mode", "workerModel", "workerEffort", "mainVariant", "workerVariant"] as const;

function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildDistillLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  ac.model = v.model || DEFAULT_DISTILL_LOCAL_MODEL;
  ac.timeoutSec = 0;
  ac.graceSec = 20;
  if (v.thinkingEffort) ac.reasoningEffort = v.thinkingEffort;
  for (const key of DISTILL_SCHEMA_KEYS) {
    const value = v.adapterSchemaValues?.[key];
    if (typeof value === "string" && value) ac[key] = value;
  }
  const env = buildAdapterEnvConfig(v.envBindings, v.envVars);
  if (Object.keys(env).length > 0) ac.env = env;
  if (v.command) ac.command = v.command;
  if (v.extraArgs) ac.extraArgs = parseCommaArgs(v.extraArgs);
  return ac;
}
