import { afterEach, describe, expect, it, vi } from "vitest";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { notifyTerminalWorkspaceWork, registerTerminalWorkspaceWork, TERMINAL_WORKSPACE_RETRY_MS } from "../services/terminal-workspace-work.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const coordinators: ReturnType<typeof createDeliveryWorkCoordinator>[] = [];
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.stop();
  vi.useRealTimers();
});

function setup() {
  vi.useFakeTimers();
  const execute = vi.fn(async () => [{ xid: "42", status: "committed" }]);
  const owner = installDatabaseWorkSignals({ execute, async transaction(callback: (tx: any) => Promise<any>) {
    return callback({ execute });
  } });
  const enabled = vi.fn(() => true), primary = vi.fn(() => true), onError = vi.fn();
  const coordinator = createDeliveryWorkCoordinator({ owner,
    canRun: () => enabled() && primary(), canReconcile: primary, onError,
  });
  coordinators.push(coordinator);
  const service = {
    sweepTerminalWorkspaces: vi.fn(async (_limit?: number, _signal?: AbortSignal, _options?: { compact?: boolean }) => ({ checked: 0 })),
    hasTerminalWorkspaceSweepContinuation: vi.fn(() => false),
    nextTerminalWorkspaceSweepAt: vi.fn(async (): Promise<number | null> => null),
  };
  return { owner, coordinator, service, enabled, primary, onError,
    start: () => registerTerminalWorkspaceWork(coordinator, service, enabled) };
}

describe("terminal workspace work", () => {
  it("recovers once at startup and makes no scans or SQL for an empty lane", async () => {
    const s = setup();
    const worker = s.start();
    await worker.ready;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(s.service.sweepTerminalWorkspaces).toHaveBeenCalledTimes(1);
    expect(s.service.nextTerminalWorkspaceSweepAt).toHaveBeenCalledTimes(1);
    expect(s.coordinator.nextWakeAt()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(idleWorkSnapshot().active).toBe(0);
    expect(worker.hasUnrecoveredWork()).toBe(false);
  });

  it("skips compaction only in the startup sweep that readiness waits for", async () => {
    const s = setup();
    s.service.hasTerminalWorkspaceSweepContinuation.mockReturnValueOnce(true);
    await s.start().ready;
    expect(s.service.sweepTerminalWorkspaces).toHaveBeenCalledTimes(1);
    expect(s.service.sweepTerminalWorkspaces.mock.calls[0]?.[2]).toEqual({ compact: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.service.sweepTerminalWorkspaces).toHaveBeenCalledTimes(2);
    expect(s.service.sweepTerminalWorkspaces.mock.calls[1]?.[2]).toEqual({ compact: true });
  });

  it("restores the cooldown deadline, lets commits preempt it, and parks after cleanup", async () => {
    const s = setup(), due = Date.now() + 86_400_000;
    s.service.nextTerminalWorkspaceSweepAt.mockResolvedValue(due);
    const worker = s.start();
    await worker.ready;
    expect(worker.hasUnrecoveredWork()).toBe(false);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(s.service.sweepTerminalWorkspaces).toHaveBeenCalledTimes(1);
    await s.owner.transaction(tx => notifyTerminalWorkspaceWork(tx));
    await s.owner.transaction(tx => notifyTerminalWorkspaceWork(tx));
    await vi.advanceTimersByTimeAsync(1);
    expect(s.service.sweepTerminalWorkspaces).toHaveBeenCalledTimes(2);
    expect(s.coordinator.nextWakeAt()).toBe(due);
    s.service.nextTerminalWorkspaceSweepAt.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(due - Date.now());
    expect(s.service.sweepTerminalWorkspaces).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes bounded recovery pages then retries only existing overdue work", async () => {
    const s = setup();
    s.service.hasTerminalWorkspaceSweepContinuation.mockReturnValueOnce(true);
    s.service.nextTerminalWorkspaceSweepAt.mockResolvedValue(Date.now() - 1);
    await s.start().ready;
    expect(s.coordinator.nextWakeAt()).toBe(Date.now() + 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.coordinator.nextWakeAt()).toBe(Date.now() + TERMINAL_WORKSPACE_RETRY_MS);
    s.service.nextTerminalWorkspaceSweepAt.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(TERMINAL_WORKSPACE_RETRY_MS);
    expect(s.service.sweepTerminalWorkspaces).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps failed recovery visible to sleep admission until a successful empty pass", async () => {
    const s = setup();
    s.service.sweepTerminalWorkspaces.mockRejectedValueOnce(new Error("database unavailable"));
    const worker = s.start();
    await worker.ready;
    expect(s.onError).toHaveBeenCalledTimes(1);
    expect(worker.hasUnrecoveredWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(TERMINAL_WORKSPACE_RETRY_MS);
    expect(worker.hasUnrecoveredWork()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defers scans and deadline SQL during standby and drain", async () => {
    const s = setup();
    s.primary.mockReturnValue(false);
    await s.start().ready;
    s.primary.mockReturnValue(true);
    s.enabled.mockReturnValue(false);
    await s.owner.transaction(tx => notifyTerminalWorkspaceWork(tx));
    await vi.advanceTimersByTimeAsync(1);
    expect(s.service.sweepTerminalWorkspaces).not.toHaveBeenCalled();
    expect(s.service.nextTerminalWorkspaceSweepAt).not.toHaveBeenCalled();
    s.enabled.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(TERMINAL_WORKSPACE_RETRY_MS);
    expect(s.service.sweepTerminalWorkspaces).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds admission until accepted cleanup finishes and waits for it during stop", async () => {
    const s = setup();
    let release!: () => void;
    s.service.sweepTerminalWorkspaces.mockImplementationOnce(async (_limit, signal) => {
      await new Promise<void>(resolve => { release = resolve; });
      expect(signal?.aborted).toBe(true);
      return { checked: 1 };
    });
    const worker = s.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(idleWorkSnapshot().active).toBe(1);
    let stopped = false;
    const stopping = s.coordinator.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toBe(false);
    release();
    await stopping;
    await worker.ready;
    expect(idleWorkSnapshot().active).toBe(0);
    expect(s.service.nextTerminalWorkspaceSweepAt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
