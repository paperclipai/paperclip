import type { AgentConfigurationWarning } from "@paperclipai/shared";

export function configurationWarningMessages(
  result: { configurationWarnings?: AgentConfigurationWarning[] } | null | undefined,
): string | null {
  const warnings = result?.configurationWarnings ?? [];
  return warnings.length > 0 ? warnings.map(warning => warning.message).join("\n") : null;
}
