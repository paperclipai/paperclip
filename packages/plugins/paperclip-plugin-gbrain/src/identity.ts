export const PAGE_TYPES = {
  ISSUE: "issue",
  AGENT: "agent",
  FACT: "fact",
} as const;

export function issueSlug(identifier: string | null | undefined): string | null {
  if (!identifier) return null;
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  return `issue/${trimmed}`;
}

export function agentSlug(name: string | null | undefined): string | null {
  if (!name) return null;
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!normalized) return null;
  return `agent/${normalized}`;
}

export function factSlug(memoryUnitUuid: string): string {
  return `fact/${memoryUnitUuid}`;
}
