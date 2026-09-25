import { explicitTaskSkillNames } from "../../contracts/runtime-context.js";
import { NATIVE_MODEL_ENVELOPE_SCHEMA, NATIVE_MODEL_ENVELOPE_SCHEMA_V2 } from "../../contracts/native-execution.js";

/** Invoke one unambiguously selected assigned skill through Claude's native
 * command parser. Keep the complete envelope as its argument, including the
 * current request and approval context. Comments never select a command.
 * Multiple selections remain available to the Skill tool rather than picking one.
 */
export function claudeNativeSkillPrompt(text: string, assignedNames: readonly string[]): string {
  let envelope: unknown;
  try { envelope = JSON.parse(text); } catch { return text; }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return text;
  const value = envelope as Record<string, unknown>;
  if (!value.task || typeof value.task !== "object") return text;
  let selected: string[];
  if (value.schema === NATIVE_MODEL_ENVELOPE_SCHEMA) {
    if (!Array.isArray(value.requestedSkills) || !value.requestedSkills.every((name) => typeof name === "string")) return text;
    const requested = new Set(value.requestedSkills as string[]);
    selected = [...new Set(assignedNames)].filter((name) => requested.has(name));
  } else if (value.schema === NATIVE_MODEL_ENVELOPE_SCHEMA_V2) {
    const description = (value.task as Record<string, unknown>).description;
    selected = explicitTaskSkillNames(typeof description === "string" ? description : null, assignedNames);
  } else return text;
  return selected.length === 1 ? `/${selected[0]} ${text}` : text;
}
