import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Verifies PAPERCLIP_LOG_FORMAT selects the pino transport rendering:
 *   unset / "pretty" → pino-pretty (human-readable, default, back-compatible)
 *   "json"           → raw JSON via pino/file (machine-parseable for Loki/ELK)
 *
 * Both the stdout (info) and server.log (debug) streams switch together.
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

vi.mock("pino", () => ({ default: mockPino }));
vi.mock("pino-http", () => ({ pinoHttp: vi.fn(() => vi.fn()) }));
vi.mock("../config-file.js", () => ({ readConfigFile: vi.fn(() => null) }));
vi.mock("../home-paths.js", () => ({
  resolveHomeAwarePath: vi.fn((p: string) => p),
  resolveDefaultLogsDir: vi.fn(() => "/tmp/paperclip-test-logs"),
}));

import { readConfigFile } from "../config-file.js";

function loadedTargets(): Array<{ target: string; level: string }> {
  return (mockTransport.mock.calls[0][0] as {
    targets: Array<{ target: string; level: string }>;
  }).targets;
}

describe("logger format selection (PAPERCLIP_LOG_FORMAT)", () => {
  const original = process.env.PAPERCLIP_LOG_FORMAT;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    // Default: no config file (env-driven tests). Individual tests override.
    vi.mocked(readConfigFile).mockReturnValue(null);
  });

  afterEach(() => {
    if (original === undefined) delete process.env.PAPERCLIP_LOG_FORMAT;
    else process.env.PAPERCLIP_LOG_FORMAT = original;
  });

  it("defaults to pino-pretty when unset", async () => {
    delete process.env.PAPERCLIP_LOG_FORMAT;
    await import("../middleware/logger.js");

    const targets = loadedTargets();
    expect(targets).toHaveLength(2);
    expect(targets.every((t) => t.target === "pino-pretty")).toBe(true);
  });

  it("uses raw JSON (pino/file) on both streams when set to json", async () => {
    process.env.PAPERCLIP_LOG_FORMAT = "json";
    await import("../middleware/logger.js");

    const targets = loadedTargets();
    expect(targets).toHaveLength(2);
    expect(targets.every((t) => t.target === "pino/file")).toBe(true);
    expect(targets.map((t) => t.level).sort()).toEqual(["debug", "info"]);
  });

  it("falls back to pino-pretty for an unrecognised value", async () => {
    process.env.PAPERCLIP_LOG_FORMAT = "garbage";
    await import("../middleware/logger.js");

    const targets = loadedTargets();
    expect(targets.every((t) => t.target === "pino-pretty")).toBe(true);
  });

  it("honours config.json logging.format=json when the env var is unset", async () => {
    delete process.env.PAPERCLIP_LOG_FORMAT;
    vi.mocked(readConfigFile).mockReturnValue({
      logging: { mode: "file", format: "json", logDir: "/tmp/paperclip-test-logs" },
    } as ReturnType<typeof readConfigFile>);

    await import("../middleware/logger.js");

    const targets = loadedTargets();
    expect(targets.every((t) => t.target === "pino/file")).toBe(true);
  });

  it("env var wins over config.json (env pretty overrides file json)", async () => {
    process.env.PAPERCLIP_LOG_FORMAT = "pretty";
    vi.mocked(readConfigFile).mockReturnValue({
      logging: { mode: "file", format: "json", logDir: "/tmp/paperclip-test-logs" },
    } as ReturnType<typeof readConfigFile>);

    await import("../middleware/logger.js");

    const targets = loadedTargets();
    expect(targets.every((t) => t.target === "pino-pretty")).toBe(true);
  });
});
