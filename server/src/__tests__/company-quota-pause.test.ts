import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CompanyPausedError,
  applyCompanyQuotaPause,
  assertCompanyNotPaused,
  clearCompanyQuotaPause,
} from "../services/company-quota-pause.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createCompany(db: ReturnType<typeof createDb>) {
  return db
    .insert(companies)
    .values({
      name: `Quota Pause ${randomUUID()}`,
      issuePrefix: `QP${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function readPauseFields(db: ReturnType<typeof createDb>, companyId: string) {
  return db
    .select({
      pauseReason: companies.pauseReason,
      pausedAt: companies.pausedAt,
      pausedUntil: companies.pausedUntil,
      pausedReason: companies.pausedReason,
      pausedCanaryAt: companies.pausedCanaryAt,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0]!);
}

describeEmbeddedPostgres("company quota pause", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-quota-pause-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  describe("assertCompanyNotPaused", () => {
    it("passes when paused_until is NULL (company never auto-paused)", async () => {
      const company = await createCompany(db);
      await expect(assertCompanyNotPaused(db, company.id)).resolves.toBeUndefined();
    });

    it("passes when paused_until has already expired", async () => {
      const company = await createCompany(db);
      const past = new Date(Date.now() - 60_000);
      await db
        .update(companies)
        .set({ pausedUntil: past, pausedReason: "claude_quota_exhausted:expired-run" })
        .where(eq(companies.id, company.id));
      await expect(assertCompanyNotPaused(db, company.id)).resolves.toBeUndefined();
    });

    it("throws CompanyPausedError with the resolved paused_until when window is active", async () => {
      const company = await createCompany(db);
      const future = new Date(Date.now() + 5 * 60_000);
      await db
        .update(companies)
        .set({ pausedUntil: future, pausedReason: "claude_quota_exhausted:active-run" })
        .where(eq(companies.id, company.id));
      await expect(assertCompanyNotPaused(db, company.id)).rejects.toBeInstanceOf(CompanyPausedError);
      try {
        await assertCompanyNotPaused(db, company.id);
      } catch (err) {
        const paused = err as CompanyPausedError;
        expect(paused.status).toBe(503);
        expect(paused.pausedUntil.getTime()).toBe(future.getTime());
        expect(paused.pausedReason).toBe("claude_quota_exhausted:active-run");
      }
    });

    it("is silent for companies with manual pause_reason set but no paused_until", async () => {
      const company = await createCompany(db);
      // Simulate a manual/budget pause from server/src/services/budgets.ts — only the
      // legacy fields are touched. The quota-pause helper should not see this as a
      // quota-driven pause.
      await db
        .update(companies)
        .set({ pauseReason: "budget", pausedAt: new Date() })
        .where(eq(companies.id, company.id));
      await expect(assertCompanyNotPaused(db, company.id)).resolves.toBeUndefined();
    });
  });

  describe("applyCompanyQuotaPause", () => {
    it("writes paused_until = resetAt + 2 minute grace and paused_reason with the run id", async () => {
      const company = await createCompany(db);
      const resetAt = new Date(Date.UTC(2026, 4, 12, 14, 0, 0));
      const runId = "run-aaaaaa";

      const result = await applyCompanyQuotaPause({ db, companyId: company.id, resetAt, runId });

      expect(result.applied).toBe(true);
      expect(result.pausedUntil.getTime()).toBe(resetAt.getTime() + 2 * 60 * 1000);
      expect(result.pausedReason).toBe("claude_quota_exhausted:run-aaaaaa");

      const row = await readPauseFields(db, company.id);
      expect(row.pausedUntil?.getTime()).toBe(resetAt.getTime() + 2 * 60 * 1000);
      expect(row.pausedReason).toBe("claude_quota_exhausted:run-aaaaaa");
    });

    it("never SHORTENS an existing longer pause window (concurrent quota signals)", async () => {
      const company = await createCompany(db);
      const longResetAt = new Date(Date.now() + 30 * 60_000);
      await applyCompanyQuotaPause({ db, companyId: company.id, resetAt: longResetAt, runId: "first" });
      const before = await readPauseFields(db, company.id);

      const shortResetAt = new Date(Date.now() + 60_000);
      const result = await applyCompanyQuotaPause({
        db,
        companyId: company.id,
        resetAt: shortResetAt,
        runId: "second",
      });

      expect(result.applied).toBe(false);
      const after = await readPauseFields(db, company.id);
      expect(after.pausedUntil?.getTime()).toBe(before.pausedUntil?.getTime());
      expect(after.pausedReason).toBe("claude_quota_exhausted:first");
    });

    it("extends a SHORTER existing pause window with a longer one", async () => {
      const company = await createCompany(db);
      const shortResetAt = new Date(Date.now() + 60_000);
      await applyCompanyQuotaPause({ db, companyId: company.id, resetAt: shortResetAt, runId: "first" });

      const longResetAt = new Date(Date.now() + 30 * 60_000);
      const result = await applyCompanyQuotaPause({
        db,
        companyId: company.id,
        resetAt: longResetAt,
        runId: "second",
      });

      expect(result.applied).toBe(true);
      const after = await readPauseFields(db, company.id);
      expect(after.pausedUntil?.getTime()).toBe(longResetAt.getTime() + 2 * 60 * 1000);
      expect(after.pausedReason).toBe("claude_quota_exhausted:second");
    });

    it("honors a custom grace window", async () => {
      const company = await createCompany(db);
      const resetAt = new Date(Date.now() + 60_000);
      const result = await applyCompanyQuotaPause({
        db,
        companyId: company.id,
        resetAt,
        runId: "run-grace",
        graceMs: 10 * 60 * 1000,
      });
      expect(result.pausedUntil.getTime()).toBe(resetAt.getTime() + 10 * 60 * 1000);
    });
  });

  describe("clearCompanyQuotaPause", () => {
    it("nulls paused_until / paused_reason / paused_canary_at and leaves manual fields alone", async () => {
      const company = await createCompany(db);
      const manualPausedAt = new Date(Date.now() - 3600_000);
      const canaryAt = new Date(Date.now() - 1000);
      await db
        .update(companies)
        .set({
          pauseReason: "manual",
          pausedAt: manualPausedAt,
          pausedUntil: new Date(Date.now() + 60_000),
          pausedReason: "claude_quota_exhausted:run-x",
          pausedCanaryAt: canaryAt,
        })
        .where(eq(companies.id, company.id));

      await clearCompanyQuotaPause(db, company.id);

      const row = await readPauseFields(db, company.id);
      expect(row.pausedUntil).toBeNull();
      expect(row.pausedReason).toBeNull();
      expect(row.pausedCanaryAt).toBeNull();
      // Manual / budget pause fields owned by services/budgets.ts must be untouched.
      expect(row.pauseReason).toBe("manual");
      expect(row.pausedAt?.getTime()).toBe(manualPausedAt.getTime());
    });
  });
});
