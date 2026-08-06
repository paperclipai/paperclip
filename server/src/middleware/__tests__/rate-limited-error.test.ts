import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("pino", () => {
  const mockPino = vi.fn(() => ({
    error: vi.fn(),
    info: vi.fn(),
  }));
  mockPino.transport = vi.fn(() => ({}));
  return { default: mockPino };
});
vi.mock("pino-http", () => ({
  pinoHttp: vi.fn(() => ({})),
}));
vi.mock("../../home-paths.js", () => ({
  resolveDefaultLogsDir: () => "/tmp/paperclip-logs",
  resolveHomeAwarePath: (p: string) => p,
}));
vi.mock("../../config-file.js", () => ({
  readConfigFile: () => ({ logging: {} }),
}));

// We import AFTER mocks are set up
describe("rate-limited error logger", () => {
  let rateLimitedError: typeof import("../logger.js").rateLimitedError;
  let mockError: ReturnType<typeof vi.fn>;
  let mockInfo: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import("../logger.js");
    rateLimitedError = mod.rateLimitedError;
    mockError = mod.logger.error;
    mockInfo = mod.logger.info;
    rateLimitedError.reset();
    mockError.mockClear();
    mockInfo.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs the first error immediately", async () => {
    const logged = rateLimitedError.error(new Error("db unreachable"), "heartbeat timer tick");

    expect(logged).toBe(true);
    expect(mockError).toHaveBeenCalledTimes(1);
  });

  it("suppresses repeated errors within the cooldown period", async () => {
    const first = rateLimitedError.error(new Error("db unreachable"), "heartbeat timer tick");
    expect(first).toBe(true);

    const second = rateLimitedError.error(new Error("db unreachable"), "heartbeat timer tick");
    expect(second).toBe(false);
    expect(mockError).toHaveBeenCalledTimes(1);
  });

  it("resumes logging after cooldown expires", async () => {
    const first = rateLimitedError.error(new Error("db unreachable"), "heartbeat timer tick");
    expect(first).toBe(true);

    vi.advanceTimersByTime(6 * 60 * 1000); // 6 minutes > 5 min cooldown

    const second = rateLimitedError.error(new Error("db unreachable"), "heartbeat timer tick");
    expect(second).toBe(true);
    expect(mockError).toHaveBeenCalledTimes(2);
  });

  it("tracks failure counts for suppressed errors", async () => {
    rateLimitedError.error(new Error("db unreachable"), "heartbeat timer tick");
    rateLimitedError.recordFailure("heartbeat timer tick");
    rateLimitedError.recordFailure("heartbeat timer tick");
    rateLimitedError.recordFailure("heartbeat timer tick");
    rateLimitedError.success("heartbeat timer tick");

    expect(mockInfo).toHaveBeenCalledWith(
      { suppressedErrors: 3 },
      "heartbeat timer tick: recovered",
    );
  });

  it("does not log recovery message when there were no suppressed failures", async () => {
    rateLimitedError.success("heartbeat timer tick");
    expect(mockInfo).not.toHaveBeenCalled();
  });

  it("handles different error messages independently", async () => {
    const a = rateLimitedError.error(new Error("err"), "heartbeat timer tick");
    expect(a).toBe(true);

    const b = rateLimitedError.error(new Error("err"), "scheduled trigger tick");
    expect(b).toBe(true);

    expect(mockError).toHaveBeenCalledTimes(2);
  });
});
