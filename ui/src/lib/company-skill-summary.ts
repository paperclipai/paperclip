type SkillSummaryInput = {
  tagline?: string | null;
  description?: string | null;
  key?: string | null;
  name?: string | null;
};

export function sanitizeSkillSummaryText(raw: string | null | undefined): string | null {
  const cleaned = (raw ?? "")
    .replace(/^[\s>#*_\-`|]+/, "")
    .trim();
  return cleaned.length >= 3 ? cleaned : null;
}

export function resolveSkillSummaryText(
  skill: SkillSummaryInput,
  options: { fallbackKey?: boolean } = {},
): string | null {
  const summary = sanitizeSkillSummaryText(skill.tagline) ?? sanitizeSkillSummaryText(skill.description);
  if (summary) return summary;

  if (options.fallbackKey) {
    const fallbackKey = skill.key?.trim();
    const name = skill.name?.trim();
    if (fallbackKey && fallbackKey !== name) return fallbackKey;
  }

  return null;
}
