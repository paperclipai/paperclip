import { describe, expect, it } from "vitest";
import { PLUGIN_CAPABILITIES } from "./constants.js";

describe("WF-1 plugin approvals capabilities", () => {
  it("includes approvals.create capability", () => {
    expect(PLUGIN_CAPABILITIES).toContain("approvals.create");
  });

  it("includes approvals.read capability", () => {
    expect(PLUGIN_CAPABILITIES).toContain("approvals.read");
  });
});
