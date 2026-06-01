/**
 * @fileoverview Cached active-agent roster lookups (BLO-8328).
 *
 * Feeds the metrics cardinality guardrail: the set of agent ids that are
 * legitimate members of a company. A short TTL cache keeps the per-increment
 * cost off the hot path without holding a stale roster long enough to matter
 * for an ops counter.
 *
 * @module server/services/agent-roster
 */

import { agents, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";

const DEFAULT_TTL_MS = 30_000;

interface CacheEntry {
  ids: Set<string>;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Resolve the set of agent ids that belong to `companyId`, cached for a short
 * window. Membership (not runtime status) is what bounds the metric label — a
 * paused agent is still a real, bounded id.
 */
export async function getActiveAgentIds(
  db: Db,
  companyId: string,
  opts: { ttlMs?: number; now?: number } = {},
): Promise<ReadonlySet<string>> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now();
  const cached = cache.get(companyId);
  if (cached && cached.expiresAt > now) {
    return cached.ids;
  }
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const ids = new Set(rows.map((row) => row.id));
  cache.set(companyId, { ids, expiresAt: now + ttlMs });
  return ids;
}

/** Test-only: clear the roster cache. */
export function __clearAgentRosterCache(): void {
  cache.clear();
}
