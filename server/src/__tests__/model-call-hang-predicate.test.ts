import fs from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  evaluateModelCallHang,
  notHungModelCallHang,
  readProcessCpuOverWallRatio,
} from "../services/recovery/service.ts";

// FUL-633: predicate isolation tests for AC #1 ("unit-tested (3 cases:
// alive-silent, alive-busy, not-running)"). These tests mock
// `node:fs/promises.readFile` so the `/proc/<pid>/stat` reader can be
// exercised without a real long-running child process, and they pin the
// boundary behaviour at `MODEL_CALL_HANG_CPU_RATIO_THRESHOLD = 0.05`.

const HUNG = 0.01;   // cpu_seconds / wall_clock_seconds < 0.05 → hung
const BUSY = 0.5;    // cpu_seconds / wall_clock_seconds > 0.05 → not hung
const TARGET_WALL_SECONDS = 3600; // 1h, well above the 60s floor
const TARGET_PID = 42_000; // synthetic pid (the alive path also forces this to be live via process.kill spy)

function buildProcStat(utimeJiffies: number, stimeJiffies: number): string {
  // Synthetic /proc/<pid>/stat. Fields after the last `)` (0-indexed):
  //   0=state, 1=ppid, 2=pgrp, 3=session, 4=tty_nr, 5=tpgid, 6=flags,
  //   7=minflt, 8=cminflt, 9=majflt, 10=cmajflt, 11=utime, 12=stime, ...
  // The reader parses utime from fields[11] and stime from fields[12], so
  // we emit ten zeroes between `S` and `${utimeJiffies}` to land utime at
  // fields[11]. The reader's safety check requires fields.length >= 13,
  // which we satisfy by padding trailing fields through at least fields[55].
  return `${TARGET_PID} (test-fixture-model-call-hang) S 0 0 0 0 0 0 0 0 0 0 ${utimeJiffies} ${stimeJiffies} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`;
}

function jiffiesFor(cpuSeconds: number): number {
  // USER_HZ = 100 (canonical Paperclip host value, hardcoded in the reader).
  return Math.round(cpuSeconds * 100);
}

const originalReadFile = fs.readFile;
let mockReadFileImpl: ((path: string | URL | import("node:fs/promises").PathLike, ...args: unknown[]) => Promise<string | Buffer>) | null = null;

beforeAll(() => {
  vi.spyOn(fs, "readFile").mockImplementation(((path: unknown, ...rest: unknown[]) => {
    const pathStr = typeof path === "string" ? path : path instanceof URL ? path.pathname : String(path);
    if (mockReadFileImpl) return mockReadFileImpl(pathStr as string, ...rest);
    return (originalReadFile as typeof fs.readFile)(path as never, ...(rest as []));
  }) as never);
});

afterAll(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  mockReadFileImpl = null;
});

