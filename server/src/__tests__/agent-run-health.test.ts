import { describe, expect, it } from "vitest";
import { evaluateAgentRunHealth } from "../services/agent-run-health.ts";
import type { AgentRunHealthInput } from "../services/agent-run-health.ts";

const NOW = new Date("2026-05-31T16:40:00Z").getTime();

function makeRun(
  overrides: Partial<AgentRunHealthInput> & { status: string; createdAtOffset?: number },
): AgentRunHealthInput {
  const base = new Date("2026-05-31T13:00:00Z");
  const createdAt = new Date(base.getTime() + (overrides.createdAtOffset ?? 0) * 60_000);
  return {
    id: Math.random().toString(36).slice(2),
    status: overrides.status,
    createdAt,
    startedAt: overrides.startedAt ?? null,
    finishedAt: overrides.finishedAt ?? null,
    updatedAt: overrides.updatedAt ?? createdAt,
    ...overrides,
  };
}

describe("evaluateAgentRunHealth", () => {
  // Fixture A: slot-holder running with oldest createdAt + several newer queued rows.
  // This is the exact BLO-8456 failure mode — the naive top-5 shows only queued.
  it("Fixture A: does NOT report starved when a running slot-holder exists with older createdAt", () => {
    const slotHolder = makeRun({
      status: "running",
      createdAtOffset: 0, // oldest — would be at the bottom of createdAt-desc window
      startedAt: new Date("2026-05-31T13:22:55Z"),
    });
    const queued = Array.from({ length: 8 }, (_, i) =>
      makeRun({ status: "queued", createdAtOffset: 60 + i * 5 }),
    );

    const result = evaluateAgentRunHealth([slotHolder, ...queued], { nowMs: NOW });

    expect(result.isStarved).toBe(false);
    expect(result.signals.every((s) => s.kind !== "starved")).toBe(true);
  });

  // Fixture A variant: slot-holder succeeded (already finished) — still healthy.
  it("Fixture A variant: does NOT report starved when a succeeded run exists with older createdAt", () => {
    const slotHolder = makeRun({
      status: "succeeded",
      createdAtOffset: 0,
      finishedAt: new Date("2026-05-31T16:37:09Z"),
    });
    const queued = Array.from({ length: 5 }, (_, i) =>
      makeRun({ status: "queued", createdAtOffset: 60 + i * 5 }),
    );

    const result = evaluateAgentRunHealth([slotHolder, ...queued], { nowMs: NOW });

    expect(result.isStarved).toBe(false);
    expect(result.signals.every((s) => s.kind !== "starved")).toBe(true);
  });

  // Fixture B: slot-holder running beyond the threshold with a queue backed up.
  it("Fixture B: emits slot-held signal when slot-holder has been running > threshold with queued backlog", () => {
    const longRunStart = new Date("2026-05-31T13:00:00Z"); // 3h40m before NOW
    const slotHolder = makeRun({
      status: "running",
      createdAtOffset: 0,
      startedAt: longRunStart,
    });
    const queued = Array.from({ length: 5 }, (_, i) =>
      makeRun({ status: "queued", createdAtOffset: 60 + i * 5 }),
    );

    const result = evaluateAgentRunHealth([slotHolder, ...queued], {
      nowMs: NOW,
      slotHeldThresholdMs: 2 * 60 * 60 * 1000, // 2h
    });

    expect(result.isStarved).toBe(false);
    const slotSignal = result.signals.find((s) => s.kind === "slot-held");
    expect(slotSignal).toBeDefined();
    if (slotSignal?.kind === "slot-held") {
      expect(slotSignal.runId).toBe(slotHolder.id);
      expect(slotSignal.queuedCount).toBe(5);
      expect(slotSignal.ageMs).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000);
    }
  });

  // Fixture B short run: under threshold → no slot-held signal.
  it("does NOT emit slot-held when running run is under the threshold", () => {
    const recentStart = new Date("2026-05-31T16:30:00Z"); // 10 min before NOW
    const slotHolder = makeRun({
      status: "running",
      createdAtOffset: 0,
      startedAt: recentStart,
    });
    const queued = Array.from({ length: 4 }, (_, i) =>
      makeRun({ status: "queued", createdAtOffset: 5 + i * 2 }),
    );

    const result = evaluateAgentRunHealth([slotHolder, ...queued], {
      nowMs: NOW,
      slotHeldThresholdMs: 2 * 60 * 60 * 1000,
    });

    expect(result.isStarved).toBe(false);
    expect(result.signals.filter((s) => s.kind === "slot-held")).toHaveLength(0);
  });

  // Genuine starvation: all runs are queued, nothing running or succeeded.
  it("reports starved with queued-streak signal when all runs are queued", () => {
    const queued = Array.from({ length: 5 }, (_, i) =>
      makeRun({ status: "queued", createdAtOffset: i * 5 }),
    );

    const result = evaluateAgentRunHealth(queued, { nowMs: NOW });

    expect(result.isStarved).toBe(true);
    const starved = result.signals.find((s) => s.kind === "starved");
    expect(starved).toBeDefined();
    if (starved?.kind === "starved") {
      expect(starved.queuedStreak).toBe(5);
    }
  });

  // Mixed: recent runs are queued but an older one is failed — still counts as starved
  // (no succeeded/running in window).
  it("reports starved when window has only queued and failed runs (no succeeded/running)", () => {
    const failed = makeRun({ status: "failed", createdAtOffset: 0 });
    const queued = Array.from({ length: 4 }, (_, i) =>
      makeRun({ status: "queued", createdAtOffset: 30 + i * 5 }),
    );

    const result = evaluateAgentRunHealth([failed, ...queued], { nowMs: NOW });

    expect(result.isStarved).toBe(true);
  });

  // Empty run window → not starved (can't conclude starvation with no data).
  it("returns isStarved=false for empty run window", () => {
    const result = evaluateAgentRunHealth([], { nowMs: NOW });
    expect(result.isStarved).toBe(false);
    expect(result.signals).toHaveLength(0);
  });

  // slot-held signal requires at least slotHeldMinQueuedCount queued runs.
  it("does NOT emit slot-held when queue depth is below minimum", () => {
    const longRunStart = new Date("2026-05-31T13:00:00Z");
    const slotHolder = makeRun({
      status: "running",
      createdAtOffset: 0,
      startedAt: longRunStart,
    });
    const oneQueued = makeRun({ status: "queued", createdAtOffset: 60 });

    const result = evaluateAgentRunHealth([slotHolder, oneQueued], {
      nowMs: NOW,
      slotHeldThresholdMs: 2 * 60 * 60 * 1000,
      slotHeldMinQueuedCount: 2,
    });

    expect(result.isStarved).toBe(false);
    expect(result.signals.filter((s) => s.kind === "slot-held")).toHaveLength(0);
  });
});
