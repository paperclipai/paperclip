import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";
import { resolvePaperclipDesiredSkillNames } from "@paperclipai/adapter-utils/server-utils";

export type RunSkillInvocationSignalSource =
  | "runtime_required"
  | "agent_selection"
  | "issue_mention";

export interface RunSkillTelemetry {
  schemaVersion: 1;
  availableCount: number;
  availableKeys: string[];
  requiredKeys: string[];
  activatedKeys: string[];
  invocationSignals: Array<{
    key: string;
    sources: RunSkillInvocationSignalSource[];
  }>;
}

/**
 * Builds durable per-run skill telemetry without claiming that an adapter or
 * model executed a skill. `invocationSignals` records why a skill was made
 * active for the run; adapters can add stronger execution evidence later.
 */
export function buildRunSkillTelemetry(input: {
  runtimeEntries: PaperclipSkillEntry[];
  effectiveConfig: Record<string, unknown>;
  mentionedSkillKeys: string[];
}): RunSkillTelemetry {
  const entries = [...input.runtimeEntries].sort((left, right) => left.key.localeCompare(right.key));
  const availableKeys = entries.map((entry) => entry.key);
  const requiredKeys = entries.filter((entry) => entry.required === true).map((entry) => entry.key);
  const activatedKeys = resolvePaperclipDesiredSkillNames(input.effectiveConfig, entries).sort((left, right) =>
    left.localeCompare(right),
  );
  const mentionedKeys = new Set(input.mentionedSkillKeys);
  const required = new Set(requiredKeys);

  return {
    schemaVersion: 1,
    availableCount: availableKeys.length,
    availableKeys,
    requiredKeys,
    activatedKeys,
    invocationSignals: activatedKeys.map((key) => {
      const sources: RunSkillInvocationSignalSource[] = [];
      if (required.has(key)) sources.push("runtime_required");
      if (mentionedKeys.has(key)) sources.push("issue_mention");
      if (!required.has(key) && !mentionedKeys.has(key)) sources.push("agent_selection");
      return { key, sources };
    }),
  };
}
