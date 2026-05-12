import { describe, expect, it } from "vitest";
import {
  isWakeupIdempotencyConflict,
  normalizeWakeupIdempotencyKey,
  resolveIdempotentWakeupHit,
  WAKEUP_IDEMPOTENCY_UNIQUE_INDEX,
} from "../services/heartbeat-wakeup-idempotency.ts";

describe("heartbeat wakeup idempotency helpers", () => {
  it("normalizes blank keys to null and trims usable keys", () => {
    expect(normalizeWakeupIdempotencyKey(null)).toBeNull();
    expect(normalizeWakeupIdempotencyKey("   ")).toBeNull();
    expect(normalizeWakeupIdempotencyKey("  issue:run:1  ")).toBe("issue:run:1");
  });

  it("resolves an existing idempotent wakeup as a hit even when no run was created", () => {
    expect(resolveIdempotentWakeupHit(null)).toEqual({ kind: "miss" });
    expect(resolveIdempotentWakeupHit({ run: null })).toEqual({ kind: "hit", run: null });
    expect(resolveIdempotentWakeupHit({ run: { id: "run-1" } })).toEqual({
      kind: "hit",
      run: { id: "run-1" },
    });
  });

  it("detects wrapped Postgres unique conflicts for idempotent wakeups", () => {
    const postgresError = {
      code: "23505",
      constraint: WAKEUP_IDEMPOTENCY_UNIQUE_INDEX,
    };

    expect(isWakeupIdempotencyConflict(postgresError)).toBe(true);
    expect(isWakeupIdempotencyConflict({ cause: postgresError })).toBe(true);
    expect(isWakeupIdempotencyConflict({ code: "23505", constraint: "other_unique_idx" })).toBe(false);
  });
});