// FUL-633: pid liveness is enforced inside `evaluateModelCallHang` via
// `isPidAlive(pid)` → `process.kill(pid, 0)`. For deterministic, host-
// agnostic tests we spy on `process.kill` rather than spawn real children.
function mockPidAlive(pid: number, alive: boolean): () => void {
  const spy = vi.spyOn(process, "kill").mockImplementation((target: unknown, signal?: unknown) => {
    if (typeof target === "number" && target === pid) {
      if (!alive) {
        const err = new Error("ESRCH: no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }
    // For any other pid, defer to the real implementation so unrelated
    // process.kill calls inside the test runner keep working.
    return vi.importActual("node:process").then(({ default: real }: { default: { kill(...a: unknown[]): unknown } }) =>
      real.kill(target as never, signal as never),
    ) as unknown as boolean;
  });
  return () => spy.mockRestore();
}

// FUL-633: `readProcessCpuOverWallRatio` enforces `process.platform ===
// "linux"` and a 60s wall-clock floor. The race-free way to assert on
// those branches is to drive the test runner in unit mode and shape the
// input; the linux gate is exercised implicitly by the alive tests below
// (which only run on linux hosts).
const describeIfLinux = process.platform === "linux" ? describe : describe.skip;

describe("evaluateModelCallHang (FUL-633 predicate isolation)", () => {
  describeIfLinux("alive + cpu/wall ratio below 0.05 (alive-silent)", () => {
    it("classifies the run as a model-call hang and surfaces the ratio", async () => {
      const now = new Date("2026-07-02T22:00:00.000Z");
      const processStartedAt = new Date(now.getTime() - TARGET_WALL_SECONDS * 1000);
      // cpu_seconds = 36 (below 0.05 * 3600 = 180 → hungProcess: true)
      const utimeJiffies = jiffiesFor(HUNG * TARGET_WALL_SECONDS);
      const stimeJiffies = 0;
      mockReadFileImpl = async (path) => {
        if (path === `/proc/${TARGET_PID}/stat`) return buildProcStat(utimeJiffies, stimeJiffies);
        return originalReadFile(path as never);
      };
      const restoreKill = mockPidAlive(TARGET_PID, true);
      try {
        const result = await evaluateModelCallHang(
          {
            status: "running",
            lastOutputAt: null,
            processPid: TARGET_PID,
            processStartedAt,
            startedAt: processStartedAt,
            createdAt: new Date(processStartedAt.getTime() - 1000),
          },
          now,
        );
        expect(result.hungProcess).toBe(true);
        expect(result.cpuRatio).not.toBeNull();
        // 36s cpu over 3600s wall = 0.01 (within rounding tolerance)
        expect(result.cpuRatio!).toBeGreaterThan(0);
        expect(result.cpuRatio!).toBeLessThan(0.05);
        expect(result.wallSeconds).toBe(TARGET_WALL_SECONDS);
        expect(result.processAlive).toBe(true);
        expect(result.readError).toBeNull();
      } finally {
        restoreKill();
      }
    });
  });

  describeIfLinux("alive + cpu/wall ratio above 0.05 (alive-busy)", () => {
    it("does NOT classify as a hang but still surfaces the ratio for observability", async () => {
      const now = new Date("2026-07-02T22:01:00.000Z");
      const processStartedAt = new Date(now.getTime() - TARGET_WALL_SECONDS * 1000);
      // cpu_seconds = 1800 (above 0.05 * 3600 = 180 → hungProcess: false)
      const utimeJiffies = jiffiesFor(BUSY * TARGET_WALL_SECONDS);
      const stimeJiffies = 0;
      mockReadFileImpl = async (path) => {
        if (path === `/proc/${TARGET_PID}/stat`) return buildProcStat(utimeJiffies, stimeJiffies);
        return originalReadFile(path as never);
      };
      const restoreKill = mockPidAlive(TARGET_PID, true);
      try {
        const result = await evaluateModelCallHang(
          {
            status: "running",
            lastOutputAt: null,
            processPid: TARGET_PID,
            processStartedAt,
            startedAt: processStartedAt,
            createdAt: new Date(processStartedAt.getTime() - 1000),
          },
          now,
        );
        expect(result.hungProcess).toBe(false);
        expect(result.cpuRatio).not.toBeNull();
        expect(result.cpuRatio!).toBeGreaterThan(0.05);
        // ratio is returned for observability even when not a hang
        expect(result.cpuRatio!).toBeCloseTo(BUSY, 2);
        expect(result.processAlive).toBe(true);
        expect(result.readError).toBeNull();
      } finally {
        restoreKill();
      }
    });
  });

  describe("not-running run is excluded from the predicate", () => {
    it("returns `notHungModelCallHang()` with `cpuRatio: null` when status !== 'running'", async () => {
      // readFile is mocked globally; this case should not even reach the reader
      // because the predicate short-circuits on `run.status !== "running"`.
      // We assert that fact by watching the mock count.
      const now = new Date("2026-07-02T22:02:00.000Z");
      const readFileMock = fs.readFile as unknown as ReturnType<typeof vi.fn>;
      readFileMock.mockClear();
      mockReadFileImpl = async (path) => {
        throw new Error(`readFile should not be called for not-running run (got ${path})`);
      };
      const result = await evaluateModelCallHang(
        {
          status: "queued",
          lastOutputAt: null,
          processPid: TARGET_PID,
          processStartedAt: now,
          startedAt: now,
          createdAt: now,
        },
        now,
      );
      expect(result).toEqual(notHungModelCallHang());
      expect(result.hungProcess).toBe(false);
      expect(result.cpuRatio).toBeNull();
      expect(result.wallSeconds).toBeNull();
      expect(result.cpuSeconds).toBeNull();
      expect(result.processAlive).toBe(false);
      expect(result.readError).toBeNull();
    });
  });
});

describe("readProcessCpuOverWallRatio (FUL-633 reader isolation)", () => {
  it("returns null on non-linux platforms (mocked)", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const now = new Date("2026-07-02T22:03:00.000Z");
      const processStartedAt = new Date(now.getTime() - 3600 * 1000);
      const result = await readProcessCpuOverWallRatio(1234, processStartedAt, now);
      expect(result).toBeNull();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("returns null when wall-clock is below the 60s floor", async () => {
    const now = new Date("2026-07-02T22:04:00.000Z");
    // 30s wall-clock — under the 60s floor; the reader must bail and return null.
    const processStartedAt = new Date(now.getTime() - 30 * 1000);
    mockReadFileImpl = async () => buildProcStat(0, 0);
    const result = await readProcessCpuOverWallRatio(TARGET_PID, processStartedAt, now);
    expect(result).toBeNull();
  });

  it("parses utime + stime from /proc/<pid>/stat and divides by wall-clock seconds", async () => {
    const now = new Date("2026-07-02T22:05:00.000Z");
    const processStartedAt = new Date(now.getTime() - TARGET_WALL_SECONDS * 1000);
    // utime=3600 jiffies, stime=0 → 36 cpu_seconds over 3600s wall = 0.01
    mockReadFileImpl = async (path) => {
      if (path === `/proc/${TARGET_PID}/stat`) return buildProcStat(3600, 0);
      return originalReadFile(path as never);
    };
    const result = await readProcessCpuOverWallRatio(TARGET_PID, processStartedAt, now);
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(0.01, 3);
  });

  it("returns null when /proc/<pid>/stat read fails", async () => {
    const now = new Date("2026-07-02T22:06:00.000Z");
    const processStartedAt = new Date(now.getTime() - TARGET_WALL_SECONDS * 1000);
    mockReadFileImpl = async () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    const result = await readProcessCpuOverWallRatio(TARGET_PID, processStartedAt, now);
    expect(result).toBeNull();
  });

  it("returns null when /proc/<pid>/stat does not contain a closing paren", async () => {
    const now = new Date("2026-07-02T22:07:00.000Z");
    const processStartedAt = new Date(now.getTime() - TARGET_WALL_SECONDS * 1000);
    mockReadFileImpl = async () => "malformed-no-close-paren";
    const result = await readProcessCpuOverWallRatio(TARGET_PID, processStartedAt, now);
    expect(result).toBeNull();
  });

  it("returns null when utime/stime are not finite integers", async () => {
    const now = new Date("2026-07-02T22:08:00.000Z");
    const processStartedAt = new Date(now.getTime() - TARGET_WALL_SECONDS * 1000);
    // Construct a stat where utime and stime are non-numeric.
    mockReadFileImpl = async (path) => {
      if (path === `/proc/${TARGET_PID}/stat`) return `${TARGET_PID} (test) S 0 0 0 0 0 0 0 0 0 abc def`;
      return originalReadFile(path as never);
    };
    const result = await readProcessCpuOverWallRatio(TARGET_PID, processStartedAt, now);
    expect(result).toBeNull();
  });
});
