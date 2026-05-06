import type { CreateConfigValues } from "../../components/AgentConfigForm";

export function buildOllamaHttpConfig(v: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (v.url.trim()) config.baseUrl = v.url.trim();
  if (v.instructionsFilePath?.trim()) config.instructionsFilePath = v.instructionsFilePath.trim();
  if (v.promptTemplate?.trim()) config.promptTemplate = v.promptTemplate.trim();
  if (v.model.trim()) config.model = v.model.trim();
  config.timeoutSec = 120;
  return config;
}