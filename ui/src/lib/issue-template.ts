const TEMPLATE_RULES = [
  { key: "goal", pattern: /(^|\n)\s*(?:#{1,6}\s*goal\b|goal\s*:)/i },
  { key: "owner", pattern: /(^|\n)\s*(?:#{1,6}\s*owner\b|owner\s*:)/i },
  { key: "dod", pattern: /(^|\n)\s*(?:#{1,6}\s*(?:definition of done|dod)\b|(?:definition of done|dod)\s*:)/i },
  { key: "dependencies", pattern: /(^|\n)\s*(?:#{1,6}\s*dependencies\b|dependencies\s*:)/i },
  { key: "deadline", pattern: /(^|\n)\s*(?:#{1,6}\s*deadline\b|deadline\s*:)/i },
];

function hasTemplateFields(description: string) {
  return TEMPLATE_RULES.every((rule) => rule.pattern.test(description));
}

export function ensureIssueTemplate(
  description: string,
  input: { goal: string; owner: string; deadline?: string },
) {
  const trimmed = description.trim();
  if (trimmed && hasTemplateFields(trimmed)) return trimmed;

  const contextBlock = trimmed ? ["## Context", trimmed, ""] : [];
  return [
    "## Goal",
    input.goal.trim() || "TBD",
    "",
    "## Owner",
    input.owner.trim() || "TBD",
    "",
    "## Definition of Done",
    "- [ ] Complete implementation and share verification evidence.",
    "",
    "## Dependencies",
    "- [ ] None identified yet (update if blocked).",
    "",
    "## Deadline",
    input.deadline?.trim() || "TBD",
    "",
    ...contextBlock,
  ].join("\n");
}
