// Slug derivation for gbrain pages. gbrain treats `/` in a slug as a
// path component and rejects new pages whose path is not a known source
// (returns "Page not found: <slug> (source=default)"). Use flat hyphenated
// slugs instead — matches the convention of existing gbrain pages like
// `vtx-95`.

export const PAGE_TYPES = {
  ISSUE: "issue",
  AGENT: "agent",
  PROJECT: "project",
  FACT: "fact",
} as const;

function normalizeSegment(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function issueSlug(identifier: string | null | undefined): string | null {
  if (!identifier) return null;
  const seg = normalizeSegment(identifier);
  if (!seg) return null;
  return `issue-${seg}`;
}

export function agentSlug(name: string | null | undefined): string | null {
  if (!name) return null;
  const seg = normalizeSegment(name);
  if (!seg) return null;
  return `agent-${seg}`;
}

export function projectSlug(nameOrKey: string | null | undefined): string | null {
  if (!nameOrKey) return null;
  const seg = normalizeSegment(nameOrKey);
  if (!seg) return null;
  return `project-${seg}`;
}

export function factSlug(memoryUnitUuid: string): string {
  return `fact-${memoryUnitUuid}`;
}
