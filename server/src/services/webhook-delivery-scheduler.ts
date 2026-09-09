import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { webhookService } from "./webhooks.js";

const DEFAULT_TICK_INTERVAL_MS = 5_000;

export function createWebhookDeliveryScheduler(db: Db, opts?: { tickIntervalMs?: number }) {
  const tickInterval = opts?.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const svc = webhookService(db);
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      await svc.processPendingRetries();
    } catch (err) {
      logger.error({ err }, "Webhook delivery scheduler tick error");
    } finally {
      running = false;
    }
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => void tick(), tickInterval);
    timer.unref?.();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop };
}
