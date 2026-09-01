export type RosterManifestEntry = { id?: string; name: string; role?: string | null };
export type LiveRosterEntry = { id: string; name: string; role: string | null; status: string; hasCostHistory: boolean };

const normalizeName = (name: string) => name.trim().toLowerCase();
const normalizeRole = (role: string | null | undefined) => (role ?? "general").trim().toLowerCase();

/**
 * Validate a roster manifest that arrives as untrusted JSON.
 *
 * The audit reads `name`, `id` and `role` off every member. A member that does
 * not carry those in the expected shape must be refused here, because the two
 * alternatives are both wrong: dropping it without a word understates the drift
 * the report exists to show, and letting it through reaches `role.trim()` on a
 * number and answers a read-only operator query with a 500.
 */
export function parseRosterManifest(
  value: unknown,
): { ok: true; manifest: RosterManifestEntry[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "manifest must be a JSON array" };
  const manifest: RosterManifestEntry[] = [];
  for (const [index, member] of value.entries()) {
    if (typeof member !== "object" || member === null || Array.isArray(member)) {
      return { ok: false, error: `manifest entry ${index} must be an object` };
    }
    const entry = member as Record<string, unknown>;
    if (typeof entry.name !== "string" || entry.name.trim() === "") {
      return { ok: false, error: `manifest entry ${index} must have a name that is a string and is not empty` };
    }
    if (entry.id !== undefined && (typeof entry.id !== "string" || entry.id.trim() === "")) {
      return { ok: false, error: `manifest entry ${index} must have an id that is a string and is not empty, or no id` };
    }
    if (entry.role !== undefined && entry.role !== null && typeof entry.role !== "string") {
      return { ok: false, error: `manifest entry ${index} must have a role that is a string, or null, or no role` };
    }
    manifest.push({
      ...(entry.id === undefined ? {} : { id: entry.id as string }),
      name: entry.name,
      ...(entry.role === undefined ? {} : { role: entry.role as string | null }),
    });
  }
  return { ok: true, manifest };
}

/**
 * Compare a repository roster manifest with the live agents of one company.
 *
 * A manifest entry matches by identifier when it states one, and by normalized
 * name when it does not. A stated identifier is authoritative: an entry that
 * points at an identifier no live agent holds is drift, and a name that still
 * agrees must not conceal it. A name matches only when exactly one live agent
 * carries it, because two agents of one name cannot tell an operator which of
 * them the entry meant.
 */
export function auditRoster(manifest: RosterManifestEntry[], live: LiveRosterEntry[]) {
  const liveById = new Map(live.map((agent) => [agent.id, agent]));
  const liveByName = new Map<string, LiveRosterEntry[]>();
  for (const agent of live) {
    const key = normalizeName(agent.name);
    liveByName.set(key, [...(liveByName.get(key) ?? []), agent]);
  }

  const matchedLiveIds = new Set<string>();
  const repoOnlyAgents: RosterManifestEntry[] = [];
  // A matched pair is one agent, not two. Counting both representations is what
  // reported every ordinary one-to-one roster as a duplicate role family.
  const roleCounts = new Map<string, number>();
  const countRole = (role: string | null | undefined) => {
    const key = normalizeRole(role);
    roleCounts.set(key, (roleCounts.get(key) ?? 0) + 1);
  };

  for (const entry of manifest) {
    const byName = liveByName.get(normalizeName(entry.name)) ?? [];
    const match = entry.id ? liveById.get(entry.id) : byName.length === 1 ? byName[0] : undefined;
    // One live agent answers for one manifest entry. A second entry that claims
    // an agent an earlier entry already claimed is a duplicate listing, which is
    // drift in its own right. Letting it match as well would hide it from both
    // lists and drop the role it declares.
    if (!match || matchedLiveIds.has(match.id)) {
      repoOnlyAgents.push(entry);
      countRole(entry.role);
      continue;
    }
    matchedLiveIds.add(match.id);
    // The live role is the role the agent holds now. What the repository intends
    // for it is a different question, and the drift lists answer that one.
    countRole(match.role);
  }

  const dbOnlyAgents = live.filter((agent) => !matchedLiveIds.has(agent.id));
  for (const agent of dbOnlyAgents) countRole(agent.role);

  return {
    dbOnlyAgents,
    repoOnlyAgents,
    duplicateRoleFamilies: [...roleCounts].filter(([, count]) => count > 1).map(([role, count]) => ({ role, count })),
    agentsWithNoCostHistory: live.filter((agent) => !agent.hasCostHistory),
    agentsInError: live.filter((agent) => agent.status === "error"),
    remediation: { action: "operator_review_only", note: "No agents were deleted, terminated, or quarantined." },
  };
}
