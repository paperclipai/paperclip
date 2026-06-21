import { describe, expect, it } from "vitest";

import { nextWorkMode, titleForPendingWorkMode, workModeMetaList } from "./work-mode-meta";

describe("work mode metadata", () => {
  it("orders issue work modes as agent, planning, then ask", () => {
    expect(workModeMetaList(false).map((mode) => mode.value)).toEqual(["standard", "planning", "ask"]);
    expect(workModeMetaList(true).map((mode) => mode.shortLabel)).toEqual(["Agent", "Plan", "Ask"]);
  });

  it("cycles issue work modes as agent, planning, ask, then agent", () => {
    expect(nextWorkMode("standard", true)).toBe("planning");
    expect(nextWorkMode("planning", true)).toBe("ask");
    expect(nextWorkMode("ask", true)).toBe("standard");
  });

  it("matches standard mode tooltip copy to the active surface", () => {
    expect(titleForPendingWorkMode("standard", false)).toBe("Standard mode for this submission. Click to change.");
    expect(titleForPendingWorkMode("standard", true)).toBe("Agent mode for this submission. Click to change.");
  });
});
