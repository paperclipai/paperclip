import { afterEach, describe, expect, it, vi } from "vitest";
import { startWorkFolderCheckpointer } from "../services/work-folder-checkpointer.js";

describe("shared work folder checkpoint cadence", () => {
  afterEach(() => vi.useRealTimers());
  it("waits 180 seconds, does not overlap, and flushes after the last in-flight save", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const checkpoint = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }))
      .mockResolvedValue(undefined);
    const sync = startWorkFolderCheckpointer({ checkpoint, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(179_999);
    expect(checkpoint).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(360_000);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    const stopped = sync.stop();
    finish();
    await stopped;
    expect(checkpoint).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(checkpoint).toHaveBeenCalledTimes(2);
  });
  it("reports periodic errors and fails completion if the final save fails", async () => {
    vi.useFakeTimers();
    const error = new Error("Storage unavailable");
    const onError = vi.fn().mockResolvedValue(undefined);
    const sync = startWorkFolderCheckpointer({ checkpoint: vi.fn().mockRejectedValue(error), onError });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(onError).toHaveBeenCalledWith(error);
    await expect(sync.stop()).rejects.toThrow("Storage unavailable");
  });
  it("does not restart a failed final save during error teardown", async () => {
    vi.useFakeTimers();
    const checkpoint = vi.fn().mockRejectedValueOnce(new Error("socket hang up")).mockResolvedValue(undefined);
    const onError = vi.fn().mockResolvedValue(undefined);
    const sync = startWorkFolderCheckpointer({ checkpoint, onError });
    const firstStop = sync.stop();
    await expect(firstStop).rejects.toThrow("socket hang up");
    expect(sync.stop()).toBe(firstStop);
    await expect(sync.stop()).rejects.toThrow("socket hang up");
    await vi.advanceTimersByTimeAsync(360_000);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
