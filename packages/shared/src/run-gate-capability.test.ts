import { describe, expect, it } from "vitest";
import { PLUGIN_CAPABILITIES } from "./constants.js";

describe("run.gate capability constant", () => {
  it("includes run.gate in PLUGIN_CAPABILITIES", () => {
    expect(PLUGIN_CAPABILITIES).toContain("run.gate");
  });
});
