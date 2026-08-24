import { describe, expect, it } from "vitest";

describe("import test", () => {
  it("can import billing", async () => {
    try {
      const mod = await import("../services/billing.js");
      expect(mod).toBeDefined();
      expect(mod.billingService).toBeDefined();
    } catch (e) {
      console.error("Import error:", e);
      throw e;
    }
  });
});
