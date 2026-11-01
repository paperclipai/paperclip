import { describe, expect, it } from "vitest";
import { createGmailMcpConfig, readConfigFromEnv } from "./config.js";

describe("Gmail MCP config", () => {
  it("reads OAuth credentials and records secret redactions", () => {
    const config = createGmailMcpConfig({
      clientId: "client-id-123",
      clientSecret: "client-secret-456",
      refreshToken: "refresh-token-789",
    });

    expect(config.credentials.clientId).toBe("client-id-123");
    expect(config.secretRedactions).toContain("client-secret-456");
    expect(config.secretRedactions).toContain("refresh-token-789");
    // The client ID is not secret (it's safe to log/display) and must never
    // be redacted out of error messages that would help debugging.
    expect(config.secretRedactions).not.toContain("client-id-123");
  });

  it("requires a non-empty client secret and refresh token", () => {
    expect(() =>
      createGmailMcpConfig({ clientId: "id", clientSecret: "", refreshToken: "token" })
    ).toThrow();
    expect(() =>
      createGmailMcpConfig({ clientId: "id", clientSecret: "secret", refreshToken: "" })
    ).toThrow();
  });

  it("reads credentials from the environment, with CLI args taking precedence", () => {
    const config = readConfigFromEnv(
      {
        GMAIL_CLIENT_ID: "env-client-id",
        GMAIL_CLIENT_SECRET: "env-client-secret",
        GMAIL_REFRESH_TOKEN: "env-refresh-token",
      } as NodeJS.ProcessEnv,
      ["--client-id", "cli-client-id"],
    );

    expect(config.credentials.clientId).toBe("cli-client-id");
    expect(config.credentials.clientSecret).toBe("env-client-secret");
    expect(config.credentials.refreshToken).toBe("env-refresh-token");
  });

  it("gives a actionable error when credentials are missing", () => {
    expect(() => readConfigFromEnv({} as NodeJS.ProcessEnv, [])).toThrow(
      /GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN/,
    );
  });
});
