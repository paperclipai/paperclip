import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

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
  readConfigFile: vi.fn(() => ({
    logging: {
      mode: "file",
      logDir: "/tmp/paperclip-test-logs",
      rotation: {
        enabled: true,
        maxFileSizeMb: 25,
        maxFiles: 7,
      },
    },
  })),
}));
vi.mock("../home-paths.js", () => ({
  resolveHomeAwarePath: vi.fn((input: string) => input),
  resolveDefaultLogsDir: vi.fn(() => "/tmp/paperclip-test-logs"),
}));

describe("logger rotation wiring", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.PAPERCLIP_FORCE_ROTATING_PRETTY_TARGET = "1";
    vi.resetModules();
    mockTransport.mockClear();
    mockPino.mockClear();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("keeps stdout pretty logging unchanged and routes file logging through the rotating target", async () => {
    await import("../middleware/logger.js");

    expect(mockTransport).toHaveBeenCalledOnce();
    const { targets } = mockTransport.mock.calls[0][0] as {
      targets: Array<{
        level: string;
        target: string;
        options: Record<string, unknown>;
      }>;
    };

    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({
      level: "info",
      target: "pino-pretty",
      options: {
        colorize: true,
        destination: 1,
        ignore: "pid,hostname,req,res,responseTime",
        translateTime: "SYS:HH:MM:ss",
      },
    });
    expect(targets[1]?.target).toContain("rotating-pretty-target.js");
    expect(targets[1]).toMatchObject({
      level: "debug",
      options: {
        logFile: "/tmp/paperclip-test-logs/server.log",
        rotation: {
          enabled: true,
          maxFileSizeMb: 25,
          maxFiles: 7,
        },
        colorize: false,
        translateTime: "SYS:HH:MM:ss",
      },
    });
  });
});

describe("file rotation helpers", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-log-rotation-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("rotates an oversized active log on startup", async () => {
    const { getRotatedLogFiles, prepareLogFileForWrite } = await import("../logging/file-rotation.js");
    const logFile = path.join(tempRoot, "server.log");

    fs.writeFileSync(logFile, "x".repeat(2048), "utf8");

    prepareLogFileForWrite({
      logFile,
      rotation: {
        enabled: true,
        maxFileSizeMb: 0.001,
        maxFiles: 5,
      },
      now: () => new Date("2026-04-20T08:15:00.000Z"),
    });

    const rotated = getRotatedLogFiles(logFile);
    expect(rotated).toHaveLength(1);
    expect(path.basename(rotated[0] ?? "")).toBe("server.log.20260420-081500");
    expect(fs.readFileSync(rotated[0]!, "utf8")).toHaveLength(2048);
    expect(fs.existsSync(logFile)).toBe(true);
    expect(fs.statSync(logFile).size).toBe(0);
  });

  it("prunes the oldest rotated logs beyond the configured retention window", async () => {
    const { getRotatedLogFiles, prepareLogFileForWrite } = await import("../logging/file-rotation.js");
    const logFile = path.join(tempRoot, "server.log");

    fs.writeFileSync(path.join(tempRoot, "server.log.20260420-070000"), "1", "utf8");
    fs.writeFileSync(path.join(tempRoot, "server.log.20260420-071000"), "2", "utf8");
    fs.writeFileSync(path.join(tempRoot, "server.log.20260420-072000"), "3", "utf8");
    fs.writeFileSync(logFile, "x".repeat(2048), "utf8");

    prepareLogFileForWrite({
      logFile,
      rotation: {
        enabled: true,
        maxFileSizeMb: 0.001,
        maxFiles: 3,
      },
      now: () => new Date("2026-04-20T08:15:00.000Z"),
    });

    expect(
      getRotatedLogFiles(logFile).map((file) => path.basename(file)),
    ).toEqual([
      "server.log.20260420-072000",
      "server.log.20260420-081500",
    ]);
  });

  it("skips startup rotation when rotation is disabled", async () => {
    const { getRotatedLogFiles, prepareLogFileForWrite } = await import("../logging/file-rotation.js");
    const logFile = path.join(tempRoot, "server.log");

    fs.writeFileSync(logFile, "x".repeat(2048), "utf8");

    prepareLogFileForWrite({
      logFile,
      rotation: {
        enabled: false,
        maxFileSizeMb: 0.001,
        maxFiles: 5,
      },
      now: () => new Date("2026-04-20T08:15:00.000Z"),
    });

    expect(getRotatedLogFiles(logFile)).toEqual([]);
    expect(fs.statSync(logFile).size).toBe(2048);
  });
});
