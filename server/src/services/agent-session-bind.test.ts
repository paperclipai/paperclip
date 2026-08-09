import { describe, expect, it } from "vitest";
import { isSessionBoundRunIdFresh, SESSION_BOUND_RUN_ID_TTL_MS } from "./agent-session-bind.js";

describe("isSessionBoundRunIdFresh", () => {
  it("returns false when boundAt is null", () => {
    expect(isSessionBoundRunIdFresh(null)).toBe(false);
    expect(isSessionBoundRunIdFresh(undefined)).toBe(false);
  });

  it("returns true when boundAt is within the TTL", () => {
    const now = new Date("2026-08-09T12:00:00Z");
    const recent = new Date(now.getTime() - 30 * 60 * 1000); // 30 min ago
    expect(isSessionBoundRunIdFresh(recent, now)).toBe(true);
  });

  it("returns false when boundAt is older than the TTL", () => {
    const now = new Date("2026-08-09T12:00:00Z");
    const stale = new Date(now.getTime() - SESSION_BOUND_RUN_ID_TTL_MS - 1);
    expect(isSessionBoundRunIdFresh(stale, now)).toBe(false);
  });

  it("returns true when boundAt equals now (boundary, elapsed=0)", () => {
    const now = new Date("2026-08-09T12:00:00Z");
    expect(isSessionBoundRunIdFresh(now, now)).toBe(true);
  });

  it("returns false when boundAt is in the future (clock skew)", () => {
    const now = new Date("2026-08-09T12:00:00Z");
    const future = new Date(now.getTime() + 60 * 1000); // 1 min ahead
    expect(isSessionBoundRunIdFresh(future, now)).toBe(false);
  });
});
