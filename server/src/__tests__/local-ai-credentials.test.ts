import { afterEach, describe, expect, it, vi } from "vitest";
import { readVerifiedLocalAiCredential } from "../services/local-ai-credentials.js";
const mocks = vi.hoisted(() => ({ claude: vi.fn(), claudeIsolatedKeychain: vi.fn(), codex: vi.fn(), codexQuota: vi.fn(), readFile: vi.fn(), credentialFile: vi.fn() }));
vi.mock("@paperclipai/adapter-claude-local/server", () => ({ readClaudeToken: mocks.claude, readIsolatedClaudeKeychainToken: mocks.claudeIsolatedKeychain }));
vi.mock("@paperclipai/adapter-codex-local/server", () => ({ readCodexAuthInfo: mocks.codex, fetchCodexQuota: mocks.codexQuota }));
vi.mock("../services/local-ai-credential-file.js", () => ({ readLocalAiCredentialFile: mocks.credentialFile }));
vi.mock("node:fs/promises", () => ({ default: { readFile: mocks.readFile } }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });
describe("explicit local subscription import", () => {
  it("verifies Claude only from the selected isolated home, never the host account", async () => {
    mocks.credentialFile.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: "isolated-claude" } }));
    await expect(readVerifiedLocalAiCredential("anthropic", "/isolated/claude")).resolves.toBe("isolated-claude");
    expect(mocks.credentialFile).toHaveBeenCalledWith("/isolated/claude/.credentials.json");
    expect(mocks.claude).not.toHaveBeenCalled();
  });
  it("does not fall back to ambient Claude auth when an isolated login is absent or invalid", async () => {
    mocks.claude.mockResolvedValue("server-operator-token");
    mocks.claudeIsolatedKeychain.mockResolvedValue(null);
    mocks.credentialFile.mockRejectedValue(new Error("No file"));
    await expect(readVerifiedLocalAiCredential("anthropic", "/isolated/claude")).rejects.toThrow("Finish browser sign-in");
    mocks.credentialFile.mockResolvedValue("malformed");
    await expect(readVerifiedLocalAiCredential("anthropic", "/isolated/claude")).rejects.toThrow("Finish browser sign-in");
    expect(mocks.claude).not.toHaveBeenCalled();
    expect(mocks.claudeIsolatedKeychain).toHaveBeenCalledWith("/isolated/claude");
  });
  it("verifies a macOS isolated login from the home's suffixed Keychain item when no credentials file exists", async () => {
    // Claude Code on macOS stores an isolated login in the auth home's own
    // Keychain item, not a credentials file — the live onboarding failure
    // this covers. The ambient reader must stay untouched.
    mocks.credentialFile.mockRejectedValue(new Error("No file"));
    mocks.claudeIsolatedKeychain.mockResolvedValue("isolated-keychain-claude");
    await expect(readVerifiedLocalAiCredential("anthropic", "/isolated/claude")).resolves.toBe("isolated-keychain-claude");
    expect(mocks.claudeIsolatedKeychain).toHaveBeenCalledWith("/isolated/claude");
    expect(mocks.claude).not.toHaveBeenCalled();
  });
  it("prefers the credentials file over the Keychain for an isolated login", async () => {
    mocks.credentialFile.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: "file-token" } }));
    mocks.claudeIsolatedKeychain.mockResolvedValue("keychain-token");
    await expect(readVerifiedLocalAiCredential("anthropic", "/isolated/claude")).resolves.toBe("file-token");
    expect(mocks.claudeIsolatedKeychain).not.toHaveBeenCalled();
  });
  it("tries the alternate Claude filename after malformed JSON", async () => {
    mocks.credentialFile.mockResolvedValueOnce("malformed").mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: "alternate-token" } }));
    await expect(readVerifiedLocalAiCredential("anthropic", "/isolated/claude")).resolves.toBe("alternate-token");
    expect(mocks.credentialFile).toHaveBeenLastCalledWith("/isolated/claude/credentials.json");
    expect(mocks.claude).not.toHaveBeenCalled();
  });
  it("reads Codex refresh credentials only from the isolated login home", async () => {
    mocks.codex.mockResolvedValue({ accessToken: "access", refreshToken: "refresh", idToken: "identity", accountId: "account", lastRefresh: "date" });
    const result = JSON.parse(await readVerifiedLocalAiCredential("openai", "/isolated/login"));
    expect(result.tokens).toEqual({ access_token: "access", refresh_token: "refresh", id_token: "identity", account_id: "account" });
    expect(mocks.codexQuota).toHaveBeenCalledWith("access", "account");
    expect(mocks.codex).toHaveBeenCalledWith("/isolated/login");
  });
  it("verifies a Grok subscription against a fixed endpoint before saving", async () => {
    const credential = JSON.stringify({ "https://issuer.x.ai::11111111-1111-4111-8111-111111111111": { key: "fixture-key", refresh_token: "fixture-refresh" } });
    mocks.readFile.mockResolvedValue(credential);
    const fetch = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetch);
    await expect(readVerifiedLocalAiCredential("xai", "/isolated/grok")).resolves.toBe(credential);
    expect(mocks.readFile).toHaveBeenCalledWith("/isolated/grok/auth.json", "utf8");
    expect(fetch).toHaveBeenCalledWith("https://api.x.ai/v1/models", expect.objectContaining({ redirect: "error" }));
  });
  it("rejects missing and invalid logins with actionable, redacted errors", async () => {
    await expect(readVerifiedLocalAiCredential("anthropic")).rejects.toThrow("Start browser sign-in");
    mocks.credentialFile.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: "" } }));
    mocks.claudeIsolatedKeychain.mockResolvedValue(null);
    await expect(readVerifiedLocalAiCredential("anthropic", "/isolated/claude")).rejects.toThrow(/^Could not verify the local subscription\. Finish browser sign-in for this connection, then try Connect again\.$/);
    mocks.codex.mockResolvedValue({ accessToken: "incomplete" });
    await expect(readVerifiedLocalAiCredential("openai", "/isolated/login")).rejects.toThrow("Finish browser sign-in");
    expect(mocks.codexQuota).not.toHaveBeenCalled();
  });
  it.each(["anthropic", "openai", "xai"] as const)("never clones the ambient rotating %s login", async (provider) => {
    await expect(readVerifiedLocalAiCredential(provider)).rejects.toThrow(provider === "xai"
      ? "Start local sign-in"
      : "Start browser sign-in");
    expect(mocks.codex).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });
  it("verifies an Antigravity subscription from the isolated login home", async () => {
    const validToken = JSON.stringify({
      token: {
        access_token: "agy-access",
        refresh_token: "agy-refresh",
        expiry: new Date(Date.now() + 3600000).toISOString(),
      },
    });
    mocks.readFile.mockResolvedValue(validToken);
    await expect(readVerifiedLocalAiCredential("antigravity", "/isolated/agy")).resolves.toBe(validToken);
    expect(mocks.readFile).toHaveBeenCalledWith("/isolated/agy/.gemini/antigravity-cli/antigravity-oauth-token", "utf8");
  });
  it("rejects an expired Antigravity token that lacks a refresh token", async () => {
    const expiredToken = JSON.stringify({
      access_token: "agy-access",
      expiry: new Date(Date.now() - 3600000).toISOString(),
    });
    mocks.readFile.mockResolvedValue(expiredToken);
    await expect(readVerifiedLocalAiCredential("antigravity", "/isolated/agy")).rejects.toThrow("sign-in command shown");
  });
});
