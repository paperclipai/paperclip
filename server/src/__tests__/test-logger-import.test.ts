import { describe, expect, it } from "vitest";

describe("import test", () => {
  it("can import logger", async () => {
    try {
      const mod = await import("../middleware/logger.js");
      expect(mod).toBeDefined();
      expect(mod.logger).toBeDefined();
    } catch (e) {
      console.error("Import error:", e);
      throw e;
    }
  });
});
