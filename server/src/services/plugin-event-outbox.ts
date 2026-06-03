import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { pluginEventOutbox, type Db } from "@paperclipai/db";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { logger } from "../middleware/logger.js";
import type { PluginEventBus } from "./plugin-event-bus.js";

/**
 * Worker-tier poller that drains the plugin_event_outbox and is the SOLE
 * emitter of plugin domain events. `publishPluginDomainEvent` only enqueues
 * rows; this loop claims them (CAS — single worker replica, no SKIP LOCKED),
 * emits to the in-process bus in creation order, and marks them processed.
 * One writer + one emitter ⇒ no double-delivery.
 */

const POLL_INTERVAL_MS = 1_000;
const CLAIM_BATCH = 50;
const MAX_ATTEMPTS = 5;
const RETENTION_DAYS = 7;
const RETENTION_SWEEP_MS = 60 * 60 * 1_000;
const RETENTION_DELETE_BATCH = 5_000;
const RETENTION_MAX_ITERATIONS = 100;

/**
 * Requeue rows left in `processing` by a previous crash. Safe because there is
 * exactly one worker replica, so nothing is mid-flight at startup.
 */
export async function resetStaleProcessing(db: Db): Promise<number> {
  const rows = await db
    .update(pluginEventOutbox)
    .set({ status: "queued", updatedAt: new Date() })
    .where(eq(pluginEventOutbox.status, "processing"))
    .returning({ id: pluginEventOutbox.id });
  if (rows.length > 0) {
    logger.warn({ count: rows.length }, "plugin-event-outbox: requeued stale processing rows on startup");
  }
  return rows.length;
}

/**
 * Claim and emit one batch of queued events. Returns the number processed.
 */
export async function pollOnce(db: Db, bus: PluginEventBus): Promise<number> {
  // Atomic batch claim: flip queued → processing for the oldest N rows.
  const claimed = await db
    .update(pluginEventOutbox)
    .set({ status: "processing", updatedAt: new Date() })
    .where(
      inArray(
        pluginEventOutbox.id,
        db
          .select({ id: pluginEventOutbox.id })
          .from(pluginEventOutbox)
          .where(eq(pluginEventOutbox.status, "queued"))
          .orderBy(asc(pluginEventOutbox.seq))
          .limit(CLAIM_BATCH),
      ),
    )
    .returning();

  if (claimed.length === 0) return 0;

  // RETURNING order is unspecified — restore insertion order (seq) before emitting.
  claimed.sort((a, b) => a.seq - b.seq);

  // Emit sequentially so per-company ordering (created before decided) holds.
  for (const row of claimed) {
    const event = row.payload as unknown as PluginEvent;
    try {
      // bus.emit never throws on handler failure — it collects per-handler
      // errors and returns them. So mark processed even when errors are
      // present (no poison loop); a thrown emit() means infra failure.
      const { errors } = await bus.emit(event);
      for (const { pluginId, error } of errors) {
        logger.warn(
          { pluginId, eventType: event.eventType, err: error },
          "plugin-event-outbox: handler failed",
        );
      }
      await db
        .update(pluginEventOutbox)
        .set({
          status: "processed",
          processedAt: new Date(),
          updatedAt: new Date(),
          attempts: row.attempts + 1,
          lastError: errors.length > 0 ? String((errors[0] as { error: unknown }).error) : null,
        })
        .where(eq(pluginEventOutbox.id, row.id));
    } catch (err) {
      // emit() itself threw (bug/infra) — requeue with backoff until MAX_ATTEMPTS.
      const attempts = row.attempts + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;
      await db
        .update(pluginEventOutbox)
        .set({
          status: giveUp ? "failed" : "queued",
          attempts,
          lastError: String(err),
          updatedAt: new Date(),
        })
        .where(eq(pluginEventOutbox.id, row.id));
      logger.warn(
        { eventType: event?.eventType, attempts, giveUp, err },
        "plugin-event-outbox: emit threw; requeued",
      );
    }
  }

  return claimed.length;
}

/** Delete terminal rows older than the retention window, in bounded batches. */
async function pruneOutbox(db: Db): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1_000);
  let total = 0;
  for (let i = 0; i < RETENTION_MAX_ITERATIONS; i++) {
    const deleted = await db
      .delete(pluginEventOutbox)
      .where(
        inArray(
          pluginEventOutbox.id,
          db
            .select({ id: pluginEventOutbox.id })
            .from(pluginEventOutbox)
            .where(
              and(
                inArray(pluginEventOutbox.status, ["processed", "failed"]),
                lt(pluginEventOutbox.createdAt, cutoff),
              ),
            )
            .limit(RETENTION_DELETE_BATCH),
        ),
      )
      .returning({ id: pluginEventOutbox.id })
      .then((rows) => rows.length);
    total += deleted;
    if (deleted < RETENTION_DELETE_BATCH) break;
  }
  return total;
}

/**
 * Start the outbox poller + retention sweep (worker tier only). Returns a stop
 * function. Drains queued events every POLL_INTERVAL_MS with a re-entrancy
 * guard so a slow batch never overlaps the next tick.
 */
export function startPluginEventOutbox(db: Db, bus: PluginEventBus): () => void {
  let polling = false;
  let stopped = false;

  void resetStaleProcessing(db).catch((err) =>
    logger.warn({ err }, "plugin-event-outbox: stale-processing reset failed"),
  );

  const pollTimer = setInterval(() => {
    if (polling || stopped) return;
    polling = true;
    void (async () => {
      try {
        // Drain the backlog in batches within a tick.
        while (!stopped && (await pollOnce(db, bus)) === CLAIM_BATCH) {
          /* keep draining */
        }
      } catch (err) {
        logger.warn({ err }, "plugin-event-outbox: poll tick failed");
      } finally {
        polling = false;
      }
    })();
  }, POLL_INTERVAL_MS);
  pollTimer.unref?.();

  const retentionTimer = setInterval(() => {
    void pruneOutbox(db).catch((err) =>
      logger.warn({ err }, "plugin-event-outbox: retention sweep failed"),
    );
  }, RETENTION_SWEEP_MS);
  retentionTimer.unref?.();
  void pruneOutbox(db).catch(() => {});

  logger.info("plugin-event-outbox poller started");

  return () => {
    stopped = true;
    clearInterval(pollTimer);
    clearInterval(retentionTimer);
  };
}
