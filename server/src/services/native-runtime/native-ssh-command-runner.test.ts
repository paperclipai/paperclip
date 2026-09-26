import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeSshCommandRunner } from "./native-ssh-command-runner.js";
import { MAX_REMOTE_DELIVERABLE_BYTES, readVerifiedRemoteWorkspaceFile } from "./remote-deliverable-file.js";

describe("native SSH deliverable output budget", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paperclip-ssh-output-"));
    // Exercise the real SSH command adapter and its execFile output limit,
    // replacing only the network executable with a deterministic byte source.
    const executable = join(root, "ssh");
    await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(require('node:fs').readFileSync(${JSON.stringify(join(root, "response"))}));\n`);
    await chmod(executable, 0o700);
    vi.stubEnv("PATH", `${root}:${process.env.PATH}`);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  const createRunner = () => createNativeSshCommandRunner({
    spec: {
      host: "fixture.invalid", port: 22, username: "fixture",
      remoteWorkspacePath: "/workspace", remoteCwd: "/workspace",
      privateKey: null, knownHosts: null, strictHostKeyChecking: true,
    },
    defaultCwd: "/workspace",
  });

  it.each([64, MAX_REMOTE_DELIVERABLE_BYTES])("returns exact verified bytes for a %i-byte file through the SSH adapter", async (byteSize) => {
    const body = Buffer.alloc(byteSize, 65);
    await writeFile(join(root, "response"), body.toString("base64"));
    const result = await readVerifiedRemoteWorkspaceFile({
      runner: createRunner(), workspaceRoot: "/workspace", contentRef: "result.md",
      byteSize, sha256: createHash("sha256").update(body).digest("hex"),
    });
    expect(result.equals(body)).toBe(true);
  });

  it("stops a remote command that exceeds the maximum encoded envelope", async () => {
    await writeFile(join(root, "response"), Buffer.alloc(4 * Math.ceil(MAX_REMOTE_DELIVERABLE_BYTES / 3) + 1, 65));
    const result = await createRunner().execute({ command: "node", args: ["unused"], timeoutMs: 10_000 });
    expect(result.exitCode).not.toBe(0);
  });
});


describe("native SSH shell command arguments", () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-ssh-argv-")));
    // Replace only the SSH network executable. The native adapter builds its
    // complete remote command, which runs in a real shell with a private HOME.
    const executable = join(root, "ssh");
    await writeFile(executable, `#!${process.execPath}\nconst { spawnSync } = require('node:child_process');\nconst child = spawnSync('/bin/sh', ['-c', process.argv.at(-1)], { stdio: 'inherit', env: { ...process.env, HOME: ${JSON.stringify(root)} } });\nif (child.error) throw child.error;\nprocess.exit(child.status ?? 1);\n`);
    await chmod(executable, 0o700);
    vi.stubEnv("PATH", `${root}:${process.env.PATH}`);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  const createRunner = () => createNativeSshCommandRunner({
    spec: {
      host: "fixture.invalid", port: 22, username: "fixture",
      remoteWorkspacePath: root, remoteCwd: root,
      privateKey: null, knownHosts: null, strictHostKeyChecking: true,
    },
  });

  it.each([
    ["sh", "-c"], ["sh", "-lc"], ["bash", "-c"], ["bash", "-lc"],
  ])("%s %s retains launch identity arguments and command inputs", async (command, flag) => {
    const identityPath = join(root, "identity 'quoted' path");
    const nonce = `nonce "quoted" $literal`;
    const name = "paperclip-runner-launch";
    const args = [identityPath, nonce, "", "space value", "'quote' $HOME; *"];
    const value = `task environment ' " $HOME`;
    const stdin = "input retained\nsecond line\n";
    const result = await createRunner().execute({
      command,
      args: [flag, 'set -eu; identity_path=$1; nonce=$2; printf "%s" "$nonce" > "$identity_path"; printf "%s\\0" "$0" "$@" "$PAPERCLIP_ARGV_TEST" "$PWD"; cat', name, ...args],
      cwd: root,
      env: { PAPERCLIP_ARGV_TEST: value },
      stdin,
      timeoutMs: 10_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.split("\0")).toEqual([name, ...args, value, root, stdin]);
    expect(await readFile(identityPath, "utf8")).toBe(nonce);
  });

  it("preserves a failed recovery command's status and stderr", async () => {
    const logs: Array<[string, string]> = [];
    const result = await createRunner().execute({
      command: "sh",
      args: ["-c", 'set -eu; printf "%s" "$1" >&2; exit 23', "recovery-probe", "identity unavailable"],
      timeoutMs: 10_000,
      onLog: async (stream, text) => { logs.push([stream, text]); },
    });
    expect(result.exitCode).toBe(23);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("identity unavailable");
    expect(logs).toContainEqual(["stderr", "identity unavailable"]);
  });

  it("passes environment, cwd, arguments and stdin to a direct executable", async () => {
    const value = `direct environment ' " $HOME`;
    const args = ["", "space argument", "literal $HOME; 'quoted'"];
    const result = await createRunner().execute({
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({args:process.argv.slice(1),value:process.env.PAPERCLIP_ARGV_TEST,cwd:process.cwd(),input:require('node:fs').readFileSync(0,'utf8')}))", ...args],
      cwd: root,
      env: { PAPERCLIP_ARGV_TEST: value },
      stdin: "direct input\n",
      timeoutMs: 10_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ args, value, cwd: root, input: "direct input\n" });
  });
});
