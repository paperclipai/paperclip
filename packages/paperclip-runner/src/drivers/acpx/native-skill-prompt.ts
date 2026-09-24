import { NATIVE_MODEL_ENVELOPE_SCHEMA } from "../../contracts/native-execution.js";

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
  if (value.schema !== NATIVE_MODEL_ENVELOPE_SCHEMA || !value.task || typeof value.task !== "object") return text;
  const description = (value.task as Record<string, unknown>).description;
  if (typeof description !== "string") return text;
  const references = new Set(Array.from(
    description.matchAll(/(?:^|[\s(`])[$/]([a-zA-Z0-9_-]+)(?=$|[\s)`,.;:!?])/g),
    (match) => match[1],
  ));
  const selected = [...new Set(assignedNames)].filter((name) => references.has(name));
  return selected.length === 1 ? `/${selected[0]} ${text}` : text;
}
