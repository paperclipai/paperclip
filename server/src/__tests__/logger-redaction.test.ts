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
  (fn as any).stdSerializers = {
    req: vi.fn((req: any) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      headers: req.headers,
    })),
  };
  return fn;
});
const mockPinoHttp = vi.hoisted(() => vi.fn(() => vi.fn()));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn() };
});

vi.mock("pino", () => ({
  default: mockPino,
}));

vi.mock("pino-http", () => ({
  pinoHttp: mockPinoHttp,
}));

vi.mock("../config-file.js", () => ({
  readConfigFile: vi.fn(() => null),
}));

vi.mock("../home-paths.js", () => ({
  resolveHomeAwarePath: vi.fn((p: string) => p),
  resolveDefaultLogsDir: vi.fn(() => "/tmp/paperclip-test-logs"),
}));

describe("HTTP logger redaction", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function loadHttpLoggerOptions() {
    await import("../middleware/logger.js");
    expect(mockPinoHttp).toHaveBeenCalledOnce();
    return mockPinoHttp.mock.calls[0][0] as any;
  }

  it("redacts CLI auth challenge tokens from success and error messages", async () => {
    const options = await loadHttpLoggerOptions();
    const req = {
      method: "GET",
      url: "/api/cli-auth/challenges/challenge-1?token=pcp_cli_auth_test_secret&after=1",
    } as any;
    const res = { statusCode: 200 } as any;

    const successMessage = options.customSuccessMessage(req, res);
    const errorMessage = options.customErrorMessage(req, { ...res, statusCode: 404 }, new Error("not found"));

    expect(successMessage).toContain("token=[REDACTED]");
    expect(successMessage).toContain("after=1");
    expect(successMessage).not.toContain("pcp_cli_auth_test_secret");
    expect(errorMessage).toContain("token=[REDACTED]");
    expect(errorMessage).not.toContain("pcp_cli_auth_test_secret");
  });

  it("redacts sensitive query values from the structured request url", async () => {
    const options = await loadHttpLoggerOptions();
    const redirectUri = encodeURIComponent("https://example.test/callback?token=nested-secret&ok=1");
    const serializedReq = options.serializers.req({
      id: "req-1",
      method: "GET",
      url: `/api/example?access_token=secret-access-token&token=pcp_cli_auth_test_secret&token%5B%5D=bracket-secret&auth%5Btoken%5D=nested-bracket-secret&cursor=2&redirect_uri=${redirectUri}`,
      headers: {},
    });

    expect(serializedReq.url).toContain("access_token=[REDACTED]");
    expect(serializedReq.url).toContain("token=[REDACTED]");
    expect(serializedReq.url).toContain("token%5B%5D=[REDACTED]");
    expect(serializedReq.url).toContain("auth%5Btoken%5D=[REDACTED]");
    expect(serializedReq.url).toContain("redirect_uri=[REDACTED]");
    expect(serializedReq.url).toContain("cursor=2");
    expect(serializedReq.url).not.toContain("secret-access-token");
    expect(serializedReq.url).not.toContain("pcp_cli_auth_test_secret");
    expect(serializedReq.url).not.toContain("bracket-secret");
    expect(serializedReq.url).not.toContain("nested-bracket-secret");
    expect(serializedReq.url).not.toContain("nested-secret");
  });

  it("redacts token query fields from error custom props", async () => {
    const options = await loadHttpLoggerOptions();
    const props = options.customProps({
      query: {
        token: "pcp_cli_auth_test_secret",
        "token[]": "bracket-secret",
        "auth[token]": "nested-bracket-secret",
        redirect_uri: "https://example.test/callback?access_token=nested-secret&ok=1",
        cursor: "2",
      },
    } as any, { statusCode: 404 } as any);

    expect(props.reqQuery).toEqual({
      token: "[REDACTED]",
      "token[]": "[REDACTED]",
      "auth[token]": "[REDACTED]",
      redirect_uri: "[REDACTED]",
      cursor: "2",
    });
  });
});
