/**
 * Per-company outbound queue for event notifications.
 *
 * The host allows a plugin 30 secret resolutions per company per minute and
 * forbids caching a resolved secret. So sends are not resolved one by one:
 * each company has one serialized queue, and one drain cycle is one
 * operation. It resolves the bot token once, delivers everything queued at
 * that moment with the token held only in a local variable, and returns.
 * Nothing token-related outlives the cycle.
 *
 * - Rate-limited resolution: the items stay queued and the drain retries
 *   with backoff; nothing is dropped.
 * - Any other resolution failure (secret deleted, disabled or missing):
 *   fail closed. The queued items are dropped unsent and `onResolveFailure`
 *   reports it.
 * - The queue is bounded; on overflow the oldest item is dropped and only
 *   a count is logged.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { errorText, isRateLimitError } from "./telegram-client.js";
import type { PluginConfig } from "./types.js";

export const outboundQueueSettings = {
  /** Most queued notifications per company. */
  maxItems: 500,
  /** First wait after a rate-limited resolution; doubles up to `maxBackoffMs`. */
  initialBackoffMs: 2_000,
  maxBackoffMs: 30_000,
};

export function nextBackoff(delayMs: number): number {
  return Math.min(delayMs * 2, outboundQueueSettings.maxBackoffMs);
}

/** Sends one notification with the config resolved for this drain cycle. */
export type Delivery = (config: PluginConfig) => Promise<void>;

interface Item {
  deliver: Delivery;
  settle: () => void;
}

interface CompanyQueue {
  items: Item[];
  draining: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
  backoffMs: number;
  dropped: number;
}

export interface OutboundQueue {
  /** Queue a delivery; settles when it was sent, failed or dropped. */
  enqueue(companyId: string, deliver: Delivery): Promise<void>;
}

export function createOutboundQueue(options: {
  logger: PluginContext["logger"];
  /** Loads the company's config with the token resolved; one call per cycle. */
  loadConfig: (companyId: string) => Promise<PluginConfig>;
  onResolveFailure: (companyId: string) => void;
  onResolveSuccess: (companyId: string) => void;
}): OutboundQueue {
  const queues = new Map<string, CompanyQueue>();

  function queueFor(companyId: string): CompanyQueue {
    let queue = queues.get(companyId);
    if (!queue) {
      queue = {
        items: [],
        draining: false,
        backoffMs: outboundQueueSettings.initialBackoffMs,
        dropped: 0,
      };
      queues.set(companyId, queue);
    }
    return queue;
  }

  function logDropped(companyId: string, queue: CompanyQueue): void {
    if (queue.dropped === 0) return;
    options.logger.warn("telegram-notifier: dropped oldest queued notifications", {
      companyId,
      dropped: queue.dropped,
    });
    queue.dropped = 0;
  }

  /** One cycle: resolve once, deliver the current batch, drop the token. */
  async function runCycle(companyId: string, queue: CompanyQueue): Promise<"done" | "retry"> {
    let config: PluginConfig;
    try {
      config = await options.loadConfig(companyId);
    } catch (err) {
      if (isRateLimitError(err)) return "retry";
      const failed = queue.items.splice(0);
      options.logger.warn("telegram-notifier: bot token secret could not be resolved", {
        companyId,
        dropped: failed.length,
      });
      options.onResolveFailure(companyId);
      for (const item of failed) item.settle();
      return "done";
    }
    options.onResolveSuccess(companyId);
    queue.backoffMs = outboundQueueSettings.initialBackoffMs;
    logDropped(companyId, queue);
    const batch = queue.items.splice(0);
    for (const item of batch) {
      try {
        await item.deliver(config);
      } catch (err) {
        options.logger.warn("telegram-notifier: notification failed", {
          companyId,
          err: errorText(err),
        });
      } finally {
        item.settle();
      }
    }
    return "done";
  }

  async function drain(companyId: string): Promise<void> {
    const queue = queueFor(companyId);
    if (queue.draining || queue.retryTimer) return;
    queue.draining = true;
    try {
      while (queue.items.length > 0) {
        if ((await runCycle(companyId, queue)) === "retry") {
          const delay = queue.backoffMs;
          queue.backoffMs = nextBackoff(delay);
          queue.retryTimer = setTimeout(() => {
            queue.retryTimer = undefined;
            void drain(companyId);
          }, delay);
          return;
        }
      }
    } finally {
      queue.draining = false;
    }
  }

  return {
    enqueue(companyId, deliver) {
      const queue = queueFor(companyId);
      const settled = new Promise<void>((resolve) => {
        queue.items.push({ deliver, settle: resolve });
      });
      while (queue.items.length > outboundQueueSettings.maxItems) {
        queue.items.shift()?.settle();
        queue.dropped += 1;
        if (queue.dropped === 1) {
          options.logger.warn("telegram-notifier: outbound queue full, dropping oldest notifications", {
            companyId,
          });
        }
      }
      void drain(companyId);
      return settled;
    },
  };
}
