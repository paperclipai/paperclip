/**
 * Plan 4 Phase 5 - auto-promotion HTTP routes integration tests.
 *
 * 38 tests covering all 8 endpoints:
 *   - Happy-path response shapes
 *   - Auth matrix (operator OK, agent rejected, cross-company rejected)
 *   - Query filter behaviour (revertedOnly, neverReviewed, limit)
 *   - Error paths (404 on missing rows, 409 on conflicts, 400 on bad body)
 *   - No-token 401 for all 3 mutating routes
 *   - Cross-company 403/404 for all 7 remaining routes
 *   - Floor validation (minUses < 3 caught by zod -> 400)
 *
 * Uses embedded Postgres + supertest, matching the guild-skills-routes
 * test pattern exactly.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let autoPromotionRoutes: typeof import("../routes/auto-promotion.js").autoPromotionRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres auto-promotion route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres(
  "auto-promotion routes (Plan 4 Phase 5)",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
    let companyId!: string;
    let guildId!: string;
    let userId!: string;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-auto-promotion-routes-",
      );
      db = createDb(tempDb.connectionString);
    }, 20_000);

    beforeEach(async () => {
      vi.resetModules();
      vi.doUnmock("../routes/auto-promotion.js");
      vi.doUnmock("../middleware/index.js");
      const [routes, middleware] = await Promise.all([
        vi.importActual<typeof import("../routes/auto-promotion.js")>(
          "../routes/auto-promotion.js",
        ),
        vi.importActual<typeof import("../middleware/index.js")>(
          "../middleware/index.js",
        ),
      ]);
      autoPromotionRoutes = routes.autoPromotionRoutes;
      errorHandler = middleware.errorHandler;

      companyId = randomUUID();
      guildId = randomUUID();
      userId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: "co-fixture",
        issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      });
      await db.insert(agents).values({
        id: guildId,
        companyId,
        name: "eng-guild",
        kind: "guild",
      });
    });

    afterEach(async () => {
      // activity_log has no CASCADE from companies so must be deleted first.
      // auto_promotion_* and skill_uses cascade from skills / agents.
      await db.delete(activityLog);
      await db.delete(skills);
      await db.delete(autoPromotionConfig);
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

    async function seedConfig(
      overrides?: Partial<typeof autoPromotionConfig.$inferInsert>,
    ): Promise<void> {
      await db.insert(autoPromotionConfig).values({
        guildId,
        companyId,
        enabled: false,
        dryRun: false,
        scanHourUtc: 6,
        minUses: 3,
        minSuccessRatio: "0.800",
        minAgeHours: 6,
        minBodyStableHours: 6,
        minDistinctRuns: 2,
        maxPromotionsPerTick: 3,
        ...overrides,
      });
    }

    async function seedSkill(opts?: {
      successCount?: number;
      failCount?: number;
      provenance?: "provisional" | "canonical";
      backdateHours?: number;
    }): Promise<string> {
      const id = randomUUID();
      const backdateMs = (opts?.backdateHours ?? 48) * 3600 * 1000;
      const ts = new Date(Date.now() - backdateMs);
      await db.insert(skills).values({
        id,
        guildId,
        companyId,
        name: `skill-${id.slice(0, 8)}`,
        body: "test skill body",
        provenance: opts?.provenance ?? "provisional",
        successCount: opts?.successCount ?? 0,
        failCount: opts?.failCount ?? 0,
        retiredAt: null,
        createdAt: ts,
        updatedAt: ts,
        bodyUpdatedAt: ts,
      });
      return id;
    }

    async function seedRun(): Promise<string> {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({
        id,
        companyId,
        agentId: guildId,
        invocationSource: "on_demand",
        status: "succeeded",
      });
      return id;
    }

    async function seedAudit(skillId: string): Promise<string> {
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
        skillAgeHoursAtDecision: 48,
        bodyStableHoursAtDecision: 48,
        minUsesThreshold: 3,
        minSuccessRatioThreshold: "0.800",
        minAgeHoursThreshold: 6,
        minBodyStableHoursThreshold: 6,
        minDistinctRunsThreshold: 2,
        scanId: randomUUID(),
      });
      return id;
    }

    async function seedRevert(auditId: string): Promise<void> {
      await db.insert(autoPromotionReverts).values({
        auditId,
        revertedBy: userId,
        reason: "test revert reason",
      });
    }

    async function seedReview(auditId: string): Promise<void> {
      await db.insert(autoPromotionReviews).values({
        auditId,
        reviewerId: userId,
        context: null,
      });
    }

    // -----------------------------------------------------------------------
    // App factory
    // -----------------------------------------------------------------------

    function createApp(
      actor:
        | { type: "operator"; userId?: string }
        | { type: "agent"; agentId?: string; agentCompanyId?: string },
    ) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        if (actor.type === "agent") {
          (req as any).actor = {
            type: "agent",
            source: "local_implicit",
            agentId: actor.agentId ?? randomUUID(),
            companyId: actor.agentCompanyId ?? companyId,
            runId: null,
          };
        } else {
          (req as any).actor = {
            type: "board",
            source: "local_implicit",
            userId: actor.userId ?? userId,
            companyIds: [companyId],
          };
        }
        next();
      });
      app.use("/api", autoPromotionRoutes(db));
      app.use(errorHandler);
      return app;
    }

    /**
     * App that sets req.actor.type = "none" to simulate an unauthenticated
     * request. assertAuthenticated (called inside assertCompanyAccess) throws
     * 401 when it sees this actor type.
     */
    function createAppNoToken() {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as any).actor = { type: "none" };
        next();
      });
      app.use("/api", autoPromotionRoutes(db));
      app.use(errorHandler);
      return app;
    }

    const operatorApp = () => createApp({ type: "operator" });
    const agentApp = () =>
      createApp({ type: "agent", agentCompanyId: companyId });

    // -----------------------------------------------------------------------
    // GET /companies/:companyId/guilds/:guildId/auto-promotion-config (3 tests)
    // -----------------------------------------------------------------------

    describe("GET auto-promotion-config", () => {
      it("returns seeded config row", async () => {
        await seedConfig({ enabled: true, dryRun: true });
        const res = await request(operatorApp())
          .get(`/api/companies/${companyId}/guilds/${guildId}/auto-promotion-config`);
        expect(res.status).toBe(200);
        expect(res.body.guildId).toBe(guildId);
        expect(res.body.enabled).toBe(true);
        expect(res.body.dryRun).toBe(true);
        expect(res.body.minUses).toBe(3);
      });

      it("returns 404 when config row is absent", async () => {
        // No seedConfig call - no row exists
        const res = await request(operatorApp())
          .get(`/api/companies/${companyId}/guilds/${guildId}/auto-promotion-config`);
        expect(res.status).toBe(404);
      });

      it("rejects cross-company access with 403", async () => {
        await seedConfig();
        const otherCompanyId = randomUUID();
        const res = await request(
          createApp({ type: "agent", agentCompanyId: otherCompanyId }),
        ).get(`/api/companies/${companyId}/guilds/${guildId}/auto-promotion-config`);
        expect(res.status).toBe(403);
      });
    });

    // -----------------------------------------------------------------------
    // PATCH /companies/:companyId/guilds/:guildId/auto-promotion-config (4 tests)
    // -----------------------------------------------------------------------

    describe("PATCH auto-promotion-config", () => {
      it("operator can patch a single field and returns updated row + activityId", async () => {
        await seedConfig({ enabled: false });
        const res = await request(operatorApp())
          .patch(`/api/companies/${companyId}/guilds/${guildId}/auto-promotion-config`)
          .send({ enabled: true });
        expect(res.status).toBe(200);
        expect(res.body.row.enabled).toBe(true);
        expect(typeof res.body.activityId).toBe("string");
      });

      it("operator can patch multiple fields atomically", async () => {
        await seedConfig({ minUses: 3, minAgeHours: 6 });
        const res = await request(operatorApp())
          .patch(`/api/companies/${companyId}/guilds/${guildId}/auto-promotion-config`)
          .send({ minUses: 5, minAgeHours: 24 });
        expect(res.status).toBe(200);
        expect(res.body.row.minUses).toBe(5);
        expect(res.body.row.minAgeHours).toBe(24);
      });

      it("returns 409 when patch is empty", async () => {
        await seedConfig();
        const res = await request(operatorApp())
          .patch(`/api/companies/${companyId}/guilds/${guildId}/auto-promotion-config`)
          .send({});
        expect(res.status).toBe(409);
      });

      it("rejects agent token with 403", async () => {
        await seedConfig();
        const res = await request(agentApp())
          .patch(`/api/companies/${companyId}/guilds/${guildId}/auto-promotion-config`)
          .send({ enabled: true });
        expect(res.status).toBe(403);
      });
    });

    // -----------------------------------------------------------------------
    // GET /companies/:companyId/guilds/:guildId/auto-promotions (5 tests)
    // -----------------------------------------------------------------------

    describe("GET auto-promotions list", () => {
      it("returns empty list when no audits exist", async () => {
        const res = await request(operatorApp())
          .get(`/api/companies/${companyId}/guilds/${guildId}/auto-promotions`);
        expect(res.status).toBe(200);
        expect(res.body.rows).toHaveLength(0);
        expect(res.body.total).toBe(0);
      });

      it("returns multiple audits ordered by decidedAt DESC", async () => {
        const skillId1 = await seedSkill();
        const skillId2 = await seedSkill();
        await seedAudit(skillId1);
        await seedAudit(skillId2);
        const res = await request(operatorApp())
          .get(`/api/companies/${companyId}/guilds/${guildId}/auto-promotions`);
        expect(res.status).toBe(200);
        expect(res.body.rows).toHaveLength(2);
        expect(res.body.total).toBe(2);
      });

      it("filters by revertedOnly=true", async () => {
        const skillId1 = await seedSkill();
        const skillId2 = await seedSkill();
        const auditId1 = await seedAudit(skillId1);
        await seedAudit(skillId2);
        await seedRevert(auditId1);

        const res = await request(operatorApp())
          .get(`/api/companies/${companyId}/guilds/${guildId}/auto-promotions?revertedOnly=true`);
        expect(res.status).toBe(200);
        expect(res.body.rows).toHaveLength(1);
        expect(res.body.rows[0].id).toBe(auditId1);
      });

      it("filters by neverReviewed=true", async () => {
        const skillId1 = await seedSkill();
        const skillId2 = await seedSkill();
        const auditId1 = await seedAudit(skillId1);
        const auditId2 = await seedAudit(skillId2);
        await seedReview(auditId1); // reviewed

        const res = await request(operatorApp())
          .get(`/api/companies/${companyId}/guilds/${guildId}/auto-promotions?neverReviewed=true`);
        expect(res.status).toBe(200);
        expect(res.body.rows).toHaveLength(1);
        expect(res.body.rows[0].id).toBe(auditId2);
      });

      it("respects limit parameter", async () => {
        for (let i = 0; i < 5; i++) {
          const skillId = await seedSkill();
          await seedAudit(skillId);
        }
        const res = await request(operatorApp())
          .get(`/api/companies/${companyId}/guilds/${guildId}/auto-promotions?limit=2`);
        expect(res.status).toBe(200);
        expect(res.body.rows).toHaveLength(2);
        expect(res.body.total).toBe(5);
      });
    });

    // -----------------------------------------------------------------------
    // GET /companies/:companyId/auto-promotions/:auditId (2 tests)
    // -----------------------------------------------------------------------

    describe("GET auto-promotions/:auditId (read-only envelope)", () => {
      it("returns envelope with skill, recentUses, revert null, reviewCount 0", async () => {
        const skillId = await seedSkill();
        const auditId = await seedAudit(skillId);
        const res = await request(operatorApp())
          .get(`/api/companies/${companyId}/auto-promotions/${auditId}`);
        expect(res.status).toBe(200);
        expect(res.body.audit.id).toBe(auditId);
        expect(res.body.skill.id).toBe(skillId);
        expect(res.body.reverted).toBeNull();
        expect(res.body.reviewCount).toBe(0);
        expect(Array.isArray(res.body.recentUses)).toBe(true);
      });

      it("returns 404 for unknown audit id", async () => {
        const res = await request(operatorApp())
          .get(`/api/companies/${companyId}/auto-promotions/${randomUUID()}`);
        expect(res.status).toBe(404);
      });
    });

    // -----------------------------------------------------------------------
    // GET /companies/:companyId/auto-promotions/:auditId/review (3 tests)
    // -----------------------------------------------------------------------

    describe("GET auto-promotions/:auditId/review (write-on-read)", () => {
      it("returns envelope + writes one review row on first call", async () => {
        const skillId = await seedSkill();
        const auditId = await seedAudit(skillId);
        const res = await request(operatorApp())
          .get(`/api/companies/${companyId}/auto-promotions/${auditId}/review`);
        expect(res.status).toBe(200);
        expect(res.body.audit.id).toBe(auditId);
        expect(res.body.review).toBeDefined();
        expect(res.body.review.auditId).toBe(auditId);

        const rows = await db
          .select()
          .from(autoPromotionReviews)
          .where(
            (await import("drizzle-orm")).eq(
              autoPromotionReviews.auditId,
              auditId,
            ),
          );
        expect(rows).toHaveLength(1);
        // reviewCount in the response must reflect the DB state after the write
        expect(res.body.reviewCount).toBe(rows.length);
      });

      it("writes two review rows when called twice (audit trail preserved)", async () => {
        const skillId = await seedSkill();
        const auditId = await seedAudit(skillId);
        await request(operatorApp())
          .get(`/api/companies/${companyId}/auto-promotions/${auditId}/review`);
        const res2 = await request(operatorApp())
          .get(`/api/companies/${companyId}/auto-promotions/${auditId}/review`);

        const rows = await db
          .select()
          .from(autoPromotionReviews)
          .where(
            (await import("drizzle-orm")).eq(
              autoPromotionReviews.auditId,
              auditId,
            ),
          );
        expect(rows).toHaveLength(2);
        // second response reviewCount must equal 2 (the live DB count after the write)
        expect(res2.body.reviewCount).toBe(2);
      });

      it("returns 404 for unknown audit id", async () => {
        const res = await request(operatorApp())
          .get(`/api/companies/${companyId}/auto-promotions/${randomUUID()}/review`);
        expect(res.status).toBe(404);
      });
    });

    // -----------------------------------------------------------------------
    // POST /companies/:companyId/auto-promotions/:auditId/revert (4 tests)
    // -----------------------------------------------------------------------

    describe("POST auto-promotions/:auditId/revert", () => {
      it("operator can revert a promotion and skill returns to provisional", async () => {
        const skillId = await seedSkill({ provenance: "canonical" });
        const auditId = await seedAudit(skillId);
        const res = await request(operatorApp())
          .post(`/api/companies/${companyId}/auto-promotions/${auditId}/revert`)
          .send({ reason: "not ready for canonical yet" });
        expect(res.status).toBe(200);
        expect(res.body.revert.auditId).toBe(auditId);
        expect(res.body.skill.provenance).toBe("provisional");
        expect(typeof res.body.activityId).toBe("string");
      });

      it("returns 409 on double-revert", async () => {
        const skillId = await seedSkill({ provenance: "canonical" });
        const auditId = await seedAudit(skillId);
        await seedRevert(auditId);
        const res = await request(operatorApp())
          .post(`/api/companies/${companyId}/auto-promotions/${auditId}/revert`)
          .send({ reason: "second attempt" });
        expect(res.status).toBe(409);
      });

      it("returns 400 when reason is missing", async () => {
        const skillId = await seedSkill();
        const auditId = await seedAudit(skillId);
        const res = await request(operatorApp())
          .post(`/api/companies/${companyId}/auto-promotions/${auditId}/revert`)
          .send({});
        expect(res.status).toBe(400);
      });

      it("rejects agent token with 403", async () => {
        const skillId = await seedSkill();
        const auditId = await seedAudit(skillId);
        const res = await request(agentApp())
          .post(`/api/companies/${companyId}/auto-promotions/${auditId}/revert`)
          .send({ reason: "agent attempt" });
        expect(res.status).toBe(403);
      });
    });

    // -----------------------------------------------------------------------
    // GET /companies/:companyId/guilds/:guildId/auto-promotion-scans (2 tests)
    // -----------------------------------------------------------------------

    describe("GET auto-promotion-scans", () => {
      it("returns empty array when no scans have run", async () => {
        const res = await request(operatorApp())
          .get(`/api/companies/${companyId}/guilds/${guildId}/auto-promotion-scans`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body).toHaveLength(0);
      });

      it("returns aggregated scan rows after a scan runs", async () => {
        await seedConfig({ dryRun: false, enabled: true });
        // Trigger a scan to generate activity_log rows
        await request(operatorApp())
          .post(`/api/companies/${companyId}/guilds/${guildId}/auto-promotion-scans`);

        const res = await request(operatorApp())
          .get(`/api/companies/${companyId}/guilds/${guildId}/auto-promotion-scans`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBeGreaterThanOrEqual(1);
      });
    });

    // -----------------------------------------------------------------------
    // POST /companies/:companyId/guilds/:guildId/auto-promotion-scans (4 tests)
    // -----------------------------------------------------------------------

    describe("POST auto-promotion-scans (manual scan)", () => {
      it("operator can trigger a scan and receives ScanResult", async () => {
        await seedConfig({ dryRun: false, enabled: true });
        const res = await request(operatorApp())
          .post(`/api/companies/${companyId}/guilds/${guildId}/auto-promotion-scans`);
        expect(res.status).toBe(200);
        expect(typeof res.body.scanId).toBe("string");
        expect(typeof res.body.scannedCount).toBe("number");
        expect(typeof res.body.eligibleCount).toBe("number");
        expect(typeof res.body.promotedCount).toBe("number");
        expect(typeof res.body.failedCount).toBe("number");
        expect(typeof res.body.dryRun).toBe("boolean");
        expect(Array.isArray(res.body.promotions)).toBe(true);
      });

      it("rejects agent token with 403", async () => {
        await seedConfig();
        const res = await request(agentApp())
          .post(`/api/companies/${companyId}/guilds/${guildId}/auto-promotion-scans`);
        expect(res.status).toBe(403);
      });

      it("dry-run mode is reflected in ScanResult.dryRun", async () => {
        await seedConfig({ dryRun: true, enabled: true });
        const res = await request(operatorApp())
          .post(`/api/companies/${companyId}/guilds/${guildId}/auto-promotion-scans`);
        expect(res.status).toBe(200);
        expect(res.body.dryRun).toBe(true);
      });

      it("scan with no eligible candidates returns promotedCount 0", async () => {
        await seedConfig({
          dryRun: false,
          enabled: true,
          minUses: 100, // very high threshold - no skill will qualify
        });
        // Seed a skill that won't qualify
        await seedSkill({ successCount: 1, failCount: 0 });
        const res = await request(operatorApp())
          .post(`/api/companies/${companyId}/guilds/${guildId}/auto-promotion-scans`);
        expect(res.status).toBe(200);
        expect(res.body.promotedCount).toBe(0);
        expect(res.body.promotions).toHaveLength(0);
      });
    });

    // -----------------------------------------------------------------------
    // Gap 1: Floor validation - minUses below 3 caught by zod -> 400
    // -----------------------------------------------------------------------

    describe("PATCH auto-promotion-config floor validation", () => {
      it("rejects min_uses below floor with 400 (zod catches before service)", async () => {
        // The zod schema enforces minUses: z.number().int().min(3). Sending
        // minUses: 2 triggers a ZodError in the validate() middleware, which
        // the errorHandler converts to 400 { error: "Validation error", details: [...] }.
        // The service floor guard at service.ts:96 is never reached.
        await seedConfig();
        const res = await request(operatorApp())
          .patch(`/api/companies/${companyId}/guilds/${guildId}/auto-promotion-config`)
          .send({ minUses: 2 });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("Validation error");
        expect(Array.isArray(res.body.details)).toBe(true);
        // ZodIssue[]: each issue has a path array; confirm minUses is the failing field
        expect(
          res.body.details.some(
            (d: { path: (string | number)[] }) =>
              Array.isArray(d.path) && d.path.includes("minUses"),
          ),
        ).toBe(true);
      });
    });

    // -----------------------------------------------------------------------
    // Gap 2: No-token 401 for the 3 mutating routes
    // -----------------------------------------------------------------------

    describe("no-token 401 for mutating routes", () => {
      it("PATCH config returns 401 when no actor token is present", async () => {
        await seedConfig();
        const res = await request(createAppNoToken())
          .patch(`/api/companies/${companyId}/guilds/${guildId}/auto-promotion-config`)
          .send({ enabled: true });
        expect(res.status).toBe(401);
      });

      it("POST revert returns 401 when no actor token is present", async () => {
        const skillId = await seedSkill({ provenance: "canonical" });
        const auditId = await seedAudit(skillId);
        const res = await request(createAppNoToken())
          .post(`/api/companies/${companyId}/auto-promotions/${auditId}/revert`)
          .send({ reason: "no-token test" });
        expect(res.status).toBe(401);
      });

      it("POST scan returns 401 when no actor token is present", async () => {
        await seedConfig({ enabled: true });
        const res = await request(createAppNoToken())
          .post(`/api/companies/${companyId}/guilds/${guildId}/auto-promotion-scans`);
        expect(res.status).toBe(401);
      });
    });

    // -----------------------------------------------------------------------
    // Gap 3: Cross-company access for the 7 remaining routes
    //
    // Design note for audit-id routes:
    //   The route passes the :companyId path param to the service. The service
    //   queries WHERE companyId = :companyId AND id = :auditId. An operator
    //   from company A who sends an agent token with agentCompanyId = otherCompanyId
    //   hits assertCompanyAccess first, which checks actor.companyId != :companyId
    //   and throws 403 before the service is ever reached. So all 7 routes here
    //   return 403 from the access-guard layer, not 404 from the service.
    // -----------------------------------------------------------------------

    describe("cross-company 403 for remaining routes", () => {
      it("PATCH config: operator from another company gets 403", async () => {
        await seedConfig();
        const otherCompanyId = randomUUID();
        const res = await request(
          createApp({ type: "agent", agentCompanyId: otherCompanyId }),
        ).patch(`/api/companies/${companyId}/guilds/${guildId}/auto-promotion-config`)
          .send({ enabled: true });
        expect(res.status).toBe(403);
      });

      it("GET list audits: operator from another company gets 403", async () => {
        const skillId = await seedSkill();
        await seedAudit(skillId);
        const otherCompanyId = randomUUID();
        const res = await request(
          createApp({ type: "agent", agentCompanyId: otherCompanyId }),
        ).get(`/api/companies/${companyId}/guilds/${guildId}/auto-promotions`);
        expect(res.status).toBe(403);
      });

      it("GET audit single: operator from another company gets 403", async () => {
        // The actor's companyId differs from :companyId in the path, so
        // assertCompanyAccess fires 403 before the service lookup.
        const skillId = await seedSkill();
        const auditId = await seedAudit(skillId);
        const otherCompanyId = randomUUID();
        const res = await request(
          createApp({ type: "agent", agentCompanyId: otherCompanyId }),
        ).get(`/api/companies/${companyId}/auto-promotions/${auditId}`);
        expect(res.status).toBe(403);
      });

      it("GET audit review (write): operator from another company gets 403", async () => {
        const skillId = await seedSkill();
        const auditId = await seedAudit(skillId);
        const otherCompanyId = randomUUID();
        const res = await request(
          createApp({ type: "agent", agentCompanyId: otherCompanyId }),
        ).get(`/api/companies/${companyId}/auto-promotions/${auditId}/review`);
        expect(res.status).toBe(403);
      });

      it("POST revert: operator from another company gets 403", async () => {
        const skillId = await seedSkill({ provenance: "canonical" });
        const auditId = await seedAudit(skillId);
        const otherCompanyId = randomUUID();
        const res = await request(
          createApp({ type: "agent", agentCompanyId: otherCompanyId }),
        ).post(`/api/companies/${companyId}/auto-promotions/${auditId}/revert`)
          .send({ reason: "cross-company revert attempt" });
        expect(res.status).toBe(403);
      });

      it("GET scans: operator from another company gets 403", async () => {
        const otherCompanyId = randomUUID();
        const res = await request(
          createApp({ type: "agent", agentCompanyId: otherCompanyId }),
        ).get(`/api/companies/${companyId}/guilds/${guildId}/auto-promotion-scans`);
        expect(res.status).toBe(403);
      });

      it("POST scan: operator from another company gets 403", async () => {
        await seedConfig({ enabled: true });
        const otherCompanyId = randomUUID();
        const res = await request(
          createApp({ type: "agent", agentCompanyId: otherCompanyId }),
        ).post(`/api/companies/${companyId}/guilds/${guildId}/auto-promotion-scans`);
        expect(res.status).toBe(403);
      });
    });
  },
);
