import { afterAll, beforeAll, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { repoAcceptanceScript } from "./work-folder-acceptance-prompts.js";
const exec = promisify(execFile);
let root: string;
beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "work-folder-acceptance-script-")));
  for (const folder of ["task", "agent", "user", "project", "repos", ".codex", ".cache"]) await fs.mkdir(path.join(root, folder));
  for (const name of ["first repo", "second-repo"]) {
    const repo = path.join(root, "repos", name);
    await exec("git", ["init", repo]);
    await fs.writeFile(path.join(repo, "README"), "fixture");
    await exec("git", ["-C", repo, "add", "README"]);
    await exec("git", ["-C", repo, "-c", "user.name=Acceptance", "-c", "user.email=acceptance@example.invalid", "commit", "-m", "fixture"]);
    await fs.writeFile(path.join(repo, ".acceptance-setup-count"), "initialized\n");
  }
});
afterAll(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });
it("proves actual warm state and fails instead of repairing lost files", async () => {
  const nonce = randomUUID();
  const run = (warm: boolean) => exec("/bin/sh", ["-c", repoAcceptanceScript(nonce, warm)], { cwd: root, env: { ...process.env, HOME: root } });
  expect((await run(false)).stdout).toContain("ACCEPTANCE_SCRIPT_PASSED");
  expect((await run(true)).stdout).toContain("ACCEPTANCE_SCRIPT_PASSED");
  // Cold tasks cannot silently share another task's checkouts.
  await expect(run(false)).rejects.toThrow();
  const untracked = path.join(root, "repos", "first repo", ".acceptance-untracked");
  await fs.writeFile(untracked, "corrupt");
  await expect(run(true)).rejects.toThrow();
  expect(await fs.readFile(untracked, "utf8")).toBe("corrupt");
  await fs.writeFile(untracked, "untracked");
  await fs.rm(path.join(root, ".cache", `warm-${nonce}`));
  await expect(run(true)).rejects.toThrow();
});
