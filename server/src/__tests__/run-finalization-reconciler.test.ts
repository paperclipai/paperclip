import { describe, expect, it } from "vitest";
import { shouldFinalizeRunForReconciler } from "../services/recovery/run-finalization-reconciler.js";

describe("run finalization reconciler decisions", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");
  const ttlMs = 30 * 60 * 1000;

  it("does not finalize runs with an in-memory handle", async () => {
    const decision = await shouldFinalizeRunForReconciler({
      runId: "run-1",
      status: "running",
      processPid: 1234,
      lastOutputAt: new Date("2026-06-15T11:00:00.000Z"),
      lastOutputSeq: 0,
      processStartedAt: new Date("2026-06-15T11:00:00.000Z"),
      startedAt: new Date("2026-06-15T11:00:00.000Z"),
      createdAt: new Date("2026-06-15T11:00:00.000Z"),
      tracksLocalChild: true,
      hasInMemoryHandle: true,
      now,
      outputStagnantTtlMs: ttlMs,
      pidFileDir: "/tmp/paperclip-test",
    });
    expect(decision.finalize).toBe(false);
    expect(decision.reason).toBe("in_memory_handle_present");
  });

  it("finalizes when the child pid is dead", async () => {
    const decision = await shouldFinalizeRunForReconciler({
      runId: "run-2",
      status: "running",
      processPid: 9_999_999,
      lastOutputAt: new Date("2026-06-15T11:59:00.000Z"),
      lastOutputSeq: 3,
      processStartedAt: new Date("2026-06-15T11:00:00.000Z"),
      startedAt: new Date("2026-06-15T11:00:00.000Z"),
      createdAt: new Date("2026-06-15T11:00:00.000Z"),
      tracksLocalChild: true,
      hasInMemoryHandle: false,
      now,
      outputStagnantTtlMs: ttlMs,
      pidFileDir: "/tmp/paperclip-test",
    });
    expect(decision.finalize).toBe(true);
    expect(decision.reason).toBe("child_pid_not_alive");
  });

  it("finalizes when output is stagnant beyond ttl even if pid is alive", async () => {
    const decision = await shouldFinalizeRunForReconciler({
      runId: "run-3",
      status: "running",
      processPid: process.pid,
      lastOutputAt: new Date("2026-06-15T10:00:00.000Z"),
      lastOutputSeq: 0,
      processStartedAt: new Date("2026-06-15T10:00:00.000Z"),
      startedAt: new Date("2026-06-15T10:00:00.000Z"),
      createdAt: new Date("2026-06-15T10:00:00.000Z"),
      tracksLocalChild: true,
      hasInMemoryHandle: false,
      now,
      outputStagnantTtlMs: ttlMs,
      pidFileDir: "/tmp/paperclip-test",
    });
    expect(decision.finalize).toBe(true);
    expect(decision.reason).toBe("output_stagnant_beyond_ttl");
  });

  it("does not finalize live output-producing runs", async () => {
    const decision = await shouldFinalizeRunForReconciler({
      runId: "run-4",
      status: "running",
      processPid: process.pid,
      lastOutputAt: new Date("2026-06-15T11:50:00.000Z"),
      lastOutputSeq: 12,
      processStartedAt: new Date("2026-06-15T11:00:00.000Z"),
      startedAt: new Date("2026-06-15T11:00:00.000Z"),
      createdAt: new Date("2026-06-15T11:00:00.000Z"),
      tracksLocalChild: true,
      hasInMemoryHandle: false,
      now,
      outputStagnantTtlMs: ttlMs,
      pidFileDir: "/tmp/paperclip-test",
    });
    expect(decision.finalize).toBe(false);
    expect(decision.reason).toBe("child_alive_and_output_recent");
  });
});
