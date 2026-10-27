import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import {
  MANAGED_CLAUDE_TRANSCRIPT_CLEANUP_RETRY_MS,
  registerManagedClaudeTranscriptCleanupWork,
  retainManagedClaudeTranscripts,
  type ManagedClaudeTranscriptExpirationResult,
} from "../services/managed-claude-transcripts.js";

const coordinators: ReturnType<typeof createDeliveryWorkCoordinator>[] = [];
afterEach(async () => {
  for (const c of coordinators.splice(0)) await c.stop();
  vi.useRealTimers();
});

function fakeOwner() {
  const execute = vi.fn(async () => [{ xid: "42" }]);
  const owner = installDatabaseWorkSignals({ execute, async transaction(fn: (tx: any) => Promise<any>): Promise<any> {
    return fn({ execute, transaction: owner.transaction });
  } });
  return owner;
}

function coordinator(canRun = () => true) {
  const c = createDeliveryWorkCoordinator({ owner: fakeOwner(), canRun, canReconcile: () => true, onError: vi.fn() });
  coordinators.push(c);
  return c;
}

function result(overrides: Partial<ManagedClaudeTranscriptExpirationResult> = {}): ManagedClaudeTranscriptExpirationResult {
  return { checked: 0, expired: 0, clearedTaskSessions: 0, failed: 0, truncated: false, skipped: {}, nextDueAt: null, ...overrides };
}

describe("registerManagedClaudeTranscriptCleanupWork", () => {
  it("scans once at startup and stays quiet with nothing to expire", async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => result());
    const c = coordinator();
    registerManagedClaudeTranscriptCleanupWork(c, { tick }, vi.fn());
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(c.nextWakeAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("schedules the real next deadline instead of polling", async () => {
    vi.useFakeTimers();
    const due = Date.now() + 5 * 24 * 60 * 60 * 1000;
    const tick = vi.fn()
      .mockResolvedValueOnce(result({ nextDueAt: due }))
      .mockResolvedValueOnce(result({ nextDueAt: null }));
    const c = coordinator();
    registerManagedClaudeTranscriptCleanupWork(c, { tick }, vi.fn());
    await vi.advanceTimersByTimeAsync(1);
    expect(c.nextWakeAt()).toBe(due);
    await vi.advanceTimersByTimeAsync(due - Date.now() - 1);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(c.nextWakeAt()).toBeNull();
  });

  it("comes straight back on a truncated pass instead of waiting for a deadline", async () => {
    vi.useFakeTimers();
    const tick = vi.fn()
      .mockResolvedValueOnce(result({ truncated: true }))
      .mockResolvedValueOnce(result({ truncated: false }));
    const c = coordinator();
    registerManagedClaudeTranscriptCleanupWork(c, { tick }, vi.fn());
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(c.nextWakeAt()).toBeNull();
  });

  it("retries soon after a failed directory instead of an absent or distant deadline", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const tick = vi.fn()
      .mockResolvedValueOnce(result({ failed: 1 }))
      .mockResolvedValueOnce(result());
    const c = coordinator();
    registerManagedClaudeTranscriptCleanupWork(c, { tick }, vi.fn());
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(c.nextWakeAt()).toBe(startedAt + MANAGED_CLAUDE_TRANSCRIPT_CLEANUP_RETRY_MS);
    await vi.advanceTimersByTimeAsync(MANAGED_CLAUDE_TRANSCRIPT_CLEANUP_RETRY_MS - 2);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("keeps a real deadline that is sooner than the failed-directory retry", async () => {
    vi.useFakeTimers();
    const soonDue = Date.now() + 10_000;
    const tick = vi.fn(async () => result({ failed: 1, nextDueAt: soonDue }));
    const c = coordinator();
    registerManagedClaudeTranscriptCleanupWork(c, { tick }, vi.fn());
    await vi.advanceTimersByTimeAsync(1);
    expect(c.nextWakeAt()).toBe(soonDue);
  });

  it("keeps a wake that arrives while a pass is still in flight", async () => {
    vi.useFakeTimers();
    const guestDir = await fs.mkdtemp(path.join(os.tmpdir(), "pap-ai-cleanup-inflight-"));
    vi.stubEnv("PAPERCLIP_HOME", await fs.mkdtemp(path.join(guestDir, "home-")));
    vi.stubEnv("PAPERCLIP_MANAGED_CLAUDE_TRANSCRIPT_RETENTION_ENABLED", "true");
    try {
      const runtime = await fs.mkdtemp(path.join(guestDir, "run-home-"));
      await fs.mkdir(path.join(runtime, "provider"), { mode: 0o700 });
      const due = Date.now() + 5 * 24 * 60 * 60 * 1000;
      let resolveSecondPass!: (value: ManagedClaudeTranscriptExpirationResult) => void;
      const tick = vi.fn()
        .mockResolvedValueOnce(result({ nextDueAt: due }))
        .mockImplementationOnce(() => new Promise<ManagedClaudeTranscriptExpirationResult>((resolve) => { resolveSecondPass = resolve; }))
        .mockResolvedValueOnce(result());
      const c = coordinator();
      registerManagedClaudeTranscriptCleanupWork(c, { tick }, vi.fn());
      await vi.advanceTimersByTimeAsync(1);
      expect(tick).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(due - Date.now());
      expect(tick).toHaveBeenCalledTimes(2);

      await retainManagedClaudeTranscripts({
        runtime: { home: runtime, sessionIdentity: "grant-1:user-1:secret-1:0" },
        adapterType: "claude_local",
        companyId: "company-1",
        agentId: "agent-1",
        taskKey: "task-2",
        target: { kind: "local" } as never,
      });

      resolveSecondPass(result());
      await vi.advanceTimersByTimeAsync(1);
      expect(tick).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(guestDir, { recursive: true, force: true });
    }
  });

  it("wakes a worker that had gone idle when a run retains a new scope", async () => {
    vi.useFakeTimers();
    const guestDir = await fs.mkdtemp(path.join(os.tmpdir(), "pap-ai-cleanup-wake-"));
    vi.stubEnv("PAPERCLIP_HOME", await fs.mkdtemp(path.join(guestDir, "home-")));
    vi.stubEnv("PAPERCLIP_MANAGED_CLAUDE_TRANSCRIPT_RETENTION_ENABLED", "true");
    try {
      const runtime = await fs.mkdtemp(path.join(guestDir, "run-home-"));
      await fs.mkdir(path.join(runtime, "provider"), { mode: 0o700 });
      const tick = vi.fn(async () => result());
      const c = coordinator();
      registerManagedClaudeTranscriptCleanupWork(c, { tick }, vi.fn());
      await vi.advanceTimersByTimeAsync(1);
      expect(tick).toHaveBeenCalledTimes(1);
      expect(c.nextWakeAt()).toBeNull();

      await retainManagedClaudeTranscripts({
        runtime: { home: runtime, sessionIdentity: "grant-1:user-1:secret-1:0" },
        adapterType: "claude_local",
        companyId: "company-1",
        agentId: "agent-1",
        taskKey: "task-1",
        target: { kind: "local" } as never,
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(tick).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(guestDir, { recursive: true, force: true });
    }
  });
});
