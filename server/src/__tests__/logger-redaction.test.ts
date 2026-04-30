import { describe, expect, it, vi } from "vitest";

/**
 * Regression tests for https://github.com/paperclipai/paperclip/issues/4759
 *
 * The HTTP logger middleware writes the entire request body to logs (stdout
 * and on-disk server.log) on any 4xx/5xx response. The original config only
 * redacted `req.headers.authorization`, so plaintext passwords from failed
 * sign-ins, password-reset tokens, adapter API keys, and other secrets in
 * request bodies / query strings / sensitive headers were persisted to disk.
 *
 * These tests pin the redaction contract:
 *   - Sensitive fields in `reqBody` / `reqParams` / `reqQuery` are scrubbed.
 *   - Sensitive headers and query-string params are scrubbed.
 *   - `/api/auth/*` failures drop `reqBody` entirely (the upstream library's
 *     body shape evolves, so an allowlist of field names is fragile).
 *   - Non-sensitive fields are preserved so logs remain useful for debugging.
 *   - Oversized bodies are sentinel-replaced rather than walked, bounding the
 *     cost of redaction and the risk of log-flood DoS.
 */

// Mirror logger-tz.test.ts: stub the transport machinery so importing the
// module does not spawn pino worker threads or touch the filesystem.
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
  stdSerializers: {
    req: (req: any) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      headers: req.headers,
    }),
  },
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

const REDACTED = "***REDACTED***";

async function loadModule() {
  return await import("../middleware/logger.js");
}

