import { describe, expect, it } from "vitest";
import { pluginSdkPreparationArgs } from "../../../scripts/dev-runner-plugin-sdk.mjs";

describe("dev runner plugin SDK preparation", () => {
  it("uses the incremental build dependency check instead of rewriting current outputs", () => {
    expect(pluginSdkPreparationArgs()).toEqual([
      "--filter",
      "@paperclipai/plugin-sdk",
      "ensure-build-deps",
    ]);
  });
});
