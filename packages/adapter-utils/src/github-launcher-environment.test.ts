import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ssh from "./ssh.js";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import { githubBrokerEnvironment } from "./github-launcher.js";
import { syncRemoteTextFilesWithHashSkip } from "./sandbox-callback-bridge.js";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  prepareGitHubOperationLaunchers,
  cleanupGitHubOperationLaunchers,
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

async function sandbox(layout: string, concurrent?: boolean) {
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
  const runner = { allowConcurrentSyncOperations: concurrent, execute: vi.fn(execute) };
  const target = { kind: "remote" as const, transport: "sandbox" as const,
    providerKey: "fixture", remoteCwd: root, runner };
  return { root, bin, remotePath, runner, target };
}

describe("managed GitHub launcher environment", () => {
  it("stages the complete remote launcher set in one control command", async () => {
    const fixture = await sandbox("tools with 'quotes'/bin", true);
    const env = await prepareGitHubOperationLaunchers({
      runId: "single-control-stage", target: fixture.target, cwd: fixture.root,
      env: githubBrokerEnvironment({ PATH: fixture.remotePath }, { url: "", token: "" }),
    });
    expect(fixture.runner.execute).toHaveBeenCalledTimes(1);
    expect(fixture.runner.execute.mock.calls[0]![0].bypassSession).toBe(true);
    const result = await fixture.runner.execute({ command: "sh", args: ["-c", "git; gh"], env });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("git started\ngh started\n");
  });

  it("uses one bounded control command and preserves the staged environment", async () => {
    const fixture = await sandbox("tools with 'quotes'/bin", true);
    const execute = fixture.runner.execute.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = 0;
    let active = 0;
    let maximum = 0;
    fixture.runner.execute.mockImplementation(async (input) => {
      if (!input.stdin) return execute(input);
      started += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        await gate;
        return await execute(input);
      } finally { active -= 1; }
    });
    const preparation = prepareGitHubOperationLaunchers({
      runId: "bounded-staging", target: fixture.target, cwd: fixture.root,
      env: githubBrokerEnvironment({ PATH: fixture.remotePath }, { url: "", token: "" }),
    });
    try {
      await vi.waitFor(() => expect(started).toBe(1));
      expect(active).toBe(1);
    } finally { release(); await preparation; }
    const env = await preparation;
    expect(maximum).toBe(1);
    expect(active).toBe(0);
    expect(started).toBe(1);
    expect(env.PATH).toBe(`${env.PAPERCLIP_GITHUB_LAUNCHER_DIR}:${fixture.remotePath}`);
    const command = await fixture.runner.execute({ command: "bash", args: ["--noprofile", "--norc", "-c", "git; gh"], env });
    expect(command.exitCode, command.stderr).toBe(0);
    expect(command.stdout).toBe("git started\ngh started\n");
    for (const name of [".profile", ".bash_profile", ".bashrc", ".zshenv", ".zprofile", ".zshrc"]) {
      const script = await readFile(path.join(env.PAPERCLIP_GITHUB_LAUNCHER_DIR, name), "utf8");
      const result = await fixture.runner.execute({ command: "sh", args: ["-c", `${script}\nprintf '%s' "$PATH"`] });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toBe(env.PATH);
    }
  });

  it("settles failed upload batches before rejecting and starting no later files", async () => {
    const fixture = await sandbox("usr/bin", true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = 0;
    let active = 0;
    let settled = false;
    fixture.runner.execute.mockImplementation(async (input) => {
      started += 1;
      active += 1;
      try {
        await gate;
        return { exitCode: 42, signal: null, timedOut: false, pid: null,
          startedAt: new Date().toISOString(), stdout: "", stderr: "fixture upload failed" };
      } finally { active -= 1; }
    });
    const preparation = prepareGitHubOperationLaunchers({
      runId: "failed-batch", target: fixture.target, cwd: fixture.root, env: { PATH: fixture.remotePath },
    });
    const outcome = preparation.then(() => { settled = true; return null; }, (error: unknown) => { settled = true; return error; });
    try {
      await vi.waitFor(() => expect(started).toBe(1));
      expect(settled).toBe(false);
      expect(active).toBe(1);
    } finally { release(); await outcome; }
    expect(await outcome).toBeInstanceOf(Error);
    expect(String(await outcome)).toContain("stage GitHub operation launcher");
    expect(started).toBe(1);
    expect(active).toBe(0);
    expect(fixture.runner.execute.mock.calls.some(([input]) => input.args?.join(" ").startsWith("chmod 700"))).toBe(false);
  });

  it("keeps concurrent staging of the same remote launcher directory coherent", async () => {
    const fixture = await sandbox("usr/bin", true);
    const input = { runId: "same-directory", target: fixture.target, cwd: fixture.root,
      env: githubBrokerEnvironment({ PATH: fixture.remotePath }, { url: "", token: "" }) };
    const [first, second] = await Promise.all([prepareGitHubOperationLaunchers(input), prepareGitHubOperationLaunchers(input)]);
    expect(first).toEqual(second);
    const command = await fixture.runner.execute({ command: "bash", args: ["--noprofile", "--norc", "-c", "git; gh"], env: second });
    expect(command.exitCode, command.stderr).toBe(0);
    expect(command.stdout).toBe("git started\ngh started\n");
    expect(await readFile(path.join(first.PAPERCLIP_GITHUB_LAUNCHER_DIR, "package.json"), "utf8")).toBe('{"type":"commonjs"}\n');
  });

  it.each([undefined, false])("keeps providers without a concurrent capability serial (%s)", async (concurrent) => {
    const fixture = await sandbox("usr/bin", concurrent);
    const execute = fixture.runner.execute.getMockImplementation()!;
    let active = 0;
    let maximum = 0;
    fixture.runner.execute.mockImplementation(async (input) => {
      active += 1;
      maximum = Math.max(maximum, active);
      try { return await execute(input); } finally { active -= 1; }
    });
    await prepareGitHubOperationLaunchers({ runId: "serial-provider", target: fixture.target,
      cwd: fixture.root, env: { PATH: fixture.remotePath } });
    expect(maximum).toBe(1);
    expect(active).toBe(0);
    expect(fixture.runner.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects corrupt batch input before replacing that file or staging later files", async () => {
    const fixture = await sandbox("usr/bin");
    const execute = fixture.runner.execute.getMockImplementation()!;
    const directory = path.join(fixture.root, "batch");
    const files = ["first", "corrupt", "later"].map(name => ({
      remoteDir: directory, remotePath: path.join(directory, name), body: name + "\n",
      label: name, action: "stage fixture", lockDir: path.join(directory, "." + name + ".lock"),
    }));
    fixture.runner.execute.mockImplementation(input => execute({ ...input,
      stdin: input.stdin?.replace(Buffer.from("corrupt\n").toString("base64"), Buffer.from("invalid\n").toString("base64")),
    }));
    await expect(syncRemoteTextFilesWithHashSkip({ runner: fixture.runner, remoteCwd: fixture.root,
      files, action: "stage fixtures" })).rejects.toThrow("sha mismatch");
    expect(await readFile(path.join(directory, "first"), "utf8")).toBe("first\n");
    expect(await readdir(directory)).toEqual(["first"]);
  });

  it("hash-skips a complete batch and repairs a missing executable bit", async () => {
    const fixture = await sandbox("usr/bin");
    const directory = path.join(fixture.root, "batch 'quoted'");
    const files = [{ remoteDir: directory, remotePath: path.join(directory, "entry"), body: "#!/bin/sh\nprintf done\n",
      label: "entry", action: "stage fixture", lockDir: path.join(directory, ".entry.lock"), executable: true }];
    const input = { runner: fixture.runner, remoteCwd: fixture.root, files, action: "stage fixtures" };
    expect((await syncRemoteTextFilesWithHashSkip(input))[0]?.uploaded).toBe(true);
    const firstHash = (await syncRemoteTextFilesWithHashSkip(input))[0]?.sha256;
    await fixture.runner.execute({ command: "chmod", args: ["600", files[0]!.remotePath] });
    const restored = await syncRemoteTextFilesWithHashSkip(input);
    expect(restored).toEqual([{ uploaded: false, sha256: firstHash }]);
    const result = await fixture.runner.execute({ command: files[0]!.remotePath });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("done");
    expect(await readdir(directory)).toEqual(["entry"]);
  });

  it.each([0, 17])("rejects an invalid batch size before remote work (%s)", async count => {
    const fixture = await sandbox("usr/bin");
    const file = { remoteDir: fixture.root, remotePath: path.join(fixture.root, "entry"), body: "entry",
      label: "entry", action: "stage fixture", lockDir: path.join(fixture.root, ".entry.lock") };
    await expect(syncRemoteTextFilesWithHashSkip({ runner: fixture.runner, remoteCwd: fixture.root,
      files: Array.from({ length: count }, () => file), action: "stage fixtures" })).rejects.toThrow("1 to 16 files");
    expect(fixture.runner.execute).not.toHaveBeenCalled();
  });

  it("rejects an oversized batch before remote work", async () => {
    const fixture = await sandbox("usr/bin");
    await expect(syncRemoteTextFilesWithHashSkip({ runner: fixture.runner, remoteCwd: fixture.root,
      files: [{ remoteDir: fixture.root, remotePath: path.join(fixture.root, "entry"), body: "x".repeat(1024 * 1024),
        label: "entry", action: "stage fixture", lockDir: path.join(fixture.root, ".entry.lock") }],
      action: "stage fixtures" })).rejects.toThrow("1 MiB");
    expect(fixture.runner.execute).not.toHaveBeenCalled();
  });

  // The Daytona native directory oracle uses Linux inotify. Run its real
  // filesystem regression on that platform; shell/launcher tests cover both.
  it.runIf(process.platform === "linux")("keeps launcher restaging and command scratch inside the runner runtime", async () => {
    const fixture = await sandbox("usr/bin");
    const privateRoot = path.join(fixture.root, ".paperclip-runtime");
    await mkdir(path.join(privateRoot, "paperclip-runner"), { recursive: true });
    await writeFile(path.join(fixture.root, "user.txt"), "Existing work\n");
    const mutations: string[] = [];
    const watchers = [fixture.root, privateRoot].map((directory) => watch(directory, (_kind, name) => {
      const changed = path.relative(fixture.root, path.join(directory, String(name)));
      if (changed !== ".paperclip-runtime/paperclip-runner") mutations.push(changed);
    }));
    try {
      const input = { runId: "restart-same-launchers", target: fixture.target, cwd: fixture.root,
        env: githubBrokerEnvironment({}, { url: "", token: "" }) };
      const first = await prepareGitHubOperationLaunchers(input);
      const original = await readFile(path.join(first.PAPERCLIP_GITHUB_LAUNCHER_DIR, "git"), "utf8");
      const restored = await prepareGitHubOperationLaunchers(input);
      const command = await fixture.runner.execute({
        command: path.join(restored.PAPERCLIP_GITHUB_LAUNCHER_DIR, "git"), args: ["--version"], env: restored,
      });
      expect(command.exitCode, command.stderr).toBe(0);
      expect(await readFile(path.join(restored.PAPERCLIP_GITHUB_LAUNCHER_DIR, "git"), "utf8")).toBe(original);
      expect(await readFile(path.join(fixture.root, "user.txt"), "utf8")).toBe("Existing work\n");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mutations).toEqual([]);
      // The watcher must still notice housekeeping outside that exact runtime.
      await mkdir(path.join(privateRoot, "outside-runtime-control"));
      await vi.waitFor(() => expect(mutations).toContain(".paperclip-runtime/outside-runtime-control"));
    } finally { for (const watcher of watchers) watcher.close(); }
  });

  it.each(["module", "commonjs"])("runs managed GitHub launchers inside a %s project", async (type) => {
    const fixture = await sandbox("usr/bin");
    const packageJson = JSON.stringify({ type });
    await writeFile(path.join(fixture.root, "package.json"), packageJson);
    // Exercise real Git; gh uses the fixture CLI because it need not be installed.
    await rm(path.join(fixture.bin, "git"));
    const env = await prepareGitHubOperationLaunchers({
      runId: "run-package-type", target: fixture.target, cwd: fixture.root,
      env: githubBrokerEnvironment({}, { url: "", token: "" }),
    });
    for (const cli of ["git", "gh"]) {
      const result = await fixture.runner.execute({
        command: path.join(env.PAPERCLIP_GITHUB_LAUNCHER_DIR, cli), args: ["--version"], env,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toMatch(cli === "git" ? /^git version / : /^gh started\n$/);
    }
    expect(await readFile(path.join(fixture.root, "package.json"), "utf8")).toBe(packageJson);
  });

  it("clears empty identity overrides in sandbox shells and preserves a captured identity", async () => {
    const fixture = await sandbox("usr/bin");
    const env = await prepareGitHubOperationLaunchers({
      runId: "run-git-identity", target: fixture.target, cwd: fixture.root,
      env: githubBrokerEnvironment({ GIT_AUTHOR_NAME: "Host Author" }, { url: "", token: "" }),
    });
    const readIdentity = `node -e 'process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)$/.test(key)))))'`;
    const shell = await fixture.runner.execute({ command: "bash", args: ["--noprofile", "--norc", "-c", readIdentity], env });
    expect(shell.exitCode, shell.stderr).toBe(0);
    expect(JSON.parse(shell.stdout)).toEqual({});

    const identity = { GIT_AUTHOR_NAME: "Captured Author", GIT_AUTHOR_EMAIL: "author@example.test",
      GIT_COMMITTER_NAME: "Captured Committer", GIT_COMMITTER_EMAIL: "committer@example.test" };
    for (const profile of [".profile", ".bash_profile", ".bashrc", ".zshenv", ".zprofile", ".zshrc"]) {
      const script = await readFile(path.join(env.PAPERCLIP_GITHUB_LAUNCHER_DIR, profile), "utf8");
      for (const captured of [false, true]) {
        const result = await fixture.runner.execute({ command: "sh", args: ["-c", `${script}\n${readIdentity}`],
          env: { ...env, ...(captured ? identity : {}) } });
        expect(result.exitCode, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(captured ? identity : {});
      }
    }
  });

  it("saves local commits through staged sandbox shells without author setup", async () => {
    const fixture = await sandbox("usr/bin");
    await rm(path.join(fixture.bin, "git"));
    await writeFile(path.join(fixture.root, ".gitconfig"), "[user]\nname = Image User\nemail = image@example.test\n");
    const env = await prepareGitHubOperationLaunchers({
      runId: "default-local-author", target: fixture.target, cwd: fixture.root,
      env: githubBrokerEnvironment({}, { url: "", token: "" }),
    });
    const command = async (script: string) => {
      const result = await fixture.runner.execute({ command: "bash", args: ["--noprofile", "--norc", "-c", script], env });
      expect(result.exitCode, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    await command("git init -q && printf 'first\\n' > work.txt && git add work.txt && git commit -qm first");
    await command("printf 'second\\n' >> work.txt && git add work.txt && git commit -qm second");
    expect(await command("git log --format='%an <%ae>|%cn <%ce>'"))
      .toBe(Array(2).fill("Paperclip <noreply@paperclip.ing>|Paperclip <noreply@paperclip.ing>").join("\n"));
    expect(await command("git show HEAD:work.txt")).toBe("first\nsecond");
    expect(await readFile(path.join(fixture.root, ".git", "config"), "utf8")).not.toContain("[user]");
    expect(await readFile(path.join(fixture.root, ".gitconfig"), "utf8")).toContain("Image User");
    expect(await readdir(env.GH_CONFIG_DIR!)).toEqual([]);
  });

  it("keeps task-only startup free of command probes and host credentials", async () => {
    const target = { kind: "remote" as const, transport: "sandbox" as const, providerKey: "plugin", remoteCwd: "/project", runnerTask: async () => ({}) };
    await expect(prepareGitHubExecutionEnvironment({ target, cwd: "/absent-controller-path", env: {}, hostCredentials: false, networkAccess: true }))
      .resolves.toMatchObject({ PAPERCLIP_GITHUB_AUTH_MODE: "managed", PAPERCLIP_GIT_METADATA_ROOTS: "[]", PAPERCLIP_RUNNER_NETWORK_ACCESS: "enabled" });
    await expect(prepareGitHubExecutionEnvironment({ target, cwd: "/absent-controller-path", env: {}, hostCredentials: true, networkAccess: true }))
      .rejects.toThrow("cannot import host GitHub credentials");
  });

  it.each([false, true])("probes the remote workspace when the controller cwd is absent (host credentials: %s)", async (hostCredentials) => {
    const fixture = await sandbox("usr/bin");
    const env = await prepareGitHubExecutionEnvironment({
      target: fixture.target,
      cwd: path.join(fixture.root, "controller-only", "agent-workspace"),
      env: {},
      hostCredentials,
      networkAccess: true,
    });

    expect(env.PAPERCLIP_RUNNER_NETWORK_ACCESS).toBe("enabled");
    expect(env.PAPERCLIP_GIT_METADATA_ROOTS).toBe("[]");
    expect(JSON.parse(env.PAPERCLIP_RUNNER_NETWORK_ROOTS!)).not.toHaveLength(0);
    expect(fixture.runner.execute).toHaveBeenCalledWith(expect.objectContaining({ cwd: fixture.root }));
  });

  it("reads Git metadata from the SSH workspace instead of an existing controller directory", async () => {
    const fixture = await sandbox("ssh-toolchain/bin");
    // Use real Git for the probe, not the launcher fixture's stub.
    await rm(path.join(fixture.bin, "git"));
    await exec("git", ["init", fixture.root]);
    const controllerCwd = path.join(fixture.root, "controller");
    await mkdir(controllerCwd);
    vi.spyOn(ssh, "createSshCommandManagedRuntimeRunner").mockReturnValue(fixture.runner);
    const target = { kind: "remote" as const, transport: "ssh" as const, remoteCwd: fixture.root,
      spec: { host: "sandbox.example.test", port: 22, username: "runner", remoteCwd: fixture.root,
        remoteWorkspacePath: fixture.root, privateKey: null, knownHosts: null, strictHostKeyChecking: true } };

    const env = await prepareGitHubExecutionEnvironment({
      target, cwd: controllerCwd, env: {}, hostCredentials: false, networkAccess: true,
    });

    expect(JSON.parse(env.PAPERCLIP_GIT_METADATA_ROOTS!)).toEqual([await realpath(path.join(fixture.root, ".git"))]);
  });

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
