import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inferClaudeAccountTier } from "@paperclipai/shared";
import {
  persistRotatedTokens,
  toPercent,
  type ProfileCredentials,
} from "../services/claude-account-usage.js";

describe("toPercent", () => {
  it("passes through 0-100 percentages and rounds", () => {
    expect(toPercent(76)).toBe(76);
    expect(toPercent(79.4)).toBe(79);
    expect(toPercent(100)).toBe(100);
    expect(toPercent(140)).toBe(100); // clamped
  });
  it("scales legacy 0-1 fractions", () => {
    expect(toPercent(0.76)).toBe(76);
    expect(toPercent(0)).toBe(0);
  });
  it("returns null for null/undefined", () => {
    expect(toPercent(null)).toBeNull();
    expect(toPercent(undefined)).toBeNull();
  });
});

describe("inferClaudeAccountTier", () => {
  it("classifies known + heuristic profiles", () => {
    expect(inferClaudeAccountTier("j-tuechler-twb-digital")).toBe("ours");
    expect(inferClaudeAccountTier("thomas")).toBe("ours");
    expect(inferClaudeAccountTier("ild-claude-web.de")).toBe("wameling");
    expect(inferClaudeAccountTier("steven-i-love-design.de")).toBe("wameling");
    expect(inferClaudeAccountTier("ild-new-customer")).toBe("wameling"); // heuristic
    expect(inferClaudeAccountTier("random-acct")).toBe("unknown");
  });
  it("honors overrides", () => {
    expect(inferClaudeAccountTier("random-acct", { "random-acct": "ours" })).toBe("ours");
  });
});

describe("persistRotatedTokens (brick-safety)", () => {
  let dir: string;
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), "claude-acct-test-"));
    dir = path.join(configDir, "auth-profiles");
    await import("node:fs/promises").then((fsp) => fsp.mkdir(dir, { recursive: true }));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.CLAUDE_AUTH_PROFILE_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_AUTH_PROFILE_DIR;
    await rm(configDir, { recursive: true, force: true });
  });

  it("atomically rotates tokens, backs up the old file, and preserves all other fields", async () => {
    const profile = "thomas";
    const original: ProfileCredentials = {
      claudeAiOauth: {
        accessToken: "OLD_ACCESS",
        refreshToken: "OLD_REFRESH",
        expiresAt: 1,
        subscriptionType: "max",
        scopes: ["user:inference", "user:profile"],
        rateLimitTier: "tier-3",
      },
      oauthAccount: { emailAddress: "thomas@example.com", displayName: "Thomas" },
    };
    const profilePath = path.join(dir, `${profile}.credentials.json`);
    await writeFile(profilePath, JSON.stringify(original, null, 2), { mode: 0o600 });

    await persistRotatedTokens(profile, original, {
      accessToken: "NEW_ACCESS",
      refreshToken: "NEW_REFRESH",
      expiresAt: 9_999_999_999_999,
    });

    // Profile now holds the NEW rotated tokens.
    const after = JSON.parse(await readFile(profilePath, "utf8")) as ProfileCredentials;
    expect(after.claudeAiOauth?.accessToken).toBe("NEW_ACCESS");
    expect(after.claudeAiOauth?.refreshToken).toBe("NEW_REFRESH");
    expect(after.claudeAiOauth?.expiresAt).toBe(9_999_999_999_999);
    // Every other field preserved (not bricked / stripped).
    expect(after.claudeAiOauth?.subscriptionType).toBe("max");
    expect(after.claudeAiOauth?.scopes).toEqual(["user:inference", "user:profile"]);
    expect(after.claudeAiOauth?.rateLimitTier).toBe("tier-3");
    expect(after.oauthAccount?.emailAddress).toBe("thomas@example.com");
    expect(after.oauthAccount?.displayName).toBe("Thomas");

    // A timestamped backup of the OLD credentials exists.
    const backups = await readdir(path.join(configDir, "backups"));
    const backup = backups.find((f) => f.includes(`profile-before-refresh.${profile}`));
    expect(backup).toBeTruthy();
    const backupBody = JSON.parse(
      await readFile(path.join(configDir, "backups", backup as string), "utf8"),
    ) as ProfileCredentials;
    expect(backupBody.claudeAiOauth?.accessToken).toBe("OLD_ACCESS");
    expect(backupBody.claudeAiOauth?.refreshToken).toBe("OLD_REFRESH");

    // No leftover temp files in the profile dir.
    const remaining = await readdir(dir);
    expect(remaining.filter((f) => f.includes(".tmp"))).toHaveLength(0);
  });
});
