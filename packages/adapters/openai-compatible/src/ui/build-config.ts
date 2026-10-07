import { buildAdapterEnvConfig, type CreateConfigValues } from "@paperclipai/adapter-utils";
import { normalizeOpenAiCompatibleApiUrl } from "../index.js";

export function buildOpenAiCompatibleConfig(values: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = {
    ...(values.adapterSchemaValues ?? {}),
  };
  if (typeof config.apiUrl === "string") {
    config.apiUrl = normalizeOpenAiCompatibleApiUrl(config.apiUrl) ?? config.apiUrl.trim();
  }
  if (values.cwd) config.cwd = values.cwd;
  if (values.instructionsFilePath) config.instructionsFilePath = values.instructionsFilePath;
  if (values.promptTemplate) config.promptTemplate = values.promptTemplate;
  if (values.bootstrapPrompt) config.bootstrapPromptTemplate = values.bootstrapPrompt;
  if (values.model?.trim()) config.model = values.model.trim();
  const env = buildAdapterEnvConfig(values.envBindings, values.envVars);
  if (Object.keys(env).length > 0) config.env = env;
  return config;
}
