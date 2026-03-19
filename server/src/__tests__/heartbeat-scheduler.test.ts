import { describe, expect, it } from "vitest";
import { stableJitterMs } from "../services/scheduler-utils.js";

describe("stableJitterMs", () => {
  it("returns 0 when maxMs is 0", () => {
    expect(stableJitterMs("agent-1", 0)).toBe(0);
  });

  it("returns 0 when maxMs is negative", () => {
    expect(stableJitterMs("agent-1", -100)).toBe(0);
  });

  it("returns a value within [0, maxMs)", () => {
    const maxMs = 30000;
    for (const id of ["agent-1", "agent-2", "agent-3", "abc", "xyz-123"]) {
      const jitter = stableJitterMs(id, maxMs);
      expect(jitter).toBeGreaterThanOrEqual(0);
      expect(jitter).toBeLessThan(maxMs);
    }
  });

  it("is deterministic for the same agent ID", () => {
    const a = stableJitterMs("agent-test", 10000);
    const b = stableJitterMs("agent-test", 10000);
    expect(a).toBe(b);
  });

  it("produces different values for different agent IDs", () => {
    const values = new Set<number>();
    for (let i = 0; i < 20; i++) {
      values.add(stableJitterMs(`agent-${i}`, 100000));
    }
    // With 20 agents and 100k max, we should get at least a few distinct values
    expect(values.size).toBeGreaterThan(5);
  });

  it("spreads UUIDs across the jitter window", () => {
    const maxMs = 300000; // 5 minutes
    const uuids = [
      "e9665ed6-b8a1-40b8-9a05-bb4464c81167",
      "b2c737ef-547f-459b-bdca-87655ca3ce7f",
      "440aaf13-8817-4122-b69c-7f464a009bce",
      "199a29c3-cbbc-45c5-afb8-003a6b69857e",
      "e0e927e5-ce07-4584-b7d4-6ac7cb648d60",
    ];
    const jitters = uuids.map(id => stableJitterMs(id, maxMs));
    // Check they're spread out (not all the same)
    const uniqueJitters = new Set(jitters);
    expect(uniqueJitters.size).toBeGreaterThan(1);
    // All within range
    for (const j of jitters) {
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThan(maxMs);
    }
  });
});
