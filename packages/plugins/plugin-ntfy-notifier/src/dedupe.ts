import type { PluginStateClient } from "@paperclipai/plugin-sdk";

/**
 * Durable, identity-keyed dedupe.
 *
 * Policy: mark a decision as sent only after ntfy confirms the publish
 * (at-least-once). A send that fails leaves no mark, so a later replay of the
 * same event can try again. Concurrent deliveries of the same decision inside
 * one worker are collapsed by an in-memory in-flight set, which closes the
 * race between the state read and the state write.
 *
 * Board-feed episodes (`runEpisode`) use the same policy: the episode is
 * marked open only after ntfy accepts the publish.
 *
 * Remaining duplicate windows, all rare:
 * - the worker stops, or the state write fails, after ntfy accepted the
 *   message but before the mark was written;
 * - a send that timed out (reported as failed, so not marked) was in fact
 *   accepted by ntfy late, and the same event is delivered again later;
 * - a retry after a network error or a 408/429/5xx, when the server had in
 *   fact accepted the earlier attempt but the response was lost.
 * A timeout is not retried (see `sendNtfy`), so one send publishes at most
 * once after a timeout. A rare extra push is preferred over a silently lost
 * decision.
 */

export const DEDUPE_NAMESPACE = "ntfy-notifier";

export interface DecisionKey {
  /** Company that owns the decision. State is company-scoped. */
  companyId: string;
  /** Stable decision identity, e.g. `approval:<id>`. Never time-based. */
  key: string;
}

export interface SentMarker {
  v: 1;
  sentAt: string;
}

/** Durable record of one board-feed episode (computed blocker attention). */
export interface EpisodeMarker {
  v: 1;
  open: boolean;
  sentAt: string;
  closedAt?: string;
}

export class DecisionDedupe {
  private readonly inFlight = new Set<string>();
  private readonly episodeQueue = new Map<string, Promise<void>>();

  constructor(private readonly state: PluginStateClient) {}

  private scope(decision: DecisionKey) {
    return {
      scopeKind: "company" as const,
      scopeId: decision.companyId,
      namespace: DEDUPE_NAMESPACE,
      stateKey: `sent:${decision.key}`,
    };
  }

  private memoryKey(decision: DecisionKey): string {
    return `${decision.companyId}\u0000${decision.key}`;
  }

  /**
   * Run `send` at most once per decision unless it reports failure.
   * Returns `"duplicate"` when the decision was already sent or is being sent.
   */
  async runOnce(
    decision: DecisionKey,
    send: () => Promise<boolean>,
    now: () => Date = () => new Date(),
  ): Promise<"sent" | "duplicate" | "failed"> {
    const memoryKey = this.memoryKey(decision);
    if (this.inFlight.has(memoryKey)) return "duplicate";
    this.inFlight.add(memoryKey);
    try {
      const existing = await this.state.get(this.scope(decision));
      if (existing !== null && existing !== undefined) return "duplicate";
      const ok = await send();
      if (!ok) return "failed";
      const marker: SentMarker = { v: 1, sentAt: now().toISOString() };
      await this.state.set(this.scope(decision), marker);
      return "sent";
    } finally {
      this.inFlight.delete(memoryKey);
    }
  }

  /**
   * Episode operations (enter and exit) for one key run strictly in arrival
   * order, each after the previous one has finished, including its send. An
   * exit that arrives while the entry's push is in flight therefore closes the
   * episode the entry has just opened, and a later re-entry sends again. The
   * host forwards events without awaiting handlers, so they can overlap.
   * `DecisionNotifier.handle` also orders feed events per key from handler
   * entry, before its own asynchronous lookups; this queue keeps the dedupe
   * layer safe on its own for any caller.
   */
  private serial<T>(decision: DecisionKey, op: () => Promise<T>): Promise<T> {
    const memoryKey = this.memoryKey(decision);
    const previous = this.episodeQueue.get(memoryKey) ?? Promise.resolve();
    const result = previous.then(op, op);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.episodeQueue.set(memoryKey, tail);
    void tail.then(() => {
      if (this.episodeQueue.get(memoryKey) === tail) this.episodeQueue.delete(memoryKey);
    });
    return result;
  }

  /**
   * One push per feed episode: send unless an episode for this key is open.
   * After a successful send the episode is marked open.
   */
  runEpisode(
    decision: DecisionKey,
    send: () => Promise<boolean>,
    now: () => Date = () => new Date(),
  ): Promise<"sent" | "duplicate" | "failed"> {
    return this.serial(decision, async () => {
      const existing = (await this.state.get(this.scope(decision))) as EpisodeMarker | null | undefined;
      if (existing && existing.open !== false) return "duplicate";
      const ok = await send();
      if (!ok) return "failed";
      const marker: EpisodeMarker = { v: 1, open: true, sentAt: now().toISOString() };
      await this.state.set(this.scope(decision), marker);
      return "sent";
    });
  }

  /** Close an episode (the item left the feed) so the next entry notifies. Ordered after any in-flight entry. */
  closeEpisode(decision: DecisionKey, now: () => Date = () => new Date()): Promise<void> {
    return this.serial(decision, async () => {
      const existing = (await this.state.get(this.scope(decision))) as EpisodeMarker | null | undefined;
      if (!existing || existing.open === false) return;
      await this.state.set(this.scope(decision), { ...existing, open: false, closedAt: now().toISOString() });
    });
  }
}
