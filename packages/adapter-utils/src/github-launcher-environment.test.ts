import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ssh from "./ssh.js";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  prepareGitHubOperationLaunchers,
  prepareGitHubExecutionEnvironment,
  runAdapterExecutionTargetProcess,
} from "./execution-target.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function sandbox(layout: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-launcher-env-"));
  roots.push(root);
  const bin = path.join(root, layout);
  await mkdir(bin, { recursive: true });
  for (const cli of ["claude", "codex", "git", "gh"]) {
    await writeFile(path.join(bin, cli), `#!/bin/sh\nprintf '%s\\n' '${cli} started'\n`, { mode: 0o700 });
  }
  const remotePath = `${bin}:${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;
  // Execute real shells and staged launchers, with a provider-owned environment.
  // Do not inherit the controller's PATH, HOME, credentials, or shell hooks.
  const execute: CommandManagedRuntimeRunner["execute"] = async (input) => {
    const startedAt = new Date().toISOString();
    try {
      const execution = exec(input.command, input.args ?? [], {
        cwd: input.cwd ?? root,
        env: { HOME: root, PATH: remotePath, ...input.env },
        timeout: input.timeoutMs ?? 15_000,
      });
      const inputComplete = new Promise<void>((resolve, reject) => {
        const stdin = execution.child.stdin;
        if (!stdin) return resolve();
        // Hash-skip staging can exit before reading the supplied file body.
        // Its exit result still determines success; other input errors fail.
        stdin.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "EPIPE") resolve();
          else reject(error);
        });
        stdin.end(input.stdin ?? "", resolve);
      });
      const [result] = await Promise.all([execution, inputComplete]);
      return { ...result, exitCode: 0, signal: null, timedOut: false, pid: null, startedAt };
    } catch (error) {
      const result = error as Error & { code?: number; killed?: boolean; stdout?: string; stderr?: string };
      return { exitCode: result.code ?? 1, signal: null, timedOut: result.killed ?? false,
        stdout: result.stdout ?? "", stderr: result.stderr ?? "", pid: null, startedAt };
    }
  };
  const runner = { execute: vi.fn(execute) };
  const target = { kind: "remote" as const, transport: "sandbox" as const,
    providerKey: "fixture", remoteCwd: root, runner };
  return { root, bin, remotePath, runner, target };
}

describe("managed GitHub launcher environment", () => {
  it("uses target Git configuration without importing controller credentials", async () => {
    const fixture = await sandbox("usr/bin");
    vi.stubEnv("GH_TOKEN", "controller-secret");
    await mkdir(path.join(fixture.root, ".config/gh"), { recursive: true });
    await writeFile(path.join(fixture.root, ".config/gh/hosts.yml"), "host credential fixture");
    const execute = fixture.runner.execute.getMockImplementation()!;
    fixture.runner.execute.mockImplementation(async (input) => {
      expect(input.command).toBe("sh"); // No Node executable is required on the SSH host.
      const result = await execute(input);
      return { ...result, stdout: `SSH login banner\n${result.stdout}\nlogout` };
    });
    const env = await prepareGitHubExecutionEnvironment({
      target: fixture.target, cwd: fixture.root, env: {
        PAPERCLIP_GIT_METADATA_ROOTS: '["/injected"]',
        PAPERCLIP_RUNNER_NETWORK_ROOTS: '["/injected"]',
        PAPERCLIP_GITHUB_HOST_HOME: "/injected",
        PAPERCLIP_GITHUB_AUTH_MODE: "managed",
        PAPERCLIP_RUNNER_NETWORK_ACCESS: "disabled",
      }, hostCredentials: true, networkAccess: true,
    });
    expect(env.PAPERCLIP_GIT_METADATA_ROOTS).not.toContain("/injected");
    expect(env.PAPERCLIP_RUNNER_NETWORK_ROOTS).not.toContain("/injected");
    expect(env.PAPERCLIP_GITHUB_AUTH_MODE).toBe("host");
    expect(env.PAPERCLIP_RUNNER_NETWORK_ACCESS).toBe("enabled");
    expect(env.PAPERCLIP_GITHUB_HOST_HOME).toBe(fixture.root);
    expect(env.GH_CONFIG_DIR).toBe(path.join(fixture.root, ".config/gh"));
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.PAPERCLIP_GITHUB_LAUNCHER_DIR).toBeUndefined();
  });

  it("preserves local host credential helpers and validates worktree metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-host-git-")); roots.push(root);
    vi.stubEnv("HOME", root);
    vi.stubEnv("GH_TOKEN", "legacy-token");
    await writeFile(path.join(root, ".gitconfig"), '[credential]\n  helper = store\n');
    await exec("git", ["init", path.join(root, "repo")]);
    const env = await prepareGitHubExecutionEnvironment({ target: null, cwd: path.join(root, "repo"), env: {}, hostCredentials: true, networkAccess: true });
    expect(env.GH_TOKEN).toBe("legacy-token");
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(env.PAPERCLIP_GIT_METADATA_ROOTS).toContain("/repo/.git");
    const config = await exec("git", ["config", "credential.helper"], { cwd: root, env: { ...process.env, ...env } });
    expect(config.stdout.trim()).toBe("store");
    const isolated = await prepareGitHubExecutionEnvironment({ target: null, cwd: root, env: {}, hostCredentials: false, networkAccess: false });
    expect(isolated.GH_TOKEN).toBeUndefined();
    expect(isolated.PAPERCLIP_RUNNER_NETWORK_ACCESS).toBe("disabled");
    expect(isolated.PAPERCLIP_GITHUB_HOST_HOME).toBeUndefined();
  });

  it.each(["nvm/current/bin", "usr/local/bin", "tools with 'quotes'/bin"])(
    "preserves %s CLIs and keeps GitHub wrappers first in child shells",
    async (layout) => {
      const fixture = await sandbox(layout);
      vi.stubEnv("PATH", "/controller-only/bin");
      const env = await prepareGitHubOperationLaunchers({
        runId: "run-layout", target: fixture.target, cwd: "/controller", env: {},
      });
      expect(env.PATH).toBe(`${env.PAPERCLIP_GITHUB_LAUNCHER_DIR}:${fixture.remotePath}`);
      for (const cli of ["claude", "codex"]) {
        await ensureAdapterExecutionTargetCommandResolvable(cli, fixture.target, fixture.root, env);
        const result = await runAdapterExecutionTargetProcess("run-layout", fixture.target, "bash", [
          "--noprofile", "--norc", "-c", `command -v git; command -v gh; ${cli}`,
        ], { cwd: fixture.root, env, timeoutSec: 5, graceSec: 1, onLog: async () => {} });
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stdout.trim().split("\n")).toEqual([
          `${env.PAPERCLIP_GITHUB_LAUNCHER_DIR}/git`,
          `${env.PAPERCLIP_GITHUB_LAUNCHER_DIR}/gh`,
          `${cli} started`,
        ]);
      }
      for (const profile of [".profile", ".bash_profile", ".bashrc", ".zshenv", ".zprofile", ".zshrc"]) {
        const script = await readFile(path.join(env.PAPERCLIP_GITHUB_LAUNCHER_DIR, profile), "utf8");
        const result = await fixture.runner.execute({ command: "sh", args: ["-c", `${script}\nprintf '%s' "$PATH"`] });
        expect(result.stdout).toBe(env.PATH);
      }
      // The wrappers' Node interpreter and underlying commands are still reachable.
      const github = await fixture.runner.execute({ command: "bash", args: ["-c", "git; gh"], env });
      expect(github.exitCode, github.stderr).toBe(0);
      expect(github.stdout).toBe("git started\ngh started\n");
    },
  );

  it("preserves an explicit remote PATH without querying the remote environment", async () => {
    const fixture = await sandbox("custom/bin");
    const env = await prepareGitHubOperationLaunchers({
      runId: "run-explicit", target: fixture.target, cwd: fixture.root, env: { PATH: fixture.remotePath },
    });
    expect(env.PATH).toBe(`${env.PAPERCLIP_GITHUB_LAUNCHER_DIR}:${fixture.remotePath}`);
    expect(fixture.runner.execute.mock.calls.every(([input]) => !input.args?.join(" ").includes("$PATH"))).toBe(true);
  });

  it("does not copy an inherited controller PATH into a remote launcher", async () => {
    const fixture = await sandbox("nvm/bin");
    vi.stubEnv("PATH", "/controller-only/bin");
    const env = await prepareGitHubOperationLaunchers({
      runId: "run-inherited", target: fixture.target, cwd: fixture.root, env: { PATH: process.env.PATH! },
    });
    expect(env.PATH).toBe(`${env.PAPERCLIP_GITHUB_LAUNCHER_DIR}:${fixture.remotePath}`);
  });

  it("keeps an explicit empty remote PATH empty apart from the managed wrappers", async () => {
    const fixture = await sandbox("nvm/bin");
    const env = await prepareGitHubOperationLaunchers({
      runId: "run-empty", target: fixture.target, cwd: fixture.root, env: { PATH: "" },
    });
    expect(env.PATH).toBe(env.PAPERCLIP_GITHUB_LAUNCHER_DIR);
    expect(fixture.runner.execute.mock.calls.every(([input]) => !input.args?.join(" ").includes("$PATH"))).toBe(true);
    const result = await fixture.runner.execute({ command: "/bin/sh", args: ["-c", "command -v claude"], env });
    expect(result.exitCode).not.toBe(0);
  });

  it("reads the SSH target PATH and ignores login banners", async () => {
    const fixture = await sandbox("ssh-toolchain/bin");
    fixture.runner.execute.mockResolvedValueOnce({ exitCode: 0, timedOut: false, signal: null,
      stdout: `Welcome\n\0${fixture.remotePath}\0\n`, stderr: "", pid: null, startedAt: new Date().toISOString() });
    vi.spyOn(ssh, "createSshCommandManagedRuntimeRunner").mockReturnValue(fixture.runner);
    const target = { kind: "remote" as const, transport: "ssh" as const, remoteCwd: fixture.root,
      spec: { host: "sandbox.example.test", port: 22, username: "runner", remoteCwd: fixture.root,
        remoteWorkspacePath: fixture.root, privateKey: null, knownHosts: null, strictHostKeyChecking: true } };
    const env = await prepareGitHubOperationLaunchers({ runId: "run-ssh", target, cwd: fixture.root, env: {} });
    expect(env.PATH).toBe(`${env.PAPERCLIP_GITHUB_LAUNCHER_DIR}:${fixture.remotePath}`);
    expect(fixture.runner.execute.mock.calls[0]?.[0].env).toBeUndefined();
  });

  it("uses the launch environment for install and re-probe after a missing command", async () => {
    const fixture = await sandbox("custom/bin");
    const env = { PATH: fixture.remotePath, HOME: fixture.root };
    await ensureAdapterExecutionTargetCommandResolvable("fixture-cli", fixture.target, fixture.root, env, {
      installCommand: `cp ${ssh.shellQuote(path.join(fixture.bin, "claude"))} ${ssh.shellQuote(path.join(fixture.bin, "fixture-cli"))}`,
    });
    expect(fixture.runner.execute.mock.calls).toHaveLength(3);
    for (const [input] of fixture.runner.execute.mock.calls) expect(input.env).toEqual(env);
  });

  it("checks command availability with the launch environment, not the provider default", async () => {
    const fixture = await sandbox("nvm/bin");
    const env = { PATH: "/usr/bin:/bin" };
    // The binary exists on the provider PATH, but the requested launch excludes it.
    await expect(ensureAdapterExecutionTargetCommandResolvable(
      "claude", fixture.target, fixture.root, env,
    )).rejects.toThrow('Command "claude" is not installed or not on PATH');
    const result = await runAdapterExecutionTargetProcess("run-missing", fixture.target, "sh", ["-c", "claude"], {
      cwd: fixture.root, env, timeoutSec: 5, graceSec: 1, onLog: async () => {},
    });
    expect(result.exitCode).toBe(127);
  });

  it.each([
    { exitCode: 1, timedOut: false, stdout: "" },
    { exitCode: 0, timedOut: true, stdout: "" },
    { exitCode: 0, timedOut: false, stdout: "login banner only" },
    { exitCode: 0, timedOut: false, stdout: "\0\0" },
  ])("fails before staging when remote PATH discovery fails: %j", async (failure) => {
    const fixture = await sandbox("nvm/bin");
    fixture.runner.execute.mockResolvedValueOnce({ ...failure, signal: null, stderr: "private diagnostic",
      pid: null, startedAt: new Date().toISOString() });
    await expect(prepareGitHubOperationLaunchers({
      runId: "run-failure", target: fixture.target, cwd: fixture.root, env: {},
    })).rejects.toThrow("Could not resolve remote PATH for managed GitHub launchers");
    expect(fixture.runner.execute).toHaveBeenCalledTimes(1);
  });
});
