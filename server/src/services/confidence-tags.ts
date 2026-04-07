/**
 * REQ-04: Confidence Tagging System
 *
 * Validates that agent outputs contain [FACT], [ASSESSMENT], or [SPECULATION]
 * confidence tags on assertion lines. Outputs without tags are flagged.
 */

export interface ConfidenceTagResult {
  valid: boolean;
  tagCounts: {
    fact: number;
    assessment: number;
    speculation: number;
  };
  untaggedAssertions: number;
  totalAssertions: number;
}

const TAG_REGEX = /\[(FACT|ASSESSMENT|SPECULATION)\]/g;

/**
 * Heuristic: a line is an "assertion" if it contains at least 8 words,
 * does not start with common non-assertion markers (headers, bullets that
 * are very short, code fences, blank lines, etc.), and looks like a
 * declarative statement rather than a question.
 */
function isAssertionLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  // Skip code fences, headers, horizontal rules
  if (/^(```|#{1,6}\s|---|\*\*\*|===)/.test(trimmed)) return false;
  // Skip questions
  if (trimmed.endsWith("?")) return false;
  // Must have at least 8 words to be a substantive assertion
  const wordCount = trimmed.split(/\s+/).length;
  return wordCount >= 8;
}

/**
 * Counts [FACT], [ASSESSMENT], [SPECULATION] tags in text and determines
 * whether at least 80% of assertion lines are tagged.
 */
export function validateConfidenceTags(text: string): ConfidenceTagResult {
  const lines = text.split("\n");
  let fact = 0;
  let assessment = 0;
  let speculation = 0;
  let totalAssertions = 0;
  let taggedAssertions = 0;

  for (const line of lines) {
    if (!isAssertionLine(line)) continue;
    totalAssertions++;

    const matches = line.match(TAG_REGEX);
    if (matches && matches.length > 0) {
      taggedAssertions++;
      for (const match of matches) {
        const tag = match.replace(/[\[\]]/g, "");
        if (tag === "FACT") fact++;
        else if (tag === "ASSESSMENT") assessment++;
        else if (tag === "SPECULATION") speculation++;
      }
    }
  }

  const untaggedAssertions = totalAssertions - taggedAssertions;
  // Valid if at least 80% of assertion lines have tags (or no assertions)
  const valid = totalAssertions === 0 || taggedAssertions / totalAssertions >= 0.8;

  return {
    valid,
    tagCounts: { fact, assessment, speculation },
    untaggedAssertions,
    totalAssertions,
  };
}

/**
 * Prompt injection text for agent system prompts.
 * Appended to heartbeat context to enforce confidence tagging.
 */
export const CONFIDENCE_TAGGING_PROMPT = `## Output Requirements - Confidence Tagging (MANDATORY)
Every assertion must be tagged: [FACT] (verified data), [ASSESSMENT] (reasoned judgment), [SPECULATION] (hypothesis).
Outputs without confidence tags will be rejected.`;
