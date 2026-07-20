import { describe, expect, it } from "vitest";
import { isExpectedClient404 } from "./http-log-policy.js";

describe("isExpectedClient404", () => {
  it("matches issue-mention prefetch 404s (with and without the /api prefix)", () => {
    expect(isExpectedClient404("GET", "/api/issues/FR-005", 404)).toBe(true);
    expect(isExpectedClient404("GET", "/issues/BPS-39", 404)).toBe(true);
    expect(isExpectedClient404("GET", "/api/issues/BACKUPS-2026", 404)).toBe(true);
  });

  it("matches heartbeat-log poll 404s and strips the query string", () => {
    expect(isExpectedClient404("GET", "/api/heartbeat-runs/ca5d23fc-c15b/log", 404)).toBe(true);
    expect(
      isExpectedClient404("GET", "/api/heartbeat-runs/ca5d23fc-c15b/log?offset=0&limitBytes=256000", 404),
    ).toBe(true);
  });

  it("leaves every other 404 at warn (returns false)", () => {
    // real sub-path, not the bare mention/log shape
    expect(isExpectedClient404("GET", "/api/issues/FR-005/comments", 404)).toBe(false);
    expect(isExpectedClient404("GET", "/api/heartbeat-runs/ca5d23fc-c15b", 404)).toBe(false);
    // not a KEY-NUMBER mention shape
    expect(isExpectedClient404("GET", "/api/issues/lowercase", 404)).toBe(false);
    // unrelated route
    expect(isExpectedClient404("GET", "/api/companies/abc/issues", 404)).toBe(false);
  });

  it("only downgrades GET 404s — other methods and statuses stay at warn", () => {
    expect(isExpectedClient404("POST", "/api/issues/FR-005", 404)).toBe(false);
    expect(isExpectedClient404("DELETE", "/api/issues/FR-005", 404)).toBe(false);
    expect(isExpectedClient404("GET", "/api/issues/FR-005", 200)).toBe(false);
    expect(isExpectedClient404("GET", "/api/issues/FR-005", 500)).toBe(false);
  });

  it("is defensive about missing method/url", () => {
    expect(isExpectedClient404(undefined, "/api/issues/FR-005", 404)).toBe(false);
    expect(isExpectedClient404("GET", undefined, 404)).toBe(false);
  });
});
