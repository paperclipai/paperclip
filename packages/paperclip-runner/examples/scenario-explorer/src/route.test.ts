import { describe, expect, it } from "vitest";

import {
  activeFilterChips,
  EMPTY_FILTERS,
  hasActiveFilters,
  parseCapabilityRoute,
  serializeCapabilityRoute,
} from "./route.js";

describe("capability explorer routes", () => {
  it("parses the explorer home", () => {
    const route = parseCapabilityRoute("#/");
    expect(route.caseId).toBeNull();
    expect(route.run).toBeNull();
    expect(route.view).toBe("transcript");
    expect(hasActiveFilters(route.filters)).toBe(false);
  });

  it("parses a selected, unrun scenario", () => {
    expect(parseCapabilityRoute("#/case/hb-scoped-wake-01")).toMatchObject({
      caseId: "hb-scoped-wake-01",
      run: null,
      view: "transcript",
    });
  });

  it("parses an auto-run screenshot route with an inspector view", () => {
    expect(parseCapabilityRoute("#/case/ap-mcp-gate-01?run=fake&view=authorization")).toMatchObject({
      caseId: "ap-mcp-gate-01",
      run: "fake",
      view: "authorization",
    });
  });

  it("parses a filtered picker route", () => {
    const route = parseCapabilityRoute("#/?group=ix&disposition=always_agent_tool&parity=pass&q=checkbox");
    expect(route.caseId).toBeNull();
    expect(route.filters).toEqual({
      group: "ix",
      disposition: "always_agent_tool",
      role: null,
      claim: null,
      parity: "pass",
      query: "checkbox",
    });
    expect(activeFilterChips(route.filters).map((chip) => chip.key)).toEqual([
      "group",
      "disposition",
      "parity",
      "query",
    ]);
  });

  it("rejects an unknown inspector view instead of rendering a dead tab", () => {
    expect(parseCapabilityRoute("#/case/x?view=nonsense").view).toBe("transcript");
    expect(parseCapabilityRoute("#/case/x?run=live").run).toBeNull();
  });

  it("round-trips every documented route shape", () => {
    for (const hash of [
      "#/",
      "#/case/hb-scoped-wake-01",
      "#/case/hb-scoped-wake-01?run=fake",
      "#/case/ap-mcp-gate-01?run=fake&view=authorization",
      "#/?group=ix&disposition=always_agent_tool&parity=pass",
    ]) {
      expect(serializeCapabilityRoute(parseCapabilityRoute(hash))).toBe(hash);
    }
  });

  it("drops picker filters from a case route so a deep link stays stable", () => {
    const route = parseCapabilityRoute("#/?group=ix");
    expect(serializeCapabilityRoute({ ...route, caseId: "ix-checkbox-01" })).toBe("#/case/ix-checkbox-01");
  });

  it("treats empty filters as no filters", () => {
    expect(activeFilterChips(EMPTY_FILTERS)).toEqual([]);
  });
});
