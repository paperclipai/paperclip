import { describe, expect, it } from "vitest";
import {
  SSH_GLOB_EXCLUDE_PREFIX,
  WORKSPACE_HEAVY_DIR_EXCLUDES,
  resolveSshWorkspaceSyncExcludes,
  shouldExcludePath,
  tarExcludePattern,
} from "./exclude-patterns.js";

describe("resolveSshWorkspaceSyncExcludes", () => {
  it("applies heavy-dir excludes and the caller's excludes by default", () => {
    const excludes = resolveSshWorkspaceSyncExcludes({ workspaceExclude: [".venv", "node_modules"] });
    expect(excludes.repository("repo")).toEqual([...WORKSPACE_HEAVY_DIR_EXCLUDES, "*/.venv"]);
    expect(excludes.workspace).toEqual([...WORKSPACE_HEAVY_DIR_EXCLUDES, ".venv", "*/.venv"]);
    expect(shouldExcludePath("pkg/node_modules/dep/index.js", excludes.workspace)).toBe(true);
    expect(shouldExcludePath("src/index.ts", excludes.workspace)).toBe(false);
  });

  it("applies only the caller's excludes in all-files mode", () => {
    const excludes = resolveSshWorkspaceSyncExcludes({ workspaceFileMode: "all", workspaceExclude: ["explicitly-excluded"] });
    expect(excludes.workspace).toEqual(["explicitly-excluded", "*/explicitly-excluded"]);
    expect(excludes.repository("repo")).toEqual(["*/explicitly-excluded"]);
    expect(resolveSshWorkspaceSyncExcludes({ workspaceFileMode: "all" }).workspace).toEqual([]);
  });

  it("matches caller excludes at any depth, as tar does", () => {
    const { workspace } = resolveSshWorkspaceSyncExcludes({ workspaceExclude: ["*.log", "secret.env", "tmp/*"] });
    expect(shouldExcludePath("app.log", workspace)).toBe(true);
    expect(shouldExcludePath("logs/deep/trace.log", workspace)).toBe(true);
    expect(shouldExcludePath("sub/secret.env", workspace)).toBe(true);
    expect(shouldExcludePath("pkg/tmp/cache.bin", workspace)).toBe(true);
    expect(shouldExcludePath("src/log.ts", workspace)).toBe(false);
  });

  it("translates caller excludes into each nested repository", () => {
    const excludes = resolveSshWorkspaceSyncExcludes({
      workspaceExclude: [".paperclip-repositories/backend/host-config.txt", ".paperclip-repositories/other/x", "*.log"],
    });
    const backend = excludes.repository(".paperclip-repositories/backend");
    expect(shouldExcludePath("host-config.txt", backend)).toBe(true);
    expect(shouldExcludePath("debug.log", backend)).toBe(true);
    expect(shouldExcludePath("node_modules/dep/index.js", backend)).toBe(true);
    expect(shouldExcludePath("x", backend)).toBe(false);
    expect(shouldExcludePath("src/app.ts", backend)).toBe(false);
  });
});

describe("shouldExcludePath", () => {
  const glob = (pattern: string) => `${SSH_GLOB_EXCLUDE_PREFIX}${pattern}`;

  it("keeps literal structured patterns anchored as before", () => {
    expect(shouldExcludePath("sub/.git/HEAD", [".git", ".git/*"])).toBe(false);
    expect(shouldExcludePath(".git/HEAD", [".git", ".git/*"])).toBe(true);
    expect(shouldExcludePath("a/node_modules/x", ["*/node_modules/*"])).toBe(true);
  });

  it("keeps unmarked names literal even when they contain glob characters", () => {
    expect(shouldExcludePath("app.log", ["*.log"])).toBe(false);
    expect(shouldExcludePath("*.log", ["*.log"])).toBe(true);
    expect(shouldExcludePath("a*b/c", ["a*b"])).toBe(true);
    expect(shouldExcludePath("axb/c", ["a*b"])).toBe(false);
  });

  it("treats marked wildcard patterns the way tar --exclude does", () => {
    expect(shouldExcludePath("app.log", [glob("*.log")])).toBe(true);
    expect(shouldExcludePath("a/b/app.log", [glob("*.log")])).toBe(true);
    expect(shouldExcludePath("build.log.d/out.txt", [glob("*.log.d")])).toBe(true);
    expect(shouldExcludePath("app.logs", [glob("*.log")])).toBe(false);
    expect(shouldExcludePath("src/tmp/x", [glob("tmp/*")])).toBe(true);
    expect(shouldExcludePath("a1.txt", [glob("a[!0-9].txt")])).toBe(false);
    expect(shouldExcludePath("ab.txt", [glob("a[!0-9].txt")])).toBe(true);
    expect(shouldExcludePath("x/a.ts", [glob("a.t?")])).toBe(true);
  });

  it("strips the marker before a pattern reaches tar", () => {
    expect(tarExcludePattern(glob("*.log"))).toBe("*.log");
    expect(tarExcludePattern("node_modules")).toBe("node_modules");
  });

  it("matches hostile wildcard patterns in bounded time", () => {
    const deep = `${"a/".repeat(400)}b`;
    const patterns = [glob(`${"a*".repeat(24)}c`), glob("**/*.log"), `${"a*".repeat(24)}c`];
    const startedAt = Date.now();
    for (let i = 0; i < 10; i += 1) {
      expect(shouldExcludePath(deep, patterns)).toBe(false);
    }
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});
