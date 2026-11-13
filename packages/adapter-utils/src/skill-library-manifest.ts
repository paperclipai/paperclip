import type { PaperclipSkillEntry } from "./server-utils.js";

/**
 * Render the company skill library as a short markdown section for an agent's
 * system context, marking each skill as enabled for this agent, installed but
 * not enabled, or enabled but unavailable (with the failure cause).
 *
 * Why this exists: an agent's runtime only mounts its own desired skills, so
 * from inside a sandbox an installed-but-not-enabled skill is
 * indistinguishable from a skill that does not exist — agents then tell users
 * a freshly installed skill "is not installed". This manifest gives the model
 * the missing distinction without any extra tool call.
 *
 * The output must stay deterministic for identical inputs: claude-local hashes
 * the instructions text into its prompt-bundle cache key, so nondeterministic
 * text would defeat the cache and identical library states must produce
 * byte-identical manifests.
 */
/**
 * Flatten untrusted text to a single bounded line before it enters the
 * manifest. Skill keys and missing-source details can embed skill-authored
 * content (a hostile frontmatter name flows into materialization error
 * messages); a newline in either would let a skill append arbitrary
 * instruction lines to the agent's system context.
 */
function sanitizeManifestText(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function buildSkillLibraryManifestMarkdown(input: {
  entries: readonly PaperclipSkillEntry[];
  desiredSkillKeys: ReadonlySet<string>;
}): string | null {
  if (input.entries.length === 0) return null;
  const lines = [...input.entries]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((entry) => {
      const enabled = input.desiredSkillKeys.has(entry.key);
      const key = sanitizeManifestText(entry.key, 200);
      if (enabled && entry.sourceStatus === "missing") {
        const detail = entry.missingDetail ? sanitizeManifestText(entry.missingDetail, 200) : "";
        return `- ${key} — enabled but unavailable${detail ? `: ${detail}` : ""}`;
      }
      return `- ${key} — ${enabled ? "enabled" : "installed, not enabled for you"}`;
    });
  return [
    "## Company skill library",
    "",
    'Skills marked "enabled" are loaded into your runtime. Skills marked',
    '"installed, not enabled for you" exist in this company\'s skill library but',
    "are not attached to you — never report those as not installed; say they",
    "are installed but not enabled for you, and ask an operator to enable them",
    'for you (the skill page\'s "Add to agent" control) when you need one.',
    "",
    ...lines,
  ].join("\n");
}
