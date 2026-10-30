import { describe, expect, it, vi } from "vitest";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerUpstreamRecoveryReprobeWork } from "./upstream-recovery-reprobe-work.js";

type Coordinator = Parameters<typeof registerUpstreamRecoveryReprobeWork>[0];
type Task = Parameters<Coordinator["register"]>[1];

function fixture() {
  let task!: Task;
  const register = vi.fn((queue: string, work: Task) => {
    expect(queue).toBe(DELIVERY_QUEUES.upstreamRecoveryReprobe);
    task = work;
    return { ready: Promise.resolve(), wake: vi.fn() };
  });
  const reprobe = vi.fn(async (_scope?: { companyId: string; agentId: string; adapterType: string }) => undefined);
  registerUpstreamRecoveryReprobeWork({ register } as unknown as Coordinator, reprobe);
  return { task: () => task, reprobe };
}

describe("upstream recovery reprobe work", () => {
  it("scans persisted pins once at startup and then only probes completed scopes", async () => {
    const { task, reprobe } = fixture();
    const signal = new AbortController().signal;
    await task().run(signal);
    expect(reprobe).toHaveBeenCalledWith();
    expect(await task().hasPending()).toBe(false);

    const scope = { companyId: "company", agentId: "agent", adapterType: "codex_local" };
    task().onSettled?.(new Set([JSON.stringify(scope)]));
    await task().run(signal);
    expect(reprobe).toHaveBeenLastCalledWith(scope);
    expect(await task().hasPending()).toBe(false);
  });

  it("retains a failed scoped probe until the coordinator retries it", async () => {
    const { task, reprobe } = fixture();
    const signal = new AbortController().signal;
    await task().run(signal);
    const scope = { companyId: "company", agentId: "agent", adapterType: "codex_local" };
    task().onSettled?.(new Set([JSON.stringify(scope)]));
    reprobe.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(task().run(signal)).rejects.toThrow("database unavailable");
    expect(await task().hasPending()).toBe(true);
    await task().run(signal);
    expect(reprobe).toHaveBeenLastCalledWith(scope);
    expect(await task().hasPending()).toBe(false);
  });

  it("keeps a success notification that arrives during the startup scan", async () => {
    const { task, reprobe } = fixture();
    let finishScan!: () => void;
    reprobe.mockImplementationOnce(() => new Promise<undefined>(resolve => { finishScan = () => resolve(undefined); }));
    const running = task().run(new AbortController().signal);
    await Promise.resolve();
    const scope = { companyId: "company", agentId: "agent", adapterType: "codex_local" };
    task().onSettled?.(new Set([JSON.stringify(scope)]));
    finishScan();
    await running;
    expect(reprobe).toHaveBeenLastCalledWith(scope);
    expect(await task().hasPending()).toBe(false);
  });

  it("retains a failed startup scan and retries it", async () => {
    const { task, reprobe } = fixture();
    reprobe.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(task().run(new AbortController().signal)).rejects.toThrow("database unavailable");
    expect(await task().hasPending()).toBe(true);
    await task().run(new AbortController().signal);
    expect(reprobe).toHaveBeenCalledTimes(2);
    expect(await task().hasPending()).toBe(false);
  });
});
