import type { CreateConfigValues } from "@paperclipai/adapter-utils";

/**
 * Build the adapter configuration for a Kimi local agent from UI form values.
 */
export function buildKimiLocalConfig(values: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  if (values.instructionsFilePath?.trim()) {
    config.instructionsFilePath = values.instructionsFilePath.trim();
  }

  if (values.cwd?.trim()) {
    config.cwd = values.cwd.trim();
  }

  if (values.model?.trim()) {
    config.model = values.model.trim();
  }

  // Kimi-specific config - use thinkingEffort as thinking (boolean)
  // Convert thinkingEffort to boolean: if set and not "off", enable thinking
  if (values.thinkingEffort) {
    config.thinking = values.thinkingEffort !== "off";
  } else {
    config.thinking = true; // Default to true
  }

  if (values.maxTurnsPerRun && values.maxTurnsPerRun > 0) {
    config.maxStepsPerTurn = values.maxTurnsPerRun;
  }

  if (values.extraArgs?.trim()) {
    config.extraArgs = values.extraArgs.split(",").map((s) => s.trim()).filter(Boolean);
  }

  if (values.envVars?.trim()) {
    // Parse env vars string into key-value pairs
    const env: Record<string, string> = {};
    for (const line of values.envVars.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        if (key) env[key] = value;
      }
    }
    if (Object.keys(env).length > 0) {
      config.env = env;
    }
  }

  return config;
}
