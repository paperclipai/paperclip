import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureRemoteWorkspaceDirectory, remoteWorkspaceArchiveScript, restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";

const execute = promisify(execFile);
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull,
  GIT_AUTHOR_NAME: "Snapshot", GIT_COMMITTER_NAME: "Snapshot", GIT_AUTHOR_EMAIL: "snapshot@example.test", GIT_COMMITTER_EMAIL: "snapshot@example.test" };
const git = async (cwd: string, ...args: string[]) => (await execute("git", ["-C", cwd, ...args], { env })).stdout.trim();

describe("reinstallable environments in portable workspace archives", () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-workspace-environment-test-")); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  async function source() { const cwd = path.join(root, "source"); await fs.mkdir(cwd); return cwd; }
  async function capture(cwd: string, mode: "local" | "serialized" = "local") {
    const archivePath = path.join(root, "snapshot.pcws");
    if (mode === "local") return { archivePath, ...await captureRemoteWorkspaceDirectory({ cwd, archivePath }) };
    // The sandbox runs this generated helper in its own Node process.
    const helper = path.join(root, "helper.cjs");
    await fs.writeFile(helper, remoteWorkspaceArchiveScript());
    return { archivePath, ...JSON.parse((await execute(process.execPath, [helper, "capture", cwd, archivePath])).stdout) };
  }
  async function restore(snapshot: { archivePath: string; manifestDigest: string }) {
    const targetDir = path.join(root, "restored");
    await restoreRemoteWorkspaceArchive({ archivePath: snapshot.archivePath, targetDir, expectedManifestDigest: snapshot.manifestDigest });
    return targetDir;
  }
  async function excluded(archivePath: string) {
    const archive = await fs.readFile(archivePath), start = Buffer.from("PCWS1\n").length, length = archive.readUInt32BE(start);
    return JSON.parse(archive.subarray(start + 4, start + 4 + length).toString()).excluded;
  }

  it.each(["local", "serialized"] as const)("omits an untracked Python virtual environment and its interpreter links in %s capture", async mode => {
    const cwd = await source(), venv = path.join(cwd, ".venv");
    await fs.writeFile(path.join(cwd, "semver.py"), "import re\n");
    await fs.mkdir(path.join(venv, "bin"), { recursive: true });
    await fs.writeFile(path.join(venv, "pyvenv.cfg"), "home = /usr/bin\n");
    // `python -m venv` links the interpreter by absolute path.
    await fs.symlink(process.execPath, path.join(venv, "bin", "python"));
    const snapshot = await capture(cwd, mode);
    expect(await fs.readdir(await restore(snapshot))).toEqual(["semver.py"]);
    expect(await excluded(snapshot.archivePath)).toEqual([".venv"]);
    expect(await fs.readlink(path.join(venv, "bin", "python"))).toBe(process.execPath);
  });

  it("keeps a deliberately tracked virtual environment and still rejects other absolute links", async () => {
    const cwd = await source(), venv = path.join(cwd, "env");
    await fs.mkdir(venv); await fs.writeFile(path.join(venv, "pyvenv.cfg"), "home = /usr/bin\n");
    await git(cwd, "init", "-q", "-b", "main"); await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "tracked environment");
    const restored = await restore(await capture(cwd));
    expect(await fs.readFile(path.join(restored, "env", "pyvenv.cfg"), "utf8")).toBe("home = /usr/bin\n");
    await fs.rm(path.join(root, "snapshot.pcws")); await fs.rm(restored, { recursive: true });
    // A directory without the PEP 405 marker is ordinary work, not an environment.
    await fs.mkdir(path.join(cwd, "tools")); await fs.symlink(process.execPath, path.join(cwd, "tools", "node"));
    await expect(capture(cwd)).rejects.toThrow("unsafe_symlink");
  });

  it("does not treat a linked pyvenv.cfg as an environment marker", async () => {
    const cwd = await source(), venv = path.join(cwd, ".venv");
    await fs.mkdir(path.join(venv, "bin"), { recursive: true });
    await fs.writeFile(path.join(cwd, "pyvenv.cfg"), "home = /usr/bin\n");
    await fs.symlink("../pyvenv.cfg", path.join(venv, "pyvenv.cfg"));
    await fs.symlink(process.execPath, path.join(venv, "bin", "python"));
    await expect(capture(cwd)).rejects.toThrow("unsafe_symlink");
  });
});
