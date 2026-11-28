import { expect, it, vi } from "vitest";
import { registerDeadlineWork } from "./deadline-work.js";

it("keeps a saved deadline ahead of the notification coalescing window", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(1_000);
    const dueAt = 1_500;
    const register = vi.fn<Parameters<typeof registerDeadlineWork>[0]["register"]>()
      .mockReturnValue({ ready: Promise.resolve(), wake: vi.fn(), stop: vi.fn(async () => {}) });
    const run = vi.fn(async (_signal: AbortSignal) => {});
    const next = vi.fn<() => Promise<number | null>>()
      .mockResolvedValueOnce(dueAt)
      .mockResolvedValue(null);
    registerDeadlineWork({ register }, "status-card-evaluation", {
      run, next, canRun: () => true, retryMs: 25, notificationCoalesceMs: 1_000,
    });
    const [, task] = register.mock.calls[0]!;
    const { signal } = new AbortController();

    await task.run(signal);
    expect(task.nextRunAt?.()).toBe(dueAt);

    vi.setSystemTime(1_100);
    task.onSettled?.(new Set(["another-company"]));
    await task.run(signal);
    expect(run).toHaveBeenCalledTimes(1);
    expect(task.nextRunAt?.()).toBe(dueAt);

    vi.setSystemTime(dueAt);
    await task.run(signal);
    expect(run).toHaveBeenCalledTimes(2);
    expect(task.nextRunAt?.()).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
