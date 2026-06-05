import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_LOCAL_BASE_URL, DEFAULT_LOCAL_MODEL } from "../index.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function buildLocalConfig(values: CreateConfigValues): Record<string, unknown> {
  const schemaValues = asRecord(values.adapterSchemaValues);
  const config: Record<string, unknown> = {
    model: values.model || DEFAULT_LOCAL_MODEL,
    baseUrl: values.url || DEFAULT_LOCAL_BASE_URL,
  };
  if (values.instructionsFilePath) config.instructionsFilePath = values.instructionsFilePath;
  if (values.promptTemplate) config.promptTemplate = values.promptTemplate;
  if (values.maxTurnsPerRun > 0) config.maxTurns = values.maxTurnsPerRun;
  if (typeof schemaValues.apiKey === "string" && schemaValues.apiKey) {
    config.apiKey = schemaValues.apiKey;
  }
  return config;
}
