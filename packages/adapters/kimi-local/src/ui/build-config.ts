import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildKimiConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};

  if (v.cwd) ac.cwd = v.cwd;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (v.model) ac.model = v.model;
  if (v.thinkingEffort) {
    // Map thinking effort to boolean
    ac.thinking = v.thinkingEffort === "high" || v.thinkingEffort === "medium";
  }
  
  ac.yolo = true; // Always use yolo mode for headless runs
  ac.timeoutSec = 0;
  ac.graceSec = 15;

  if (v.command) ac.command = v.command;
  if (v.extraArgs) {
    // Parse extra args string into array
    const args = v.extraArgs
      .split(/\s+/)
      .map((s: string) => s.trim())
      .filter(Boolean);
    if (args.length > 0) ac.extraArgs = args;
  }
  if (v.maxTurnsPerRun > 0) ac.maxStepsPerTurn = v.maxTurnsPerRun;

  // Handle env vars
  if (v.envVars || Object.keys(v.envBindings).length > 0) {
    const env: Record<string, string> = {};
    if (v.envVars) {
      for (const line of v.envVars.split("\n")) {
        const [key, ...rest] = line.split("=");
        if (key && rest.length > 0) {
          env[key.trim()] = rest.join("=").trim();
        }
      }
    }
    for (const [key, value] of Object.entries(v.envBindings)) {
      if (typeof value === "string") env[key] = value;
    }
    if (Object.keys(env).length > 0) ac.env = env;
  }

  return ac;
}
