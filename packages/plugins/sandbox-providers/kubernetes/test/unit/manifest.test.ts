import { describe, expect, it } from "vitest";
import manifest from "../../src/manifest.js";

describe("manifest", () => {
  it("declares reusable leases so the server may keep one pod per conversation (opt-in via reuseLease)", () => {
    const driver = manifest.environmentDrivers?.[0] as { sandboxCapabilities?: Record<string, boolean> };
    expect(driver.sandboxCapabilities?.reusableLeases).toBe(true);
  });
});
