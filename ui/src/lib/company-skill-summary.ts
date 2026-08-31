type SkillSummaryInput = {
  tagline?: string | null;
  description?: string | null;
  key?: string | null;
  name?: string | null;
};

function isStaleYamlBlockScalarIndicator(raw: string) {
  return /^[>|][+-]?$/.test(raw.trim());
}

export function sanitizeSkillSummaryText(raw: string | null | undefined): string | null {
  const cleaned = (raw ?? "").trim();
  if (isStaleYamlBlockScalarIndicator(cleaned)) return null;
  return cleaned.length > 0 ? cleaned : null;
}

export function resolveSkillSummaryText(
  skill: SkillSummaryInput,
  options: { fallbackKey?: boolean } = {},
): string | null {
  const summary = sanitizeSkillSummaryText(skill.tagline) ?? sanitizeSkillSummaryText(skill.description);
  if (summary) return summary;

  if (options.fallbackKey) {
    const fallbackKey = skill.key?.trim();
    if (fallbackKey) return fallbackKey;
  }

  return null;
}
