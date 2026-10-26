import { buildAdapterEnvConfig, type CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildT3CodeLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = { timeoutSec: 0, graceSec: 15 };
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (v.command) ac.command = v.command;
  const provider = v.adapterSchemaValues?.provider;
  if (typeof provider === "string" && provider.trim()) ac.provider = provider.trim();
  if (v.model) ac.model = v.model;
  const env = buildAdapterEnvConfig(v.envBindings, v.envVars);
  if (Object.keys(env).length > 0) ac.env = env;
  return ac;
}
