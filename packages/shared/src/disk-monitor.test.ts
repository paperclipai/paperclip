import { describe, expect, it } from "vitest";
import { ConsecutiveSkipCounter, evaluateBackupDiskPressure } from "./disk-monitor.js";

const ONE_GIB = 1024 * 1024 * 1024;

function fakeStatfs(freeGiB: number) {
  return async () => ({ bsize: 4096, bavail: Math.round((freeGiB * ONE_GIB) / 4096) });
}

describe("evaluateBackupDiskPressure", () => {
  it("returns no pressure when free space is above both thresholds", async () => {
    const result = await evaluateBackupDiskPressure({
      targetPath: "/tmp",
      minFreeGiB: 2,
      aggressivePruneGiB: 5,
      statfsImpl: fakeStatfs(10),
    });
    expect(result.skip).toBe(false);
    expect(result.aggressivePrune).toBe(false);
    expect(result.freeGiB).toBeCloseTo(10, 1);
  });

  it("flags aggressivePrune when between aggressive and min thresholds", async () => {
    const result = await evaluateBackupDiskPressure({
      targetPath: "/tmp",
      minFreeGiB: 2,
      aggressivePruneGiB: 5,
      statfsImpl: fakeStatfs(3),
    });
    expect(result.skip).toBe(false);
    expect(result.aggressivePrune).toBe(true);
  });

  it("requests skip when below the minimum free threshold", async () => {
    const result = await evaluateBackupDiskPressure({
      targetPath: "/tmp",
      minFreeGiB: 2,
      aggressivePruneGiB: 5,
      statfsImpl: fakeStatfs(1.5),
    });
    expect(result.skip).toBe(true);
    expect(result.aggressivePrune).toBe(true);
    expect(result.freeGiB).toBeCloseTo(1.5, 1);
  });

  it("reads env defaults when thresholds are omitted", async () => {
    const previousMin = process.env.PAPERCLIP_BACKUP_MIN_FREE_GB;
    const previousAggressive = process.env.PAPERCLIP_BACKUP_AGGRESSIVE_PRUNE_GB;
    process.env.PAPERCLIP_BACKUP_MIN_FREE_GB = "1";
    process.env.PAPERCLIP_BACKUP_AGGRESSIVE_PRUNE_GB = "4";
    try {
      const result = await evaluateBackupDiskPressure({
        targetPath: "/tmp",
        statfsImpl: fakeStatfs(2),
      });
      expect(result.minFreeGiB).toBe(1);
      expect(result.aggressivePruneGiB).toBe(4);
      expect(result.skip).toBe(false);
      expect(result.aggressivePrune).toBe(true);
    } finally {
      if (previousMin === undefined) {
        delete process.env.PAPERCLIP_BACKUP_MIN_FREE_GB;
      } else {
        process.env.PAPERCLIP_BACKUP_MIN_FREE_GB = previousMin;
      }
      if (previousAggressive === undefined) {
        delete process.env.PAPERCLIP_BACKUP_AGGRESSIVE_PRUNE_GB;
      } else {
        process.env.PAPERCLIP_BACKUP_AGGRESSIVE_PRUNE_GB = previousAggressive;
      }
    }
  });

  it("falls back to coded defaults when env values are missing or invalid", async () => {
    const previousMin = process.env.PAPERCLIP_BACKUP_MIN_FREE_GB;
    process.env.PAPERCLIP_BACKUP_MIN_FREE_GB = "not-a-number";
    try {
      const result = await evaluateBackupDiskPressure({
        targetPath: "/tmp",
        statfsImpl: fakeStatfs(10),
      });
      expect(result.minFreeGiB).toBe(2);
      expect(result.aggressivePruneGiB).toBe(5);
    } finally {
      if (previousMin === undefined) {
        delete process.env.PAPERCLIP_BACKUP_MIN_FREE_GB;
      } else {
        process.env.PAPERCLIP_BACKUP_MIN_FREE_GB = previousMin;
      }
    }
  });
});

describe("ConsecutiveSkipCounter", () => {
  it("emits pause log exactly once on the third consecutive skip", () => {
    const counter = new ConsecutiveSkipCounter();
    const r1 = counter.recordSkip();
    const r2 = counter.recordSkip();
    const r3 = counter.recordSkip();
    const r4 = counter.recordSkip();
    expect(r1.shouldEmitPauseLog).toBe(false);
    expect(r2.shouldEmitPauseLog).toBe(false);
    expect(r3.shouldEmitPauseLog).toBe(true);
    expect(r4.shouldEmitPauseLog).toBe(false);
    expect(r4.count).toBe(4);
  });

  it("resets the streak and rearms the pause log on success", () => {
    const counter = new ConsecutiveSkipCounter();
    counter.recordSkip();
    counter.recordSkip();
    counter.recordSkip();
    counter.recordSuccess();
    expect(counter.snapshot()).toEqual({ count: 0, pauseLogEmitted: false });
    const next = counter.recordSkip();
    expect(next.shouldEmitPauseLog).toBe(false);
  });
});
