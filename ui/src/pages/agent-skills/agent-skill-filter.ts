/**
 * Client-side search for the agent Skills tab. Mirrors the store's
 * `discoveryMatchesSearch` haystack (name, slug, author, tagline, description,
 * categories) so the two surfaces filter on the same fields.
 */
export interface AgentSkillSearchFields {
  name: string;
  slug?: string | null;
  author?: string | null;
  tagline?: string | null;
  description?: string | null;
  categories?: string[] | null;
}

export function buildAgentSkillHaystack(fields: AgentSkillSearchFields): string {
  return [
    fields.name,
    fields.slug ?? "",
    fields.author ?? "",
    fields.tagline ?? "",
    fields.description ?? "",
    (fields.categories ?? []).join(" "),
  ]
    .join(" ")
    .toLowerCase();
}

export function agentSkillMatchesSearch(
  fields: AgentSkillSearchFields,
  query: string,
): boolean {
  const trimmed = query.trim();
  if (!trimmed) return true;
  return buildAgentSkillHaystack(fields).includes(trimmed.toLowerCase());
}

export function filterAgentSkills<T extends AgentSkillSearchFields>(
  rows: T[],
  query: string,
): T[] {
  const trimmed = query.trim();
  if (!trimmed) return rows;
  return rows.filter((row) => agentSkillMatchesSearch(row, trimmed));
}
