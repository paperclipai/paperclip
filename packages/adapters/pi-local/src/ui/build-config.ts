import { buildAdapterEnvConfig, type CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildPiLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.model) ac.model = v.model;
  if (v.thinkingEffort) ac.thinking = v.thinkingEffort;
  
  // Bound Pi runs with a 30-minute wall ceiling. Silence watchdog (300s) is the
  // primary hang detector; wall timeout stops noisy infinite loops.
  ac.timeoutSec = 1800;
  ac.silenceTimeoutSec = 300;
  ac.graceSec = 20;
  
  const env = buildAdapterEnvConfig(v.envBindings, v.envVars);
  if (Object.keys(env).length > 0) ac.env = env;
  if (v.command) ac.command = v.command;
  if (v.extraArgs) ac.extraArgs = v.extraArgs;
  if (v.args) ac.args = v.args;

  return ac;
}
