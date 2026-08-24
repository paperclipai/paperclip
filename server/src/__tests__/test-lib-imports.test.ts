import { describe, expect, it } from "vitest";

describe("import test", () => {
  it("can import drizzle-orm", async () => {
    const mod = await import("drizzle-orm");
    expect(mod).toBeDefined();
  });

  it("can import express", async () => {
    const mod = await import("express");
    expect(mod).toBeDefined();
  });
});
