import type { AgentConfigurationWarning } from "@paperclipai/shared";
import { t } from "@/i18n";

const known: Record<string, { label: string; key: string }> = {
  maxTurnsPerRun: { label: "Max turns per run", key: "ignoredMaxTurns" },
  chrome: { label: "Chrome integration", key: "ignoredChrome" },
  warmHandleIdleMs: { label: "Warm handle idle timeout", key: "ignoredWarmTimeout" },
  acpWarmHandleIdleMs: { label: "ACP warm handle idle timeout", key: "ignoredAcpWarmTimeout" },
};

/** Translate only known normalization notices; custom diagnostics stay verbatim. */
export function runnerWarningDisplay(warning: AgentConfigurationWarning): string {
  if (warning.code !== "runner_option_ignored" || !Object.hasOwn(known, warning.field)) return warning.message;
  const entry = known[warning.field];
  const expected = `${entry.label} (${warning.field}) is not supported by Paperclip Runner and is ignored. The agent can still run.`;
  return warning.message === expected ? t(`oct26Onboarding.runner.${entry.key}`) : warning.message;
}
