import { describe, expect, it } from "vitest";
import { defaultCreateValues } from "./agent-config-defaults";

describe("defaultCreateValues", () => {
  it("defaults hybrid/local token budgeting fields for new forms", () => {
    expect(defaultCreateValues.maxTurnsPerRun).toBe(300);
    expect(defaultCreateValues.maxTotalTokens).toBe(300000);
  });
});
