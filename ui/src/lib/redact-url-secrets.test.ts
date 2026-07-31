import { describe, expect, it } from "vitest";
import { redactUrlSecrets } from "./redact-url-secrets";

describe("redactUrlSecrets", () => {
  it("redacts credential-like query parameters while preserving useful URL context", () => {
    expect(
      redactUrlSecrets("https://mcp.zapier.com/api/v1/connect?token=zapier-secret&region=us"),
    ).toBe("https://mcp.zapier.com/api/v1/connect?token=REDACTED&region=us");
  });

  it("redacts common credential names case-insensitively", () => {
    expect(
      redactUrlSecrets("https://example.test/mcp?API_KEY=secret&access-token=other&mode=read"),
    ).toBe("https://example.test/mcp?API_KEY=REDACTED&access-token=REDACTED&mode=read");
  });

  it("redacts URL user info and credential-like hash parameters", () => {
    expect(
      redactUrlSecrets("mcp+https://user:password@example.test/connect#access_token=secret&state=safe"),
    ).toBe("mcp+https://REDACTED@example.test/connect#access_token=REDACTED&state=REDACTED");
  });

  it("redacts OAuth callback parameters", () => {
    expect(
      redactUrlSecrets("https://example.test/oauth/callback?code=secret&state=opaque&nonce=once"),
    ).toBe("https://example.test/oauth/callback?code=REDACTED&state=REDACTED&nonce=REDACTED");
  });

  it("falls back to masking secret assignments in non-standard URL text", () => {
    expect(redactUrlSecrets("connect to host?token=secret value")).toBe(
      "connect to host?token=REDACTED value",
    );
  });

  it("leaves ordinary URLs unchanged", () => {
    expect(redactUrlSecrets("https://example.test/mcp?workspace=paperclip&page=2")).toBe(
      "https://example.test/mcp?workspace=paperclip&page=2",
    );
  });
});
