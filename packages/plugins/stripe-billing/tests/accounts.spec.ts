import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAccountsService } from "../src/services/accounts.js";
import { ENTITY_TYPES, STATE_KEYS, BILLING_NAMESPACE } from "../src/constants.js";

describe("AccountsService", () => {
  let mockEntities: any;
  let mockState: any;
  let accounts: ReturnType<typeof createAccountsService>;

  beforeEach(() => {
    mockEntities = {
      upsert: vi.fn().mockResolvedValue({ id: "ent_1" }),
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
    };
    mockState = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    };
    accounts = createAccountsService(mockEntities, mockState);
  });

  describe("create", () => {
    it("creates a billing account entity", async () => {
      await accounts.create("cus_123", {
        name: "Test Co",
        email: "test@test.com",
        stripeSubscriptionId: "sub_123",
        status: "active",
        markupPercent: 30,
        modelMarkupOverrides: {},
        companyIds: ["comp_1"],
      });

      expect(mockEntities.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: ENTITY_TYPES.billingAccount,
          externalId: "cus_123",
          scopeKind: "instance",
        }),
      );
    });
  });

  describe("findByCompanyId", () => {
    it("looks up billing account ID from company state then fetches entity", async () => {
      mockState.get.mockResolvedValue("cus_123");
      mockEntities.list.mockResolvedValue([{
        id: "ent_1",
        externalId: "cus_123",
        data: { name: "Test Co", companyIds: ["comp_1"], status: "active" },
      }]);

      const result = await accounts.findByCompanyId("comp_1");
      expect(result).toBeDefined();
      expect(result!.externalId).toBe("cus_123");
    });

    it("returns null when company has no billing account", async () => {
      mockState.get.mockResolvedValue(null);
      const result = await accounts.findByCompanyId("comp_1");
      expect(result).toBeNull();
    });
  });

  describe("linkCompany", () => {
    it("sets company billing state keys", async () => {
      await accounts.linkCompany("comp_1", "ba_ent_1", "cus_123");

      expect(mockState.set).toHaveBeenCalledWith(
        expect.objectContaining({
          scopeKind: "company",
          scopeId: "comp_1",
          namespace: BILLING_NAMESPACE,
          stateKey: STATE_KEYS.billingAccountId,
        }),
        "ba_ent_1",
      );
    });
  });
});
