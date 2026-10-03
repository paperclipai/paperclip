import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSshSpawnTarget,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryFromSsh,
  syncDirectoryToSsh,
  type SshRemoteExecutionSpec,
} from "./ssh.js";

const execFileAsync = promisify(execFile);
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
let root: string | undefined;
let spec: SshRemoteExecutionSpec;

beforeEach(async (context) => {
  if (process.platform === "win32") context.skip("Requires a POSIX shell");
  const tools = new Map<string, string>();
  for (const command of ["sh", "git", "tar", "mkdir", "mktemp", "cat", "rm", "env"]) {
    const resolved = await execFileAsync("sh", ["-c", 'command -v "$1"', "ssh-profile-test", command])
      .then(({ stdout }) => stdout.trim(), () => "");
    if (!resolved) context.skip(`Missing required command: ${command}`);
    tools.set(command, resolved);
  }
  root = await mkdtemp(path.join(os.tmpdir(), "pc-ssh-profile-"));
  const home = path.join(root, "home");
  const bootstrapBin = path.join(root, "bootstrap-bin");
  const profileBin = path.join(root, "profile-bin");
  const localBin = path.join(root, "local-bin");
  for (const directory of [home, bootstrapBin, profileBin, localBin]) {
    await mkdir(directory);
  }
  await symlink(tools.get("sh")!, path.join(bootstrapBin, "sh"));
  for (const [name, executable] of tools) {
    await symlink(executable, path.join(profileBin, name));
  }
  await writeFile(path.join(home, ".gitconfig"), [
    "[user]", "name = Paperclip Test", "email = paperclip@example.invalid",
    "[commit]", "gpgSign = false", "[core]", "hooksPath = /dev/null", "",
  ].join("\n"));
  await writeFile(path.join(home, ".profile"), [
    `export PATH=${quote(profileBin)}`,
    "export PROFILE_VALUE=from-profile",
    "printf 'profile stdout must not enter archive\\n'",
    "printf 'profile stderr must not enter archive\\n' >&2",
    // A login profile must see EOF, not consume the tar or bundle header.
    `if IFS= read -r line; then printf consumed > ${quote(path.join(root, "consumed"))}; fi`,
    "",
  ].join("\n"));
  // Replace only the transport. Real sh, tar and git execute the exact last
  // SSH argument with tools unavailable until the remote profile runs.
  const nodePath = path.join(root, "node 'with spaces'");
  await symlink(process.execPath, nodePath);
  const launcher = path.join(localBin, "ssh.cjs");
  await writeFile(launcher, [
    'const { spawn } = require("node:child_process");',
    `const child = spawn(${JSON.stringify(tools.get("sh"))}, ["-c", process.argv.at(-1)], {`,
    `  env: { ...process.env, HOME: ${JSON.stringify(home)}, PATH: ${JSON.stringify(bootstrapBin)} },`,
    '  stdio: "inherit",',
    '});',
    'child.on("error", (error) => { console.error(error); process.exitCode = 1; });',
    'child.on("close", (code) => { process.exitCode = code ?? 1; });',
    "",
  ].join("\n"), { mode: 0o600 });
  // A shebang cannot quote an interpreter path. Use a shell wrapper so Node
  // installations in paths with spaces work, and exercise quoting on every run.
  await writeFile(path.join(localBin, "ssh"), [
    "#!/bin/sh",
    `exec ${quote(nodePath)} ${quote(launcher)} "$@"`,
    "",
  ].join("\n"), { mode: 0o700 });
  vi.stubEnv("PATH", `${localBin}${path.delimiter}${process.env.PATH ?? ""}`);
  vi.stubEnv("HOME", home);
  vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(home, ".gitconfig"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  spec = {
    host: "ssh.example.test", port: 22, username: "test",
    remoteCwd: path.join(root, "remote"), remoteWorkspacePath: path.join(root, "remote"),
    privateKey: null, knownHosts: null, strictHostKeyChecking: true,
  };
  await mkdir(spec.remoteCwd);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("SSH login profiles and transfer streams", () => {
  it("round-trips binary tar data with profile-only tools", async () => {
    const localDir = path.join(root!, "local");
    const restoredDir = path.join(root!, "restored");
    const remoteDir = path.join(spec.remoteCwd, "space ' quoted");
    const bytes = Buffer.from(Array.from({ length: 32_768 }, (_, index) => index % 256));
    await mkdir(localDir);
    await writeFile(path.join(localDir, "binary.dat"), bytes);
    await syncDirectoryToSsh({ spec, localDir, remoteDir });
    await syncDirectoryFromSsh({ spec, localDir: restoredDir, remoteDir });
    expect(await readFile(path.join(restoredDir, "binary.dat"))).toEqual(bytes);
    await expect(readFile(path.join(root!, "consumed"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("round-trips Git history with profile-only tools", async () => {
    const localDir = path.join(root!, "local");
    await mkdir(localDir);
    await execFileAsync("git", ["init", "--template=", localDir]);
    await writeFile(path.join(localDir, "tracked.txt"), "initial\n");
    await execFileAsync("git", ["-C", localDir, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", localDir, "commit", "-m", "initial"]);
    await prepareWorkspaceForSshExecution({ spec, localDir });
    await writeFile(path.join(spec.remoteCwd, "tracked.txt"), "remote change\n");
    await runSshCommand(spec, `git -C ${quote(spec.remoteCwd)} commit -am 'remote change'`);
    const remoteHead = (await execFileAsync("git", ["-C", spec.remoteCwd, "rev-parse", "HEAD"])).stdout;
    await restoreWorkspaceFromSshExecution({ spec, localDir });
    expect((await execFileAsync("git", ["-C", localDir, "rev-parse", "HEAD"])).stdout).toBe(remoteHead);
    expect(await readFile(path.join(localDir, "tracked.txt"), "utf8")).toBe("remote change\n");
    await expect(readFile(path.join(root!, "consumed"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves stdin and explicit environment overrides after profiles", async () => {
    const result = await runSshCommand(spec, 'printf "%s\\n" "$PROFILE_VALUE"; cat', {
      stdin: "payload\n", env: { PROFILE_VALUE: "explicit" },
    });
    expect(result).toEqual({ stdout: "explicit\npayload\n", stderr: "" });
    const target = await buildSshSpawnTarget({
      spec, command: "sh", args: ["-c", 'printf "%s" "$PROFILE_VALUE"'],
      env: { PROFILE_VALUE: "explicit" },
    });
    try {
      const output = await execFileAsync(target.command, target.args);
      expect(output.stdout).toBe("explicit");
      expect(output.stderr).toBe("");
    } finally {
      await target.cleanup();
    }
  });
});
