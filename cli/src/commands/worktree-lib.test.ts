import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isWorktreeSeedMode,
  resolveWorktreeSeedPlan,
  sanitizeWorktreeInstanceId,
  resolveSuggestedWorktreeName,
  rewriteLocalUrlPort,
  resolveWorktreeLocalPaths,
  buildWorktreeEnvEntries,
  formatShellExports,
  DEFAULT_WORKTREE_HOME,
} from "./worktree-lib.js";

// ============================================================================
// isWorktreeSeedMode
// ============================================================================

describe("isWorktreeSeedMode", () => {
  it("returns true for 'minimal'", () => {
    expect(isWorktreeSeedMode("minimal")).toBe(true);
  });

  it("returns true for 'full'", () => {
    expect(isWorktreeSeedMode("full")).toBe(true);
  });

  it("returns false for unknown mode", () => {
    expect(isWorktreeSeedMode("partial")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isWorktreeSeedMode("")).toBe(false);
  });
});

// ============================================================================
// resolveWorktreeSeedPlan
// ============================================================================

describe("resolveWorktreeSeedPlan", () => {
  it("returns full mode with empty exclusions for 'full'", () => {
    const plan = resolveWorktreeSeedPlan("full");
    expect(plan.mode).toBe("full");
    expect(plan.excludedTables).toEqual([]);
    expect(plan.nullifyColumns).toEqual({});
  });

  it("returns minimal mode with excluded tables for 'minimal'", () => {
    const plan = resolveWorktreeSeedPlan("minimal");
    expect(plan.mode).toBe("minimal");
    expect(plan.excludedTables.length).toBeGreaterThan(0);
  });

  it("returns different configurations for 'minimal' vs 'full'", () => {
    const minimal = resolveWorktreeSeedPlan("minimal");
    const full = resolveWorktreeSeedPlan("full");
    expect(minimal.excludedTables.length).toBeGreaterThan(full.excludedTables.length);
  });
});

// ============================================================================
// sanitizeWorktreeInstanceId
// ============================================================================

describe("sanitizeWorktreeInstanceId", () => {
  it("lowercases the value", () => {
    expect(sanitizeWorktreeInstanceId("MyWorktree")).toBe("myworktree");
  });

  it("replaces spaces with hyphens", () => {
    expect(sanitizeWorktreeInstanceId("my worktree")).toBe("my-worktree");
  });

  it("replaces special characters with hyphens", () => {
    expect(sanitizeWorktreeInstanceId("my@worktree!")).toBe("my-worktree");
  });

  it("collapses multiple hyphens into one", () => {
    expect(sanitizeWorktreeInstanceId("my---worktree")).toBe("my-worktree");
  });

  it("strips leading and trailing hyphens", () => {
    expect(sanitizeWorktreeInstanceId("-my-worktree-")).toBe("my-worktree");
  });

  it("returns 'worktree' for empty string", () => {
    expect(sanitizeWorktreeInstanceId("")).toBe("worktree");
  });

  it("returns 'worktree' for string of only special characters", () => {
    expect(sanitizeWorktreeInstanceId("@#$")).toBe("worktree");
  });

  it("preserves underscores", () => {
    expect(sanitizeWorktreeInstanceId("my_worktree")).toBe("my_worktree");
  });

  it("trims leading and trailing whitespace before processing", () => {
    expect(sanitizeWorktreeInstanceId("  hello  ")).toBe("hello");
  });
});

// ============================================================================
// resolveSuggestedWorktreeName
// ============================================================================

describe("resolveSuggestedWorktreeName", () => {
  it("uses explicitName when provided", () => {
    expect(resolveSuggestedWorktreeName("/some/dir", "my-name")).toBe("my-name");
  });

  it("falls back to the basename of cwd when explicitName is omitted", () => {
    const result = resolveSuggestedWorktreeName("/home/user/projects/my-repo");
    expect(result).toBe("my-repo");
  });

  it("falls back to the basename of cwd when explicitName is empty string", () => {
    const result = resolveSuggestedWorktreeName("/home/user/projects/my-repo", "");
    expect(result).toBe("my-repo");
  });

  it("falls back to the basename of cwd when explicitName is whitespace-only", () => {
    const result = resolveSuggestedWorktreeName("/home/user/projects/my-repo", "   ");
    expect(result).toBe("my-repo");
  });
});

// ============================================================================
// rewriteLocalUrlPort
// ============================================================================

describe("rewriteLocalUrlPort", () => {
  it("returns undefined for undefined input", () => {
    expect(rewriteLocalUrlPort(undefined, 8080)).toBeUndefined();
  });

  it("returns undefined for empty string input", () => {
    expect(rewriteLocalUrlPort("", 8080)).toBeUndefined();
  });

  it("rewrites port for localhost URL", () => {
    const result = rewriteLocalUrlPort("http://localhost:3000", 8080);
    expect(result).toContain(":8080");
    expect(result).toContain("localhost");
  });

  it("rewrites port for 127.0.0.1 URL", () => {
    const result = rewriteLocalUrlPort("http://127.0.0.1:3000/path", 9000);
    expect(result).toContain(":9000");
  });

  it("does not rewrite port for non-loopback URLs", () => {
    const url = "http://example.com:3000";
    expect(rewriteLocalUrlPort(url, 8080)).toBe(url);
  });

  it("returns the original string for invalid URLs", () => {
    const invalid = "not-a-url";
    expect(rewriteLocalUrlPort(invalid, 8080)).toBe(invalid);
  });
});

// ============================================================================
// resolveWorktreeLocalPaths
// ============================================================================

