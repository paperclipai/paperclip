import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { parseEnvVars, parseEnvBindings } from "@paperclipai/adapter-utils";

export function buildPiLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (v.bootstrapPrompt) ac.bootstrapPromptTemplate = v.bootstrapPrompt;
  if (v.model) ac.model = v.model;
  if (v.thinkingEffort) ac.thinking = v.thinkingEffort;
  
  // Pi sessions can run until the CLI exits naturally; keep timeout disabled (0)
  ac.timeoutSec = 0;
  ac.graceSec = 20;
  
  const env = parseEnvBindings(v.envBindings);
  const legacy = parseEnvVars(v.envVars);
  for (const [key, value] of Object.entries(legacy)) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) {
      env[key] = { type: "plain", value };
    }
  }
  if (Object.keys(env).length > 0) ac.env = env;
  if (v.command) ac.command = v.command;
  if (v.extraArgs) ac.extraArgs = v.extraArgs;
  if (v.args) ac.args = v.args;

  return ac;
}
