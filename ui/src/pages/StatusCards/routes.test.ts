import { describe, expect, it } from "vitest";

import { isStatusCardTab, statusCardPath } from "./routes";

describe("status card routes", () => {
  it("builds a URL for every card tab", () => {
    expect(statusCardPath("card-1", "summary")).toBe("/status/card-1/summary");
    expect(statusCardPath("card-1", "settings")).toBe("/status/card-1/settings");
    expect(statusCardPath("card-1", "watched")).toBe("/status/card-1/watched");
    expect(statusCardPath("card-1", "history")).toBe("/status/card-1/history");
  });

  it("rejects unknown tab path segments", () => {
    expect(isStatusCardTab("history")).toBe(true);
    expect(isStatusCardTab("unknown")).toBe(false);
    expect(isStatusCardTab(undefined)).toBe(false);
  });
});
