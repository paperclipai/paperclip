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
 * 2. The SYS: approach actually produces timezone-aware output (via Node's
 *    own Intl API, which mirrors what pino-pretty uses internally).
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
    const { targets } = mockTransport.mock.calls[0][0] as { targets: Array<{ options: Record<string, unknown> }> };
    for (const target of targets) {
      expect(target.options.translateTime).toBe("SYS:HH:MM:ss");
    }
  });

  it("SYS: behaviour: Node local-time formatting differs between UTC and UTC+8", () => {
    // Demonstrates that using local time (what SYS: does) produces different
    // output in different timezones — the property the fix relies on.
    const EPOCH_MS = 946_684_800_000; // 2000-01-01 00:00:00 UTC

    const fmtUtc = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(EPOCH_MS);

    const fmtSgt = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Singapore",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(EPOCH_MS);

    // UTC midnight vs SGT 08:00 — must differ
    expect(fmtUtc).toBe("00:00:00");
    expect(fmtSgt).toBe("08:00:00");
    expect(fmtUtc).not.toBe(fmtSgt);
  });
});
