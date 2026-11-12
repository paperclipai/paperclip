import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

import { prepareWorkspaceForSshExecution, restoreWorkspaceFromSshExecution } from "./ssh.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const originalPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("round-trips Git history with trailing-X-only temporary file allocation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ssh-portable-bundle-"));
  roots.push(root);
  const localDir = path.join(root, "local repo");
  const remoteDir = path.join(root, "remote repo");
  const bin = path.join(root, "bin");
  await Promise.all([mkdir(localDir), mkdir(remoteDir), mkdir(bin)]);
  const { stdout: mktemp } = await execFile("sh", ["-c", "command -v mktemp"]);
  await writeFile(path.join(bin, "mktemp"), [
    "#!/bin/sh",
    'case "$1" in *XXXXXX) ;; *) echo "mktemp: template must end in XXXXXX" >&2; exit 1 ;; esac',
    `exec '${mktemp.trim().replaceAll("'", "'\\''")}' "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  await writeFile(path.join(bin, "ssh"), "#!/bin/sh\nfor argument do remote_command=$argument; done\nexec sh -c \"$remote_command\"\n", { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  const git = async (cwd: string, ...args: string[]) => (await execFile("git", ["-C", cwd, ...args])).stdout.trim();
  await git(localDir, "init", "-b", "main");
  await writeFile(path.join(localDir, "tracked.txt"), "before\n");
  await git(localDir, "add", "tracked.txt");
  await git(localDir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Initial fixture");
  const initialCommit = await git(localDir, "rev-parse", "HEAD");
  const spec = {
    host: "fixture.invalid", username: "fixture", port: 22,
    remoteCwd: remoteDir, remoteWorkspacePath: remoteDir,
    privateKey: null, knownHosts: null, strictHostKeyChecking: true,
  };
  await prepareWorkspaceForSshExecution({ spec, localDir, remoteDir });
  expect(await git(remoteDir, "rev-parse", "HEAD")).toBe(initialCommit);
  expect(await readFile(path.join(remoteDir, "tracked.txt"), "utf8")).toBe("before\n");
  expect(await readdir(path.join(remoteDir, ".paperclip-runtime"))).toEqual([]);
  await writeFile(path.join(remoteDir, "tracked.txt"), "after\n");
  await git(remoteDir, "add", "tracked.txt");
  await git(remoteDir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Remote fixture change");
  const remoteCommit = await git(remoteDir, "rev-parse", "HEAD");
  await restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir, restoreGitHistory: true });
  expect(await git(localDir, "rev-parse", "HEAD")).toBe(remoteCommit);
  expect(await readFile(path.join(localDir, "tracked.txt"), "utf8")).toBe("after\n");
  expect(await readdir(path.join(remoteDir, ".paperclip-runtime"))).toEqual([]);
}, 30_000);
