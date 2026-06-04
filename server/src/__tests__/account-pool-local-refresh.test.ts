import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for ensureFreshLocalToken — the default (local) account's
 * refresh-on-use (Option 2: refresh + write the fresh blob back to the file).
 *
 * The on-disk read/write and the OAuth refresh are mocked so we can assert the
 * decision logic and the write-back shape without touching the filesystem or
 * the network.
 */

const readClaudeCredentialFile = vi.fn();
const writeClaudeCredentialFile = vi.fn();
const oauthRefreshToken = vi.fn();

vi.mock("@paperclipai/adapter-claude-local/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-claude-local/server")>();
  return {
    ...actual,
    readClaudeCredentialFile: (...args: unknown[]) => readClaudeCredentialFile(...args),
    writeClaudeCredentialFile: (...args: unknown[]) => writeClaudeCredentialFile(...args),
  };
});

vi.mock("../services/claude-oauth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/claude-oauth.js")>();
  return { ...actual, refreshToken: (...args: unknown[]) => oauthRefreshToken(...args) };
});

const { ensureFreshLocalToken } = await import("../services/account-pool.js");

function credFile(over: Record<string, unknown> = {}) {
  return {
    filePath: "/paperclip/.claude/.credentials.json",
    raw: { claudeAiOauth: {}, someOtherKey: "keep-me" },
    oauth: { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 0, scopes: ["a"] },
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 0,
    ...over,
  };
}

describe("ensureFreshLocalToken (default account refresh-on-use)", () => {
  beforeEach(() => {
    readClaudeCredentialFile.mockReset();
    writeClaudeCredentialFile.mockReset();
    oauthRefreshToken.mockReset();
  });

  it("no file login → returns null token, no refresh, no write", async () => {
    readClaudeCredentialFile.mockResolvedValue(null);
    const res = await ensureFreshLocalToken();
    expect(res).toEqual({ accessToken: null, refreshed: false, error: null });
    expect(oauthRefreshToken).not.toHaveBeenCalled();
    expect(writeClaudeCredentialFile).not.toHaveBeenCalled();
  });

  it("token still valid (far from expiry) → returns it without refreshing", async () => {
    const future = Date.now() + 60 * 60 * 1000; // +1h, well past the 5-min buffer
    readClaudeCredentialFile.mockResolvedValue(
      credFile({ expiresAt: future, oauth: { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: future, scopes: ["a"] } }),
    );
    const res = await ensureFreshLocalToken();
    expect(res).toEqual({ accessToken: "old-access", refreshed: false, error: null });
    expect(oauthRefreshToken).not.toHaveBeenCalled();
    expect(writeClaudeCredentialFile).not.toHaveBeenCalled();
  });

  it("expired token → refreshes, writes the fresh blob back, returns new token", async () => {
    readClaudeCredentialFile.mockResolvedValue(credFile({ expiresAt: Date.now() - 60 * 60 * 1000 }));
    oauthRefreshToken.mockResolvedValue({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: 9_999_999_999_999,
      scopes: ["b", "c"],
      email: null,
      organizationName: null,
    });

    const res = await ensureFreshLocalToken();

    expect(oauthRefreshToken).toHaveBeenCalledWith("old-refresh");
    expect(res).toEqual({ accessToken: "new-access", refreshed: true, error: null });

    expect(writeClaudeCredentialFile).toHaveBeenCalledTimes(1);
    const [path, json] = writeClaudeCredentialFile.mock.calls[0] as [string, string];
    expect(path).toBe("/paperclip/.claude/.credentials.json");
    const written = JSON.parse(json);
    expect(written.someOtherKey).toBe("keep-me"); // preserves unknown top-level keys
    expect(written.claudeAiOauth).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh", // rotated refresh token persisted
      expiresAt: 9_999_999_999_999,
      scopes: ["b", "c"],
    });
  });

  it("keeps the old refresh token when the refresh response omits a new one", async () => {
    readClaudeCredentialFile.mockResolvedValue(credFile({ expiresAt: Date.now() - 1000 }));
    oauthRefreshToken.mockResolvedValue({
      accessToken: "new-access",
      refreshToken: null,
      expiresAt: 123,
      scopes: [],
      email: null,
      organizationName: null,
    });

    await ensureFreshLocalToken();
    const [, json] = writeClaudeCredentialFile.mock.calls[0] as [string, string];
    const written = JSON.parse(json);
    expect(written.claudeAiOauth.refreshToken).toBe("old-refresh");
    expect(written.claudeAiOauth.scopes).toEqual(["a"]); // falls back to existing scopes
  });

  it("refresh throws → falls back to the stale token, surfaces error, no write, never throws", async () => {
    readClaudeCredentialFile.mockResolvedValue(credFile({ expiresAt: Date.now() - 1000 }));
    oauthRefreshToken.mockRejectedValue(new Error("network down"));

    const res = await ensureFreshLocalToken();
    expect(res.accessToken).toBe("old-access");
    expect(res.refreshed).toBe(false);
    expect(res.error).toBe("network down");
    expect(writeClaudeCredentialFile).not.toHaveBeenCalled();
  });

  it("expired but no refresh token → returns stale token, no refresh attempt", async () => {
    readClaudeCredentialFile.mockResolvedValue(
      credFile({ refreshToken: null, expiresAt: Date.now() - 1000, oauth: { accessToken: "old-access", refreshToken: null, expiresAt: 0, scopes: [] } }),
    );
    const res = await ensureFreshLocalToken();
    expect(res).toEqual({ accessToken: "old-access", refreshed: false, error: null });
    expect(oauthRefreshToken).not.toHaveBeenCalled();
    expect(writeClaudeCredentialFile).not.toHaveBeenCalled();
  });
});
