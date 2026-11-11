export interface HierarchyMember {
  id: string;
  reportsTo: string | null;
}

export function buildManagerIndex(members: readonly HierarchyMember[]): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const member of members) index.set(member.id, member.reportsTo);
  return index;
}

export function wouldCreateCycle(
  managerById: ReadonlyMap<string, string | null>,
  agentId: string,
  nextManagerId: string | null,
): boolean {
  if (nextManagerId === null) return false;
  if (nextManagerId === agentId) return true;
  const visited = new Set<string>();
  let cursor: string | null = nextManagerId;
  while (cursor !== null && !visited.has(cursor)) {
    if (cursor === agentId) return true;
    visited.add(cursor);
    cursor = managerById.get(cursor) ?? null;
  }
  return false;
}

export type ReparentCheck =
  | { ok: true }
  | { ok: false; reason: "same-manager" | "self" | "cycle" | "unknown-agent" | "unknown-manager" };

export function checkReparent(
  managerById: ReadonlyMap<string, string | null>,
  agentId: string,
  nextManagerId: string | null,
): ReparentCheck {
  if (!managerById.has(agentId)) return { ok: false, reason: "unknown-agent" };
  if (nextManagerId !== null && !managerById.has(nextManagerId)) return { ok: false, reason: "unknown-manager" };
  if (nextManagerId === agentId) return { ok: false, reason: "self" };
  if ((managerById.get(agentId) ?? null) === nextManagerId) return { ok: false, reason: "same-manager" };
  if (wouldCreateCycle(managerById, agentId, nextManagerId)) return { ok: false, reason: "cycle" };
  return { ok: true };
}

export const REPARENT_REJECTION_MESSAGES: Record<Exclude<ReparentCheck, { ok: true }>["reason"], string> = {
  "same-manager": "This agent already reports to that manager.",
  self: "An agent cannot report to itself.",
  cycle: "That change would create a reporting cycle.",
  "unknown-agent": "That agent is no longer in this organization.",
  "unknown-manager": "That manager is no longer in this organization.",
};
