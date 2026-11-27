import { describe, expect, it } from "vitest";
import { appsRouteHasRail } from "./apps-rail";

describe("appsRouteHasRail", () => {
  it("gives the marketplace pages no rail", () => {
    for (const segments of [["apps"], ["apps", "review"], ["apps", "plugin", "github"], ["apps", "connect"]]) {
      expect(appsRouteHasRail(segments, true)).toBe(false);
    }
  });

  it("keeps the chat setup and detail rail", () => {
    expect(appsRouteHasRail(["apps", "chat", "connect"], false)).toBe(true);
    expect(appsRouteHasRail(["apps", "chat", "endpoint-1", "settings"], false)).toBe(true);
    expect(appsRouteHasRail(["apps", "chat"], false)).toBe(false);
  });

  it("shows the developer rail only while a developer tab is on", () => {
    for (const segments of [["apps", "advanced", "smoke-lab"], ["apps", "gateways"], ["tools"]]) {
      expect(appsRouteHasRail(segments, true)).toBe(true);
      expect(appsRouteHasRail(segments, false)).toBe(false);
    }
  });

  it("ignores routes outside the Apps area", () => {
    expect(appsRouteHasRail(["skills"], true)).toBe(false);
  });
});
