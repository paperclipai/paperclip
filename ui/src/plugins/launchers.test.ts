import { describe, expect, it } from "vitest";
import { readPluginLauncherBadgeValue } from "./launchers";

describe("readPluginLauncherBadgeValue", () => {
  it("reads nested positive numeric badge values", () => {
    expect(readPluginLauncherBadgeValue({ summary: { pending: 9 } }, "summary.pending")).toBe(9);
  });

  it("hides missing, invalid, and non-positive values", () => {
    expect(readPluginLauncherBadgeValue({}, "count")).toBe(0);
    expect(readPluginLauncherBadgeValue({ count: "bad" }, "count")).toBe(0);
    expect(readPluginLauncherBadgeValue({ count: -2 }, "count")).toBe(0);
  });
});
