import { describe, expect, it } from "vitest";
import { getCLIAdapter } from "../adapters/index.js";

describe("getCLIAdapter", () => {
  it("loads process adapter without requiring unrelated adapter packages", async () => {
    const adapter = await getCLIAdapter("process");
    expect(adapter.type).toBe("process");
  });

  it("falls back to process adapter for unknown adapter types", async () => {
    const adapter = await getCLIAdapter("does_not_exist");
    expect(adapter.type).toBe("process");
  });
});
