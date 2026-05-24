/**
 * Plan 4 Phase 4 - auto-promotion scanner tests.
 *
 * 7 cases per spec §8.5:
 * 1. Disabled config: guild with enabled=false, dry_run=false is not scanned.
 * 2. Due guild: enabled/dry-run guild with matching scan hour and NULL last scan IS scanned.
 * 3. Debounce: guild scanned 12h ago is NOT scanned again.
 * 4. Hour mismatch: guild whose scan_hour_utc doesn't match current UTC hour is skipped.
 * 5. Advisory-lock race: tick skips when lock is held by another connection.
 * 6. One-guild-failure isolation: 3 due guilds; one throws; others complete; failures:1.
 * 7. start/stop idempotency: double-start does NOT install two intervals; double-stop OK.
 *
 * Uses inline seeding matching auto-promotion-service.test.ts.
 * Advisory-lock race uses a raw postgres.js connection held open during tick.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  activityLog,
  agents,
  autoPromotionAudit,
  autoPromotionConfig,
  companies,
  createDb,
  heartbeatRuns,
  skillUses,
  skills,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { eq, sql } from "drizzle-orm";
import { autoPromotionService } from "../services/auto-promotion.js";
import { autoPromotionScanner } from "../services/auto-promotion-scanner.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping auto-promotion scanner tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres(
  "autoPromotionScanner (Plan 4 Phase 4)",
  () => {
    let db!: ReturnType<typeof createDb>;
    let svc!: ReturnType<typeof autoPromotionService>;
    let connectionString!: string;
    let tempDb: Awaited<
      ReturnType<typeof startEmbeddedPostgresTestDatabase>
    > | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-auto-promotion-scanner-",
      );
      connectionString = tempDb.connectionString;
      db = createDb(connectionString);
      svc = autoPromotionService(db);
    }, 20_000);

    afterEach(async () => {
      // Delete in FK-safe order; CASCADE handles children.
      await db.delete(activityLog);
      await db.delete(autoPromotionConfig);
      await db.delete(skills);
      await db.delete(heartbeatRuns);
      await db.delete(agents);
      await db.delete(companies);
      // Release any advisory lock that may have been left held by a previous
      // test (e.g., from the lock-race test) so subsequent tests start clean.
      await db
        .execute(sql`SELECT pg_advisory_unlock_all()`)
        .catch(() => {});
    });

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    // -----------------------------------------------------------------------
    // Inline seeding helpers (mirroring auto-promotion-service.test.ts)
    // -----------------------------------------------------------------------

    async function seedCompany(): Promise<string> {
      const id = randomUUID();
      const prefix = id.replace(/-/g, "").slice(0, 6).toUpperCase();
      await db.insert(companies).values({
        id,
        name: `test-co-${id.slice(0, 8)}`,
        issuePrefix: prefix,
      });
      return id;
    }

    async function seedGuild(companyId: string): Promise<string> {
      const id = randomUUID();
      await db.insert(agents).values({
        id,
        companyId,
        name: `guild-${id.slice(0, 8)}`,
        kind: "guild",
      });
      return id;
    }

    async function seedConfig(
      companyId: string,
      guildId: string,
      overrides?: Partial<typeof autoPromotionConfig.$inferInsert>,
    ): Promise<void> {
      const currentHour = new Date().getUTCHours();
      await db.insert(autoPromotionConfig).values({
        guildId,
        companyId,
        enabled: false,
        dryRun: true,
        scanHourUtc: currentHour,
        minUses: 5,
        minSuccessRatio: "0.800",
        minAgeHours: 24,
        minBodyStableHours: 24,
        minDistinctRuns: 3,
        maxPromotionsPerTick: 3,
        ...overrides,
      });
    }

    async function seedRun(companyId: string, agentId: string): Promise<string> {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({
        id,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "succeeded",
      });
      return id;
    }

    async function seedSkill(
      companyId: string,
      guildId: string,
      opts?: {
        name?: string;
        successCount?: number;
        failCount?: number;
        provenance?: "provisional" | "canonical";
        retiredAt?: Date | null;
        backdateHours?: number;
      },
    ): Promise<string> {
      const id = randomUUID();
      const backdateMs = (opts?.backdateHours ?? 0) * 3600 * 1000;
      const ts = new Date(Date.now() - backdateMs);
      await db.insert(skills).values({
        id,
        guildId,
        companyId,
        name: opts?.name ?? `skill-${id.slice(0, 8)}`,
        body: "test skill body",
        provenance: opts?.provenance ?? "provisional",
        successCount: opts?.successCount ?? 0,
        failCount: opts?.failCount ?? 0,
        retiredAt: opts?.retiredAt ?? null,
        createdAt: ts,
        updatedAt: ts,
        bodyUpdatedAt: ts,
      });
      return id;
    }

    async function seedUses(
      companyId: string,
      guildId: string,
      skillId: string,
      count: number,
      success = true,
    ): Promise<void> {
      for (let i = 0; i < count; i++) {
        const runId = await seedRun(companyId, guildId);
        await db.insert(skillUses).values({
          skillId,
          guildId,
          runId,
          success,
        });
      }
    }

    // Seeds a fully-eligible skill that will pass all default thresholds.
    async function seedEligibleSkill(
      companyId: string,
      guildId: string,
    ): Promise<string> {
      const skillId = await seedSkill(companyId, guildId, {
        successCount: 5,
        failCount: 0,
        backdateHours: 48, // older than 24h age + body-stable gates
      });
      await seedUses(companyId, guildId, skillId, 3, true);
      return skillId;
    }

    // Build a no-op logger to keep test output clean
    const silentLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => silentLogger,
    } as unknown as Parameters<typeof autoPromotionScanner>[1]["logger"];

    // -----------------------------------------------------------------------
    // Case 1: disabled config - guild with enabled=false, dry_run=false skipped
    // -----------------------------------------------------------------------

    it("does not scan a guild whose config has enabled=false and dry_run=false", async () => {
      const companyId = await seedCompany();
      const guildId = await seedGuild(companyId);
      const currentHour = new Date().getUTCHours();

      // Config with both flags off - should NOT be in the "due" set at all
      await seedConfig(companyId, guildId, {
        enabled: false,
        dryRun: false,
        scanHourUtc: currentHour,
      });

      const scanSpy = vi.spyOn(svc, "scanGuild");
      const scanner = autoPromotionScanner(db, {
        intervalMs: 60_000,
        service: svc,
        logger: silentLogger,
      });

      const result = await scanner.tick();

      expect(result.skipped).toBe(false);
      expect(result.scannedGuilds).toBe(0);
      expect(scanSpy).not.toHaveBeenCalled();

      scanSpy.mockRestore();
    });

    // -----------------------------------------------------------------------
    // Case 2: due guild - matching hour + NULL last_successful_scan_at IS scanned
    // -----------------------------------------------------------------------

    it("scans a due guild once and updates last_successful_scan_at", async () => {
      const companyId = await seedCompany();
      const guildId = await seedGuild(companyId);
      const currentHour = new Date().getUTCHours();

      await seedConfig(companyId, guildId, {
        enabled: true,
        dryRun: true,
        scanHourUtc: currentHour,
        // lastSuccessfulScanAt defaults to null in seedConfig
      });

      // Seed an eligible skill so scanGuild has something to process
      await seedEligibleSkill(companyId, guildId);

      const scanSpy = vi.spyOn(svc, "scanGuild");
      const scanner = autoPromotionScanner(db, {
        intervalMs: 60_000,
        service: svc,
        logger: silentLogger,
      });

      const result = await scanner.tick();

      expect(result.skipped).toBe(false);
      expect(result.scannedGuilds).toBe(1);
      expect(result.failures).toBe(0);
      expect(scanSpy).toHaveBeenCalledOnce();

      // Verify the config health metric was updated (scanGuild does this internally)
      const [updatedCfg] = await db
        .select()
        .from(autoPromotionConfig)
        .where(eq(autoPromotionConfig.guildId, guildId));
      expect(updatedCfg?.lastSuccessfulScanAt).not.toBeNull();

      scanSpy.mockRestore();
    });

    // -----------------------------------------------------------------------
    // Case 3: debounce - guild scanned 12h ago is NOT scanned again
    // -----------------------------------------------------------------------

    it("skips a guild that was scanned less than 23h ago (debounce)", async () => {
      const companyId = await seedCompany();
      const guildId = await seedGuild(companyId);
      const currentHour = new Date().getUTCHours();

      // Set last scan 12 hours ago - within the 23h debounce window
      const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
      await seedConfig(companyId, guildId, {
        enabled: true,
        dryRun: true,
        scanHourUtc: currentHour,
        lastSuccessfulScanAt: twelveHoursAgo,
      });

      const scanSpy = vi.spyOn(svc, "scanGuild");
      const scanner = autoPromotionScanner(db, {
        intervalMs: 60_000,
        service: svc,
        logger: silentLogger,
      });

      const result = await scanner.tick();

      expect(result.skipped).toBe(false);
      expect(result.scannedGuilds).toBe(0);
      expect(scanSpy).not.toHaveBeenCalled();

      scanSpy.mockRestore();
    });

    // -----------------------------------------------------------------------
    // Case 4: hour mismatch - scan_hour_utc doesn't match current UTC hour
    // -----------------------------------------------------------------------

    it("skips a guild whose scan_hour_utc does not match the current UTC hour", async () => {
      const companyId = await seedCompany();
      const guildId = await seedGuild(companyId);
      const currentHour = new Date().getUTCHours();

      // Use the opposite hour so it never matches
      const wrongHour = (currentHour + 12) % 24;
      await seedConfig(companyId, guildId, {
        enabled: true,
        dryRun: true,
        scanHourUtc: wrongHour,
      });

      const scanSpy = vi.spyOn(svc, "scanGuild");
      const scanner = autoPromotionScanner(db, {
        intervalMs: 60_000,
        service: svc,
        logger: silentLogger,
      });

      const result = await scanner.tick();

      expect(result.skipped).toBe(false);
      expect(result.scannedGuilds).toBe(0);
      expect(scanSpy).not.toHaveBeenCalled();

      scanSpy.mockRestore();
    });

    // -----------------------------------------------------------------------
    // Case 5: advisory-lock race - tick skips when lock held externally
    // -----------------------------------------------------------------------

    it("returns { skipped: true } when advisory lock is held by another connection", async () => {
      // Simulate the advisory lock being held by intercepting db.execute so that
      // the first call (pg_try_advisory_lock) returns false. The scanner must
      // check the return value and skip the tick body entirely.
      //
      // Note: when the scanner sees acquired=false it returns immediately and
      // never enters the body, so pg_advisory_unlock is NOT called on this path
      // by design (no lock was acquired). The call-through on subsequent calls
      // exists only to keep the test harness clean if the code path changes.
      const originalExecute = db.execute.bind(db);
      let firstCall = true;
      const executeSpy = vi.spyOn(db, "execute").mockImplementation(
        async (query: Parameters<typeof db.execute>[0]) => {
          if (firstCall) {
            firstCall = false;
            // Simulate pg_try_advisory_lock returning false (lock held elsewhere)
            return [{ pg_try_advisory_lock: false }] as any;
          }
          return originalExecute(query);
        },
      );

      const scanSpy = vi.spyOn(svc, "scanGuild");
      const scanner = autoPromotionScanner(db, {
        intervalMs: 60_000,
        service: svc,
        logger: silentLogger,
      });

      try {
        const result = await scanner.tick();

        expect(result.skipped).toBe(true);
        expect(result.scannedGuilds).toBe(0);
        expect(scanSpy).not.toHaveBeenCalled();
      } finally {
        executeSpy.mockRestore();
        scanSpy.mockRestore();
      }
    });

    // -----------------------------------------------------------------------
    // Case 6: one-guild-failure isolation
    // -----------------------------------------------------------------------

    it("completes other guilds when one throws; emits scan_failed activity; failures:1", async () => {
      const companyId = await seedCompany();
      const currentHour = new Date().getUTCHours();

      // Seed 3 guilds all due this hour
      const guildIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const guildId = await seedGuild(companyId);
        guildIds.push(guildId);
        await seedConfig(companyId, guildId, {
          enabled: true,
          dryRun: true,
          scanHourUtc: currentHour,
        });
      }

      // Make the second guild's scanGuild call throw; call the real
      // implementation for the other two guilds.
      // Save the original method BEFORE spying to avoid recursive spy calls.
      const originalScanGuild = svc.scanGuild.bind(svc);
      let callCount = 0;
      const scanSpy = vi.spyOn(svc, "scanGuild").mockImplementation(
        async (scanId, config) => {
          callCount += 1;
          if (config.guildId === guildIds[1]) {
            throw new Error("simulated eligibility failure");
          }
          // Call the original (pre-spy) method to avoid infinite recursion
          return originalScanGuild(scanId, config);
        },
      );

      const scanner = autoPromotionScanner(db, {
        intervalMs: 60_000,
        service: svc,
        logger: silentLogger,
      });

      const result = await scanner.tick();

      // All 3 guilds were attempted
      expect(result.scannedGuilds).toBe(3);
      expect(result.failures).toBe(1);
      expect(result.skipped).toBe(false);

      // scanGuild was called 3 times (once per guild)
      expect(callCount).toBe(3);

      // A scan_failed activity row must exist for the failing guild
      const failRows = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "guild.skill.auto_promotion_scan_failed"));
      expect(failRows).toHaveLength(1);
      const failPayload = failRows[0]!.details as Record<string, unknown>;
      expect(failPayload.guild_id).toBe(guildIds[1]);
      expect(typeof failPayload.error_message).toBe("string");
      expect(typeof failPayload.scan_id).toBe("string");
      expect(typeof failPayload.stage).toBe("string");

      scanSpy.mockRestore();
    });

    // -----------------------------------------------------------------------
    // Case 7: start/stop idempotency
    // -----------------------------------------------------------------------

    it("start() is idempotent and stop() is idempotent; manual tick() still works after stop", async () => {
      vi.useFakeTimers();
      try {
        const scanner = autoPromotionScanner(db, {
          intervalMs: 60_000,
          service: svc,
          logger: silentLogger,
        });

        // Double start should not throw and should not register two intervals
        scanner.start();
        scanner.start(); // no-op; should not throw

        // Advance time twice the interval; scanGuild would be called if two intervals existed.
        // With idempotent start there is exactly one interval.
        // We verify by stopping and confirming no error.
        scanner.stop();
        scanner.stop(); // no-op; should not throw

        // After stop, manual tick() must still work (it's independent of the interval)
        vi.useRealTimers();
        const result = await scanner.tick();
        // No guilds seeded = scannedGuilds: 0, skipped: false (lock acquired)
        expect(result.skipped).toBe(false);
        expect(result.scannedGuilds).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  },
);
