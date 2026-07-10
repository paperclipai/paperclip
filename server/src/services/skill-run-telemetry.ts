import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";
import {
  readPaperclipSkillSyncPreference,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

export type RunSkillPreparationSource =
  | "runtime_required"
  | "agent_selection"
  | "issue_mention";

export interface RunSkillTelemetry {
  schemaVersion: 2;
  availableCount: number;
  availableKeys: string[];
  requestedKeys: string[];
  desiredKeys: string[];
  requiredKeys: string[];
  preparedKeys: string[];
  unavailableDesiredKeys: string[];
  preparationSignals: Array<{
    key: string;
    sources: RunSkillPreparationSource[];
  }>;
}

/**
 * Builds durable pre-adapter skill telemetry. Requested keys may be absent
 * from the runtime inventory; prepared keys are the available intersection.
 * Neither field claims that an adapter activated or executed a skill.
 */
export function buildRunSkillTelemetry(input: {
  runtimeEntries: PaperclipSkillEntry[];
  effectiveConfig: Record<string, unknown>;
  mentionedSkillKeys: string[];
}): RunSkillTelemetry {
  const entries = [...input.runtimeEntries].sort((left, right) => left.key.localeCompare(right.key));
  const availableKeys = entries.map((entry) => entry.key);
  const available = new Set(availableKeys);
  const requestedKeys = [...readPaperclipSkillSyncPreference(input.effectiveConfig).desiredSkills]
    .sort((left, right) => left.localeCompare(right));
  const requiredKeys = entries.filter((entry) => entry.required === true).map((entry) => entry.key);
  const desiredKeys = resolvePaperclipDesiredSkillNames(input.effectiveConfig, entries).sort((left, right) =>
    left.localeCompare(right),
  );
  const preparedKeys = desiredKeys.filter((key) => available.has(key));
  const unavailableDesiredKeys = desiredKeys.filter((key) => !available.has(key));
  const mentionedKeys = new Set(input.mentionedSkillKeys);
  const required = new Set(requiredKeys);

  return {
    schemaVersion: 2,
    availableCount: availableKeys.length,
    availableKeys,
    requestedKeys,
    desiredKeys,
    requiredKeys,
    preparedKeys,
    unavailableDesiredKeys,
    preparationSignals: preparedKeys.map((key) => {
      const sources: RunSkillPreparationSource[] = [];
      if (required.has(key)) sources.push("runtime_required");
      if (mentionedKeys.has(key)) sources.push("issue_mention");
      if (!required.has(key) && !mentionedKeys.has(key)) sources.push("agent_selection");
      return { key, sources };
    }),
  };
}
