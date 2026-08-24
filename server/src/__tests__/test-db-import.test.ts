import { describe, expect, it } from "vitest";

describe("import test", () => {
  it("can import from @paperclipai/db", async () => {
    const mod = await import("@paperclipai/db");
    expect(mod).toBeDefined();
  });
});
