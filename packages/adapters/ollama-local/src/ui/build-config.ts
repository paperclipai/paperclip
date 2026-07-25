import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildOllamaLocalConfig(values: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = {
    baseUrl: values.adapterSchemaValues?.baseUrl ?? "http://127.0.0.1:11434",
    apiMode: values.adapterSchemaValues?.apiMode ?? "openai",
    model: values.model,
    stream: true,
  };
  if (values.adapterSchemaValues?.apiKey) config.apiKey = values.adapterSchemaValues.apiKey;
  return config;
}
