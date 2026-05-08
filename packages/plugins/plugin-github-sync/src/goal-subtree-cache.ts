import type { PluginContext } from "@paperclipai/plugin-sdk";

/** Default cache TTL: 5 minutes. */
const DEFAULT_TTL_MS = 5 * 60 * 1_000;

export interface GoalSubtreeCache {
  /**
   * Return the ancestor chain for a goal (the goal itself + all ancestors up to
   * the tree root), using cache when fresh.  Chain is ordered leaf-first.
   */
  getAncestorChain(goalId: string, companyId: string, ctx: PluginContext): Promise<string[]>;

  /** Invalidate all cached entries for a company (call on goal.updated). */
  invalidate(companyId: string): void;
}

export function createGoalSubtreeCache(ttlMs = DEFAULT_TTL_MS): GoalSubtreeCache {
  const store = new Map<string, { chain: string[]; expiresAt: number }>();

  return {
    async getAncestorChain(goalId, companyId, ctx) {
      const key = `${companyId}:${goalId}`;
      const now = Date.now();
      const hit = store.get(key);
      if (hit && hit.expiresAt > now) return hit.chain;

      const chain: string[] = [];
      let current: string | null = goalId;
      const visited = new Set<string>();

      while (current && !visited.has(current)) {
        visited.add(current);
        try {
          const goal = await ctx.goals.get(current, companyId);
          if (!goal) break;
          chain.push(goal.id);
          current = goal.parentId;
        } catch {
          break;
        }
      }

      store.set(key, { chain, expiresAt: now + ttlMs });
      return chain;
    },

    invalidate(companyId) {
      const prefix = `${companyId}:`;
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) store.delete(key);
      }
    },
  };
}

/**
 * Returns true when goalId is within the synced subtree.
 *
 * A goal is "in scope" when it or any ancestor matches (starts-with) one of the
 * configured syncedGoalIds.  Short-prefix IDs like "eee6ff51" match full UUIDs
 * that begin with that prefix.
 *
 * When syncedGoalIds is empty, all goals are in scope.
 */
export async function isGoalInSyncedSubtree(
  goalId: string,
  companyId: string,
  syncedGoalIds: string[],
  cache: GoalSubtreeCache,
  ctx: PluginContext,
): Promise<boolean> {
  if (syncedGoalIds.length === 0) return true;

  const chain = await cache.getAncestorChain(goalId, companyId, ctx);
  for (const id of chain) {
    for (const root of syncedGoalIds) {
      if (id.startsWith(root)) return true;
    }
  }
  return false;
}
