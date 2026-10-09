import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { runWorkspaceGitProcess } from "./workspace-git-stream.js";

const exec = promisify(execFile);
const roots: string[] = [];
const git = (cwd: string, args: string[]) => exec("git", args, {
  cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "1" },
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function repository() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-scan-locks-"));
  roots.push(cwd);
  await git(cwd, ["init"]);
  await git(cwd, ["config", "user.name", "Test"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await fs.writeFile(path.join(cwd, "tracked.txt"), "tracked content\n");
  await git(cwd, ["add", "tracked.txt"]);
  await git(cwd, ["commit", "-m", "Initial fixture"]);
  return cwd;
}

function scan(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  return runWorkspaceGitProcess({ cwd, args, env, timeoutMs: 5000, maxStdoutBytes: 8192, maxStderrBytes: 8192 });
}

it.each([false, true])("does not refresh a clean index during a background status scan (explicit env: %s)", async (explicitEnv) => {
  const cwd = await repository();
  const index = path.join(cwd, ".git", "index");
  const before = await fs.readFile(index);
  // Force a stale stat cache without changing file content. Ordinary status
  // rewrites the index, while a background scan must only report its result.
  await fs.utimes(path.join(cwd, "tracked.txt"), new Date(1000), new Date(1000));
  const env = explicitEnv ? { ...process.env, GIT_OPTIONAL_LOCKS: "1" } : undefined;
  const result = await scan(cwd, ["status", "--porcelain", "--untracked-files=all"], env);
  expect(result.stdout).toBe("");
  expect(await fs.readFile(index)).toEqual(before);
  await git(cwd, ["status", "--porcelain"]);
  expect(await fs.readFile(index)).not.toEqual(before);
});

it("reports changes beside an existing lock without removing it or bypassing mandatory write locks", async () => {
  const cwd = await repository();
  const lock = path.join(cwd, ".git", "index.lock");
  await fs.writeFile(lock, "another writer owns this lock\n", { flag: "wx" });
  await fs.writeFile(path.join(cwd, "tracked.txt"), "uncommitted work\n");
  await fs.writeFile(path.join(cwd, "untracked.txt"), "scratch\n");
  const result = await scan(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  expect(result.stdout).toContain(" M tracked.txt");
  expect(result.stdout).toContain("?? untracked.txt");
  await expect(scan(cwd, ["reset", "--hard", "HEAD"])).rejects.toMatchObject({
    code: "workspace_git_scan_failed", details: { stderr: expect.stringContaining("index.lock") },
  });
  expect(await fs.readFile(lock, "utf8")).toBe("another writer owns this lock\n");
  expect(await fs.readFile(path.join(cwd, "tracked.txt"), "utf8")).toBe("uncommitted work\n");
  expect(await fs.readFile(path.join(cwd, "untracked.txt"), "utf8")).toBe("scratch\n");
});

it("preserves caller Git configuration without mutating the supplied environment", async () => {
  const cwd = await repository();
  await fs.writeFile(path.join(cwd, "untracked.txt"), "scratch\n");
  const env = {
    ...process.env, GIT_OPTIONAL_LOCKS: "1", GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "status.showUntrackedFiles", GIT_CONFIG_VALUE_0: "no",
  };
  expect((await scan(cwd, ["status", "--porcelain"], env)).stdout).toBe("");
  expect((await git(cwd, ["status", "--porcelain", "--untracked-files=all"])).stdout).toContain("?? untracked.txt");
  expect(env.GIT_OPTIONAL_LOCKS).toBe("1");
});
