import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_CODEBUDDY_LOCAL_MODEL } from "../index.js";

function parseArgs(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function buildCodeBuddyLocalConfig(values: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = {
    model: values.model || DEFAULT_CODEBUDDY_LOCAL_MODEL,
    timeoutSec: 0,
    graceSec: 20,
  };
  if (values.cwd) config.cwd = values.cwd;
  if (values.instructionsFilePath) config.instructionsFilePath = values.instructionsFilePath;
  if (values.thinkingEffort) config.effort = values.thinkingEffort;
  if (values.command) config.command = values.command;
  if (values.extraArgs) config.extraArgs = parseArgs(values.extraArgs);
  if (typeof values.envBindings === "object" && values.envBindings !== null) {
    config.env = values.envBindings;
  }
  return config;
}
