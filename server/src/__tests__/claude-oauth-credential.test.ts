import { describe, expect, it, vi } from "vitest";
import { claudeAccessTokenOf, claudeRefreshDue, parseStoredClaudeOauth, refreshClaudeOauth, serializeClaudeOauth } from "../services/claude-oauth-credential.js";

const now = 1_800_000_000_000;
const stored = { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: now + 28800_000, scopes: ["user:inference", "user:profile"], subscriptionType: "max" };
describe("Claude OAuth credential", () => {
  it("keeps refresh fields and uses only the access token for execution", () => {
    const raw = serializeClaudeOauth({ ...stored, unrelated: "discard" })!;
    expect(JSON.parse(raw)).toEqual({ claudeAiOauth: stored });
    expect(claudeAccessTokenOf(raw)).toBe(stored.accessToken);
    expect(claudeAccessTokenOf("legacy-token")).toBe("legacy-token");
    expect(serializeClaudeOauth({ accessToken: "setup-token" })).toBeNull();
    expect(parseStoredClaudeOauth("{invalid")).toBeNull();
    expect(claudeRefreshDue(stored, now)).toBe(false);
    expect(claudeRefreshDue(stored, now + 7 * 3600_000)).toBe(true);
  });
  it("keeps the rotated pair, expiry, scopes and subscription metadata", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 28800 })));
    const next = await refreshClaudeOauth(stored, { fetchImpl, now: () => now });
    expect(parseStoredClaudeOauth(next)).toEqual({ ...stored, accessToken: "new-access", refreshToken: "new-refresh" });
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://platform.claude.com/v1/oauth/token");
    expect(request.redirect).toBe("error");
    expect(JSON.parse(request.body)).toMatchObject({ grant_type: "refresh_token", refresh_token: stored.refreshToken, scope: "user:inference user:profile" });
  });
  it.each([0, -1, 400 * 86400 + 1, "28800"])("rejects an invalid expires_in (%s)", async expires_in => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "private-token", expires_in })));
    await expect(refreshClaudeOauth(stored, { fetchImpl })).rejects.toThrow("unexpected response");
  });
  it.each([400, 401, 403, 503])("redacts provider failure bodies (HTTP %s)", async status => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("private-response", { status }));
    await expect(refreshClaudeOauth(stored, { fetchImpl })).rejects.toMatchObject({ rejected: status !== 503, message: `Claude token refresh failed with HTTP ${status}` });
  });
});
