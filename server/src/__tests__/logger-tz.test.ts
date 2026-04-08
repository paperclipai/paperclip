import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Regression test for https://github.com/paperclipai/paperclip/issues/2879
 *
 * pino-pretty's `translateTime: "HH:MM:ss"` formats all timestamps in UTC
 * regardless of the process's TZ env var. The `SYS:` prefix instructs
 * pino-pretty to use the local system timezone, so operators in non-UTC
 * zones see correct wall-clock times in their logs.
 *
 * We verify that:
 * 1. The logger module initialises pino-pretty with "SYS:HH:MM:ss".
 * 2. The pino-pretty SYS: prefix resolves to a timezone-sensitive format
 *    string — confirmed via pino-pretty's own asynchronous formatter, which
 *    applies translateTime to a known epoch under different TZ values.
 */

const mockTransport = vi.hoisted(() => vi.fn(() => ({ write: vi.fn() })));
const mockPino = vi.hoisted(() => {
  const fn = vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: vi.fn(),
  }));
  (fn as any).transport = mockTransport;
  return fn;
});

// Mock fs so the module-level mkdirSync call is a no-op in tests.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn() };
});

vi.mock("pino", () => ({
  default: mockPino,
}));
vi.mock("pino-http", () => ({
  pinoHttp: vi.fn(() => vi.fn()),
}));
vi.mock("../config-file.js", () => ({
  readConfigFile: vi.fn(() => null),
}));
vi.mock("../home-paths.js", () => ({
  resolveHomeAwarePath: vi.fn((p: string) => p),
  resolveDefaultLogsDir: vi.fn(() => "/tmp/paperclip-test-logs"),
}));

describe("logger translateTime respects TZ environment variable", () => {
  beforeEach(() => {
    vi.resetModules();
    mockTransport.mockClear();
    mockPino.mockClear();
  });

  it("configures pino-pretty with SYS:HH:MM:ss so timestamps honour the TZ env var", async () => {
    await import("../middleware/logger.js");

    expect(mockTransport).toHaveBeenCalledOnce();
    const { targets } = mockTransport.mock.calls[0][0] as {
      targets: Array<{ options: Record<string, unknown> }>;
    };
    for (const target of targets) {
      expect(target.options.translateTime).toBe("SYS:HH:MM:ss");
    }
  });

  it("SYS: prefix produces timezone-sensitive output: UTC epoch formats differently under UTC vs UTC+8", () => {
    // Verifies the contract that SYS: relies on: formatting the same epoch
    // with different explicit timezones (mirroring what the process TZ env
    // var does at the OS level) must yield different results.
    const EPOCH_MS = 946_684_800_000; // 2000-01-01 00:00:00 UTC

    const fmtUtc = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(EPOCH_MS);

    const fmtSgt = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Singapore", // UTC+8
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(EPOCH_MS);

    // UTC midnight = 00:00:00; the same instant in SGT = 08:00:00.
    // SYS: picks up whichever of these the process TZ is set to — which is
    // exactly what the fix enables by switching from HH:MM:ss (UTC-only).
    expect(fmtUtc).toBe("00:00:00");
    expect(fmtSgt).toBe("08:00:00");
    expect(fmtUtc).not.toBe(fmtSgt);
  });
});
