import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  buildAuthorizeUrl,
  generatePkce,
  parsePastedCode,
  buildCredentialsBlob,
  CLAUDE_OAUTH,
  type ClaudeTokenResult,
} from "../services/claude-oauth.js";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("claude-oauth", () => {
  it("generatePkce: challenge = base64url(SHA256(verifier)); state == verifier", () => {
    const { codeVerifier, codeChallenge, state } = generatePkce();
    expect(codeVerifier.length).toBeGreaterThan(20);
    expect(state).toBe(codeVerifier);
    const expected = base64url(createHash("sha256").update(codeVerifier).digest());
    expect(codeChallenge).toBe(expected);
    // base64url has no padding/+//
    expect(codeChallenge).not.toMatch(/[+/=]/);
  });

  it("generatePkce produces unique verifiers", () => {
    expect(generatePkce().codeVerifier).not.toBe(generatePkce().codeVerifier);
  });

  it("buildAuthorizeUrl includes the required PKCE + client params", () => {
    const url = new URL(buildAuthorizeUrl("CHALLENGE", "STATE"));
    expect(url.origin + url.pathname).toBe(CLAUDE_OAUTH.authorizeUrl);
    expect(url.searchParams.get("code")).toBe("true");
    expect(url.searchParams.get("client_id")).toBe(CLAUDE_OAUTH.clientId);
    expect(url.searchParams.get("code_challenge")).toBe("CHALLENGE");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("STATE");
    expect(url.searchParams.get("redirect_uri")).toBe(CLAUDE_OAUTH.redirectUri);
  });

  it("parsePastedCode splits CODE#STATE and tolerates a bare code", () => {
    expect(parsePastedCode("abc123#xyz789")).toEqual({ code: "abc123", state: "xyz789" });
    expect(parsePastedCode("  abc123#xyz789  ")).toEqual({ code: "abc123", state: "xyz789" });
    expect(parsePastedCode("justcode")).toEqual({ code: "justcode", state: null });
  });

  it("buildCredentialsBlob emits the claudeAiOauth shape", () => {
    const token: ClaudeTokenResult = {
      accessToken: "sk-ant-oat01-x",
      refreshToken: "sk-ant-ort01-y",
      expiresAt: 123,
      scopes: ["user:inference"],
      email: "a@b.com",
      organizationName: "Org",
    };
    const parsed = JSON.parse(buildCredentialsBlob(token, "Claude Max"));
    expect(parsed.claudeAiOauth.accessToken).toBe("sk-ant-oat01-x");
    expect(parsed.claudeAiOauth.refreshToken).toBe("sk-ant-ort01-y");
    expect(parsed.claudeAiOauth.expiresAt).toBe(123);
    expect(parsed.claudeAiOauth.subscriptionType).toBe("Claude Max");
  });
});
