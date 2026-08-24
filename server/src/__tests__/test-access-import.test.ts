import { describe, expect, it } from "vitest";

describe("import test", () => {
  it("can import access routes", async () => {
    try {
      const mod = await import("../routes/access.js");
      expect(mod).toBeDefined();
      expect(mod.createInviteToken).toBeDefined();
    } catch (e) {
      console.error("Import error:", e);
      throw e;
    }
  });
});