describe("scrubUrl", () => {
  it("redacts sensitive query-string params (token, access_token, api_key, password, code, state)", async () => {
    const { scrubUrl } = await loadModule();
    expect(scrubUrl("/api/auth/reset?token=eyJabc.def.ghi")).toContain(REDACTED);
    expect(scrubUrl("/api/auth/reset?token=eyJabc.def.ghi")).not.toContain("eyJabc");
    expect(scrubUrl("/x?access_token=abc&keep=1")).toContain(REDACTED);
    expect(scrubUrl("/x?access_token=abc&keep=1")).toContain("keep=1");
    expect(scrubUrl("/x?api_key=sk-secret123456789012345")).toContain(REDACTED);
    expect(scrubUrl("/x?password=hunter2")).toContain(REDACTED);
    expect(scrubUrl("/oauth/cb?code=abc&state=xyz")).not.toMatch(/code=abc|state=xyz/);
  });

  it("preserves the path and non-sensitive params", async () => {
    const { scrubUrl } = await loadModule();
    const out = scrubUrl("/api/issues?status=open&limit=10");
    expect(out).toBe("/api/issues?status=open&limit=10");
  });

  it("scrubs JWT-shaped tokens embedded anywhere in the URL via redactSensitiveText", async () => {
    const { scrubUrl } = await loadModule();
    const url = "/cb/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payloadclaim.signaturepart";
    expect(scrubUrl(url)).toContain(REDACTED);
    expect(scrubUrl(url)).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("returns input unchanged on empty / unparseable URL without throwing", async () => {
    const { scrubUrl } = await loadModule();
    expect(scrubUrl("")).toBe("");
    expect(typeof scrubUrl("not a url at all")).toBe("string");
  });
});

describe("redactHeaders", () => {
  it("scrubs authorization, cookie, set-cookie, x-api-key, proxy-authorization (case-insensitive)", async () => {
    const { redactHeaders } = await loadModule();
    const out = redactHeaders({
      Authorization: "Bearer abc123",
      cookie: "session=xyz",
      "Set-Cookie": "id=1",
      "X-API-Key": "sk-secret-key-123",
      "Proxy-Authorization": "Basic abc",
      "user-agent": "vitest",
      host: "localhost",
    }) as Record<string, unknown>;
    expect(out.Authorization).toBe(REDACTED);
    expect(out.cookie).toBe(REDACTED);
    expect(out["Set-Cookie"]).toBe(REDACTED);
    expect(out["X-API-Key"]).toBe(REDACTED);
    expect(out["Proxy-Authorization"]).toBe(REDACTED);
    expect(out["user-agent"]).toBe("vitest");
    expect(out.host).toBe("localhost");
  });

  it("returns input unchanged for non-object input", async () => {
    const { redactHeaders } = await loadModule();
    expect(redactHeaders(undefined)).toBeUndefined();
    expect(redactHeaders(null)).toBeNull();
    expect(redactHeaders("nope")).toBe("nope");
  });
});

describe("isAuthPath", () => {
  it("matches /api/auth/* and rejects unrelated paths", async () => {
    const { isAuthPath } = await loadModule();
    expect(isAuthPath("/api/auth/sign-in/email")).toBe(true);
    expect(isAuthPath("/api/auth/reset-password")).toBe(true);
    expect(isAuthPath("/api/auth/")).toBe(true);
    expect(isAuthPath("/api/issues")).toBe(false);
    expect(isAuthPath("/auth/sign-in")).toBe(false);
    expect(isAuthPath(undefined)).toBe(false);
  });
});

describe("redactBodyForLog", () => {
  it("redacts top-level password, currentPassword, newPassword, token, apiKey, secret", async () => {
    const { redactBodyForLog } = await loadModule();
    const out = redactBodyForLog({
      email: "user@example.com",
      password: "hunter2",
      currentPassword: "old-pass",
      newPassword: "new-pass",
      token: "reset-token-abc",
      apiKey: "sk-secret",
      secret: "shh",
    }) as Record<string, unknown>;
    expect(out.email).toBe("user@example.com");
    expect(out.password).toBe(REDACTED);
    expect(out.currentPassword).toBe(REDACTED);
    expect(out.newPassword).toBe(REDACTED);
    expect(out.token).toBe(REDACTED);
    expect(out.apiKey).toBe(REDACTED);
    expect(out.secret).toBe(REDACTED);
  });

  it("redacts deeply nested adapter env API keys", async () => {
    const { redactBodyForLog } = await loadModule();
    const out = redactBodyForLog({
      config: {
        adapters: [
          { name: "openai", env: { OPENAI_API_KEY: "sk-abc-very-secret-1234567890" } },
          { name: "claude", env: { ANTHROPIC_API_KEY: "sk-ant-abc-1234567890" } },
        ],
      },
    });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("sk-abc-very-secret-1234567890");
    expect(serialized).not.toContain("sk-ant-abc-1234567890");
    expect(serialized).toContain(REDACTED);
  });

  it("preserves non-sensitive fields (email, name, ids)", async () => {
    const { redactBodyForLog } = await loadModule();
    const out = redactBodyForLog({
      email: "user@example.com",
      name: "Alice",
      id: "abc-123",
    }) as Record<string, unknown>;
    expect(out.email).toBe("user@example.com");
    expect(out.name).toBe("Alice");
    expect(out.id).toBe("abc-123");
  });

  it("returns sentinel for bodies larger than the size cap (no walk, no throw)", async () => {
    const { redactBodyForLog, MAX_LOGGED_BODY_BYTES } = await loadModule();
    const padding = "x".repeat(MAX_LOGGED_BODY_BYTES + 1);
    const out = redactBodyForLog({ password: "hunter2", padding });
    expect(out).toBe("[omitted: body too large]");
  });

  it("passes through null, undefined, and primitives", async () => {
    const { redactBodyForLog } = await loadModule();
    expect(redactBodyForLog(null)).toBeNull();
    expect(redactBodyForLog(undefined)).toBeUndefined();
    expect(redactBodyForLog("plain string")).toBe("plain string");
    expect(redactBodyForLog(42)).toBe(42);
  });

  it("walks array bodies and redacts records inside them", async () => {
    const { redactBodyForLog } = await loadModule();
    const out = redactBodyForLog([
      { id: 1, password: "p1" },
      { id: 2, apiKey: "sk-2" },
    ]) as Array<Record<string, unknown>>;
    expect(out[0].password).toBe(REDACTED);
    expect(out[0].id).toBe(1);
    expect(out[1].apiKey).toBe(REDACTED);
  });
});

describe("buildErrorLogProps", () => {
  it("returns empty object for 2xx/3xx responses", async () => {
    const { buildErrorLogProps } = await loadModule();
    expect(buildErrorLogProps({ url: "/x", body: { password: "p" } }, { statusCode: 200 })).toEqual({});
    expect(buildErrorLogProps({ url: "/x", body: { password: "p" } }, { statusCode: 302 })).toEqual({});
  });

  it("redacts password in 401 sign-in body via the auth-path bypass (omits reqBody entirely)", async () => {
    const { buildErrorLogProps } = await loadModule();
    const out = buildErrorLogProps(
      {
        originalUrl: "/api/auth/sign-in/email",
        url: "/api/auth/sign-in/email",
        body: { email: "user@example.com", password: "hunter2" },
      },
      { statusCode: 401 },
    );
    expect(out.reqBody).toBeUndefined();
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("hunter2");
  });

  it("redacts deeply nested apiKey on a 400 outside /api/auth/*", async () => {
    const { buildErrorLogProps } = await loadModule();
    const out = buildErrorLogProps(
      {
        originalUrl: "/api/companies/abc/agents",
        url: "/api/companies/abc/agents",
        body: {
          adapterConfig: { env: { OPENAI_API_KEY: "sk-leaky-key-1234567890" } },
        },
      },
      { statusCode: 400 },
    );
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("sk-leaky-key-1234567890");
    expect(serialized).toContain(REDACTED);
  });

  it("omits reqBody entirely on /api/auth/reset-password 4xx (skipBody applies)", async () => {
    const { buildErrorLogProps } = await loadModule();
    const out = buildErrorLogProps(
      {
        originalUrl: "/api/auth/reset-password",
        url: "/api/auth/reset-password",
        body: { token: "reset-abc", currentPassword: "old", newPassword: "new" },
      },
      { statusCode: 400 },
    );
    expect(out.reqBody).toBeUndefined();
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("reset-abc");
  });

  it("redacts via __errorContext path on 500 (preserves error message)", async () => {
    const { buildErrorLogProps } = await loadModule();
    const out = buildErrorLogProps(
      { originalUrl: "/api/x", url: "/api/x" },
      {
        statusCode: 500,
        __errorContext: {
          error: { message: "boom", name: "Error" },
          reqBody: { password: "leak-me" },
          reqParams: {},
          reqQuery: { token: "qs-leak" },
        },
      },
    );
    expect(out.errorContext).toEqual({ message: "boom", name: "Error" });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("leak-me");
    expect(serialized).not.toContain("qs-leak");
    expect(serialized).toContain("boom");
  });

  it("preserves non-sensitive fields and routePath in 4xx props", async () => {
    const { buildErrorLogProps } = await loadModule();
    const out = buildErrorLogProps(
      {
        originalUrl: "/api/issues",
        url: "/api/issues",
        body: { email: "a@b.com", name: "Alice" },
        route: { path: "/api/issues" },
      },
      { statusCode: 400 },
    ) as Record<string, unknown>;
    expect(out.routePath).toBe("/api/issues");
    const reqBody = out.reqBody as Record<string, unknown>;
    expect(reqBody.email).toBe("a@b.com");
    expect(reqBody.name).toBe("Alice");
  });

  it("redacts reqQuery containing sensitive params on non-auth paths", async () => {
    const { buildErrorLogProps } = await loadModule();
    const out = buildErrorLogProps(
      {
        originalUrl: "/api/x",
        url: "/api/x",
        query: { token: "qs-token-abc", limit: "10" },
      },
      { statusCode: 400 },
    ) as Record<string, unknown>;
    const reqQuery = out.reqQuery as Record<string, unknown>;
    expect(reqQuery.token).toBe(REDACTED);
    expect(reqQuery.limit).toBe("10");
  });
});
