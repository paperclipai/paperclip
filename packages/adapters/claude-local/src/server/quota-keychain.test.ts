import { afterEach, describe, expect, it, vi } from "vitest";
import { readClaudeToken, readClaudeTokenFromConfigDirKeychain } from "./quota.js";
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
  it("never substitutes Keychain credentials for a custom auth home", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/isolated/auth");
    mocks.read.mockRejectedValue(new Error("missing"));
    await expect(readClaudeToken({ allowKeychain: true })).resolves.toBeNull();
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
describe("isolated config dir Keychain item", () => {
  it("reads only the item named for the config dir hash", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    mocks.exec.mockResolvedValue({ stdout: JSON.stringify({ claudeAiOauth: { accessToken: "isolated" } }) });
    const dir = "/Users/backlit/.paperclip/instances/default/ai-local-logins/9f8815e0-1345-49c9-a638-06ca4e3e38b4";
    await expect(readClaudeTokenFromConfigDirKeychain(dir)).resolves.toBe("isolated");
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.exec).toHaveBeenCalledWith("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials-59ba6fc3", "-w"], expect.any(Object));
  });
  it("does not consult Keychain off macOS", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    await expect(readClaudeTokenFromConfigDirKeychain("/isolated/auth")).resolves.toBeNull();
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it("does not surface a credential-bearing subprocess error", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    mocks.exec.mockRejectedValue(new Error("fixture-secret"));
    await expect(readClaudeTokenFromConfigDirKeychain("/isolated/auth")).resolves.toBeNull();
  });
});
