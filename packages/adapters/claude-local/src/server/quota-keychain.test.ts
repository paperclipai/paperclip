import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readClaudeToken, readIsolatedClaudeKeychainToken } from "./quota.js";

const suffixedService = (dir: string) => `Claude Code-credentials-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
const mocks = vi.hoisted(() => ({ read: vi.fn(), exec: vi.fn() }));
vi.mock("node:fs/promises", () => ({ default: { readFile: mocks.read } }));
vi.mock("node:child_process", () => ({ execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: mocks.exec }) }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("explicit Claude Keychain import", () => {
  it("does not consult Keychain during passive reads", async () => {
    mocks.read.mockRejectedValue(new Error("missing"));
    await expect(readClaudeToken()).resolves.toBeNull();
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it("reads the macOS login only after explicit opt-in", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    mocks.read.mockRejectedValue(new Error("missing"));
    mocks.exec.mockResolvedValue({ stdout: JSON.stringify({ claudeAiOauth: { accessToken: "fixture" } }) });
    await expect(readClaudeToken({ allowKeychain: true })).resolves.toBe("fixture");
    expect(mocks.exec).toHaveBeenCalledWith("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], expect.any(Object));
  });
  it("reads only the custom auth home's own suffixed Keychain item", async () => {
    // Claude Code stores a custom CLAUDE_CONFIG_DIR login in a per-directory
    // suffixed item; the unsuffixed item belongs to a different account and
    // must never be substituted.
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/isolated/auth");
    mocks.read.mockRejectedValue(new Error("missing"));
    mocks.exec.mockResolvedValue({ stdout: JSON.stringify({ claudeAiOauth: { accessToken: "isolated" } }) });
    await expect(readClaudeToken({ allowKeychain: true })).resolves.toBe("isolated");
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.exec).toHaveBeenCalledWith("/usr/bin/security", ["find-generic-password", "-s", suffixedService("/isolated/auth"), "-w"], expect.any(Object));
  });
  it("returns null for a custom auth home whose suffixed item is absent, without touching the unsuffixed item", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/isolated/auth");
    mocks.read.mockRejectedValue(new Error("missing"));
    mocks.exec.mockRejectedValue(new Error("The specified item could not be found in the keychain."));
    await expect(readClaudeToken({ allowKeychain: true })).resolves.toBeNull();
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
  it("skips an expired credentials file and falls through to Keychain", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    mocks.read.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: "stale", expiresAt: Date.now() - 60_000 } }));
    mocks.exec.mockResolvedValue({ stdout: JSON.stringify({ claudeAiOauth: { accessToken: "fresh", expiresAt: Date.now() + 60_000 } }) });
    await expect(readClaudeToken({ allowKeychain: true })).resolves.toBe("fresh");
    expect(mocks.exec).toHaveBeenCalledTimes(1);
  });
  it("returns null for an expired credentials file without Keychain access", async () => {
    mocks.read.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: "stale", expiresAt: Date.now() - 60_000 } }));
    await expect(readClaudeToken()).resolves.toBeNull();
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it("still accepts a credentials file that records no expiry", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    mocks.read.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: "file" } }));
    await expect(readClaudeToken({ allowKeychain: true })).resolves.toBe("file");
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it("does not surface a credential-bearing subprocess error", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    mocks.read.mockRejectedValue(new Error("missing"));
    mocks.exec.mockRejectedValue(new Error("fixture-secret"));
    await expect(readClaudeToken({ allowKeychain: true })).resolves.toBeNull();
  });
});
