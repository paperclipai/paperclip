import { describe, expect, it, vi, beforeEach } from "vitest";

// Capture the customProps function injected into pinoHttp so we can call it directly.
let capturedCustomProps: ((req: any, res: any) => Record<string, unknown>) | undefined;

vi.mock("pino", () => ({
  default: Object.assign(
    vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() })),
    { transport: vi.fn(() => ({})) },
  ),
}));

vi.mock("pino-http", () => ({
  pinoHttp: vi.fn((opts: any) => {
    capturedCustomProps = opts.customProps;
    return vi.fn();
  }),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn() };
});

vi.mock("../config-file.js", () => ({ readConfigFile: vi.fn(() => null) }));
vi.mock("../home-paths.js", () => ({
  resolveHomeAwarePath: vi.fn((p: string) => p),
  resolveDefaultLogsDir: vi.fn(() => "/tmp/paperclip-test-logs"),
}));
vi.mock("../middleware/http-log-policy.js", () => ({
  shouldSilenceHttpSuccessLog: vi.fn(() => false),
}));

describe("HTTP logger body sanitization", () => {
  beforeEach(async () => {
    vi.resetModules();
    capturedCustomProps = undefined;
    await import("../middleware/logger.js");
  });

  it("redacts known sensitive fields from reqBody on 4xx responses", () => {
    const props = capturedCustomProps!(
      {
        url: "/api/companies/1/settings",
        body: { name: "Acme", apiKey: "sk-secret", password: "hunter2", email: "a@b.com" },
        params: {},
        query: {},
      },
      { statusCode: 400 },
    );

    expect((props.reqBody as any).apiKey).toBe("[REDACTED]");
    expect((props.reqBody as any).password).toBe("[REDACTED]");
    expect((props.reqBody as any).name).toBe("Acme");
    expect((props.reqBody as any).email).toBe("a@b.com");
  });

  it("does not log reqBody at all for /api/auth/* routes", () => {
    const props = capturedCustomProps!(
      {
        url: "/api/auth/sign-in/email",
        body: { email: "a@b.com", password: "hunter2" },
        params: {},
        query: {},
      },
      { statusCode: 401 },
    );

    expect(props.reqBody).toBeUndefined();
  });

  it("returns empty object for 2xx responses (no body logged)", () => {
    const props = capturedCustomProps!(
      { url: "/api/issues", body: { password: "hunter2" }, params: {}, query: {} },
      { statusCode: 200 },
    );

    expect(props).toEqual({});
  });

  it("redacts sensitive fields in __errorContext.reqBody", () => {
    const props = capturedCustomProps!(
      { url: "/api/companies/1/agents", body: {}, params: {}, query: {} },
      {
        statusCode: 422,
        __errorContext: {
          error: { message: "validation failed" },
          reqBody: { name: "Bot", secret: "top-secret" },
          reqParams: {},
          reqQuery: {},
        },
      },
    );

    expect((props.reqBody as any).secret).toBe("[REDACTED]");
    expect((props.reqBody as any).name).toBe("Bot");
  });
});
