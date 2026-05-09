import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildHermesObservableConfig(values: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  if (values.model?.trim()) config.model = values.model.trim();
  if (values.cwd) config.cwd = values.cwd;
  if (values.instructionsFilePath) config.instructionsFilePath = values.instructionsFilePath;
  if (values.promptTemplate) config.promptTemplate = values.promptTemplate;
  if (values.command?.trim()) config.hermesCommand = values.command.trim();
  if (values.extraArgs?.trim()) {
    config.extraArgs = values.extraArgs.split(/\s+/).filter(Boolean);
  }
  if (values.adapterSchemaValues) {
    Object.assign(config, values.adapterSchemaValues);
  }

  return config;
}
