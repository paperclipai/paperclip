import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { userPreferencesService } from "./user-preferences.js";
import type { SupportedCurrency } from "@paperclipai/shared";

function createDbStub(preferences: Map<string, { preferredCurrency: SupportedCurrency }> = new Map()) {
  let lastUserId: string | undefined;

  return {
    query: {
      userPreferences: {
        findFirst: vi.fn(async () => {
          const pref = preferences.get(lastUserId!);
          return pref ? { preferredCurrency: pref.preferredCurrency } : null;
        }),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn((values: { userId: string; preferredCurrency: SupportedCurrency }) => ({
        onConflictDoUpdate: vi.fn(() => ({
          returning: vi.fn(async () => {
            preferences.set(values.userId, { preferredCurrency: values.preferredCurrency });
            return [{ preferredCurrency: values.preferredCurrency }];
          }),
        })),
      })),
    })),
    _testHelpers: {
      setLastUserId: (userId: string) => { lastUserId = userId; },
    },
  } as unknown as Db & { _testHelpers: { setLastUserId: (userId: string) => void } };
}

describe("userPreferencesService", () => {
  let db: ReturnType<typeof createDbStub>;
  let service: ReturnType<typeof userPreferencesService>;

  beforeEach(() => {
    db = createDbStub();
    service = userPreferencesService(db);
  });

  describe("getPreferences", () => {
    it("returns default USD when no preferences exist", async () => {
      db._testHelpers.setLastUserId("user-1");
      const result = await service.getPreferences("user-1");
      expect(result.preferredCurrency).toBe("USD");
    });

    it("returns stored preferred currency", async () => {
      const dbWithPrefs = createDbStub(
        new Map([["user-1", { preferredCurrency: "EUR" }]])
      );
      const svc = userPreferencesService(dbWithPrefs);
      dbWithPrefs._testHelpers.setLastUserId("user-1");
      const result = await svc.getPreferences("user-1");
      expect(result.preferredCurrency).toBe("EUR");
    });

    it("returns USD for unknown user", async () => {
      db._testHelpers.setLastUserId("unknown-user");
      const result = await service.getPreferences("unknown-user");
      expect(result.preferredCurrency).toBe("USD");
    });
  });

  describe("upsertPreferences", () => {
    it("inserts new preferences with valid currency", async () => {
      db._testHelpers.setLastUserId("user-1");
      const result = await service.upsertPreferences("user-1", "EUR");
      expect(result.preferredCurrency).toBe("EUR");
    });

    it("accepts all supported currencies", async () => {
      const currencies: SupportedCurrency[] = ["USD", "EUR", "UYU", "ARS"];
      for (const currency of currencies) {
        db._testHelpers.setLastUserId(`user-${currency}`);
        const result = await service.upsertPreferences(`user-${currency}`, currency);
        expect(result.preferredCurrency).toBe(currency);
      }
    });

    it("updates existing preferences", async () => {
      const dbWithPrefs = createDbStub(
        new Map([["user-1", { preferredCurrency: "USD" }]])
      );
      const svc = userPreferencesService(dbWithPrefs);
      dbWithPrefs._testHelpers.setLastUserId("user-1");

      const result = await svc.upsertPreferences("user-1", "ARS");
      expect(result.preferredCurrency).toBe("ARS");
    });
  });
});