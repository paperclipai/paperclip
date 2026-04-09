import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolvePaperclipSkillsDir } from "@paperclipai/adapter-utils/server-utils";

/**
 * Tests for the shared skill-dir resolver used by all `*-local` adapters.
 *
 * Priority:
 *   1. PAPERCLIP_SKILLS_DIR env var (explicit override)
 *   2. module-relative candidates: `<moduleDir>/../../skills` (published) and
 *      `<moduleDir>/../../../../../skills` (dev/workspace)
 */
describe("resolvePaperclipSkillsDir", () => {
  const originalEnv = process.env.PAPERCLIP_SKILLS_DIR;
  let tmpRoot: string;

  beforeEach(async () => {
    delete process.env.PAPERCLIP_SKILLS_DIR;
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skills-dir-test-"));
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.PAPERCLIP_SKILLS_DIR;
    } else {
      process.env.PAPERCLIP_SKILLS_DIR = originalEnv;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns the env var path when PAPERCLIP_SKILLS_DIR is set to an existing directory", async () => {
    const envDir = path.join(tmpRoot, "env-skills");
    await fs.mkdir(envDir, { recursive: true });
    process.env.PAPERCLIP_SKILLS_DIR = envDir;

    const moduleDir = path.join(tmpRoot, "modules", "pkg", "src", "server");
    await fs.mkdir(moduleDir, { recursive: true });

    const resolved = await resolvePaperclipSkillsDir(moduleDir);
    expect(resolved).toBe(envDir);
  });

  it("falls back to module-relative ../../skills when env var is unset (published layout)", async () => {
    // Published layout: <pkg>/dist/server/<file> → <pkg>/skills
    const pkgRoot = path.join(tmpRoot, "dist-pkg");
    const moduleDir = path.join(pkgRoot, "dist", "server");
    const skillsDir = path.join(pkgRoot, "skills");
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.mkdir(skillsDir, { recursive: true });

    const resolved = await resolvePaperclipSkillsDir(moduleDir);
    expect(resolved).toBe(skillsDir);
  });

  it("falls back to module-relative ../../../../../skills when env var is unset (dev layout)", async () => {
    // Dev/workspace layout: <repo>/packages/adapters/<name>/src/server/<file> → <repo>/skills
    const repoRoot = path.join(tmpRoot, "repo");
    const moduleDir = path.join(repoRoot, "packages", "adapters", "claude-local", "src", "server");
    const skillsDir = path.join(repoRoot, "skills");
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.mkdir(skillsDir, { recursive: true });

    const resolved = await resolvePaperclipSkillsDir(moduleDir);
    expect(resolved).toBe(skillsDir);
  });

  it("returns null when env var is unset and no candidate exists", async () => {
    const moduleDir = path.join(tmpRoot, "orphan", "src", "server");
    await fs.mkdir(moduleDir, { recursive: true });

    const resolved = await resolvePaperclipSkillsDir(moduleDir);
    expect(resolved).toBeNull();
  });

  it("falls back to module-relative when env var points at a non-directory", async () => {
    const notADir = path.join(tmpRoot, "not-a-dir.txt");
    await fs.writeFile(notADir, "i am a file");
    process.env.PAPERCLIP_SKILLS_DIR = notADir;

    // Provide a valid fallback so the test asserts the fallback path is taken.
    const repoRoot = path.join(tmpRoot, "repo2");
    const moduleDir = path.join(repoRoot, "packages", "adapters", "x", "src", "server");
    const skillsDir = path.join(repoRoot, "skills");
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.mkdir(skillsDir, { recursive: true });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const resolved = await resolvePaperclipSkillsDir(moduleDir);
    expect(resolved).toBe(skillsDir);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("falls back to module-relative when env var points at a non-existent path", async () => {
    const missing = path.join(tmpRoot, "does", "not", "exist");
    process.env.PAPERCLIP_SKILLS_DIR = missing;

    const repoRoot = path.join(tmpRoot, "repo3");
    const moduleDir = path.join(repoRoot, "packages", "adapters", "y", "src", "server");
    const skillsDir = path.join(repoRoot, "skills");
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.mkdir(skillsDir, { recursive: true });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const resolved = await resolvePaperclipSkillsDir(moduleDir);
    expect(resolved).toBe(skillsDir);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("ignores empty / whitespace env var values", async () => {
    process.env.PAPERCLIP_SKILLS_DIR = "   ";

    const repoRoot = path.join(tmpRoot, "repo4");
    const moduleDir = path.join(repoRoot, "packages", "adapters", "z", "src", "server");
    const skillsDir = path.join(repoRoot, "skills");
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.mkdir(skillsDir, { recursive: true });

    const resolved = await resolvePaperclipSkillsDir(moduleDir);
    expect(resolved).toBe(skillsDir);
  });
});
