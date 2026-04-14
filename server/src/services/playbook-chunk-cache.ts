import { logger } from "../middleware/logger.js";

/**
 * In-memory per-agent cache of playbook chunks loaded recently.
 *
 * Why: agents often query the same playbook repeatedly within a single
 * working session (e.g., the COO running through MBR steps that all
 * reference the operating-rhythm playbook). Without a cache, every
 * lookup re-runs the embedding query and re-fetches the same chunks
 * from postgres, wasting latency and Ollama embed CPU.
 *
 * Why per-agent (not global): different agents have different audience
 * filters (department, owner_role) so their result sets diverge. Caching
 * by query string alone would miss the role-scoped filtering.
 *
 * TTL: 1 hour. Playbooks change rarely; an agent that loaded a chunk
 * within the last hour is likely working on a coherent task and the
 * content is still relevant. After 1 hour we re-fetch in case the
 * playbook was updated by reindex.
 *
 * Bounds: max 100 cached entries per agent, LRU eviction. Across a
 * fleet of 12 agents this caps memory at ~12 * 100 * 5KB = 6MB.
 */

const TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_AGENT = 100;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  lastAccessedAt: number;
}

interface AgentCache<T> {
  entries: Map<string, CacheEntry<T>>;
}

const caches = new Map<string, AgentCache<unknown>>();

/**
 * Build a stable cache key from the lookup parameters. Order-independent
 * for the optional filter fields so { department: 'X', topK: 3 } and
 * { topK: 3, department: 'X' } hit the same key.
 */
export function buildChunkCacheKey(opts: {
  query: string;
  department?: string;
  ownerRole?: string;
  documentType?: string;
  topK?: number;
}): string {
  const norm = opts.query.trim().toLowerCase().replace(/\s+/g, " ");
  const parts = [
    `q:${norm}`,
    `k:${opts.topK ?? 3}`,
    opts.department ? `d:${opts.department}` : "",
    opts.ownerRole ? `r:${opts.ownerRole}` : "",
    opts.documentType ? `t:${opts.documentType}` : "",
  ].filter(Boolean);
  return parts.join("|");
}

export function getCachedChunks<T>(agentId: string, cacheKey: string): T | null {
  const cache = caches.get(agentId) as AgentCache<T> | undefined;
  if (!cache) return null;

  const entry = cache.entries.get(cacheKey);
  if (!entry) return null;

  const now = Date.now();
  if (entry.expiresAt < now) {
    cache.entries.delete(cacheKey);
    return null;
  }

  entry.lastAccessedAt = now;
  return entry.value;
}

export function setCachedChunks<T>(agentId: string, cacheKey: string, value: T): void {
  let cache = caches.get(agentId) as AgentCache<T> | undefined;
  if (!cache) {
    cache = { entries: new Map() };
    caches.set(agentId, cache as AgentCache<unknown>);
  }

  // Evict oldest entry if at capacity
  if (cache.entries.size >= MAX_PER_AGENT) {
    let oldestKey: string | null = null;
    let oldestAccessed = Infinity;
    for (const [k, e] of cache.entries) {
      if (e.lastAccessedAt < oldestAccessed) {
        oldestAccessed = e.lastAccessedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) cache.entries.delete(oldestKey);
  }

  const now = Date.now();
  cache.entries.set(cacheKey, {
    value,
    expiresAt: now + TTL_MS,
    lastAccessedAt: now,
  });
}

/**
 * Drop all cached entries for an agent. Useful when an agent's role or
 * department changes (audience filters would no longer match), or when
 * a playbook is reindexed (chunk IDs/content may have changed).
 */
export function invalidateAgentCache(agentId: string): void {
  caches.delete(agentId);
}

/**
 * Drop all cached entries for ALL agents in a company. Called after
 * reindexAllPlaybooks so stale chunk IDs don't leak.
 */
export function invalidateAllCaches(): void {
  const before = caches.size;
  caches.clear();
  logger.info({ before }, "playbook-chunk-cache: cleared all agent caches");
}

/**
 * Periodic sweeper: drop expired entries across all agents.
 * Called from a setInterval at startup so dead entries don't accumulate
 * when an agent stops querying for a while.
 */
export function sweepExpired(): { swept: number; remaining: number } {
  const now = Date.now();
  let swept = 0;
  let remaining = 0;
  for (const [agentId, cache] of caches) {
    for (const [key, entry] of cache.entries) {
      if (entry.expiresAt < now) {
        cache.entries.delete(key);
        swept += 1;
      } else {
        remaining += 1;
      }
    }
    // Drop empty agent caches
    if (cache.entries.size === 0) caches.delete(agentId);
  }
  return { swept, remaining };
}

/**
 * Stats for observability / debugging.
 */
export function getCacheStats(): { agents: number; totalEntries: number } {
  let totalEntries = 0;
  for (const cache of caches.values()) {
    totalEntries += cache.entries.size;
  }
  return { agents: caches.size, totalEntries };
}
