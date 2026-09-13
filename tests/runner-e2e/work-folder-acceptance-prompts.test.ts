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
    await exec("git", ["-C", repo, "remote", "add", "origin", repo]);
    await fs.writeFile(path.join(repo, ".acceptance-setup-count"), "initialized\n");
  }
});
afterAll(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });
it("proves actual warm state and fails instead of repairing lost files", async () => {
  const nonce = randomUUID();
  const run = (warm: boolean) => exec("/bin/sh", ["-c", repoAcceptanceScript(nonce, warm)], { cwd: root, env: { ...process.env, HOME: root,
    GIT_AUTHOR_NAME: "", GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_NAME: "", GIT_COMMITTER_EMAIL: "" } });
  const firstRepo = path.join(root, "repos", "first repo");
  await exec("git", ["-C", firstRepo, "remote", "set-url", "origin", path.join(root, "missing-origin")]);
  await expect(run(false)).rejects.toThrow();
  await expect(fs.access(path.join(firstRepo, ".acceptance-owner"))).rejects.toThrow();
  await exec("git", ["-C", firstRepo, "remote", "set-url", "origin", firstRepo]);
  expect((await run(false)).stdout).toContain("ACCEPTANCE_SCRIPT_PASSED");
  expect((await run(true)).stdout).toContain("ACCEPTANCE_SCRIPT_PASSED");
  for (const scope of ["task", "agent", "user", "project"]) {
    const message = path.join(root, scope, `roundtrip-${nonce}`, "message.txt");
    expect(await fs.readFile(message, "utf8")).toBe(nonce);
    await fs.writeFile(message, "changed");
    await expect(run(true)).rejects.toThrow();
    await fs.writeFile(message, nonce);
  }
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
