import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getQuotaWindows, readClaudeToken, readIsolatedClaudeKeychainToken } from "./quota.js";

const suffixedService = (dir: string) => `Claude Code-credentials-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
const UNSUFFIXED_LOOKUP = ["find-generic-password", "-s", "Claude Code-credentials", "-w"];
const mocks = vi.hoisted(() => ({ read: vi.fn(), exec: vi.fn(), spawn: vi.fn() }));
vi.mock("node:fs/promises", () => ({ default: { readFile: mocks.read } }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: mocks.exec }),
  spawn: mocks.spawn,
}));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Claude login lookup", () => {
  it("reads the default macOS login from the Keychain when no credentials file exists", async () => {
    // On macOS the CLI keeps the default login only in the Keychain, so a
    // passive read with no options must find it there or it finds nothing.
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    mocks.read.mockRejectedValue(new Error("missing"));
    mocks.exec.mockResolvedValue({ stdout: JSON.stringify({ claudeAiOauth: { accessToken: "fixture" } }) });
    await expect(readClaudeToken()).resolves.toBe("fixture");
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.exec).toHaveBeenCalledWith("/usr/bin/security", UNSUFFIXED_LOOKUP, expect.any(Object));
  });
  it("does not consult the Keychain off macOS", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    mocks.read.mockRejectedValue(new Error("missing"));
    await expect(readClaudeToken()).resolves.toBeNull();
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it("skips the Keychain when the caller asks for a file-only read", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    mocks.read.mockRejectedValue(new Error("missing"));
    await expect(readClaudeToken({ allowKeychain: false })).resolves.toBeNull();
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it("reads only the custom auth home's own suffixed Keychain item", async () => {
    // Claude Code stores a custom CLAUDE_CONFIG_DIR login in a per-directory
    // suffixed item; the unsuffixed item belongs to a different account and
    // must never be substituted, with or without options.
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/isolated/auth");
    mocks.read.mockRejectedValue(new Error("missing"));
    mocks.exec.mockResolvedValue({ stdout: JSON.stringify({ claudeAiOauth: { accessToken: "isolated" } }) });
    await expect(readClaudeToken()).resolves.toBe("isolated");
    await expect(readClaudeToken({ allowKeychain: true })).resolves.toBe("isolated");
    expect(mocks.exec).toHaveBeenCalledTimes(2);
    for (const call of mocks.exec.mock.calls) {
      expect(call[0]).toBe("/usr/bin/security");
      expect(call[1]).toEqual(["find-generic-password", "-s", suffixedService("/isolated/auth"), "-w"]);
    }
  });
  it("returns null for a custom auth home whose suffixed item is absent, without touching the unsuffixed item", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/isolated/auth");
    mocks.read.mockRejectedValue(new Error("missing"));
    mocks.exec.mockRejectedValue(new Error("The specified item could not be found in the keychain."));
    await expect(readClaudeToken()).resolves.toBeNull();
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.exec).toHaveBeenCalledWith("/usr/bin/security", ["find-generic-password", "-s", suffixedService("/isolated/auth"), "-w"], expect.any(Object));
  });
  it("readIsolatedClaudeKeychainToken reads the login home's suffixed item on macOS", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    mocks.exec.mockResolvedValue({ stdout: JSON.stringify({ claudeAiOauth: { accessToken: "isolated-keychain" } }) });
    await expect(readIsolatedClaudeKeychainToken("/data/ai-local-logins/abc")).resolves.toBe("isolated-keychain");
    expect(mocks.exec).toHaveBeenCalledWith("/usr/bin/security", ["find-generic-password", "-s", suffixedService("/data/ai-local-logins/abc"), "-w"], expect.any(Object));
  });
  it("readIsolatedClaudeKeychainToken returns null off macOS", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    await expect(readIsolatedClaudeKeychainToken("/data/ai-local-logins/abc")).resolves.toBeNull();
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it("skips an expired credentials file and falls through to the Keychain", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    mocks.read.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: "stale", expiresAt: Date.now() - 60_000 } }));
    mocks.exec.mockResolvedValue({ stdout: JSON.stringify({ claudeAiOauth: { accessToken: "fresh", expiresAt: Date.now() + 60_000 } }) });
    await expect(readClaudeToken()).resolves.toBe("fresh");
    expect(mocks.exec).toHaveBeenCalledTimes(1);
  });
  it("returns null for an expired credentials file off macOS", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    mocks.read.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: "stale", expiresAt: Date.now() - 60_000 } }));
    await expect(readClaudeToken()).resolves.toBeNull();
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it("still accepts a credentials file that records no expiry", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    mocks.read.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: "file" } }));
    await expect(readClaudeToken()).resolves.toBe("file");
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it("does not surface a credential-bearing subprocess error", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    mocks.read.mockRejectedValue(new Error("missing"));
    mocks.exec.mockRejectedValue(new Error("fixture-secret"));
    await expect(readClaudeToken()).resolves.toBeNull();
  });
});

describe("getQuotaWindows on a default macOS install", () => {
  it("polls the OAuth usage API with the Keychain login and never opens the interactive CLI", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "");
    vi.stubEnv("ANTHROPIC_BEDROCK_BASE_URL", "");
    mocks.read.mockRejectedValue(new Error("missing"));
    mocks.exec.mockImplementation(async (file: string) => {
      if (file === "claude") {
        return { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }) };
      }
      return { stdout: JSON.stringify({ claudeAiOauth: { accessToken: "keychain-token" } }) };
    });
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          five_hour: { utilization: 71, resets_at: "2026-10-04T15:00:00.000Z" },
          seven_day: { utilization: 12, resets_at: "2026-10-08T08:00:00.000Z" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getQuotaWindows();

    expect(result).toMatchObject({ provider: "anthropic", ok: true, source: "anthropic-oauth" });
    expect(result.windows.map((window) => [window.label, window.usedPercent])).toEqual([
      ["Current session", 71],
      ["Current week (all models)", 12],
    ]);
    expect(mocks.exec).toHaveBeenCalledWith("/usr/bin/security", UNSUFFIXED_LOOKUP, expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/usage",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer keychain-token" }) }),
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
