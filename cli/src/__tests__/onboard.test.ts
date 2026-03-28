import { describe, expect, it } from "vitest";
import { resolveOpenOnListenValueForOnboardRun } from "../commands/onboard.js";

describe("resolveOpenOnListenValueForOnboardRun", () => {
  it("defaults to opening the browser when no explicit preference is set", () => {
    expect(resolveOpenOnListenValueForOnboardRun(undefined)).toBe("true");
  });

  it("preserves an explicit false preference from the caller environment", () => {
    expect(resolveOpenOnListenValueForOnboardRun("false")).toBe("false");
  });
});
