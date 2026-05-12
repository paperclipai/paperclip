import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CommandRunner,
  getQuotaWindows,
  parseClaudeCredentialsPayload,
  readClaudeToken,
  readClaudeTokenFromKeychain,
} from "./quota.js";

const SAMPLE_TOKEN = "sk-ant-oat01-test-token";
const SAMPLE_PAYLOAD = JSON.stringify({
  claudeAiOauth: { accessToken: SAMPLE_TOKEN, subscriptionType: "max" },
});

describe("parseClaudeCredentialsPayload", () => {
  it("returns the access token from a well-formed payload", () => {
    expect(parseClaudeCredentialsPayload(SAMPLE_PAYLOAD)).toBe(SAMPLE_TOKEN);
  });

  it("returns null for invalid JSON", () => {
    expect(parseClaudeCredentialsPayload("not json")).toBeNull();
  });

  it("returns null when claudeAiOauth is missing", () => {
    expect(parseClaudeCredentialsPayload(JSON.stringify({ other: 1 }))).toBeNull();
  });

  it("returns null when accessToken is missing or empty", () => {
    expect(parseClaudeCredentialsPayload(JSON.stringify({ claudeAiOauth: {} }))).toBeNull();
    expect(parseClaudeCredentialsPayload(JSON.stringify({ claudeAiOauth: { accessToken: "" } }))).toBeNull();
  });
});

describe("readClaudeTokenFromKeychain", () => {
  it("returns null on non-darwin platforms without invoking security", async () => {
    const run = vi.fn();
    const token = await readClaudeTokenFromKeychain({
      platform: "linux",
      account: "user",
      runCommand: run as unknown as CommandRunner,
    });
    expect(token).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("calls security with the documented service+account and parses stdout", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: SAMPLE_PAYLOAD });
    const token = await readClaudeTokenFromKeychain({
      platform: "darwin",
      account: "alice",
      runCommand: run,
    });
    expect(token).toBe(SAMPLE_TOKEN);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("security", [
      "find-generic-password",
      "-s",
      "Claude Code-credentials",
      "-a",
      "alice",
      "-w",
    ]);
  });

  it("returns null when security exits non-zero (entry not found)", async () => {
    const run = vi.fn().mockRejectedValue(new Error("SecKeychainSearchCopyNext: The specified item could not be found"));
    const token = await readClaudeTokenFromKeychain({
      platform: "darwin",
      account: "alice",
      runCommand: run,
    });
    expect(token).toBeNull();
  });

  it("returns null when stdout is not a credentials payload", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: '{"other":"value"}' });
    const token = await readClaudeTokenFromKeychain({
      platform: "darwin",
      account: "alice",
      runCommand: run,
    });
    expect(token).toBeNull();
  });
});

describe("readClaudeToken (file → keychain fallthrough)", () => {
  let tempDir: string;
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-quota-test-"));
    process.env.CLAUDE_CONFIG_DIR = tempDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns the file token when ~/.claude/.credentials.json exists", async () => {
    await fs.writeFile(path.join(tempDir, ".credentials.json"), SAMPLE_PAYLOAD);
    const keychain = vi.fn().mockResolvedValue(null);
    const token = await readClaudeToken({ readKeychain: keychain });
    expect(token).toBe(SAMPLE_TOKEN);
    // Keychain fallback should NOT be consulted when the file path succeeds.
    expect(keychain).not.toHaveBeenCalled();
  });

  it("falls through to the keychain when no credentials file exists", async () => {
    const keychain = vi.fn().mockResolvedValue(SAMPLE_TOKEN);
    const token = await readClaudeToken({ readKeychain: keychain });
    expect(token).toBe(SAMPLE_TOKEN);
    expect(keychain).toHaveBeenCalledTimes(1);
  });

  it("returns null when neither the file nor the keychain has a token", async () => {
    const keychain = vi.fn().mockResolvedValue(null);
    const token = await readClaudeToken({ readKeychain: keychain });
    expect(token).toBeNull();
    expect(keychain).toHaveBeenCalledTimes(1);
  });
});

describe("getQuotaWindows graceful degradation", () => {
  it("returns ok with OAuth source when a token is available", async () => {
    const result = await getQuotaWindows({
      env: {},
      readAuthStatus: async () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readToken: async () => SAMPLE_TOKEN,
      fetchOauthQuota: async () => [
        { label: "Current session", usedPercent: 12, resetsAt: null, valueLabel: null, detail: null },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("anthropic-oauth");
      expect(result.windows).toHaveLength(1);
    }
  });

  it("surfaces a clean OAuth API error without shell-quoting", async () => {
    const result = await getQuotaWindows({
      env: {},
      readAuthStatus: async () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readToken: async () => SAMPLE_TOKEN,
      fetchOauthQuota: async () => {
        throw new Error("anthropic usage api returned 401");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Claude is logged in via claude.ai (max)");
      expect(result.error).toContain("anthropic usage api returned 401");
      expect(result.error).not.toMatch(/Command failed: sh -c/);
    }
  });

  it("returns a clean unavailable message when no token and user is logged into claude.ai", async () => {
    const result = await getQuotaWindows({
      env: {},
      readAuthStatus: async () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readToken: async () => null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Claude is logged in via claude.ai (max)");
      expect(result.error).toContain("Keychain");
      // Critical: no shell-quoting from the dropped TTY scrape
      expect(result.error).not.toMatch(/Command failed: sh -c/);
      expect(result.error).not.toMatch(/script -q/);
      expect(result.error).not.toMatch(/printf '\/usage/);
    }
  });

  it("returns a clean unavailable message when no token and no auth status", async () => {
    const result = await getQuotaWindows({
      env: {},
      readAuthStatus: async () => null,
      readToken: async () => null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Quota polling unavailable/);
      expect(result.error).not.toMatch(/Command failed/);
    }
  });

  it("returns ok with bedrock source when bedrock env is set", async () => {
    const result = await getQuotaWindows({
      env: { CLAUDE_CODE_USE_BEDROCK: "1" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("bedrock");
      expect(result.windows).toEqual([]);
    }
  });

  it("explains ANTHROPIC_API_KEY mode when no claude.ai session is present", async () => {
    const result = await getQuotaWindows({
      env: { ANTHROPIC_API_KEY: "sk-ant-key-test" },
      readAuthStatus: async () => null,
      readToken: async () => null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ANTHROPIC_API_KEY is set");
    }
  });
});
