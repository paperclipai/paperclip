import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectMemoryService } from "../services/project-memory.js";
import { slugifyClaudeCodeProjectCwd } from "../lib/claude-code-project-slug.js";

const ORIGINAL_HOME = process.env.HOME;

let tmpDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  tmpDirs = [];
});

afterEach(async () => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function setupHome(): Promise<{ home: string; claudeProjectsRoot: string }> {
  const home = await makeTempDir("paperclip-project-memory-home-");
  process.env.HOME = home;
  const claudeProjectsRoot = path.join(home, ".claude", "projects");
  await fs.mkdir(claudeProjectsRoot, { recursive: true });
  return { home, claudeProjectsRoot };
}

function projectWithCwd(cwd: string | null) {
  return {
    id: "project-1",
    companyId: "company-1",
    codebase: cwd ? { effectiveLocalFolder: cwd } : null,
  };
}

describe("projectMemoryService.getManifest", () => {
  it("returns a clean manifest when the project has no resolvable cwd", async () => {
    await setupHome();
    const svc = projectMemoryService();
    const manifest = await svc.getManifest(projectWithCwd(null));
    expect(manifest.root).toBeNull();
    expect(manifest.exists).toBe(false);
    expect(manifest.files).toEqual([]);
  });

  it("returns exists=false with an empty file list when the directory is missing", async () => {
    await setupHome();
    const svc = projectMemoryService();
    // The slugified directory does not exist on disk yet.
    const manifest = await svc.getManifest(projectWithCwd("/Users/me/nope"));
    expect(manifest.exists).toBe(false);
    expect(manifest.files).toEqual([]);
    expect(manifest.slug).toBe(slugifyClaudeCodeProjectCwd("/Users/me/nope"));
    expect(manifest.root).toContain(manifest.slug!);
  });

  it("lists files when the project memory directory exists", async () => {
    const { claudeProjectsRoot } = await setupHome();
    const cwd = "/Users/me/projects/foo";
    const slug = slugifyClaudeCodeProjectCwd(cwd);
    const memoryRoot = path.join(claudeProjectsRoot, slug, "memory");
    await fs.mkdir(memoryRoot, { recursive: true });
    await fs.writeFile(path.join(memoryRoot, "a.md"), "alpha");
    await fs.writeFile(path.join(memoryRoot, "MEMORY.md"), "index");

    const svc = projectMemoryService();
    const manifest = await svc.getManifest(projectWithCwd(cwd));
    expect(manifest.exists).toBe(true);
    expect(manifest.files.map((f) => f.path).sort()).toEqual(["MEMORY.md", "a.md"]);
  });
});

describe("projectMemoryService.readFile", () => {
  it("requires a non-empty path", async () => {
    const { claudeProjectsRoot } = await setupHome();
    const cwd = "/Users/me/projects/foo";
    const slug = slugifyClaudeCodeProjectCwd(cwd);
    await fs.mkdir(path.join(claudeProjectsRoot, slug, "memory"), { recursive: true });

    const svc = projectMemoryService();
    await expect(svc.readFile(projectWithCwd(cwd), "")).rejects.toThrow();
  });

  it("rejects path traversal", async () => {
    const { claudeProjectsRoot } = await setupHome();
    const cwd = "/Users/me/projects/foo";
    const slug = slugifyClaudeCodeProjectCwd(cwd);
    const memoryRoot = path.join(claudeProjectsRoot, slug, "memory");
    await fs.mkdir(memoryRoot, { recursive: true });
    await fs.writeFile(path.join(claudeProjectsRoot, slug, "OUTSIDE.md"), "leak");

    const svc = projectMemoryService();
    await expect(svc.readFile(projectWithCwd(cwd), "../OUTSIDE.md")).rejects.toThrow();
  });

  it("rejects symlinks that escape the memory root", async () => {
    const { claudeProjectsRoot } = await setupHome();
    const cwd = "/Users/me/projects/foo";
    const slug = slugifyClaudeCodeProjectCwd(cwd);
    const memoryRoot = path.join(claudeProjectsRoot, slug, "memory");
    await fs.mkdir(memoryRoot, { recursive: true });
    const outside = await makeTempDir("paperclip-project-memory-outside-");
    const secret = path.join(outside, "secret.md");
    await fs.writeFile(secret, "PWNED");
    await fs.symlink(secret, path.join(memoryRoot, "leak.md"));

    const svc = projectMemoryService();
    await expect(svc.readFile(projectWithCwd(cwd), "leak.md")).rejects.toThrow();
  });

  it("reads files happily when they live inside the memory root", async () => {
    const { claudeProjectsRoot } = await setupHome();
    const cwd = "/Users/me/projects/foo";
    const slug = slugifyClaudeCodeProjectCwd(cwd);
    const memoryRoot = path.join(claudeProjectsRoot, slug, "memory");
    await fs.mkdir(memoryRoot, { recursive: true });
    await fs.writeFile(path.join(memoryRoot, "a.md"), "alpha");

    const svc = projectMemoryService();
    const file = await svc.readFile(projectWithCwd(cwd), "a.md");
    expect(file.path).toBe("a.md");
    expect(file.content).toBe("alpha");
    expect(file.size).toBe(5);
  });
});
