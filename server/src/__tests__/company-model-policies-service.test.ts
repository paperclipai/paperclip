import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModelPolicyCacheForTests } from "../services/model-policy-config.ts";
import { companyModelPolicyService } from "../services/company-model-policies.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_RULE = { when: { issuePriority: ["high"] }, modelProfile: "deep" as const };
const VALID_RULES = [VALID_RULE];

/**
 * Build a minimal fake Drizzle db whose select().from().where().limit()
 * chain resolves to `rows`, and whose insert/update chains are vi.fn() spies.
 */
function buildFakeDb(rows: unknown[]) {
  const selectSpy = vi.fn();
  const insertSpy = vi.fn();
  const updateSpy = vi.fn();

  // select chain: select().from().where().limit() → rows
  const limitFn = vi.fn().mockResolvedValue(rows);
  const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  selectSpy.mockReturnValue({ from: fromFn });

  // insert chain: insert().values() → void
  const valuesFn = vi.fn().mockResolvedValue(undefined);
  insertSpy.mockReturnValue({ values: valuesFn });

  // update chain: update().set().where() → void
  const updateWhereFn = vi.fn().mockResolvedValue(undefined);
  const setFn = vi.fn().mockReturnValue({ where: updateWhereFn });
  updateSpy.mockReturnValue({ set: setFn });

  const db = {
    select: selectSpy,
    insert: insertSpy,
    update: updateSpy,
  };

  return { db, selectSpy, insertSpy, updateSpy, limitFn };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("companyModelPolicyService", () => {
  afterEach(() => {
    // Always reset env-var cache and clean the env var after each test.
    delete process.env.PAPERCLIP_MODEL_POLICIES;
    resetModelPolicyCacheForTests();
  });

  describe("getCompanyPolicy", () => {
    it("returns [] when db has no row and no env override", async () => {
      const { db } = buildFakeDb([]);
      const svc = companyModelPolicyService(db as never);
      const result = await svc.getCompanyPolicy("company-x");
      expect(result).toEqual([]);
    });

    it("returns parsed rules when db row exists", async () => {
      const { db } = buildFakeDb([{ rules: VALID_RULES }]);
      const svc = companyModelPolicyService(db as never);
      const result = await svc.getCompanyPolicy("company-x");
      expect(result).toHaveLength(1);
      expect(result[0]?.modelProfile).toBe("deep");
    });

    it("resolves to [] (does not throw) when the stored rules value is corrupt", async () => {
      // Spec: "a corrupt stored value must not break dispatch."
      const { db } = buildFakeDb([{ rules: "CORRUPT" }]);
      const svc = companyModelPolicyService(db as never);

      const result = await svc.getCompanyPolicy("company-x");
      expect(result).toEqual([]);
    });

    it("caches: a second call within TTL does NOT re-query the db", async () => {
      const { db, selectSpy } = buildFakeDb([{ rules: VALID_RULES }]);
      const svc = companyModelPolicyService(db as never);

      const now = Date.now();
      await svc.getCompanyPolicy("company-x", now);
      await svc.getCompanyPolicy("company-x", now + 1_000); // well within 30s TTL

      // select() should have been called only once
      expect(selectSpy).toHaveBeenCalledTimes(1);
    });

    it("re-queries db after TTL expires", async () => {
      const { db, selectSpy } = buildFakeDb([{ rules: VALID_RULES }]);
      const svc = companyModelPolicyService(db as never);

      const now = Date.now();
      await svc.getCompanyPolicy("company-x", now);
      await svc.getCompanyPolicy("company-x", now + 31_000); // past 30s TTL

      expect(selectSpy).toHaveBeenCalledTimes(2);
    });

    it("re-queries db after setCompanyPolicy invalidates the cache", async () => {
      const { db, selectSpy, insertSpy } = buildFakeDb([]);
      const svc = companyModelPolicyService(db as never);

      const now = Date.now();
      await svc.getCompanyPolicy("company-x", now);
      await svc.setCompanyPolicy("company-x", VALID_RULES);
      await svc.getCompanyPolicy("company-x", now + 1_000); // would be within TTL without invalidation

      // 1st get + 1 check in setCompanyPolicy + 2nd get = 3 calls
      expect(selectSpy).toHaveBeenCalledTimes(3);
      // buildFakeDb([]) → no existing row → upsert took the insert path
      expect(insertSpy).toHaveBeenCalledTimes(1);
    });

    it("falls back to env var when db returns no row", async () => {
      const { db } = buildFakeDb([]);
      const svc = companyModelPolicyService(db as never);

      process.env.PAPERCLIP_MODEL_POLICIES = JSON.stringify({
        "company-env": VALID_RULES,
      });
      resetModelPolicyCacheForTests(); // force re-parse on next read

      const result = await svc.getCompanyPolicy("company-env");
      expect(result).toHaveLength(1);
      expect(result[0]?.modelProfile).toBe("deep");
    });

    it("returns [] for a company not in env var and not in db", async () => {
      const { db } = buildFakeDb([]);
      const svc = companyModelPolicyService(db as never);

      process.env.PAPERCLIP_MODEL_POLICIES = JSON.stringify({
        "other-company": VALID_RULES,
      });
      resetModelPolicyCacheForTests();

      const result = await svc.getCompanyPolicy("company-missing");
      expect(result).toEqual([]);
    });
  });

  describe("setCompanyPolicy", () => {
    it("calls insert when no existing row is found", async () => {
      const { db, insertSpy } = buildFakeDb([]); // select returns empty → no existing row
      const svc = companyModelPolicyService(db as never);

      await svc.setCompanyPolicy("company-x", VALID_RULES);

      expect(insertSpy).toHaveBeenCalledTimes(1);
    });

    it("calls update when an existing row is found", async () => {
      const { db, updateSpy } = buildFakeDb([{ id: "existing-id" }]); // select returns a row
      const svc = companyModelPolicyService(db as never);

      await svc.setCompanyPolicy("company-x", VALID_RULES);

      expect(updateSpy).toHaveBeenCalledTimes(1);
    });

    it("returns the validated rules", async () => {
      const { db } = buildFakeDb([]);
      const svc = companyModelPolicyService(db as never);

      const result = await svc.setCompanyPolicy("company-x", VALID_RULES);
      expect(result).toEqual(VALID_RULES);
    });

    it("throws on an invalid rule shape", async () => {
      const { db } = buildFakeDb([]);
      const svc = companyModelPolicyService(db as never);

      await expect(
        svc.setCompanyPolicy("company-x", [{ when: {}, modelProfile: "INVALID_PROFILE" }]),
      ).rejects.toThrow();
    });

    it("throws on non-array input", async () => {
      const { db } = buildFakeDb([]);
      const svc = companyModelPolicyService(db as never);

      await expect(svc.setCompanyPolicy("company-x", "not-an-array")).rejects.toThrow();
    });
  });
});
