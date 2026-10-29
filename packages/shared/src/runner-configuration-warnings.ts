export interface AgentConfigurationWarning {
  code: "runner_option_ignored";
  field: string;
  message: string;
}

// Only obsolete tuning/features belong here. Permission, filesystem, network,
// command and credential settings must retain their existing validation.
const CLAUDE_IGNORED_OPTIONS = {
  maxTurnsPerRun: "Max turns per run",
  chrome: "Chrome integration",
  warmHandleIdleMs: "Warm handle idle timeout",
  acpWarmHandleIdleMs: "ACP warm handle idle timeout",
} as const;

export function normalizeClaudeRunnerOptions(config: Record<string, unknown>): {
  config: Record<string, unknown>;
  warnings: AgentConfigurationWarning[];
} {
  const normalized = { ...config };
  const warnings: AgentConfigurationWarning[] = [];
  for (const [field, label] of Object.entries(CLAUDE_IGNORED_OPTIONS)) {
    const value = config[field];
    if (value !== undefined && value !== null && value !== false && value !== "" && value !== 0
      && !(Array.isArray(value) && value.length === 0)) {
      warnings.push({ code: "runner_option_ignored", field,
        message: `${label} (${field}) is not supported by Paperclip Runner and is ignored. The agent can still run.` });
    }
    delete normalized[field];
  }
  return { config: normalized, warnings };
}
