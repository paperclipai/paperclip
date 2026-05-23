/**
 * Plan 4 Phase 4 - auto-promotion scanner.
 *
 * Wraps autoPromotionService.scanGuild in a periodic tick with:
 * - PG advisory lock to prevent multi-replica duplicate ticks
 * - Scan-hour UTC filtering + 23h debounce per guild
 * - Per-guild try/catch so one failing guild does not block others
 * - Idempotent start/stop
 *
 * Design notes:
 * - tick() is exposed for tests; production code calls start().
 * - Advisory lock is session-level (not transaction-level) so it
 *   survives transaction commits mid-tick. Released in a finally block.
 * - Failure case emits guild.skill.auto_promotion_scan_failed into
 *   activity_log via direct INSERT so the notifier picks it up.
 */
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, autoPromotionConfig } from "@paperclipai/db";
import { eq, or } from "drizzle-orm";

import type { autoPromotionService } from "./auto-promotion.js";
import { logger as defaultLogger } from "../middleware/logger.js";

export interface ScannerTickResult {
  skipped: boolean;
  scannedGuilds: number;
  failures: number;
}

const LOCK_KEY = "auto-promotion-scanner";

export function autoPromotionScanner(
  db: Db,
  opts: {
    intervalMs: number;
    service: ReturnType<typeof autoPromotionService>;
    logger?: typeof defaultLogger;
  },
) {
  const log = opts.logger ?? defaultLogger;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<ScannerTickResult> {
    // Acquire session-level advisory lock. Returns false if already held.
    const [lockRow] = await db.execute<{ pg_try_advisory_lock: boolean }>(
      sql`SELECT pg_try_advisory_lock(hashtext(${LOCK_KEY}))`,
    );
    if (!lockRow?.pg_try_advisory_lock) {
      log.debug("auto-promotion-scanner: tick skipped - advisory lock held by another replica");
      return { skipped: true, scannedGuilds: 0, failures: 0 };
    }

    try {
      // Read all guilds that have auto-promotion active (enabled OR dry-run)
      const configs = await db
        .select()
        .from(autoPromotionConfig)
        .where(
          or(
            eq(autoPromotionConfig.enabled, true),
            eq(autoPromotionConfig.dryRun, true),
          ),
        );

      // Filter to guilds whose scan hour matches current UTC hour and that
      // haven't been scanned within the 23-hour debounce window.
      const currentHour = new Date().getUTCHours();
      const dueConfigs = configs.filter((cfg) => {
        if (cfg.scanHourUtc !== currentHour) return false;
        if (!cfg.lastSuccessfulScanAt) return true;
        const msSinceScan = Date.now() - cfg.lastSuccessfulScanAt.getTime();
        return msSinceScan >= 23 * 60 * 60 * 1000;
      });

      let failures = 0;

      for (const cfg of dueConfigs) {
        const scanId = randomUUID();
        try {
          await opts.service.scanGuild(scanId, cfg);
        } catch (err) {
          failures += 1;
          const error = err instanceof Error ? err : new Error(String(err));

          // Stage defaults to "unknown". The service-level scanGuild absorbs
          // per-skill promotion failures internally (returning a failedCount),
          // so outer-layer errors here are typically DB or config-fetch issues
          // that don't map cleanly to a named stage. Spec §6.2 permits "unknown"
          // as a valid value; specific stage classification is left for v2 when
          // the service exposes stage hints on the thrown error.
          const stage: "eligibility" | "promote-txn" | "config-update" | "unknown" = "unknown";

          // Emit failure activity event so the notifier channel picks it up
          try {
            const [guild] = await db
              .select({ name: agents.name })
              .from(agents)
              .where(eq(agents.id, cfg.guildId))
              .limit(1);

            await db.insert(activityLog).values({
              companyId: cfg.companyId,
              actorType: "system",
              actorId: "auto-promotion-scanner",
              action: "guild.skill.auto_promotion_scan_failed",
              entityType: "guild",
              entityId: cfg.guildId,
              agentId: null,
              runId: null,
              details: {
                guildId: cfg.guildId,
                guildSlug: guild?.name ?? null,
                scanId,
                errorMessage: error.message,
                errorStack: error.stack ?? null,
                stage,
              } as Record<string, unknown>,
            });
          } catch (emitErr) {
            log.error(
              { err: emitErr, guildId: cfg.guildId, scanId },
              "auto-promotion-scanner: failed to emit scan-failed activity event",
            );
          }

          log.error(
            { err: error, guildId: cfg.guildId, scanId, stage },
            "auto-promotion-scanner: guild scan failed",
          );
        }
      }

      return { skipped: false, scannedGuilds: dueConfigs.length, failures };
    } finally {
      // Always release the lock, even if tick body throws
      await db
        .execute(sql`SELECT pg_advisory_unlock(hashtext(${LOCK_KEY}))`)
        .catch((err) => {
          log.error({ err }, "auto-promotion-scanner: failed to release advisory lock");
        });
    }
  }

  function start(): void {
    if (intervalHandle !== null) {
      // Already running - idempotent no-op
      return;
    }
    log.info(
      { intervalMs: opts.intervalMs },
      "auto-promotion-scanner: starting periodic scanner",
    );
    intervalHandle = setInterval(() => {
      void tick()
        .then((result) => {
          if (!result.skipped && (result.scannedGuilds > 0 || result.failures > 0)) {
            log.info(result, "auto-promotion-scanner: tick completed");
          }
        })
        .catch((err) => {
          log.error({ err }, "auto-promotion-scanner: tick threw unexpectedly");
        });
    }, opts.intervalMs);
  }

  function stop(): void {
    if (intervalHandle === null) {
      // Already stopped - idempotent no-op
      return;
    }
    clearInterval(intervalHandle);
    intervalHandle = null;
    log.info("auto-promotion-scanner: stopped");
  }

  return { start, stop, tick };
}
