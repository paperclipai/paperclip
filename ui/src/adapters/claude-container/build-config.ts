import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildClaudeContainerConfig(values: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  if (values.cwd) config.cwd = values.cwd;
  if (values.instructionsFilePath) config.instructionsFilePath = values.instructionsFilePath;
  if (values.model) config.model = values.model;
  if (values.thinkingEffort) config.effort = values.thinkingEffort;
  if (values.chrome) config.chrome = true;
  if (values.dangerouslySkipPermissions) config.dangerouslySkipPermissions = true;
  if (values.maxTurnsPerRun) config.maxTurnsPerRun = values.maxTurnsPerRun;
  if (values.promptTemplate) config.promptTemplate = values.promptTemplate;
  if (values.bootstrapPrompt) config.bootstrapPromptTemplate = values.bootstrapPrompt;

  const extraArgs = values.extraArgs
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (extraArgs?.length) config.extraArgs = extraArgs;

  const envLines = values.envVars
    ?.split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (envLines?.length) {
    const env: Record<string, string> = {};
    for (const line of envLines) {
      const eq = line.indexOf("=");
      if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    config.env = env;
  }

  return config;
}
