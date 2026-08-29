import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TASK_DRAIN_TTL_MS } from "@paperclipai/shared";
import {
  getTaskDrainGeneration,
  getTaskDrainStatus,
  resolveHeartbeatSchedulingSuppression,
  restoreTaskDrainIfCurrent,
  startTaskDrain,
  stopTaskDrain,
} from "../services/heartbeat.ts";

describe("heartbeat task drain", () => {
  afterEach(() => {
    stopTaskDrain();
    vi.useRealTimers();
  });

  it("start_task_drain_suppresses_admission", () => {
    startTaskDrain({});
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: true,
      reason: "task_drain",
    });
  });

  it("stop_task_drain_restores_admission", () => {
    startTaskDrain({});
    expect(stopTaskDrain()).toEqual({ wasActive: true });
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: false,
      reason: null,
    });
    expect(stopTaskDrain()).toEqual({ wasActive: false });
  });

  it("null_ttl_produces_no_expiry", () => {
    const { expiresAt } = startTaskDrain({ ttlMs: null });
    expect(expiresAt).toBeNull();
    expect(getTaskDrainStatus().expiresAt).toBeNull();
  });

  it("ttl_above_the_maximum_clamps_to_24_hours", () => {
    const { startedAt, expiresAt } = startTaskDrain({ ttlMs: MAX_TASK_DRAIN_TTL_MS * 10 });
    expect(expiresAt).not.toBeNull();
    expect((expiresAt as Date).getTime() - startedAt.getTime()).toBe(MAX_TASK_DRAIN_TTL_MS);
  });

  it("an_expired_ttl_ends_the_drain_and_restores_admission", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    startTaskDrain({ ttlMs: 1000 });
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: true,
      reason: "task_drain",
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:01.001Z"));
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: false,
      reason: null,
    });
    expect(getTaskDrainStatus().draining).toBe(false);
  });

  it("status_reports_quiescent_when_both_promise_sets_are_empty", () => {
    startTaskDrain({});
    const status = getTaskDrainStatus();
    expect(status.draining).toBe(true);
    expect(status.activeRuns).toBe(0);
    expect(status.pendingWakes).toBe(0);
    expect(status.quiescent).toBe(true);
  });

  it("a_stale_restore_does_not_clobber_a_newer_concurrent_mutation", () => {
    // Simulate a route's own mutation, whose caller wants to roll it back
    // on a failed audit write.
    startTaskDrain({ ttlMs: null });
    const staleGeneration = getTaskDrainGeneration();

    // A concurrent request supersedes that mutation with its own drain
    // before the first caller's rollback runs.
    const { startedAt: newerStartedAt } = startTaskDrain({ ttlMs: 5_000 });

    const restored = restoreTaskDrainIfCurrent(staleGeneration, { draining: false, ttlMs: null });

    expect(restored).toBe(false);
    const status = getTaskDrainStatus();
    expect(status.draining).toBe(true);
    expect(status.startedAt).toEqual(newerStartedAt);
  });

  it("restore_applies_when_no_newer_mutation_happened", () => {
    startTaskDrain({ ttlMs: 10_000 });
    const generation = getTaskDrainGeneration();

    const restored = restoreTaskDrainIfCurrent(generation, { draining: false, ttlMs: null });

    expect(restored).toBe(true);
    expect(getTaskDrainStatus().draining).toBe(false);
  });

  it("restore_reinstates_a_prior_active_drain", () => {
    startTaskDrain({ ttlMs: null });
    const generation = getTaskDrainGeneration();

    const restored = restoreTaskDrainIfCurrent(generation, { draining: true, ttlMs: 30_000 });

    expect(restored).toBe(true);
    const status = getTaskDrainStatus();
    expect(status.draining).toBe(true);
    expect(status.expiresAt).not.toBeNull();
  });
});
