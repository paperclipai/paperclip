import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * LET-436 regression: when the real server config path resolves logging.logDir
 * to a vitest scratch directory (e.g. `/tmp/paperclip-vitest-*`), production
 * startup must refuse rather than write logs into a tempdir that gets nuked
 * between runs. Asserts the guard fires through `resolveServerLogDir` ->
 * `assertServerLogDirIsSafe`, not just a unit helper.
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

describe("LET-436 server logger insecure logDir guard", () => {
  const originalLogDir = process.env.PAPERCLIP_LOG_DIR;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.PAPERCLIP_LOG_DIR = originalLogDir;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("assertServerLogDirIsSafe throws in production when logDir is a vitest tempdir", async () => {
    const { assertServerLogDirIsSafe } = await import("../middleware/logger.js");
    expect(() =>
      assertServerLogDirIsSafe("/tmp/paperclip-vitest-leak/logs", { nodeEnv: "production" }),
    ).toThrow(/LET-436|vitest|insecure/i);
  });

  it("assertServerLogDirIsSafe is a no-op in test mode (vitest still allowed)", async () => {
    const { assertServerLogDirIsSafe } = await import("../middleware/logger.js");
    expect(() =>
      assertServerLogDirIsSafe("/tmp/paperclip-vitest-leak/logs", { nodeEnv: "test" }),
    ).not.toThrow();
  });

  it("assertServerLogDirIsSafe accepts a normal user logDir in production", async () => {
    const { assertServerLogDirIsSafe } = await import("../middleware/logger.js");
    expect(() =>
      assertServerLogDirIsSafe("/home/op/.paperclip/instances/default/logs", {
        nodeEnv: "production",
      }),
    ).not.toThrow();
  });

  it("resolveServerLogDir + assertServerLogDirIsSafe rejects PAPERCLIP_LOG_DIR=/tmp/paperclip-vitest-* in production", async () => {
    process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-vitest-prod-bad/logs";
    const { resolveServerLogDir, assertServerLogDirIsSafe } = await import(
      "../middleware/logger.js"
    );
    const resolved = resolveServerLogDir();
    expect(resolved).toBe("/tmp/paperclip-vitest-prod-bad/logs");
    expect(() => assertServerLogDirIsSafe(resolved, { nodeEnv: "production" })).toThrow();
  });
});
