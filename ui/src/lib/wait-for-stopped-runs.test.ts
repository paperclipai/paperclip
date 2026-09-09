import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeartbeatRun } from "@paperclipai/shared";
import { waitForStoppedRuns } from "./wait-for-stopped-runs";

function run(id: string, status: HeartbeatRun["status"]) {
  return { id, status } as HeartbeatRun;
}
afterEach(() => vi.useRealTimers());
describe("stop confirmation", () => {
  it("waits for native cancellation acknowledgment after the run becomes terminal", async () => {
    vi.useFakeTimers();
    const native = { ...run("native", "cancelled"), runtimeMode: "native" };
    const getRun = vi
      .fn()
      .mockResolvedValueOnce({
        ...native,
        resultJson: { nativeCancellation: { dispatchState: "pending" } },
      })
      .mockResolvedValueOnce({
        ...native,
        resultJson: { nativeCancellation: { dispatchState: "acknowledged" } },
      });
    const finished = vi.fn();
    const result = waitForStoppedRuns(["native"], { getRun }).then(finished);
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await result;
    expect(finished).toHaveBeenCalledOnce();
  });
  it("waits for every affected run, including scheduled retries", async () => {
    vi.useFakeTimers();
    const getRun = vi
      .fn()
      .mockResolvedValueOnce(run("native", "running"))
      .mockResolvedValueOnce(run("legacy", "scheduled_retry"))
      .mockResolvedValueOnce(run("native", "cancelled"))
      .mockResolvedValueOnce(run("legacy", "running"))
      .mockResolvedValueOnce(run("legacy", "cancelled"));
    const finished = vi.fn();
    const result = waitForStoppedRuns(["native", "legacy", "native"], {
      getRun,
    }).then(finished);
    await vi.advanceTimersByTimeAsync(500);
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await result;
    expect(finished).toHaveBeenCalledOnce();
    expect(getRun).toHaveBeenCalledTimes(5);
  });
  it("does not claim termination when a paused run continues", async () => {
    vi.useFakeTimers();
    const result = waitForStoppedRuns(["active"], {
      getRun: vi.fn().mockResolvedValue(run("active", "running")),
      timeoutMs: 1000,
    });
    const assertion = expect(result).rejects.toThrow(
      "pause was saved, but work is still stopping",
    );
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
  it("distinguishes a verification error from a failed pause", async () => {
    await expect(
      waitForStoppedRuns(["active"], {
        getRun: vi.fn().mockRejectedValue(new Error("offline")),
      }),
    ).rejects.toThrow("pause was saved, but stopping could not be verified");
  });
});

it("bounds a hung status request instead of leaving Stop pending forever", async () => {
  vi.useFakeTimers();
  const result = waitForStoppedRuns(["active"], {
    getRun: () => new Promise(() => {}),
    timeoutMs: 1000,
  });
  const assertion = expect(result).rejects.toThrow(
    "stopping could not be verified",
  );
  await vi.advanceTimersByTimeAsync(1000);
  await assertion;
});
