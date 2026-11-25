import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureRemoteWorkspaceDirectory } from "./remote-workspace-snapshot-archive.js";

const execute = promisify(execFile);
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull,
  GIT_AUTHOR_NAME: "Snapshot", GIT_COMMITTER_NAME: "Snapshot", GIT_AUTHOR_EMAIL: "snapshot@example.test", GIT_COMMITTER_EMAIL: "snapshot@example.test" };
const git = async (cwd: string, ...args: string[]) => (await execute("git", ["-C", cwd, ...args], { env })).stdout.trim();

describe("portable workspace archive source fences", () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-workspace-fence-test-")); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it.skipIf(process.platform === "win32")("accepts four source roots per admitted identity and rejects an oversized fence", async () => {
    const cwd = path.join(root, "source"); await fs.mkdir(cwd);
    await git(cwd, "init", "--quiet");
    await fs.writeFile(path.join(cwd, "saved.txt"), "preserve work\n");
    await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "Saved work");
    const canonical = await fs.realpath(root);
    const roots = [canonical, ...Array.from({ length: 511 }, (_, i) => path.join(canonical, `owner-${i}`))];
    await expect(captureRemoteWorkspaceDirectory({ cwd, archivePath: path.join(root, "too-many.pcws"),
      gitSourceRoots: [...roots, path.join(canonical, "extra")] })).rejects.toThrow("online_source_git_requires_shared_fence");
    await expect(captureRemoteWorkspaceDirectory({ cwd, archivePath: path.join(root, "complete.pcws"), gitSourceRoots: roots }))
      .resolves.toHaveProperty("manifestDigest");
    expect(await fs.readFile(path.join(cwd, "saved.txt"), "utf8")).toBe("preserve work\n");
  });
});