describe("resolveWorktreeLocalPaths", () => {
  it("resolves all path properties based on cwd and instanceId", () => {
    const result = resolveWorktreeLocalPaths({
      cwd: "/tmp/my-repo",
      instanceId: "test-wt",
    });
    expect(result.cwd).toBe("/tmp/my-repo");
    expect(result.instanceId).toBe("test-wt");
    expect(result.repoConfigDir).toContain(".paperclip");
    expect(result.configPath).toMatch(/config\.json$/);
    expect(result.embeddedPostgresDataDir).toContain("db");
  });

  it("uses DEFAULT_WORKTREE_HOME when homeDir is not specified", () => {
    const result = resolveWorktreeLocalPaths({
      cwd: "/tmp/my-repo",
      instanceId: "wt",
    });
    // Should use the expanded DEFAULT_WORKTREE_HOME (not the literal ~ path)
    expect(result.homeDir).not.toContain("~");
    expect(result.homeDir.length).toBeGreaterThan(0);
  });

  it("uses provided homeDir when specified", () => {
    const result = resolveWorktreeLocalPaths({
      cwd: "/tmp/my-repo",
      homeDir: "/custom/worktree-home",
      instanceId: "wt",
    });
    expect(result.homeDir).toBe("/custom/worktree-home");
  });
});

// ============================================================================
// buildWorktreeEnvEntries
// ============================================================================

describe("buildWorktreeEnvEntries", () => {
  const mockPaths = {
    cwd: "/tmp/repo",
    repoConfigDir: "/tmp/repo/.paperclip",
    configPath: "/tmp/repo/.paperclip/config.json",
    envPath: "/tmp/repo/.paperclip/.env",
    homeDir: "/tmp/wt-home",
    instanceId: "wt-1",
    instanceRoot: "/tmp/wt-home/instances/wt-1",
    contextPath: "/tmp/wt-home/context.json",
    embeddedPostgresDataDir: "/tmp/wt-home/instances/wt-1/db",
    backupDir: "/tmp/wt-home/instances/wt-1/data/backups",
    logDir: "/tmp/wt-home/instances/wt-1/logs",
    secretsKeyFilePath: "/tmp/wt-home/instances/wt-1/secrets/master.key",
    storageDir: "/tmp/wt-home/instances/wt-1/data/storage",
  };

  it("sets PAPERCLIP_HOME from paths", () => {
    const entries = buildWorktreeEnvEntries(mockPaths);
    expect(entries.PAPERCLIP_HOME).toBe("/tmp/wt-home");
  });

  it("sets PAPERCLIP_INSTANCE_ID from paths", () => {
    const entries = buildWorktreeEnvEntries(mockPaths);
    expect(entries.PAPERCLIP_INSTANCE_ID).toBe("wt-1");
  });

  it("sets PAPERCLIP_IN_WORKTREE to 'true'", () => {
    const entries = buildWorktreeEnvEntries(mockPaths);
    expect(entries.PAPERCLIP_IN_WORKTREE).toBe("true");
  });

  it("includes branding name when provided", () => {
    const branding = { enabled: true as const, name: "My Worktree", color: "#336699", textColor: "#ffffff" };
    const entries = buildWorktreeEnvEntries(mockPaths, branding);
    expect(entries.PAPERCLIP_WORKTREE_NAME).toBe("My Worktree");
  });

  it("includes branding color when provided", () => {
    const branding = { enabled: true as const, name: "Test", color: "#ff0000", textColor: "#ffffff" };
    const entries = buildWorktreeEnvEntries(mockPaths, branding);
    expect(entries.PAPERCLIP_WORKTREE_COLOR).toBe("#ff0000");
  });

  it("does not include branding keys when branding is not provided", () => {
    const entries = buildWorktreeEnvEntries(mockPaths);
    expect("PAPERCLIP_WORKTREE_NAME" in entries).toBe(false);
    expect("PAPERCLIP_WORKTREE_COLOR" in entries).toBe(false);
  });
});

// ============================================================================
// formatShellExports
// ============================================================================

describe("formatShellExports", () => {
  it("formats entries as export KEY=VALUE lines", () => {
    const result = formatShellExports({ MY_VAR: "hello" });
    expect(result).toContain("export MY_VAR=");
    expect(result).toContain("hello");
  });

  it("single-quotes values with shell escaping", () => {
    const result = formatShellExports({ PATH_VAR: "/some/path" });
    expect(result).toContain("'/some/path'");
  });

  it("escapes single quotes in values", () => {
    const result = formatShellExports({ VAR: "it's a value" });
    // Single quotes need shell-escaping
    expect(result).toContain("export VAR=");
    expect(result).toContain("it");
    expect(result).toContain("s a value");
  });

  it("filters out entries with empty values", () => {
    const result = formatShellExports({ EMPTY: "", PRESENT: "value" });
    expect(result).not.toContain("EMPTY");
    expect(result).toContain("PRESENT");
  });

  it("handles multiple entries with one line per entry", () => {
    const result = formatShellExports({ A: "1", B: "2" });
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
  });

  it("returns empty string for empty input", () => {
    expect(formatShellExports({})).toBe("");
  });
});

// ============================================================================
// DEFAULT_WORKTREE_HOME
// ============================================================================

describe("DEFAULT_WORKTREE_HOME", () => {
  it("is a non-empty string", () => {
    expect(typeof DEFAULT_WORKTREE_HOME).toBe("string");
    expect(DEFAULT_WORKTREE_HOME.length).toBeGreaterThan(0);
  });

  it("starts with ~ indicating a home-relative path", () => {
    expect(DEFAULT_WORKTREE_HOME.startsWith("~")).toBe(true);
  });
});
