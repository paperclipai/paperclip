import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DISK_FREE_FAIL_PERCENT,
  DISK_FREE_WARN_PERCENT,
  FOOTPRINT_WARN_BYTES,
  computeFootprint,
  evaluateDiskHealth,
  formatBytes,
  readDirectorySizeBytes,
  type DiskFootprint,
  type DiskUsage,
} from "../checks/disk-check.js";

function makeDiskUsage(percentUsed: number, totalBytes = 100_000_000_000): DiskUsage {
  const usedBytes = Math.round((percentUsed / 100) * totalBytes);
  const freeBytes = totalBytes - usedBytes;
  return {
    totalBytes,
    freeBytes,
    usedBytes,
    percentUsed,
    percentFree: 100 - percentUsed,
  };
}

function makeFootprint(totalBytes = 0, entries: Array<[string, number]> = []): DiskFootprint {
  return {
    rootPath: "/tmp/paperclip-test",
    totalBytes,
    entries: entries.map(([name, bytes]) => ({ name, path: `/tmp/paperclip-test/${name}`, bytes })),
  };
}

describe("formatBytes", () => {
  it("formats zero and negative as 0 B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
  });

  it("formats small values in bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("scales to KiB / MiB / GiB", () => {
    expect(formatBytes(1024)).toMatch(/^1\.00 KiB$/);
    expect(formatBytes(5 * 1024 * 1024)).toMatch(/^5\.00 MiB$/);
    expect(formatBytes(2 * 1024 ** 3)).toMatch(/^2\.00 GiB$/);
  });

  it("uses fewer decimals for larger magnitudes", () => {
    expect(formatBytes(123 * 1024)).toBe("123 KiB");
  });
});

describe("readDirectorySizeBytes", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-disk-check-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns 0 for empty directories", () => {
    expect(readDirectorySizeBytes(tmp)).toBe(0);
  });

  it("sums file sizes recursively", () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "hello"); // 5
    fs.mkdirSync(path.join(tmp, "nested"));
    fs.writeFileSync(path.join(tmp, "nested", "b.txt"), "world!"); // 6
    expect(readDirectorySizeBytes(tmp)).toBe(11);
  });

  it("returns 0 for non-existent paths instead of throwing", () => {
    expect(readDirectorySizeBytes(path.join(tmp, "does-not-exist"))).toBe(0);
  });
});

describe("computeFootprint", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-footprint-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty entries when no known subpaths exist", () => {
    const fp = computeFootprint(tmp);
    expect(fp.rootPath).toBe(tmp);
    expect(fp.totalBytes).toBe(0);
    expect(fp.entries).toEqual([]);
  });

  it("collects only known subpaths and sorts by descending size", () => {
    fs.mkdirSync(path.join(tmp, "db"));
    fs.writeFileSync(path.join(tmp, "db", "huge.bin"), Buffer.alloc(2000));
    fs.mkdirSync(path.join(tmp, "logs"));
    fs.writeFileSync(path.join(tmp, "logs", "small.log"), Buffer.alloc(500));
    fs.mkdirSync(path.join(tmp, "unrelated"));
    fs.writeFileSync(path.join(tmp, "unrelated", "ignored.bin"), Buffer.alloc(9999));

    const fp = computeFootprint(tmp);
    expect(fp.totalBytes).toBe(2500);
    expect(fp.entries.map((e) => e.name)).toEqual(["db", "logs"]);
    expect(fp.entries[0].bytes).toBe(2000);
    expect(fp.entries[1].bytes).toBe(500);
  });
});

describe("evaluateDiskHealth", () => {
  it("fails when filesystem free space is below the fail threshold", () => {
    const result = evaluateDiskHealth(
      makeDiskUsage(100 - DISK_FREE_FAIL_PERCENT + 1),
      makeFootprint(),
    );
    expect(result.status).toBe("fail");
    expect(result.repairHint).toMatch(/Free space immediately/);
  });

  it("warns when free space is below the warn threshold", () => {
    const result = evaluateDiskHealth(
      makeDiskUsage(100 - DISK_FREE_WARN_PERCENT + 1),
      makeFootprint(),
    );
    expect(result.status).toBe("warn");
    expect(result.diskMessage).toMatch(/Free space is below/);
  });

  it("warns when footprint exceeds the configured threshold even with plenty of disk", () => {
    const result = evaluateDiskHealth(
      makeDiskUsage(20),
      makeFootprint(FOOTPRINT_WARN_BYTES + 1024, [["db", FOOTPRINT_WARN_BYTES + 1024]]),
    );
    expect(result.status).toBe("warn");
    expect(result.diskMessage).toMatch(/footprint exceeds/);
  });

  it("passes when disk and footprint are both healthy", () => {
    const result = evaluateDiskHealth(
      makeDiskUsage(40),
      makeFootprint(100 * 1024 * 1024, [
        ["db", 80 * 1024 * 1024],
        ["logs", 20 * 1024 * 1024],
      ]),
    );
    expect(result.status).toBe("pass");
    expect(result.repairHint).toBeUndefined();
    expect(result.footprintMessage).toMatch(/Paperclip footprint/);
  });

  it("returns warn when filesystem stats are unavailable", () => {
    const result = evaluateDiskHealth(null, makeFootprint());
    expect(result.status).toBe("warn");
    expect(result.diskMessage).toMatch(/Could not read filesystem statistics/);
  });

  it("renders a footprint breakdown in display order with the largest entry first", () => {
    const result = evaluateDiskHealth(
      makeDiskUsage(40),
      makeFootprint(3 * 1024 * 1024, [
        ["db", 2 * 1024 * 1024],
        ["logs", 1 * 1024 * 1024],
      ]),
    );
    expect(result.footprintMessage).toContain("db ");
    expect(result.footprintMessage.indexOf("db ")).toBeLessThan(result.footprintMessage.indexOf("logs "));
  });
});
