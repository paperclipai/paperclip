/**
 * Max agents that can be enqueued in a single scheduler tick.
 * Prevents thundering herd on server restart when all agents are due.
 */
export const TICK_MAX_ENQUEUE = 5;

/**
 * Deterministic per-agent jitter based on agent ID hash.
 * Spreads agents across the scheduler tick window so they don't all fire at once.
 */
export function stableJitterMs(agentId: string, maxMs: number): number {
  if (maxMs <= 0) return 0;
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = ((hash << 5) - hash + agentId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % maxMs;
}
