import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Regression test for https://github.com/paperclipai/paperclip/issues/1825
 *
 * The stdout pino-pretty target ignores `req,res,responseTime`; the file
 * target historically did not. Prettifying the full req/res objects for
 * every HTTP entry makes the file formatter worker slower than the log
 * producers, so thread-stream's send buffer grows without bound and the
 * server aborts at the V8 heap limit.
 *
 * We verify that EVERY pino-pretty transport target ignores the large HTTP
 * fields, so the two targets cannot silently diverge again.
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

describe("logger transports ignore large HTTP fields (issue #1825)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("every transport target ignores req, res, and responseTime", async () => {
    await import("../middleware/logger.js");

    expect(mockTransport).toHaveBeenCalledOnce();
    const { targets } = mockTransport.mock.calls[0][0] as {
      targets: Array<{ options: Record<string, unknown> }>;
    };
    expect(targets.length).toBeGreaterThanOrEqual(2);

    for (const target of targets) {
      const ignore = String(target.options.ignore ?? "");
      const ignored = ignore.split(",").map((field) => field.trim());
      for (const field of ["req", "res", "responseTime"]) {
        expect(ignored, `target ignore list must include "${field}"`).toContain(field);
      }
    }
  });
});
