import { describe, expect, it, vi } from "vitest";
import {
  claudeAccessTokenOf, claudeRefreshDue, ClaudeOauthRefreshError, CLAUDE_OAUTH_CLIENT_ID, CLAUDE_OAUTH_TOKEN_URL,
  CLAUDE_REFRESH_MARGIN_MS, parseStoredClaudeOauth, refreshClaudeOauth, serializeClaudeOauth,
} from "../services/claude-oauth-credential.js";

const HOUR = 60 * 60 * 1000;
const oauth = { accessToken: "access-0", refreshToken: "refresh-0", expiresAt: 8 * HOUR, scopes: ["user:inference"], subscriptionType: "max" };
const stored = JSON.stringify({ claudeAiOauth: oauth });

describe("Claude OAuth credential", () => {
  it("treats a plain token as a legacy value that never refreshes", () => {
    expect(parseStoredClaudeOauth("sk-ant-oat01-plain")).toBeNull();
    expect(claudeAccessTokenOf("sk-ant-oat01-plain")).toBe("sk-ant-oat01-plain");
  });

  it("rejects documents that cannot be renewed", () => {
    expect(parseStoredClaudeOauth("{")).toBeNull();
    expect(parseStoredClaudeOauth(JSON.stringify({ tokens: { access_token: "codex" } }))).toBeNull();
    expect(serializeClaudeOauth({ accessToken: "a", expiresAt: 1 })).toBeNull();
    expect(serializeClaudeOauth({ accessToken: "a", refreshToken: "r", expiresAt: "soon" })).toBeNull();
  });

  it("round-trips the renewable document and exposes only the access token to runs", () => {
    const serialized = serializeClaudeOauth({ ...oauth, extra: "dropped" })!;
    expect(parseStoredClaudeOauth(serialized)).toEqual(oauth);
    expect(claudeAccessTokenOf(serialized)).toBe("access-0");
  });

  it("is due once the token is inside the refresh margin", () => {
    const parsed = parseStoredClaudeOauth(stored)!;
    expect(claudeRefreshDue(parsed, 0)).toBe(false);
    expect(claudeRefreshDue(parsed, 8 * HOUR - CLAUDE_REFRESH_MARGIN_MS)).toBe(true);
    expect(claudeRefreshDue(parsed, 8.5 * HOUR)).toBe(true);
  });

  it("exchanges the refresh token and stores the rotated pair", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 28800, scope: "user:inference" }));
    const next = await refreshClaudeOauth(parseStoredClaudeOauth(stored)!, { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 7 * HOUR });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CLAUDE_OAUTH_TOKEN_URL);
    expect(JSON.parse(String(init.body))).toEqual({
      grant_type: "refresh_token", refresh_token: "refresh-0", client_id: CLAUDE_OAUTH_CLIENT_ID, scope: "user:inference",
    });
    expect(parseStoredClaudeOauth(next)).toMatchObject({
      accessToken: "access-1", refreshToken: "refresh-1", expiresAt: 7 * HOUR + 28800 * 1000, subscriptionType: "max",
    });
  });

  it("is due at once for a broad login token, until the provider has refused to narrow it", () => {
    const broad = parseStoredClaudeOauth(JSON.stringify({ claudeAiOauth: { ...oauth, scopes: ["user:inference", "org:create_api_key"] } }))!;
    expect(claudeRefreshDue(broad, 0)).toBe(true);
    expect(claudeRefreshDue({ ...broad, scopeNarrowingRefused: true }, 0)).toBe(false);
    expect(claudeRefreshDue({ ...broad, scopes: undefined }, 0)).toBe(false);
  });

  it("asks the provider for inference only and keeps what it grants", async () => {
    const broad = parseStoredClaudeOauth(JSON.stringify({ claudeAiOauth: { ...oauth, scopes: ["user:inference", "org:create_api_key", "user:profile"] } }))!;
    const fetchImpl = vi.fn(async () => Response.json({ access_token: "access-1", expires_in: 3600 }));
    const next = await refreshClaudeOauth(broad, { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 });
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)).scope).toBe("user:inference");
    expect(parseStoredClaudeOauth(next)).toMatchObject({ scopes: ["user:inference"] });
    expect(parseStoredClaudeOauth(next)?.scopeNarrowingRefused).toBeUndefined();
  });

  it("marks the token when the provider returns broad scopes anyway, and does not retry", async () => {
    const broad = parseStoredClaudeOauth(JSON.stringify({ claudeAiOauth: { ...oauth, scopes: ["user:inference", "org:create_api_key"] } }))!;
    const fetchImpl = vi.fn(async () => Response.json({ access_token: "access-1", expires_in: 28800, scope: "user:inference org:create_api_key" }));
    const next = parseStoredClaudeOauth(await refreshClaudeOauth(broad, { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 }))!;
    expect(next.scopeNarrowingRefused).toBe(true);
    expect(claudeRefreshDue(next, 0)).toBe(false);
  });

  it("treats a refused narrowing as a refused scope, not a revoked login, only for invalid_scope", async () => {
    const broad = parseStoredClaudeOauth(JSON.stringify({ claudeAiOauth: { ...oauth, scopes: ["user:inference", "org:create_api_key"] } }))!;
    const fetchImpl = vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
    const error = await refreshClaudeOauth(broad, { fetchImpl: fetchImpl as unknown as typeof fetch }).catch(e => e);
    expect(error.rejected).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous refresh token when the provider does not rotate it", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ access_token: "access-1", expires_in: 3600 }));
    const next = await refreshClaudeOauth(parseStoredClaudeOauth(stored)!, { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 });
    expect(parseStoredClaudeOauth(next)).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-0", expiresAt: HOUR });
  });

  it.each([[400, true], [401, true], [403, true], [429, false], [500, false]])("classifies HTTP %i as rejected=%s", async (status, rejected) => {
    const fetchImpl = vi.fn(async () => new Response("secret refresh-0 body", { status }));
    const error = await refreshClaudeOauth(parseStoredClaudeOauth(stored)!, { fetchImpl: fetchImpl as unknown as typeof fetch }).catch(e => e);
    expect(error).toBeInstanceOf(ClaudeOauthRefreshError);
    expect(error.rejected).toBe(rejected);
    expect(error.message).not.toContain("refresh-0");
  });

  it("does not echo credentials when the response is malformed or the network fails", async () => {
    for (const fetchImpl of [
      vi.fn(async () => Response.json({ access_token: "access-1" })),
      vi.fn(async () => new Response("not json")),
      vi.fn(async () => { throw new Error("connect failed for refresh-0"); }),
    ]) {
      const error = await refreshClaudeOauth(parseStoredClaudeOauth(stored)!, { fetchImpl: fetchImpl as unknown as typeof fetch }).catch(e => e);
      expect(error).toBeInstanceOf(ClaudeOauthRefreshError);
      expect(error.rejected).toBe(false);
      expect(error.message).not.toMatch(/refresh-0|access-1/);
    }
  });
});
