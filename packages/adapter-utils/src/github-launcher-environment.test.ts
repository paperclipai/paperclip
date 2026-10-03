import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ssh from "./ssh.js";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import { githubBrokerEnvironment } from "./github-launcher.js";
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

  it("keeps a local tool's node_modules/.bin on PATH in a shell the launcher starts", async () => {
    const fixture = await sandbox("usr/bin");
    // A tool such as a package runner prepends its own binary directory and then
    // execs a shell. The launcher profile must not discard that directory.
    const localBin = path.join(fixture.root, "node_modules", ".bin");
    await mkdir(localBin, { recursive: true });
    await writeFile(path.join(localBin, "local-tool-marker"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const env = await prepareGitHubOperationLaunchers({
      runId: "run-local-bin", target: fixture.target, cwd: fixture.root,
      env: githubBrokerEnvironment({}, { url: "", token: "" }),
    });
    // A non-interactive shell reads BASH_ENV. Do not let it read an unrelated
    // ~/.bashrc as well; the staged .bashrc is the file under test.
    const result = await fixture.runner.execute({
      command: "bash", args: ["--noprofile", "--norc", "-c",
        "command -v local-tool-marker; command -v git; command -v gh"],
      env: { HOME: fixture.root, PATH: `${localBin}:/usr/local/bin:/usr/bin:/bin`,
        BASH_ENV: env.BASH_ENV, ZDOTDIR: env.ZDOTDIR },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    // The launchers still win, and the spawning tool's binary still resolves.
    expect(result.stdout.trim().split("\n")).toEqual([
      path.join(localBin, "local-tool-marker"),
      path.join(env.PAPERCLIP_GITHUB_LAUNCHER_DIR, "git"),
      path.join(env.PAPERCLIP_GITHUB_LAUNCHER_DIR, "gh"),
    ]);
  });

  it.each([".profile", ".bash_profile", ".bashrc", ".zshenv", ".zprofile", ".zshrc"])(
    "prepends the launchers to, and does not replace, PATH in %s",
    async (profile) => {
      const fixture = await sandbox("usr/bin");
      const env = await prepareGitHubOperationLaunchers({
        runId: `run-prepend-${profile.replace(/\W/g, "")}`, target: fixture.target, cwd: fixture.root,
        env: githubBrokerEnvironment({}, { url: "", token: "" }),
      });
      const script = await readFile(path.join(env.PAPERCLIP_GITHUB_LAUNCHER_DIR, profile), "utf8");
      const result = await fixture.runner.execute({ command: "sh", args: ["-c", `${script}\nprintf '%s' "$PATH"`],
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" } });
      expect(result.stdout).toBe(`${env.PAPERCLIP_GITHUB_LAUNCHER_DIR}:/usr/local/bin:/usr/bin:/bin`);
    },
  );

  it("keeps the launcher directory first without growing PATH when a shell sources the profile again", async () => {
    const fixture = await sandbox("usr/bin");
    const localBin = path.join(fixture.root, "node_modules", ".bin");
    await mkdir(localBin, { recursive: true });
    await writeFile(path.join(localBin, "local-tool-marker"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const env = await prepareGitHubOperationLaunchers({
      runId: "run-repeat", target: fixture.target, cwd: fixture.root,
      env: githubBrokerEnvironment({}, { url: "", token: "" }),
    });
    const childPath = `${localBin}:/usr/local/bin:/usr/bin:/bin`;
    // A login shell reads several of the staged profiles, and every nested shell
    // reads one more. PATH must not collect a copy per source.
    const result = await fixture.runner.execute({
      command: "bash", args: ["-c", '. "$BASH_ENV"; . "$BASH_ENV"; printf "%s" "$PATH"'],
      env: { HOME: fixture.root, PATH: childPath, BASH_ENV: env.BASH_ENV, ZDOTDIR: env.ZDOTDIR },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${env.PAPERCLIP_GITHUB_LAUNCHER_DIR}:${childPath}`);
  });

  it("restores launcher priority without dropping PATH when a login profile reorders it", async () => {
    const fixture = await sandbox("usr/bin");
    const env = await prepareGitHubOperationLaunchers({
      runId: "run-reorder", target: fixture.target, cwd: fixture.root,
      env: githubBrokerEnvironment({}, { url: "", token: "" }),
    });
    // A login profile can move directories around. The launchers must return to
    // the front, and every other entry must survive that move.
    const reordered = `/usr/bin:${env.PAPERCLIP_GITHUB_LAUNCHER_DIR}:/usr/local/bin:/bin`;
    const result = await fixture.runner.execute({
      command: "sh", args: ["-c", '. "$BASH_ENV"; printf "%s" "$PATH"'],
      env: { HOME: fixture.root, PATH: reordered, BASH_ENV: env.BASH_ENV, ZDOTDIR: env.ZDOTDIR },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${env.PAPERCLIP_GITHUB_LAUNCHER_DIR}:/usr/bin:/usr/local/bin:/bin`);
  });

  it("restores the managed PATH in a shell that starts with no PATH at all", async () => {
    const fixture = await sandbox("usr/bin");
    const env = await prepareGitHubOperationLaunchers({
      runId: "run-empty-child", target: fixture.target, cwd: fixture.root,
      env: githubBrokerEnvironment({}, { url: "", token: "" }),
    });
    // An empty PATH is not a caller choice, so the profile falls back to the
    // managed snapshot instead of leaving the shell with one entry.
    const result = await fixture.runner.execute({ command: "/bin/sh", args: ["-c", '. "$BASH_ENV"; printf "%s" "$PATH"'],
      env: { HOME: fixture.root, PATH: "", BASH_ENV: env.BASH_ENV, ZDOTDIR: env.ZDOTDIR } });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe(env.PATH);
  });

  it("keeps a launcher-only PATH narrow instead of restoring the managed snapshot", async () => {
    const fixture = await sandbox("usr/bin");
    const env = await prepareGitHubOperationLaunchers({
      runId: "run-launcher-only", target: fixture.target, cwd: fixture.root,
      env: githubBrokerEnvironment({}, { url: "", token: "" }),
    });
    // A shell that arrived with only the launcher directory on PATH asked for
    // exactly that. It is a caller choice, not an empty PATH, so the profile must
    // not hand back the directories the caller left out.
    const result = await fixture.runner.execute({ command: "/bin/sh", args: ["-c", '. "$BASH_ENV"; printf "%s" "$PATH"'],
      env: { HOME: fixture.root, PATH: env.PAPERCLIP_GITHUB_LAUNCHER_DIR, BASH_ENV: env.BASH_ENV, ZDOTDIR: env.ZDOTDIR } });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe(env.PAPERCLIP_GITHUB_LAUNCHER_DIR);
    expect(result.stdout).not.toBe(env.PATH);
  });

  it("keeps empty PATH entries, which tell the shell to search the current directory", async () => {
    const fixture = await sandbox("usr/bin");
    const env = await prepareGitHubOperationLaunchers({
      runId: "run-empty-entries", target: fixture.target, cwd: fixture.root,
      env: githubBrokerEnvironment({}, { url: "", token: "" }),
    });
    const launcher = env.PAPERCLIP_GITHUB_LAUNCHER_DIR;
    for (const inherited of [":/usr/bin", "::/usr/bin", "/usr/bin:", "::/usr/bin:"]) {
      // The launcher directory is not one of these entries, so the profile has
      // to produce exactly the caller's list with the launcher in front of it.
      const result = await fixture.runner.execute({ command: "/bin/sh", args: ["-c", '. "$BASH_ENV"; printf "%s" "$PATH"'],
        env: { HOME: fixture.root, PATH: inherited, BASH_ENV: env.BASH_ENV, ZDOTDIR: env.ZDOTDIR } });
      expect(result.exitCode, `${inherited}: ${result.stderr}`).toBe(0);
      expect(result.stdout, inherited).toBe(`${launcher}:${inherited}`);
    }
  });

  it("moves the launcher directory to the front of a PATH that also has empty entries", async () => {
    const fixture = await sandbox("usr/bin");
    const env = await prepareGitHubOperationLaunchers({
      runId: "run-empty-entries-reorder", target: fixture.target, cwd: fixture.root,
      env: githubBrokerEnvironment({}, { url: "", token: "" }),
    });
    // A login profile can move the launchers and leave empty entries behind at
    // the same time. Both the move and the empty entries have to survive.
    const launcher = env.PAPERCLIP_GITHUB_LAUNCHER_DIR;
    const result = await fixture.runner.execute({ command: "/bin/sh", args: ["-c", '. "$BASH_ENV"; printf "%s" "$PATH"'],
      env: { HOME: fixture.root, PATH: `::${launcher}::/usr/bin`, BASH_ENV: env.BASH_ENV, ZDOTDIR: env.ZDOTDIR } });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${launcher}::::/usr/bin`);
  });

  it("leaves a caller's exported variables alone instead of overwriting and unsetting them", async () => {
    const fixture = await sandbox("usr/bin");
    const env = await prepareGitHubOperationLaunchers({
      runId: "run-caller-vars", target: fixture.target, cwd: fixture.root,
      env: githubBrokerEnvironment({}, { url: "", token: "" }),
    });
    // The profile walks PATH through temporary variables. A caller may already
    // export a name the walk wants, and a command started by that shell has to
    // keep receiving the caller's value. The single assignment this replaced
    // touched PATH alone, so the walk must not add any other name to the shell.
    const caller = { count: "5", inherited: "/caller/keep", kept: "caller-kept", rest: "caller-rest",
      entry: "caller-entry", launcher_directory: "caller-dir", fallback_path: "caller-fallback" };
    // `env` reports the environment of a child process, so this reads the values
    // the caller exported rather than any copy the profile may have left behind.
    const result = await fixture.runner.execute({
      command: "/bin/sh",
      args: ["-c", '. "$BASH_ENV"\nprintf \'path=%s\\n\' "$PATH"\n'
        + "env | grep -E '^(count|inherited|kept|rest|entry|launcher_directory|fallback_path)=' | sort"],
      env: { HOME: fixture.root, PATH: "/usr/local/bin:/usr/bin:/bin",
        BASH_ENV: env.BASH_ENV, ZDOTDIR: env.ZDOTDIR, ...caller },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      `path=${env.PAPERCLIP_GITHUB_LAUNCHER_DIR}:/usr/local/bin:/usr/bin:/bin`,
      `count=${caller.count}`,
      `entry=${caller.entry}`,
      `fallback_path=${caller.fallback_path}`,
      `inherited=${caller.inherited}`,
      `kept=${caller.kept}`,
      `launcher_directory=${caller.launcher_directory}`,
      `rest=${caller.rest}`,
    ]);
  });

  it("keeps a PATH whose last directory name ends in a newline", async () => {
    const fixture = await sandbox("usr/bin");
    const env = await prepareGitHubOperationLaunchers({
      runId: "run-trailing-newline", target: fixture.target, cwd: fixture.root,
      env: githubBrokerEnvironment({}, { url: "", token: "" }),
    });
    // A directory name may contain a newline, so a PATH entry may end in one. A
    // command substitution strips trailing newlines from what it captures, so the
    // profile has to guard the value it captures. Without the guard the entry
    // comes back one character short and names a different directory, and a tool
    // in the caller's directory can no longer be found.
    const launcher = env.PAPERCLIP_GITHUB_LAUNCHER_DIR;
    const result = await fixture.runner.execute({ command: "/bin/sh", args: ["-c", '. "$BASH_ENV"; printf "%s" "$PATH"'],
      env: { HOME: fixture.root, PATH: "/usr/bin:usr\n", BASH_ENV: env.BASH_ENV, ZDOTDIR: env.ZDOTDIR } });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${launcher}:/usr/bin:usr\n`);
  });

  it("keeps the caller's PATH when a readonly variable collides with the walk", async () => {
    const fixture = await sandbox("usr/bin");
    const env = await prepareGitHubOperationLaunchers({
      runId: "run-readonly-collision", target: fixture.target, cwd: fixture.root,
      env: githubBrokerEnvironment({}, { url: "", token: "" }),
    });
    // A readonly attribute is inherited by a subshell, so a caller that owns one
    // of the walk's names as a readonly variable stops the walk at its first
    // assignment. The walk must then fall back to a plain prepend rather than to
    // the managed snapshot, or the caller's own entries are lost. That is the same
    // defect the whole change exists to fix.
    const launcher = env.PAPERCLIP_GITHUB_LAUNCHER_DIR;
    for (const name of ["kept", "count", "rest", "entry"]) {
      const result = await fixture.runner.execute({
        command: "/bin/sh",
        args: ["-c", `readonly ${name}=caller-${name}\n. "$BASH_ENV"\nprintf '%s' "$PATH"\nprintf '\\n%s=%s\\n' "${name}" "$${name}"`],
        env: { HOME: fixture.root, PATH: "/opt/x:/usr/bin:/bin", BASH_ENV: env.BASH_ENV, ZDOTDIR: env.ZDOTDIR },
      });
      expect(result.exitCode, `${name}: ${result.stderr}`).toBe(0);
      expect(result.stderr, name).toBe("");
      const [path, echoed] = result.stdout.split("\n");
      expect(path, name).toBe(`${launcher}:/opt/x:/usr/bin:/bin`);
      // The caller's own value is still the caller's, not the walk's.
      expect(echoed, name).toBe(`${name}=caller-${name}`);
    }
  });

  it("gives an empty PATH the managed snapshot and stays stable when a readonly variable collides", async () => {
    const fixture = await sandbox("usr/bin");
    const env = await prepareGitHubOperationLaunchers({
      runId: "run-readonly-fallback", target: fixture.target, cwd: fixture.root,
      env: githubBrokerEnvironment({}, { url: "", token: "" }),
    });
    // The collision fallback must not invent an empty entry. A trailing colon on
    // PATH means "search the current directory", so a plain prepend of an empty
    // PATH would add that and drop the system directories the managed snapshot
    // carries. A login shell can also read more than one staged profile, so the
    // fallback has to be stable when the profile is read again.
    const launcher = env.PAPERCLIP_GITHUB_LAUNCHER_DIR;

    const empty = await fixture.runner.execute({
      command: "/bin/sh",
      args: ["-c", 'readonly kept=caller-kept\n. "$BASH_ENV"\nprintf \'%s\' "$PATH"'],
      env: { HOME: fixture.root, PATH: "", BASH_ENV: env.BASH_ENV, ZDOTDIR: env.ZDOTDIR },
    });
    expect(empty.exitCode, empty.stderr).toBe(0);
    expect(empty.stdout).toBe(env.PATH);

    for (const reads of [2, 3]) {
      const repeated = await fixture.runner.execute({
        command: "/bin/sh",
        args: ["-c", `readonly kept=caller-kept\n${'. "$BASH_ENV"\n'.repeat(reads)}printf '%s' "$PATH"`],
        env: { HOME: fixture.root, PATH: "/opt/x:/usr/bin:/bin", BASH_ENV: env.BASH_ENV, ZDOTDIR: env.ZDOTDIR },
      });
      expect(repeated.exitCode, repeated.stderr).toBe(0);
      expect(repeated.stdout, `${reads} reads`).toBe(`${launcher}:/opt/x:/usr/bin:/bin`);
    }
  });

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
