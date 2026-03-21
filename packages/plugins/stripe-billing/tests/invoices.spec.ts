import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInvoicesService } from "../src/services/invoices.js";

describe("InvoicesService", () => {
  let mockEntities: any;
  let invoices: ReturnType<typeof createInvoicesService>;

  beforeEach(() => {
    mockEntities = {
      upsert: vi.fn().mockResolvedValue({ id: "ent_1" }),
      list: vi.fn().mockResolvedValue([]),
    };
    invoices = createInvoicesService(mockEntities);
  });

  describe("upsert", () => {
    it("creates an invoice entity", async () => {
      await invoices.upsert("in_123", {
        billingAccountExternalId: "cus_123",
        amountCents: 5000,
        status: "open",
        paidAt: null,
        periodStart: "2026-03-01T00:00:00Z",
        periodEnd: "2026-03-31T00:00:00Z",
        lineItems: [],
      });

      expect(mockEntities.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: "stripe-invoice",
          externalId: "in_123",
          status: "open",
        }),
      );
    });
  });

  describe("listForAccount", () => {
    it("filters invoices by billing account external ID", async () => {
      mockEntities.list.mockResolvedValue([
        { id: "e1", data: { billingAccountExternalId: "cus_123", amountCents: 100 } },
        { id: "e2", data: { billingAccountExternalId: "cus_456", amountCents: 200 } },
      ]);

      const result = await invoices.listForAccount("cus_123");
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe("e1");
    });
  });
});
