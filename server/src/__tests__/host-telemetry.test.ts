import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// RENA-55149 / Greptile review on PR #10288: startHostResourceTelemetry() used to resolve
// and create its log directory (fs.mkdirSync) outside of any error handling, so a
// filesystem error there (e.g. read-only disk, permission denial) threw synchronously out
// of the exported function. Since it's called unguarded during server startup
// (server/src/index.ts), that failure could reject startServer entirely for what is meant
// to be optional, best-effort diagnostics. It must instead log a warning and return a
// no-op cleanup so telemetry setup failures never take down the server.

const mockLogger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("../middleware/logger.js", () => ({ logger: mockLogger }));

const mockResolveDefaultLogsDir = vi.hoisted(() => vi.fn());
vi.mock("../home-paths.js", () => ({
  resolveDefaultLogsDir: mockResolveDefaultLogsDir,
}));

describe("startHostResourceTelemetry", () => {
  const tempRoots: string[] = [];

  beforeEach(() => {
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not throw and returns a no-op cleanup when the log directory cannot be created", async () => {
    // Point the log dir at a path that already exists as a regular file. mkdirSync(...,
    // { recursive: true }) throws EEXIST in that situation, exercising the real failure
    // this defect covers without needing to mock node:fs internals.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-host-telemetry-"));
    tempRoots.push(root);
    const blockedDirPath = path.join(root, "blocked-log-dir");
    fs.writeFileSync(blockedDirPath, "not a directory");
    mockResolveDefaultLogsDir.mockReturnValue(blockedDirPath);

    const { startHostResourceTelemetry } = await import("../services/host-telemetry.js");

    let stop: (() => void) | undefined;
    expect(() => {
      stop = startHostResourceTelemetry();
    }).not.toThrow();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      expect.stringContaining("host resource telemetry disabled"),
    );

    // Cleanup must be safely callable even though nothing was actually started.
    expect(() => stop?.()).not.toThrow();

    // The blocked path must remain untouched: no interval was ever scheduled.
    expect(fs.readFileSync(blockedDirPath, "utf8")).toBe("not a directory");
  });

  it("samples immediately and on interval, and stops cleanly", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-host-telemetry-"));
    tempRoots.push(root);
    const logDir = path.join(root, "logs");
    mockResolveDefaultLogsDir.mockReturnValue(logDir);

    vi.useFakeTimers();

    const { startHostResourceTelemetry } = await import("../services/host-telemetry.js");
    const stop = startHostResourceTelemetry({ intervalMs: 30_000 });

    const logFile = path.join(logDir, "host-telemetry.log");
    const readLines = () =>
      fs
        .readFileSync(logFile, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);

    expect(readLines()).toHaveLength(1);

    vi.advanceTimersByTime(30_000);
    expect(readLines()).toHaveLength(2);

    stop();
    vi.advanceTimersByTime(60_000);
    expect(readLines()).toHaveLength(2);
  });
});
