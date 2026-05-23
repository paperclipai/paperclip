/**
 * Plan 4 Phase 3 - autoPromotionService integration tests.
 *
 * Covers all 8 service methods with 25+ cases including the 15 scanGuild
 * scenarios from spec §8.1: empty guild, each threshold gate failure,
 * retired skill, already-canonical, prior audit, max-per-tick clipping,
 * dry-run mode, and the 3 race scenarios.
 *
 * Uses inline seeding helpers; no createServerTestHarness abstraction exists.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  activityLog,
  agents,
  autoPromotionAudit,
  autoPromotionConfig,
  autoPromotionReverts,
  autoPromotionReviews,
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping auto-promotion service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres(
  "autoPromotionService (Plan 4 Phase 3)",
  () => {
    let db!: ReturnType<typeof createDb>;
    let svc!: ReturnType<typeof autoPromotionService>;
    let tempDb: Awaited<
      ReturnType<typeof startEmbeddedPostgresTestDatabase>
    > | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-auto-promotion-service-",
      );
      db = createDb(tempDb.connectionString);
      svc = autoPromotionService(db);
    }, 20_000);

    afterEach(async () => {
      // Delete in FK-safe order; CASCADE handles children.
      // skill_uses, auto_promotion_reverts, auto_promotion_reviews,
      // auto_promotion_audit all cascade from skills / agents.
      await db.delete(activityLog);
      await db.delete(autoPromotionConfig);
      await db.delete(skills);
      await db.delete(heartbeatRuns);
      await db.delete(agents);
      await db.delete(companies);
    });

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    // -----------------------------------------------------------------------
    // Inline seeding helpers
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
      await db.insert(autoPromotionConfig).values({
        guildId,
        companyId,
        enabled: false,
        dryRun: true,
        scanHourUtc: 6,
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

    // Seeds a skill with customisable counts, provenance, and timestamps.
    // backdateHours: how many hours ago created_at / body_updated_at are set.
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

    // Seeds N skill_uses rows for the given skill, each from a distinct run.
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

    // Seeds an audit row for the given skill (simulates a prior promotion).
    async function seedAudit(
      companyId: string,
      guildId: string,
      skillId: string,
      scanId?: string,
    ): Promise<string> {
      const id = randomUUID();
      await db.insert(autoPromotionAudit).values({
        id,
        skillId,
        guildId,
        companyId,
        successCountAtDecision: 5,
        failCountAtDecision: 0,
        totalUsesAtDecision: 5,
        distinctRunsAtDecision: 3,
        successRatioAtDecision: "1.000",
        skillAgeHoursAtDecision: 25,
        bodyStableHoursAtDecision: 25,
        minUsesThreshold: 5,
        minSuccessRatioThreshold: "0.800",
        minAgeHoursThreshold: 24,
        minBodyStableHoursThreshold: 24,
        minDistinctRunsThreshold: 3,
        scanId: scanId ?? randomUUID(),
      });
      return id;
    }

    // Default config that passes all thresholds (dry_run=false for real promotion tests).
    function liveConfig(
      companyId: string,
      guildId: string,
      overrides?: Partial<typeof autoPromotionConfig.$inferSelect>,
    ): typeof autoPromotionConfig.$inferSelect {
      return {
        guildId,
        companyId,
        enabled: true,
        dryRun: false,
        scanHourUtc: 6,
        minUses: 5,
        minSuccessRatio: "0.800",
        minAgeHours: 24,
        minBodyStableHours: 24,
        minDistinctRuns: 3,
        maxPromotionsPerTick: 3,
        lastSuccessfulScanAt: null,
        lastScanId: null,
        updatedAt: new Date(),
        ...overrides,
      };
    }

    // -----------------------------------------------------------------------
    // getConfig
    // -----------------------------------------------------------------------

    describe("getConfig", () => {
      it("returns the seeded config with defaults", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        await seedConfig(companyId, guildId);

        const row = await svc.getConfig(companyId, guildId);
        expect(row).toMatchObject({
          guildId,
          companyId,
          enabled: false,
          dryRun: true,
          scanHourUtc: 6,
          minUses: 5,
          minAgeHours: 24,
          minBodyStableHours: 24,
          minDistinctRuns: 3,
          maxPromotionsPerTick: 3,
          lastSuccessfulScanAt: null,
        });
        expect(Number(row.minSuccessRatio)).toBeCloseTo(0.8, 3);
      });

      it("throws notFound when config row is missing", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        // intentionally do NOT seed config
        await expect(svc.getConfig(companyId, guildId)).rejects.toThrow(/not found/i);
      });
    });

    // -----------------------------------------------------------------------
    // patchConfig
    // -----------------------------------------------------------------------

    describe("patchConfig", () => {
      it("patches a single field; only that field changes; activity event emitted", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        await seedConfig(companyId, guildId);

        const { row, activityId } = await svc.patchConfig(
          companyId,
          guildId,
          { enabled: true },
          { id: "op", type: "user" },
        );
        expect(row.enabled).toBe(true);
        expect(row.dryRun).toBe(true); // unchanged

        const [activity] = await db
          .select()
          .from(activityLog)
          .where(eq(activityLog.id, activityId))
          .limit(1);
        expect(activity?.action).toBe("guild.skill.auto_promotion_config_changed");
        expect(activity?.details).toMatchObject({ fieldsChanged: ["enabled"] });
      });

      it("rejects patch that violates the min_uses floor", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        await seedConfig(companyId, guildId);

        await expect(
          svc.patchConfig(companyId, guildId, { minUses: 2 }, { id: "op", type: "user" }),
        ).rejects.toThrow(/min_uses/i);
      });

      it("empty patch throws conflict and emits no activity event", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        await seedConfig(companyId, guildId);

        const before = await db.select().from(activityLog);
        await expect(
          svc.patchConfig(companyId, guildId, {}, { id: "op", type: "user" }),
        ).rejects.toThrow(/empty patch/i);
        const after = await db.select().from(activityLog);
        expect(after.length).toBe(before.length);
      });

      it("patches multiple fields atomically; one event with all fieldsChanged", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        await seedConfig(companyId, guildId);

        const { row, activityId } = await svc.patchConfig(
          companyId,
          guildId,
          { enabled: true, dryRun: false, minUses: 7 },
          { id: "op", type: "user" },
        );
        expect(row).toMatchObject({ enabled: true, dryRun: false, minUses: 7 });

        const [activity] = await db
          .select()
          .from(activityLog)
          .where(eq(activityLog.id, activityId))
          .limit(1);
        expect(activity?.details).toMatchObject({
          fieldsChanged: expect.arrayContaining(["enabled", "dryRun", "minUses"]),
        });
      });
    });

    // -----------------------------------------------------------------------
    // recordReview
    // -----------------------------------------------------------------------

    describe("recordReview", () => {
      it("writes a review row and returns it", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const skillId = await seedSkill(companyId, guildId, { backdateHours: 30 });
        const auditId = await seedAudit(companyId, guildId, skillId);

        const review = await svc.recordReview(companyId, auditId, "op-1", "looked good");
        expect(review.auditId).toBe(auditId);
        expect(review.reviewerId).toBe("op-1");
        expect(review.context).toBe("looked good");
      });

      it("allows multiple reviews of the same audit row", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const skillId = await seedSkill(companyId, guildId, { backdateHours: 30 });
        const auditId = await seedAudit(companyId, guildId, skillId);

        await svc.recordReview(companyId, auditId, "op-1");
        await svc.recordReview(companyId, auditId, "op-2", "still fine");
        const rows = await db
          .select()
          .from(autoPromotionReviews)
          .where(eq(autoPromotionReviews.auditId, auditId));
        expect(rows).toHaveLength(2);
      });

      it("rejects unknown auditId", async () => {
        const companyId = await seedCompany();
        await expect(
          svc.recordReview(companyId, "00000000-0000-0000-0000-000000000000", "op-1"),
        ).rejects.toThrow(/not found/i);
      });
    });

    // -----------------------------------------------------------------------
    // revert
    // -----------------------------------------------------------------------

    describe("revert", () => {
      it("inserts revert row, flips skill back to provisional, emits activity", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const skillId = await seedSkill(companyId, guildId, {
          backdateHours: 30,
          provenance: "canonical",
        });
        const auditId = await seedAudit(companyId, guildId, skillId);

        const { revert, skill, activityId } = await svc.revert(
          companyId,
          auditId,
          "wrong skill",
          "op-1",
        );

        expect(revert.auditId).toBe(auditId);
        expect(revert.revertedBy).toBe("op-1");
        expect(revert.reason).toBe("wrong skill");
        expect(skill.provenance).toBe("provisional");
        expect(skill.id).toBe(skillId);

        const [activity] = await db
          .select()
          .from(activityLog)
          .where(eq(activityLog.id, activityId))
          .limit(1);
        expect(activity?.action).toBe("guild.skill.auto_promotion_reverted");
        expect(activity?.details).toMatchObject({ auditId, revertedBy: "op-1" });
      });

      it("rejects empty reason", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const skillId = await seedSkill(companyId, guildId, { backdateHours: 30 });
        const auditId = await seedAudit(companyId, guildId, skillId);

        await expect(
          svc.revert(companyId, auditId, "", "op-1"),
        ).rejects.toThrow(/reason/i);
      });

      it("rejects reason exceeding 2000 chars", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const skillId = await seedSkill(companyId, guildId, { backdateHours: 30 });
        const auditId = await seedAudit(companyId, guildId, skillId);

        await expect(
          svc.revert(companyId, auditId, "x".repeat(2001), "op-1"),
        ).rejects.toThrow(/reason/i);
      });

      it("rejects double-revert with conflict", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const skillId = await seedSkill(companyId, guildId, {
          backdateHours: 30,
          provenance: "canonical",
        });
        const auditId = await seedAudit(companyId, guildId, skillId);

        await svc.revert(companyId, auditId, "first revert", "op-1");
        await expect(
          svc.revert(companyId, auditId, "second attempt", "op-2"),
        ).rejects.toThrow(/already reverted/i);
      });

      it("rejects unknown auditId", async () => {
        const companyId = await seedCompany();
        await expect(
          svc.revert(companyId, "00000000-0000-0000-0000-000000000000", "reason", "op"),
        ).rejects.toThrow(/not found/i);
      });

      it("rolls back entirely when skill insert fails (transactional integrity)", async () => {
        // We can test transaction atomicity by attempting a revert on an audit
        // where the skill row has been deleted (FK violation on skills update).
        // In practice this shouldn't happen but verifies the txn boundary.
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const skillId = await seedSkill(companyId, guildId, { backdateHours: 30 });
        const auditId = await seedAudit(companyId, guildId, skillId);

        // Force-delete the skill (bypasses CASCADE since we're deleting the parent)
        await db.delete(skills).where(eq(skills.id, skillId));

        // Revert should fail: skill not found inside the txn
        await expect(
          svc.revert(companyId, auditId, "cascade test", "op"),
        ).rejects.toThrow(/not found/i);

        // No revert row should have been written
        const reverts = await db
          .select()
          .from(autoPromotionReverts)
          .where(eq(autoPromotionReverts.auditId, auditId));
        expect(reverts).toHaveLength(0);
      });
    });

    // -----------------------------------------------------------------------
    // listAudits
    // -----------------------------------------------------------------------

    describe("listAudits", () => {
      it("returns all audits for a guild ordered desc by decidedAt", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const s1 = await seedSkill(companyId, guildId, { backdateHours: 30 });
        const s2 = await seedSkill(companyId, guildId, { backdateHours: 30 });
        await seedAudit(companyId, guildId, s1);
        await seedAudit(companyId, guildId, s2);

        const { rows, total } = await svc.listAudits(companyId, guildId, {
          revertedOnly: false,
          neverReviewed: false,
          limit: 20,
        });
        expect(rows).toHaveLength(2);
        expect(total).toBe(2);
      });

      it("revertedOnly=true returns only reverted audits", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const s1 = await seedSkill(companyId, guildId, {
          backdateHours: 30,
          provenance: "canonical",
        });
        const s2 = await seedSkill(companyId, guildId, { backdateHours: 30 });
        const auditId1 = await seedAudit(companyId, guildId, s1);
        await seedAudit(companyId, guildId, s2);
        await svc.revert(companyId, auditId1, "test revert", "op");

        const { rows } = await svc.listAudits(companyId, guildId, {
          revertedOnly: true,
          neverReviewed: false,
          limit: 20,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]!.revert).not.toBeNull();
      });

      it("neverReviewed=true returns only un-reviewed audits", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const s1 = await seedSkill(companyId, guildId, { backdateHours: 30 });
        const s2 = await seedSkill(companyId, guildId, { backdateHours: 30 });
        const auditId1 = await seedAudit(companyId, guildId, s1);
        await seedAudit(companyId, guildId, s2);
        await svc.recordReview(companyId, auditId1, "op");

        const { rows } = await svc.listAudits(companyId, guildId, {
          revertedOnly: false,
          neverReviewed: true,
          limit: 20,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]!.reviewCount).toBe(0);
      });

      it("limit is respected", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        for (let i = 0; i < 5; i++) {
          const sid = await seedSkill(companyId, guildId, { backdateHours: 30 });
          await seedAudit(companyId, guildId, sid);
        }
        const { rows, total } = await svc.listAudits(companyId, guildId, {
          revertedOnly: false,
          neverReviewed: false,
          limit: 3,
        });
        expect(rows).toHaveLength(3);
        expect(total).toBe(5);
      });

      it("since/until filters by decidedAt", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const sid = await seedSkill(companyId, guildId, { backdateHours: 30 });
        await seedAudit(companyId, guildId, sid);

        const future = new Date(Date.now() + 86400_000).toISOString();
        const { rows } = await svc.listAudits(companyId, guildId, {
          until: new Date(Date.now() - 86400_000).toISOString(), // yesterday = before the audit
          revertedOnly: false,
          neverReviewed: false,
          limit: 20,
        });
        expect(rows).toHaveLength(0);

        const { rows: rows2 } = await svc.listAudits(companyId, guildId, {
          since: new Date(Date.now() - 3600_000).toISOString(), // 1h ago = audit is within range
          until: future,
          revertedOnly: false,
          neverReviewed: false,
          limit: 20,
        });
        expect(rows2).toHaveLength(1);
      });

      it("revertedOnly=true: total matches rows.length when only some audits have reverts", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        // 4 audits, only 1 with a revert
        const skills4 = await Promise.all(
          Array.from({ length: 4 }, () =>
            seedSkill(companyId, guildId, { backdateHours: 30, provenance: "canonical" }),
          ),
        );
        const auditIds = await Promise.all(
          skills4.map((s) => seedAudit(companyId, guildId, s)),
        );
        await svc.revert(companyId, auditIds[0]!, "test", "op");

        const { rows, total } = await svc.listAudits(companyId, guildId, {
          revertedOnly: true,
          neverReviewed: false,
          limit: 20,
        });
        expect(rows).toHaveLength(1);
        expect(total).toBe(rows.length);
      });

      it("revertedOnly=true: pagination with limit respects SQL-level filter", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        // 10 audits, 3 with reverts
        const seededs = await Promise.all(
          Array.from({ length: 10 }, () =>
            seedSkill(companyId, guildId, { backdateHours: 30, provenance: "canonical" }),
          ),
        );
        const auditIds = await Promise.all(
          seededs.map((s) => seedAudit(companyId, guildId, s)),
        );
        // Revert the first 3
        for (const id of auditIds.slice(0, 3)) {
          await svc.revert(companyId, id, "test", "op");
        }

        const { rows, total } = await svc.listAudits(companyId, guildId, {
          revertedOnly: true,
          neverReviewed: false,
          limit: 2,
        });
        // LIMIT is applied after SQL filter, so we get 2 out of 3 reverted audits
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.revert !== null)).toBe(true);
        // total reflects the full filtered count (3), not the page size
        expect(total).toBe(3);
      });

      it("neverReviewed=true: total matches rows.length when only some audits have reviews", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        // 4 audits, 1 reviewed
        const skills4 = await Promise.all(
          Array.from({ length: 4 }, () =>
            seedSkill(companyId, guildId, { backdateHours: 30 }),
          ),
        );
        const auditIds = await Promise.all(
          skills4.map((s) => seedAudit(companyId, guildId, s)),
        );
        await svc.recordReview(companyId, auditIds[0]!, "op");

        const { rows, total } = await svc.listAudits(companyId, guildId, {
          revertedOnly: false,
          neverReviewed: true,
          limit: 20,
        });
        expect(rows).toHaveLength(3);
        expect(total).toBe(rows.length);
        expect(rows.every((r) => r.reviewCount === 0)).toBe(true);
      });

      it("neverReviewed=true: pagination with limit respects SQL-level filter", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        // 10 audits, 7 reviewed (leaves 3 never-reviewed)
        const seededs = await Promise.all(
          Array.from({ length: 10 }, () =>
            seedSkill(companyId, guildId, { backdateHours: 30 }),
          ),
        );
        const auditIds = await Promise.all(
          seededs.map((s) => seedAudit(companyId, guildId, s)),
        );
        // Review the first 7
        for (const id of auditIds.slice(0, 7)) {
          await svc.recordReview(companyId, id, "op");
        }

        const { rows, total } = await svc.listAudits(companyId, guildId, {
          revertedOnly: false,
          neverReviewed: true,
          limit: 2,
        });
        // LIMIT is applied after SQL filter, so we get 2 out of 3 never-reviewed audits
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.reviewCount === 0)).toBe(true);
        // total reflects the full filtered count (3), not the page size
        expect(total).toBe(3);
      });
    });

    // -----------------------------------------------------------------------
    // getAuditEnvelope
    // -----------------------------------------------------------------------

    describe("getAuditEnvelope", () => {
      it("returns audit + skill + recent uses (capped at 10) + revert + reviewCount", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const skillId = await seedSkill(companyId, guildId, {
          backdateHours: 30,
          successCount: 15,
          failCount: 0,
        });
        // Seed 12 uses (10 distinct runs) - envelope should cap at 10
        await seedUses(companyId, guildId, skillId, 12);
        const auditId = await seedAudit(companyId, guildId, skillId);
        await svc.recordReview(companyId, auditId, "op");

        const env = await svc.getAuditEnvelope(companyId, auditId);

        expect(env.audit.id).toBe(auditId);
        expect(env.skill?.id).toBe(skillId);
        expect(env.recentUses.length).toBeLessThanOrEqual(10);
        expect(env.reverted).toBeNull();
        expect(env.reviewCount).toBe(1);
      });

      it("throws notFound for unknown auditId", async () => {
        const companyId = await seedCompany();
        await expect(
          svc.getAuditEnvelope(companyId, "00000000-0000-0000-0000-000000000000"),
        ).rejects.toThrow(/not found/i);
      });
    });

    // -----------------------------------------------------------------------
    // listScanTicks
    // -----------------------------------------------------------------------

    describe("listScanTicks", () => {
      it("aggregates activity_log rows by scanId into one row per scan", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        await seedConfig(companyId, guildId, { dryRun: false, enabled: true });
        const cfg = liveConfig(companyId, guildId, { maxPromotionsPerTick: 3 });

        // Seed an eligible skill and run a scan
        const skillId = await seedSkill(companyId, guildId, {
          backdateHours: 30,
          successCount: 10,
          failCount: 0,
        });
        await seedUses(companyId, guildId, skillId, 5);
        const scanId = randomUUID();
        await svc.scanGuild(scanId, cfg);

        const ticks = await svc.listScanTicks(companyId, guildId, 10);
        expect(ticks.length).toBeGreaterThanOrEqual(1);
        const tick = ticks.find((t) => t.scan_id === scanId);
        expect(tick).toBeDefined();
      });

      it("returns multiple scans ordered by decided_at desc", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const cfg = liveConfig(companyId, guildId);

        // Run two empty scans with different scanIds
        const scanId1 = randomUUID();
        const scanId2 = randomUUID();
        await svc.scanGuild(scanId1, cfg);
        await svc.scanGuild(scanId2, cfg);

        const ticks = await svc.listScanTicks(companyId, guildId, 10);
        // At minimum both scans appear
        const ids = ticks.map((t) => t.scan_id);
        expect(ids).toContain(scanId1);
        expect(ids).toContain(scanId2);
      });
    });

    // -----------------------------------------------------------------------
    // scanGuild - the 15 scenarios from spec §8.1
    // -----------------------------------------------------------------------

    describe("scanGuild", () => {
      // S1: empty guild - no skills at all
      it("S1: empty guild returns promotedCount=0 and emits auto_promotion_scan", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const cfg = liveConfig(companyId, guildId);
        const result = await svc.scanGuild(randomUUID(), cfg);

        expect(result.promotedCount).toBe(0);
        expect(result.scannedCount).toBe(0);
        expect(result.eligibleCount).toBe(0);

        const [activity] = await db
          .select()
          .from(activityLog)
          .where(eq(activityLog.entityId, guildId))
          .limit(1);
        expect(activity?.action).toBe("guild.skill.auto_promotion_scan");
      });

      // S2: skill below minUses threshold
      it("S2: skill below minUses is not promoted", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        // Only 3 uses, threshold is 5
        await seedSkill(companyId, guildId, {
          backdateHours: 30,
          successCount: 3,
          failCount: 0,
        });
        const cfg = liveConfig(companyId, guildId);
        const result = await svc.scanGuild(randomUUID(), cfg);
        expect(result.promotedCount).toBe(0);
        expect(result.scannedCount).toBe(0); // didn't pass SQL filter
      });

      // S3: skill below success ratio
      it("S3: skill below minSuccessRatio is not promoted", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        // 5 uses, only 3 successes = 0.6 ratio, threshold is 0.8
        await seedSkill(companyId, guildId, {
          backdateHours: 30,
          successCount: 3,
          failCount: 2,
        });
        const cfg = liveConfig(companyId, guildId);
        const result = await svc.scanGuild(randomUUID(), cfg);
        expect(result.promotedCount).toBe(0);
      });

      // S4: skill too young (below minAgeHours)
      it("S4: skill that is too young is not promoted", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        // Created 1 hour ago, threshold is 24h
        await seedSkill(companyId, guildId, {
          backdateHours: 1,
          successCount: 10,
          failCount: 0,
        });
        const cfg = liveConfig(companyId, guildId);
        const result = await svc.scanGuild(randomUUID(), cfg);
        expect(result.promotedCount).toBe(0);
      });

      // S5: skill body not stable (below minBodyStableHours)
      it("S5: skill with unstable body (too recent bodyUpdatedAt) is not promoted", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const skillId = await seedSkill(companyId, guildId, {
          successCount: 10,
          failCount: 0,
        });
        // Backdate only createdAt but leave bodyUpdatedAt recent
        // We do this by force-updating the created_at to be old but bodyUpdatedAt to now
        await db.execute(sql`
          UPDATE skills
          SET created_at = NOW() - INTERVAL '48 hours',
              body_updated_at = NOW()
          WHERE id = ${skillId}
        `);
        const cfg = liveConfig(companyId, guildId);
        const result = await svc.scanGuild(randomUUID(), cfg);
        expect(result.promotedCount).toBe(0);
      });

      // S6: diversity gate - all uses from same run_id
      it("S6: skill with all uses from one run is blocked by diversity gate", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const skillId = await seedSkill(companyId, guildId, {
          backdateHours: 30,
          successCount: 10,
          failCount: 0,
        });
        // All 10 uses from a single run
        const runId = await seedRun(companyId, guildId);
        for (let i = 0; i < 10; i++) {
          await db.insert(skillUses).values({ skillId, guildId, runId, success: true });
        }
        const cfg = liveConfig(companyId, guildId); // minDistinctRuns=3
        const result = await svc.scanGuild(randomUUID(), cfg);
        expect(result.promotedCount).toBe(0);
        expect(result.eligibleCount).toBe(0); // filtered by diversity gate
      });

      // S7: diversity gate passes - uses from 3 distinct runs
      it("S7: skill with uses from 3+ distinct runs passes diversity gate", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const skillId = await seedSkill(companyId, guildId, {
          backdateHours: 30,
          successCount: 5,
          failCount: 0,
        });
        await seedUses(companyId, guildId, skillId, 5);
        const cfg = liveConfig(companyId, guildId);
        const result = await svc.scanGuild(randomUUID(), cfg);
        expect(result.promotedCount).toBe(1);
        expect(result.promotions[0]?.distinctRuns).toBeGreaterThanOrEqual(3);
      });

      // S8: retired skill is not promoted
      it("S8: retired skill is excluded from promotion", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        await seedSkill(companyId, guildId, {
          backdateHours: 30,
          successCount: 10,
          failCount: 0,
          retiredAt: new Date(),
        });
        const cfg = liveConfig(companyId, guildId);
        const result = await svc.scanGuild(randomUUID(), cfg);
        expect(result.promotedCount).toBe(0);
      });

      // S9: already-canonical skill is not re-promoted
      it("S9: already-canonical skill is excluded", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        await seedSkill(companyId, guildId, {
          backdateHours: 30,
          successCount: 10,
          failCount: 0,
          provenance: "canonical",
        });
        const cfg = liveConfig(companyId, guildId);
        const result = await svc.scanGuild(randomUUID(), cfg);
        expect(result.promotedCount).toBe(0);
      });

      // S10: skill that already has an audit row is not re-promoted
      it("S10: skill with prior audit row is excluded (UNIQUE invariant)", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const skillId = await seedSkill(companyId, guildId, {
          backdateHours: 30,
          successCount: 10,
          failCount: 0,
          provenance: "canonical",
        });
        await seedAudit(companyId, guildId, skillId);
        const cfg = liveConfig(companyId, guildId);
        const result = await svc.scanGuild(randomUUID(), cfg);
        expect(result.promotedCount).toBe(0);
      });

      // S11: max-per-tick clipping - 5 eligible skills but maxPerTick=3
      it("S11: at most maxPromotionsPerTick skills are promoted per scan", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        for (let i = 0; i < 5; i++) {
          const sid = await seedSkill(companyId, guildId, {
            backdateHours: 30,
            successCount: 10,
            failCount: 0,
          });
          await seedUses(companyId, guildId, sid, 5);
        }
        const cfg = liveConfig(companyId, guildId, { maxPromotionsPerTick: 3 });
        const result = await svc.scanGuild(randomUUID(), cfg);
        expect(result.promotedCount).toBe(3);
        expect(result.promotions).toHaveLength(3);
      });

      // S12: dry-run mode - no audit rows, no skill mutations, dryrun action emitted
      it("S12: dry-run mode emits dryrun action but writes no audit rows or skill mutations", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const skillId = await seedSkill(companyId, guildId, {
          backdateHours: 30,
          successCount: 5,
          failCount: 0,
        });
        await seedUses(companyId, guildId, skillId, 5);
        const cfg = liveConfig(companyId, guildId, { dryRun: true });
        const result = await svc.scanGuild(randomUUID(), cfg);

        expect(result.dryRun).toBe(true);
        expect(result.promotedCount).toBe(1); // would have promoted
        expect(result.promotions[0]?.auditId).toBeNull(); // no audit row

        // No audit rows in DB
        const auditRows = await db.select().from(autoPromotionAudit);
        expect(auditRows).toHaveLength(0);

        // Skill still provisional
        const [skill] = await db
          .select()
          .from(skills)
          .where(eq(skills.id, skillId))
          .limit(1);
        expect(skill?.provenance).toBe("provisional");

        // Activity action is dryrun variant
        const [activity] = await db
          .select()
          .from(activityLog)
          .where(eq(activityLog.entityId, guildId))
          .limit(1);
        expect(activity?.action).toBe("guild.skill.auto_promotion_scan_dryrun");
      });

      // S13 race: concurrent flip to canonical between eligibility query and FOR UPDATE
      it("S13 race: skill flipped to canonical by concurrent promote → promoteOne skips it", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const skillId = await seedSkill(companyId, guildId, {
          backdateHours: 30,
          successCount: 5,
          failCount: 0,
        });
        await seedUses(companyId, guildId, skillId, 5);
        const cfg = liveConfig(companyId, guildId);

        // Manually flip to canonical before promoteOne runs (simulates race)
        await db
          .update(skills)
          .set({ provenance: "canonical" })
          .where(eq(skills.id, skillId));

        const result = await svc.promoteOne(
          { id: skillId, distinctRuns: 5, ageHours: 30, bodyStableHours: 30 },
          cfg,
          randomUUID(),
        );

        expect(result.skipped).toBe(true);
        expect(result.auditId).toBeNull();

        // No audit row inserted
        const auditRows = await db.select().from(autoPromotionAudit);
        expect(auditRows).toHaveLength(0);
      });

      // S14 race: skill retired between eligibility query and FOR UPDATE
      it("S14 race: skill retired before promoteOne transaction → skipped", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const skillId = await seedSkill(companyId, guildId, {
          backdateHours: 30,
          successCount: 5,
          failCount: 0,
        });
        await seedUses(companyId, guildId, skillId, 5);
        const cfg = liveConfig(companyId, guildId);

        // Retire the skill before promote
        await db
          .update(skills)
          .set({ retiredAt: new Date() })
          .where(eq(skills.id, skillId));

        const result = await svc.promoteOne(
          { id: skillId, distinctRuns: 5, ageHours: 30, bodyStableHours: 30 },
          cfg,
          randomUUID(),
        );
        expect(result.skipped).toBe(true);
        const auditRows = await db.select().from(autoPromotionAudit);
        expect(auditRows).toHaveLength(0);
      });

      // S15a: second scanGuild sees already-canonical skill via eligibility filter - no double audit row
      it("S15a: second scan skips already-canonical skill via eligibility filter", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const skillId = await seedSkill(companyId, guildId, {
          backdateHours: 30,
          successCount: 5,
          failCount: 0,
        });
        await seedUses(companyId, guildId, skillId, 5);
        const cfg = liveConfig(companyId, guildId);

        // First scan promotes the skill
        const result1 = await svc.scanGuild(randomUUID(), cfg);
        expect(result1.promotedCount).toBe(1);

        // Second scan: skill is now canonical, should not be re-promoted
        const result2 = await svc.scanGuild(randomUUID(), cfg);
        expect(result2.promotedCount).toBe(0);

        // Only one audit row
        const auditRows = await db.select().from(autoPromotionAudit);
        expect(auditRows).toHaveLength(1);
      });

      // S15b: promoteOne raises UNIQUE collision when audit row already exists out-of-band
      it("S15b: promoteOne raises on UNIQUE collision when an audit row already exists", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const skillId = await seedSkill(companyId, guildId, {
          backdateHours: 30,
          successCount: 5,
          failCount: 0,
        });
        await seedUses(companyId, guildId, skillId, 5);
        const cfg = liveConfig(companyId, guildId);

        // Insert an audit row out-of-band (different scanId) to simulate a race
        await seedAudit(companyId, guildId, skillId, randomUUID());

        // promoteOne should throw due to UNIQUE constraint on auto_promotion_audit(skill_id)
        await expect(
          svc.promoteOne(
            { id: skillId, distinctRuns: 5, ageHours: 30, bodyStableHours: 30 },
            cfg,
            randomUUID(),
          ),
        ).rejects.toThrow();

        // Still exactly one audit row (the out-of-band one; promoteOne did not insert another)
        const auditRows = await db.select().from(autoPromotionAudit);
        expect(auditRows).toHaveLength(1);
      });

      // Bonus: happy path - full promotion flow emits auto_promoted action
      it("happy path: eligible skill is promoted and emits auto_promoted action", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        const skillId = await seedSkill(companyId, guildId, {
          backdateHours: 30,
          successCount: 7,
          failCount: 0,
        });
        await seedUses(companyId, guildId, skillId, 5);
        const scanId = randomUUID();
        const cfg = liveConfig(companyId, guildId);

        const result = await svc.scanGuild(scanId, cfg);
        expect(result.promotedCount).toBe(1);
        expect(result.promotions[0]?.auditId).toBeTruthy();

        // Skill is now canonical
        const [skill] = await db
          .select()
          .from(skills)
          .where(eq(skills.id, skillId))
          .limit(1);
        expect(skill?.provenance).toBe("canonical");

        // Audit row exists
        const auditRows = await db.select().from(autoPromotionAudit);
        expect(auditRows).toHaveLength(1);
        expect(auditRows[0]!.scanId).toBe(scanId);

        // Activity action is auto_promoted
        const [activity] = await db
          .select()
          .from(activityLog)
          .where(eq(activityLog.entityId, guildId))
          .limit(1);
        expect(activity?.action).toBe("guild.skill.auto_promoted");
        expect(activity?.details).toMatchObject({ promotedCount: 1, dryRun: false });
      });

      // health update: lastSuccessfulScanAt is updated after scan
      it("updates lastSuccessfulScanAt on autoPromotionConfig after scan", async () => {
        const companyId = await seedCompany();
        const guildId = await seedGuild(companyId);
        await seedConfig(companyId, guildId);
        const scanId = randomUUID();
        const cfg = liveConfig(companyId, guildId);

        await svc.scanGuild(scanId, cfg);

        const [updatedConfig] = await db
          .select()
          .from(autoPromotionConfig)
          .where(eq(autoPromotionConfig.guildId, guildId))
          .limit(1);
        // config may not exist if we only seeded via liveConfig helper
        // but lastSuccessfulScanAt should be set in the DB update
        // (note: liveConfig() is an in-memory object; the DB update targets by guildId)
        // Config is only in DB if we called seedConfig; if not, update is a no-op
        // Here we DID call seedConfig so it should be set.
        if (updatedConfig) {
          expect(updatedConfig.lastSuccessfulScanAt).not.toBeNull();
          expect(updatedConfig.lastScanId).toBe(scanId);
        }
      });
    });
  },
);
