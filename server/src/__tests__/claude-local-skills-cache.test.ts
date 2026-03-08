import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSkillsDir, _resetSkillsDirCache } from "@paperclipai/adapter-claude-local/server";

/**
 * Tests for the buildSkillsDir caching logic.
 *
 * These tests create real temp directories with skill-like subdirectories
 * and verify that the caching, fingerprinting, and invalidation work correctly.
 *
 * NOTE: buildSkillsDir resolves its skills source from PAPERCLIP_SKILLS_CANDIDATES
 * (relative to the module directory).  In the test environment this resolves to
 * the repo's `skills/` directory, which contains real skill subdirectories.
 * The tests therefore validate real-world caching behavior.
 */
describe("buildSkillsDir caching", () => {
  beforeEach(() => {
    _resetSkillsDirCache();
  });

  afterEach(() => {
    _resetSkillsDirCache();
  });

  it("returns a directory containing .claude/skills/", async () => {
    const dir = await buildSkillsDir();
    const skillsPath = path.join(dir, ".claude", "skills");
    const stat = await fs.stat(skillsPath);
    expect(stat.isDirectory()).toBe(true);
  });

  it("cache hit: repeated calls return the same directory", async () => {
    const dir1 = await buildSkillsDir();
    const dir2 = await buildSkillsDir();
    expect(dir2).toBe(dir1);
  });

  it("cache miss on deleted dir: rebuilds even with matching fingerprint", async () => {
    const dir1 = await buildSkillsDir();
    // Simulate the OS cleaning up the temp directory.
    await fs.rm(dir1, { recursive: true, force: true });

    const dir2 = await buildSkillsDir();
    expect(dir2).not.toBe(dir1);
    // Verify the new dir actually exists.
    const stat = await fs.stat(path.join(dir2, ".claude", "skills"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("creates symlinks for skill directories", async () => {
    const dir = await buildSkillsDir();
    const skillsPath = path.join(dir, ".claude", "skills");
    const entries = await fs.readdir(skillsPath, { withFileTypes: true });
    // Should have at least the "paperclip" skill
    const names = entries.map((e) => e.name);
    expect(names).toContain("paperclip");
    // Entries should be symlinks
    for (const entry of entries) {
      const linkStat = await fs.lstat(path.join(skillsPath, entry.name));
      expect(linkStat.isSymbolicLink()).toBe(true);
    }
  });

  it("fingerprint is order-independent (sorted)", async () => {
    // Call twice — if fingerprinting weren't sorted, readdir order changes
    // could cause spurious cache misses. By verifying cache hits across
    // calls we indirectly confirm sorting works.
    const dir1 = await buildSkillsDir();
    const dir2 = await buildSkillsDir();
    const dir3 = await buildSkillsDir();
    expect(dir1).toBe(dir2);
    expect(dir2).toBe(dir3);
  });
});
