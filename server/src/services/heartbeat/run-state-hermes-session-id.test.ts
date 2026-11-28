import { describe, expect, it } from "vitest";
import { isCanonicalSessionIdForAdapter } from "./run-state.js";

describe("isCanonicalSessionIdForAdapter for hermes_local", () => {
  it("accepts Hermes gateway session ids", () => {
    expect(isCanonicalSessionIdForAdapter("hermes_local", `local-${"b4".repeat(32)}`)).toBe(true);
  });

  it("still accepts legacy timestamp and uuid ids", () => {
    expect(isCanonicalSessionIdForAdapter("hermes_local", "20250101_120000_ab12cd")).toBe(true);
    expect(isCanonicalSessionIdForAdapter("hermes_local", "123e4567-e89b-12d3-a456-426614174000")).toBe(true);
  });

  it("rejects malformed local ids", () => {
    expect(isCanonicalSessionIdForAdapter("hermes_local", "local-abc")).toBe(false);
    expect(isCanonicalSessionIdForAdapter("hermes_local", `local-${"g".repeat(64)}`)).toBe(false);
    expect(isCanonicalSessionIdForAdapter("hermes_local", `local-${"a".repeat(64)}x`)).toBe(false);
  });
});
