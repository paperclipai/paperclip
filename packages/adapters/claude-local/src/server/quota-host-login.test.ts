import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasUsableClaudeHostLogin } from "./quota.js";

const mocks = vi.hoisted(() => ({ read: vi.fn(), exec: vi.fn() }));
vi.mock("node:fs/promises", () => ({ default: { readFile: mocks.read } }));
vi.mock("node:child_process", () => ({ execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: mocks.exec }) }));

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const credentials = (oauth: Record<string, unknown>) => JSON.stringify({ claudeAiOauth: oauth });

beforeEach(() => { vi.stubEnv("CLAUDE_CONFIG_DIR", "/host/.claude"); });
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("hasUsableClaudeHostLogin", () => {
  it("accepts a live access token", async () => {
    mocks.read.mockResolvedValue(credentials({ accessToken: "a", expiresAt: NOW + HOUR }));
    await expect(hasUsableClaudeHostLogin(NOW)).resolves.toBe(true);
    expect(mocks.read).toHaveBeenCalledWith(path.join("/host/.claude", ".credentials.json"), "utf8");
  });
  it("accepts an expired access token while the refresh token is live", async () => {
    // The CLI refreshes the access token on its next run, so the login is
    // still usable between refreshes.
    mocks.read.mockResolvedValue(credentials({ accessToken: "a", expiresAt: NOW - HOUR, refreshToken: "r" }));
    await expect(hasUsableClaudeHostLogin(NOW)).resolves.toBe(true);
  });
  it("rejects an expired access token with no refresh token", async () => {
    mocks.read.mockResolvedValue(credentials({ accessToken: "a", expiresAt: NOW - HOUR }));
    await expect(hasUsableClaudeHostLogin(NOW)).resolves.toBe(false);
  });
  it("rejects an expired access token whose refresh token has expired too", async () => {
    mocks.read.mockResolvedValue(credentials({
      accessToken: "a",
      expiresAt: NOW - HOUR,
      refreshToken: "r",
      refreshTokenExpiresAt: NOW - HOUR,
    }));
    await expect(hasUsableClaudeHostLogin(NOW)).resolves.toBe(false);
  });
  it("falls back to credentials.json when .credentials.json is missing", async () => {
    mocks.read.mockImplementation(async (file: string) => {
      if (file.endsWith(`${path.sep}.credentials.json`)) throw new Error("missing");
      return credentials({ accessToken: "a" });
    });
    await expect(hasUsableClaudeHostLogin(NOW)).resolves.toBe(true);
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
  it("rejects a missing, corrupt, or empty credentials file", async () => {
    mocks.read.mockRejectedValue(new Error("missing"));
    await expect(hasUsableClaudeHostLogin(NOW)).resolves.toBe(false);
    mocks.read.mockResolvedValue("{not json");
    await expect(hasUsableClaudeHostLogin(NOW)).resolves.toBe(false);
    mocks.read.mockResolvedValue(credentials({ accessToken: "" }));
    await expect(hasUsableClaudeHostLogin(NOW)).resolves.toBe(false);
  });
  it("never consults the Keychain", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    mocks.read.mockRejectedValue(new Error("missing"));
    await expect(hasUsableClaudeHostLogin(NOW)).resolves.toBe(false);
    expect(mocks.exec).not.toHaveBeenCalled();
  });
});
