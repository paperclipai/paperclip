import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureLocalWorkspaceGitRepo } from "../services/onboarding-workspace-git.js";

const execFileAsync = promisify(execFile);

describe("ensureLocalWorkspaceGitRepo", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pc-onboarding-git-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("initializes git in an existing non-git directory", async () => {
    const result = await ensureLocalWorkspaceGitRepo(tmpRoot);
    expect(result.status).toBe("initialized");
    // The directory is now a git work tree.
    const inside = await execFileAsync("git", ["-C", tmpRoot, "rev-parse", "--is-inside-work-tree"]);
    expect(inside.stdout.trim()).toBe("true");
  });

  it("leaves an existing git repository untouched", async () => {
    await execFileAsync("git", ["-C", tmpRoot, "init"]);
    const headBefore = await fs.stat(path.join(tmpRoot, ".git"));
    const result = await ensureLocalWorkspaceGitRepo(tmpRoot);
    expect(result.status).toBe("already_repo");
    const headAfter = await fs.stat(path.join(tmpRoot, ".git"));
    // .git was not recreated.
    expect(headAfter.birthtimeMs).toBe(headBefore.birthtimeMs);
  });

  it("does not create a nested repo inside an existing git work tree", async () => {
    await execFileAsync("git", ["-C", tmpRoot, "init"]);
    const child = path.join(tmpRoot, "packages", "api");
    await fs.mkdir(child, { recursive: true });
    const result = await ensureLocalWorkspaceGitRepo(child);
    expect(result.status).toBe("already_repo");
    // No nested .git directory was created in the subdirectory.
    await expect(fs.access(path.join(child, ".git"))).rejects.toThrow();
  });

  it("skips a path that does not exist instead of throwing", async () => {
    const missing = path.join(tmpRoot, "does", "not", "exist");
    const result = await ensureLocalWorkspaceGitRepo(missing);
    expect(result.status).toBe("skipped_missing");
  });

  it("skips empty input without throwing", async () => {
    expect((await ensureLocalWorkspaceGitRepo("")).status).toBe("skipped_missing");
  });
});
