import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const mockReadConfigFile = vi.hoisted(() => vi.fn(() => null));
const mockFs = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
  unlinkSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, ...mockFs };
});

vi.mock("pino", () => ({
  default: mockPino,
}));
vi.mock("pino-http", () => ({
  pinoHttp: vi.fn(() => vi.fn()),
}));
vi.mock("../config-file.js", () => ({
  readConfigFile: mockReadConfigFile,
}));
vi.mock("../home-paths.js", () => ({
  resolveHomeAwarePath: vi.fn((value: string) => value),
  resolveDefaultLogsDir: vi.fn(() => "/tmp/paperclip-test-logs"),
}));

describe("logger configuration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-09T12:00:00.000Z"));
    mockTransport.mockClear();
    mockPino.mockClear();
    mockReadConfigFile.mockReset();
    mockReadConfigFile.mockReturnValue(null);
    mockFs.mkdirSync.mockReset();
    mockFs.readdirSync.mockReset();
    mockFs.readdirSync.mockReturnValue([]);
    mockFs.statSync.mockReset();
    mockFs.statSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mockFs.unlinkSync.mockReset();
    delete process.env.PAPERCLIP_LOG_LEVEL;
    delete process.env.PAPERCLIP_LOG_CONSOLE_LEVEL;
    delete process.env.PAPERCLIP_LOG_FILE_LEVEL;
    delete process.env.PAPERCLIP_LOG_MAX_FILES;
    delete process.env.PAPERCLIP_LOG_MAX_FILE_SIZE_MB;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses environment-sensitive console level defaults and date-scoped log files", async () => {
    process.env.NODE_ENV = "production";

    await import("../middleware/logger.js");

    expect(mockPino).toHaveBeenCalledOnce();
    expect(mockPino.mock.calls[0]?.[0]).toMatchObject({
      level: "debug",
      redact: ["req.headers.authorization"],
    });

    const { targets } = mockTransport.mock.calls[0]?.[0] as {
      targets: Array<{ level: string; options: Record<string, unknown> }>;
    };
    const consoleTarget = targets.find((target) => target.options.destination === 1);
    const fileTarget = targets.find((target) => target.options.destination !== 1);

    expect(consoleTarget?.level).toBe("info");
    expect(fileTarget?.level).toBe("debug");
    expect(fileTarget?.options.destination).toBe("/tmp/paperclip-test-logs/server-2026-04-09.log");
  });

  it("honors configured levels and prunes old managed log files", async () => {
    mockReadConfigFile.mockReturnValue({
      logging: {
        mode: "file",
        logDir: "/tmp/custom-logs",
        consoleLevel: "warn",
        fileLevel: "error",
        maxFiles: 2,
        maxFileSizeMb: 25,
      },
    });
    mockFs.readdirSync.mockReturnValue([
      { name: "server-2026-04-07.log", isFile: () => true },
      { name: "server-2026-04-08.log", isFile: () => true },
      { name: "server-2026-04-09.log", isFile: () => true },
    ]);
    mockFs.statSync.mockImplementation((filePath: string) => {
      const statsByFile = new Map<string, { size: number; mtimeMs: number }>([
        ["/tmp/custom-logs/server-2026-04-07.log", { size: 128, mtimeMs: 1 }],
        ["/tmp/custom-logs/server-2026-04-08.log", { size: 128, mtimeMs: 2 }],
        ["/tmp/custom-logs/server-2026-04-09.log", { size: 128, mtimeMs: 3 }],
      ]);
      const stat = statsByFile.get(path.resolve(filePath));
      if (stat) return stat;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const { pruneManagedLogFiles } = await import("../middleware/logger.js");

    const { targets } = mockTransport.mock.calls[0]?.[0] as {
      targets: Array<{ level: string; options: Record<string, unknown> }>;
    };
    const consoleTarget = targets.find((target) => target.options.destination === 1);
    const fileTarget = targets.find((target) => target.options.destination !== 1);

    expect(consoleTarget?.level).toBe("warn");
    expect(fileTarget?.level).toBe("error");
    expect(fileTarget?.options.destination).toBe("/tmp/custom-logs/server-2026-04-09.log");
    pruneManagedLogFiles("/tmp/custom-logs", 2, mockFs as any);
    expect(mockFs.unlinkSync).toHaveBeenCalledWith("/tmp/custom-logs/server-2026-04-07.log");
  });
});
