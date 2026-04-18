import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("logger request redaction config", () => {
  beforeEach(() => {
    vi.resetModules();
    mockTransport.mockClear();
    mockPino.mockClear();
  });

  it("redacts cookie headers and keeps req/res out of both pretty transports", async () => {
    await import("../middleware/logger.js");

    expect(mockPino).toHaveBeenCalledOnce();
    const [config] = mockPino.mock.calls[0] as [{ redact?: string[] }];
    expect(config.redact).toEqual(
      expect.arrayContaining(["req.headers.authorization", "req.headers.cookie"]),
    );

    expect(mockTransport).toHaveBeenCalledOnce();
    const { targets } = mockTransport.mock.calls[0][0] as {
      targets: Array<{ options: Record<string, unknown> }>;
    };
    for (const target of targets) {
      expect(target.options.ignore).toBe("pid,hostname,req,res,responseTime");
    }
  });
});
