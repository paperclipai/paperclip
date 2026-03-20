import type { CreateConfigValues } from "@paperclipai/adapter-utils";

/**
 * Build Kiro adapter config from form values.
 */
export function buildAdapterConfig(values: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  if (values.command && values.command.trim()) {
    config.command = values.command.trim();
  }
  if (values.model && values.model.trim()) {
    config.model = values.model.trim();
  }
  if (values.cwd && values.cwd.trim()) {
    config.cwd = values.cwd.trim();
  }
  if (values.instructionsFilePath && values.instructionsFilePath.trim()) {
    config.instructionsFilePath = values.instructionsFilePath.trim();
  }
  if (typeof values.maxTurnsPerRun === "number" && values.maxTurnsPerRun > 0) {
    config.timeoutSec = values.maxTurnsPerRun * 120; // Rough estimate
  }
  config.graceSec = 15;
  if (values.extraArgs && values.extraArgs.trim()) {
    config.extraArgs = values.extraArgs.trim().split(/\s+/).filter(Boolean);
  }
  if (values.envVars && values.envVars.trim()) {
    // Parse env vars from string format
    config.env = {};
    const lines = values.envVars.split("\n");
    for (const line of lines) {
      const match = line.match(/^(\w+)=(.*)$/);
      if (match) {
        (config.env as Record<string, string>)[match[1]] = match[2];
      }
    }
  }

  return config;
}
