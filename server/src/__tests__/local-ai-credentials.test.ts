import { afterEach, describe, expect, it, vi } from "vitest";
import { readVerifiedLocalAiCredential } from "../services/local-ai-credentials.js";
const mocks = vi.hoisted(() => ({ claude: vi.fn(), claudeQuota: vi.fn(), codex: vi.fn(), codexQuota: vi.fn(), readFile: vi.fn(), credentialFile: vi.fn() }));
vi.mock("@paperclipai/adapter-claude-local/server", () => ({ readClaudeToken: mocks.claude, fetchClaudeQuota: mocks.claudeQuota }));
vi.mock("@paperclipai/adapter-codex-local/server", () => ({ readCodexAuthInfo: mocks.codex, fetchCodexQuota: mocks.codexQuota }));
vi.mock("../services/local-ai-credential-file.js", () => ({ readLocalAiCredentialFile: mocks.credentialFile }));
vi.mock("node:fs/promises", () => ({ default: { readFile: mocks.readFile } }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });
describe("explicit local subscription import", () => {
  it("verifies Claude only from the selected isolated home, never the host account", async () => {
    mocks.credentialFile.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: "isolated-claude" } }));
    await expect(readVerifiedLocalAiCredential("anthropic", "/isolated/claude")).resolves.toBe("isolated-claude");
    expect(mocks.credentialFile).toHaveBeenCalledWith("/isolated/claude/.credentials.json");
    expect(mocks.claudeQuota).toHaveBeenCalledWith("isolated-claude");
    expect(mocks.claude).not.toHaveBeenCalled();
  });
  it("does not fall back to ambient Claude auth when an isolated login is absent or invalid", async () => {
    mocks.claude.mockResolvedValue("server-operator-token");
    mocks.credentialFile.mockRejectedValue(new Error("No file"));
    await expect(readVerifiedLocalAiCredential("anthropic", "/isolated/claude")).rejects.toThrow("sign-in command shown");
    mocks.credentialFile.mockResolvedValue("malformed");
    await expect(readVerifiedLocalAiCredential("anthropic", "/isolated/claude")).rejects.toThrow("sign-in command shown");
    expect(mocks.claude).not.toHaveBeenCalled();
    expect(mocks.claudeQuota).not.toHaveBeenCalled();
  });
  it("tries the alternate Claude filename after malformed JSON", async () => {
    mocks.credentialFile.mockResolvedValueOnce("malformed").mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: "alternate-token" } }));
    await expect(readVerifiedLocalAiCredential("anthropic", "/isolated/claude")).resolves.toBe("alternate-token");
    expect(mocks.credentialFile).toHaveBeenLastCalledWith("/isolated/claude/credentials.json");
    expect(mocks.claude).not.toHaveBeenCalled();
  });
  it("verifies Claude's local credential, including explicit Keychain access", async () => {
    mocks.claude.mockResolvedValue("fixture-claude");
    await expect(readVerifiedLocalAiCredential("anthropic")).resolves.toBe("fixture-claude");
    expect(mocks.claude).toHaveBeenCalledWith({ allowKeychain: true });
    expect(mocks.claudeQuota).toHaveBeenCalledWith("fixture-claude");
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
    mocks.claude.mockResolvedValue(null);
    await expect(readVerifiedLocalAiCredential("anthropic")).rejects.toThrow("claude auth login");
    mocks.claude.mockResolvedValue("fixture-secret");
    mocks.claudeQuota.mockRejectedValue(new Error("credential fixture-secret rejected"));
    await expect(readVerifiedLocalAiCredential("anthropic")).rejects.toThrow(/^Could not verify the local subscription\. Run claude auth login in a terminal on the machine running Paperclip, then try Connect again\.$/);
    mocks.codex.mockResolvedValue({ accessToken: "incomplete" });
    await expect(readVerifiedLocalAiCredential("openai", "/isolated/login")).rejects.toThrow("sign-in command shown");
    expect(mocks.codexQuota).not.toHaveBeenCalled();
  });
  it.each(["openai", "xai"] as const)("never clones the ambient rotating %s login", async (provider) => {
    await expect(readVerifiedLocalAiCredential(provider)).rejects.toThrow("separate local sign-in");
    expect(mocks.codex).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });
});
