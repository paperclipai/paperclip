import { describe, it, expect } from "vitest";
import manifest from "../../src/manifest.js";

const driver = manifest.environmentDrivers![0]!;

describe("kubernetes driver manifest", () => {
  it("declares reusable-lease support so the server can reach the resume path", () => {
    // paperclip-server gates environmentResumeLease on `=== true`; without the
    // declaration the plugin's onEnvironmentResumeLease is unreachable.
    expect(driver.supportsReusableLeases).toBe(true);
  });

  it("publishes reuseLease in the driver config schema", () => {
    const properties = (driver.configSchema as { properties: Record<string, unknown> }).properties;
    expect(properties.reuseLease).toEqual(
      expect.objectContaining({ type: "boolean", default: false }),
    );
  });
});
