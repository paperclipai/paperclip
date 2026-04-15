import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { parseCommaArgs, parseEnvVars, parseEnvBindings } from "@paperclipai/adapter-utils";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "../index.js";

export function buildGeminiLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (v.bootstrapPrompt) ac.bootstrapPromptTemplate = v.bootstrapPrompt;
  ac.model = v.model || DEFAULT_GEMINI_LOCAL_MODEL;
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
  ac.sandbox = !v.dangerouslyBypassSandbox;

  if (v.command) ac.command = v.command;
  if (v.extraArgs) ac.extraArgs = parseCommaArgs(v.extraArgs);
  return ac;
}
