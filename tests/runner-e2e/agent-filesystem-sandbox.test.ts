import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HARNESS_PRIVATE_TEMPORARY_CHILDREN,
  agentFilesystemSandboxConfig,
  agentTemporaryParent,
  defaultPlaywrightCacheDirectory,
  playwrightCacheDirectory,
  isRunnerdLaunch,
  parseAgentFilesystemSandboxConfig,
  probeAgentFilesystemSandbox,
  pythonExecutable,
  sandboxedInvocation,
  agentFilesystemSandboxHelper,
  wrapRunnerdSpawn,
  wrapRunnerdLaunch,
  gitStorePaths,
  RUNNERD_LAUNCH_APIS,
  instanceRunStatePaths,
  opencodeSessionDirectoryName,
  prepareRunnerdLaunchSandbox,
  probeRunScopedSandbox,
  runnerdLaunchSandbox,
} from "./agent-filesystem-sandbox.js";
import { RUNNER_SELECTED_ID_ENV, parseRunnerSelectors, selectorArgumentsWithEnvironment } from "./selectors.js";
import { runnerMatrix } from "./catalog.js";

const repositoryRoot = "/work/paperclip";
const temporaryRoot = "/var/tmp/paperclip-runner-e2e-abc";
const cell = (id: string) => {
  const execution = runnerMatrix.find((candidate) => candidate.id === id);
  if (!execution) throw new Error(`missing ${id}`);
  return execution;
};
const gitStores = ["/work/paperclip/.git"];
const opencodeLocal = cell("task-workspaces.runner-opencode.local.task-directory-repository-resume");
const base = {
  platform: "linux" as const,
  env: { GITHUB_ACTIONS: "true", RUNNER_TEMP: "/work/_temp" },
  executions: [opencodeLocal],
  repositoryRoot,
  temporaryRoot,
  privateDir: "/work/_temp/manual-private-evidence-x/capture",
  evidenceRoot: "/work/_temp/manual-private-evidence-x",
  installedRelease: false,
  sharedTemporary: "/tmp",
  gitStores,
};

describe("agent filesystem sandbox selection", () => {
  it("hides the harness, the trusted copy and captured evidence from local native agents", () => {
    expect(agentFilesystemSandboxConfig(base)).toEqual({
      hidden: [
        "/work/paperclip/tests",
        "/work/paperclip/.git",
        "/work/paperclip/.manual-private-trusted",
        `${temporaryRoot}/artifacts-private`,
        `${temporaryRoot}/control`,
        `${temporaryRoot}/selected-private-inputs`,
        `${temporaryRoot}/playwright-transform-cache`,
        "/work/_temp/manual-private-evidence-x/capture",
        "/work/_temp/manual-private-evidence-x",
        "/work/_temp",
      ],
      required: true,
    });
  });

  it("hides the attempt's private children and Playwright cache when its root is outside the shared temporary directory", () => {
    const config = agentFilesystemSandboxConfig(base);
    expect(config?.hidden).toContain(playwrightCacheDirectory(temporaryRoot));
    expect(config?.hidden).not.toContain(temporaryRoot);
    expect(HARNESS_PRIVATE_TEMPORARY_CHILDREN).toContain("playwright-transform-cache");
    expect(defaultPlaywrightCacheDirectory("/tmp")).toMatch(/^\/tmp\/playwright-transform-cache-/);
  });

  it("fails closed in CI when harness material sits where it cannot be hidden", () => {
    const underShared = { ...base, temporaryRoot: "/tmp/paperclip-runner-e2e-abc", privateDir: "/tmp/paperclip-runner-e2e-abc/artifacts-private" };
    expect(() => agentFilesystemSandboxConfig(underShared)).toThrow(/agent_filesystem_sandbox_incomplete: .*artifacts-private/);
    expect(() => agentFilesystemSandboxConfig({ ...base, repositoryRoot: "/tmp/checkout" })).toThrow(/\/tmp\/checkout\/tests/);
  });

  it("keeps a sandboxed attempt's root out of the shared temporary directory", () => {
    const parent = agentTemporaryParent(true);
    if (process.platform === "linux") expect(parent).toBe(realpathSync("/var/tmp"));
    expect(agentTemporaryParent(false)).toBe(realpathSync(os.tmpdir()));
  });

  it("never hides the agent's own state or the checkout root, and only warns outside CI", () => {
    const config = agentFilesystemSandboxConfig({
      ...base,
      env: { RUNNER_TEMP: "/tmp" },
      temporaryRoot: "/tmp/paperclip-runner-e2e-abc",
      privateDir: "/tmp/paperclip-runner-e2e-abc/artifacts-private",
      evidenceRoot: "/work",
    });
    expect(config).toEqual({ hidden: ["/work/paperclip/tests", "/work/paperclip/.git", "/work/paperclip/.manual-private-trusted"], required: false });
  });

  it.each([
    ["macOS", { platform: "darwin" as const }],
    ["an installed release", { installedRelease: true }],
    ["remote-only cells", { executions: [cell("rolling-web-deployment.runner-opencode.daytona.recover-controller")] }],
    ["legacy adapters", { executions: [cell("blocker-guidance.legacy-codex.local.human-authority")] }],
    ["Codex's own mount sandbox", { executions: [opencodeLocal, cell("necessary-question.runner-codex.local.necessary-free-text")] }],
  ])("does not apply to %s", (_label, override) => {
    expect(agentFilesystemSandboxConfig({ ...base, ...override })).toBeNull();
  });

  it("round-trips through the server environment and rejects malformed values", () => {
    const config = agentFilesystemSandboxConfig(base)!;
    expect(parseAgentFilesystemSandboxConfig(JSON.stringify(config))).toEqual(config);
    expect(parseAgentFilesystemSandboxConfig(undefined)).toBeNull();
    expect(() => parseAgentFilesystemSandboxConfig(JSON.stringify({ hidden: ["relative"], required: true }))).toThrow(/malformed/);
  });
});

describe("run-scoped runnerd sandbox", () => {
  const instanceRoot = `${temporaryRoot}/paperclip-home/instances/runner-e2e-1`;
  const runner = `${instanceRoot}/runtime/paperclip-runner`;
  const config = { hidden: ["/work/paperclip/tests"], required: true, instanceRoot };

  it("keeps the instance root in the attempt's sandbox configuration", () => {
    expect(agentFilesystemSandboxConfig({ ...base, instanceRoot })?.instanceRoot).toBe(instanceRoot);
    expect(agentFilesystemSandboxConfig({ ...base, instanceRoot: "/tmp/home/instances/x" })?.instanceRoot).toBeUndefined();
    const parsed = parseAgentFilesystemSandboxConfig(JSON.stringify(config));
    expect(parsed).toEqual(config);
    expect(() => parseAgentFilesystemSandboxConfig(JSON.stringify({ ...config, instanceRoot: "relative" }))).toThrow(/malformed/);
  });

  it("hides every run's state and keeps only the launch's own durable session, OpenCode session and trace", () => {
    const trace = `${instanceRoot}/data/provider-traces/4b1c.ndjson`;
    const launch = runnerdLaunchSandbox(config, [
      "--connect-url", "ws://127.0.0.1:1/durableRecovery/connect",
      "--state-dir", `${runner}/durable-sessions/abc123/runner`,
      "--run-id", "run-1", "--session-id", "ses:own/1",
    ], { PAPERCLIP_OPENCODE_RUNTIME_DIR: `${runner}/opencode`, PAPERCLIP_PROVIDER_TRACE_PATH: trace });
    expect(launch.hidden).toEqual([
      "/work/paperclip/tests",
      `${runner}/durable-sessions`,
      `${runner}/runner`,
      `${runner}/control-plane`,
      `${runner}/opencode`,
      `${instanceRoot}/data/run-logs`,
      `${instanceRoot}/data/provider-traces`,
      `${instanceRoot}/data/backups`,
      `${instanceRoot}/db`,
      `${instanceRoot}/secrets`,
    ]);
    expect(launch.exposed).toEqual([`${runner}/durable-sessions/abc123`, `${runner}/opencode/ses_own_1`, trace]);
    expect(launch.exposedFiles).toEqual([trace]);
    expect(launch.precreated).toEqual([`${runner}/acpx`, ...["companies", "projects", "workspaces", "runtime-context-assets", "skills", "runtime/provider-packs"].map((name) => `${instanceRoot}/${name}`)]);
    expect(launch.required).toBe(true);
  });

  it("keeps a Codex runner's own state directory and exposes nothing it was not given", () => {
    const launch = runnerdLaunchSandbox(config, ["--state-dir", `${runner}/runner/run-9`, "--run-id", "run-9"], {
      PAPERCLIP_PROVIDER_TRACE_PATH: `${instanceRoot}/elsewhere/trace.ndjson`,
    });
    expect(launch.exposed).toEqual([`${runner}/runner/run-9`]);
    // A state directory naming the shared root itself, or escaping it, exposes nothing.
    expect(runnerdLaunchSandbox(config, ["--state-dir", `${runner}/durable-sessions`], {}).exposed).toEqual([]);
    expect(runnerdLaunchSandbox(config, ["--state-dir", `${runner}/durable-sessions/../control-plane`], {}).exposed).toEqual([]);
    expect(runnerdLaunchSandbox(config, ["--state-dir", "relative/runner"], {}).exposed).toEqual([]);
  });

  it("adds nothing without an instance root", () => {
    const launch = runnerdLaunchSandbox({ hidden: ["/h"], required: false }, ["--state-dir", `${runner}/durable-sessions/a/runner`], {});
    expect(launch).toEqual({ hidden: ["/h"], exposed: [], exposedFiles: [], precreated: [], required: false });
  });

  it("names the OpenCode session directory as the driver does", () => {
    expect(opencodeSessionDirectoryName("ses_1:x/y")).toBe("ses_1_x_y");
    expect(opencodeSessionDirectoryName("a".repeat(200))).toBe("a".repeat(120));
    expect(opencodeSessionDirectoryName("..")).toBeNull();
    const driver = readFileSync(path.join(import.meta.dirname, "../../packages/paperclip-runner/src/drivers/opencode/opencode-server-driver.ts"), "utf8");
    const body = /export function opencodeRuntimeSessionDirectoryName\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(driver)?.[1] ?? "";
    expect(body.replace(/\s+/g, "")).toContain('.replace(/[^a-zA-Z0-9._-]/g,"_").slice(0,120)');
  });

  it("creates the launch's own entries before runnerd starts and passes them as exposures", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-sandbox-run-")));
    try {
      const instance = path.join(root, "home", "instances", "i");
      const paths = instanceRunStatePaths(instance);
      const trace = path.join(paths.providerTraces, "t.ndjson");
      const calls: unknown[][] = [];
      const fake = ((...args: unknown[]) => { calls.push(args); return { pid: 3 }; }) as unknown as typeof import("node:child_process").spawn;
      const spawn = wrapRunnerdSpawn(fake, { hidden: ["/work/paperclip/tests"], required: true, instanceRoot: instance }, "/usr/bin/python3");
      const state = path.join(paths.durableSessions, "scope", "runner");
      spawn("/r/paperclip-runnerd", ["--state-dir", state, "--session-id", "own"], { env: { PAPERCLIP_PROVIDER_TRACE_PATH: trace } });
      expect(statSync(path.join(paths.durableSessions, "scope")).isDirectory()).toBe(true);
      expect(statSync(path.join(paths.opencode, "own")).mode & 0o777).toBe(0o700);
      expect(statSync(trace).isFile()).toBe(true);
      expect(existsSync(paths.acpx)).toBe(true);
      const args = calls[0]![1] as string[];
      expect(args).toEqual(expect.arrayContaining(["--hide", paths.durableSessions, "--expose", path.join(paths.durableSessions, "scope"), "--expose", trace]));
      expect(args.slice(args.indexOf("--"))).toEqual(["--", "/r/paperclip-runnerd", "--state-dir", state, "--session-id", "own"]);
      // Creating an exposed trace never truncates one the run already wrote.
      const launch = runnerdLaunchSandbox({ hidden: [], required: true, instanceRoot: instance }, [], { PAPERCLIP_PROVIDER_TRACE_PATH: trace });
      await writeFile(trace, "frame\n");
      prepareRunnerdLaunchSandbox(launch);
      expect(await readFile(trace, "utf8")).toBe("frame\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects exposures that are missing, outside every hidden path, or that would reveal one", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-sandbox-expose-")));
    try {
      const hidden = path.join(root, "sessions");
      await mkdir(path.join(hidden, "own", "inner"), { recursive: true });
      const run = (...args: string[]) => {
        try {
          execFileSync(pythonExecutable(), ["-I", "-S", agentFilesystemSandboxHelper, ...args, "--", "/bin/true"], { stdio: "pipe" });
          return 0;
        } catch (error) {
          return (error as { status: number }).status;
        }
      };
      expect(run("--hide", hidden, "--expose", path.join(hidden, "missing"))).toBe(2);
      expect(run("--hide", hidden, "--expose", root)).toBe(2);
      expect(run("--hide", hidden, "--expose", hidden)).toBe(2);
      expect(run("--hide", path.join(hidden, "own", "inner"), "--hide", hidden, "--expose", path.join(hidden, "own"))).toBe(2);
      expect(run("--hide", hidden, "--expose", "relative")).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("selected cell outside the command line", () => {
  it("reads the selected cell from the environment and removes it", () => {
    const env: NodeJS.ProcessEnv = { [RUNNER_SELECTED_ID_ENV]: " chat-features.runner-opencode.local.agents.change-manager " };
    const args = selectorArgumentsWithEnvironment([], env);
    expect(args).toEqual(["--id", "chat-features.runner-opencode.local.agents.change-manager"]);
    expect(env[RUNNER_SELECTED_ID_ENV]).toBeUndefined();
    expect(parseRunnerSelectors(args).ids).toEqual(["chat-features.runner-opencode.local.agents.change-manager"]);
    expect(selectorArgumentsWithEnvironment(["--", "--id", "x"], {})).toEqual(["--", "--id", "x"]);
  });

  it("is what CI passes instead of --id", async () => {
    for (const workflow of ["runner-full-stack-e2e.yml", "chat-catalog-testops-case.yml"]) {
      const source = await readFile(path.join(import.meta.dirname, "../../.github/workflows", workflow), "utf8");
      expect(source).toContain(`${RUNNER_SELECTED_ID_ENV}: \${{`);
      expect(source).not.toMatch(/test:e2e:runner -- --id "\$\{\{/);
    }
  });
});

describe("runnerd launch rewriting", () => {
  it("wraps only the absolute runnerd executable and execs it with the original argv", () => {
    const runnerd = "/work/paperclip/packages/paperclip-runner/runner/target/debug/paperclip-runnerd";
    expect(isRunnerdLaunch(runnerd)).toBe(true);
    expect(isRunnerdLaunch("paperclip-runnerd")).toBe(true);
    expect(isRunnerdLaunch("/usr/bin/git")).toBe(false);
    const invocation = sandboxedInvocation({ hidden: ["/work/paperclip/tests"], required: true }, "/usr/bin/python3", runnerd, ["--run-id", "r"], {});
    expect(invocation).toEqual({
      command: "/usr/bin/python3",
      args: ["-I", "-S", agentFilesystemSandboxHelper, "--required", "--unset", "LC_CTYPE", "--hide", "/work/paperclip/tests", "--", runnerd, "--run-id", "r"],
    });
    expect(sandboxedInvocation({ hidden: [], required: false }, "p", runnerd, [], { LC_CTYPE: "C" }).args).toContain("LC_CTYPE=C");
  });

  it("rewrites runnerd launches through the wrapped spawn and passes other launches through", () => {
    const calls: unknown[][] = [];
    const fake = ((...args: unknown[]) => { calls.push(args); return { pid: 7 }; }) as unknown as typeof import("node:child_process").spawn;
    const spawn = wrapRunnerdSpawn(fake, { hidden: ["/work/paperclip/tests"], required: true }, "/usr/bin/python3");
    const runnerd = "/work/paperclip/packages/paperclip-runner/runner/target/debug/paperclip-runnerd";
    spawn(runnerd, ["--run-id", "r"], { cwd: "/work", env: { LC_CTYPE: "C.UTF-8" }, detached: true });
    spawn("/usr/bin/git", ["status"], { cwd: "/work" });
    expect(calls[0]).toEqual(["/usr/bin/python3", expect.arrayContaining(["--hide", "/work/paperclip/tests", "--", runnerd, "--run-id", "r"]),
      { cwd: "/work", env: { LC_CTYPE: "C.UTF-8" }, detached: true }]);
    expect(calls[1]).toEqual(["/usr/bin/git", ["status"], { cwd: "/work" }]);
  });

  it("rewrites runnerd for every direct launch API and refuses a shell launch", () => {
    const calls: unknown[][] = [];
    const fake = (...args: unknown[]) => { calls.push(args); return { pid: 9 }; };
    const config = { hidden: ["/work/paperclip/tests"], required: true };
    const callback = () => undefined;
    wrapRunnerdLaunch(fake, config, "/usr/bin/python3", "execFile")("paperclip-runnerd", ["--x"], { cwd: "/w" }, callback);
    wrapRunnerdLaunch(fake, config, "/usr/bin/python3", "spawnSync")("/r/paperclip-runnerd", { cwd: "/w" });
    expect(calls[0]).toEqual(["/usr/bin/python3", expect.arrayContaining(["--", "paperclip-runnerd", "--x"]), { cwd: "/w" }, callback]);
    expect(calls[1]).toEqual(["/usr/bin/python3", expect.arrayContaining(["--", "/r/paperclip-runnerd"]), { cwd: "/w" }]);
    expect(() => wrapRunnerdLaunch(fake, config, "/usr/bin/python3")("/r/paperclip-runnerd", [], { shell: true })).toThrow(/refusing/);
    expect(RUNNERD_LAUNCH_APIS).toEqual(["spawn", "spawnSync", "execFile", "execFileSync"]);
  });

  it("keeps promisify(execFile) resolving { stdout, stderr } after wrapping", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const wrapped = wrapRunnerdLaunch(execFile, { hidden: ["/nowhere"], required: false }, "/usr/bin/python3", "execFile");
    const result = await promisify(wrapped)(process.execPath, ["-e", "process.stdout.write('ok')"]);
    expect(result).toEqual({ stdout: "ok", stderr: "" });
  });

  it("hides a linked worktree's gitdir and the shared object store", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-sandbox-git-")));
    try {
      const common = path.join(root, "main", ".git");
      const gitDir = path.join(common, "worktrees", "wt");
      await mkdir(gitDir, { recursive: true });
      await writeFile(path.join(gitDir, "commondir"), "../..\n");
      const checkout = path.join(root, "wt");
      await mkdir(checkout);
      await writeFile(path.join(checkout, ".git"), `gitdir: ${gitDir}\n`);
      expect(gitStorePaths(checkout)).toEqual([path.join(checkout, ".git"), gitDir, common]);
      expect(gitStorePaths(path.join(root, "main"))).toEqual([common]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("installs the sandbox in the E2E server entry before the product starts", async () => {
    const entry = await readFile(path.join(import.meta.dirname, "server-entry.ts"), "utf8");
    const install = entry.indexOf("installAgentFilesystemSandbox(");
    expect(install).toBeGreaterThan(0);
    expect(install).toBeLessThan(entry.indexOf('await import("../../cli/src/index.js")'));
  });
});

const landlock = process.platform === "linux" && (() => {
  const probe = mkdtempSync(path.join(os.tmpdir(), "agent-sandbox-abi-"));
  try {
    execFileSync(pythonExecutable(), ["-I", "-S", agentFilesystemSandboxHelper, "--required", "--hide", probe, "--", "/bin/true"]);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

describe.skipIf(!landlock)("Landlock agent sandbox on this host", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("denies a sandboxed process the harness while keeping the product and temporary files usable", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-sandbox-")));
    roots.push(root);
    const repository = path.join(root, "checkout");
    await mkdir(path.join(repository, "tests", "runner-e2e", "chat-scenarios"), { recursive: true });
    await mkdir(path.join(repository, "packages", "paperclip-runner"), { recursive: true });
    await mkdir(path.join(root, "scratch"));
    await writeFile(path.join(repository, "tests", "runner-e2e", "agent-filesystem-sandbox.ts"), "grader");
    await writeFile(path.join(repository, "tests", "runner-e2e", "chat-scenarios", "access.yaml"), "expected_outcome: secret");
    await writeFile(path.join(repository, "packages", "paperclip-runner", "package.json"), "{}");
    const attempt = path.join(root, "attempt");
    await mkdir(path.join(attempt, "artifacts-private"), { recursive: true });
    await mkdir(path.join(attempt, "workspace"));
    await writeFile(path.join(attempt, "artifacts-private", "server.log"), "secret");
    const config = { hidden: [path.join(repository, "tests"), path.join(attempt, "artifacts-private"), path.join(attempt, "control")], required: true };
    // The fixture lives under the shared temporary directory, so point mktemp at a granted sibling.
    const probe = probeAgentFilesystemSandbox(config, repository, pythonExecutable(), { ...process.env, TMPDIR: path.join(root, "scratch") }, path.join(root, "no-playwright-cache"));
    expect(probe.failures).toEqual([]);
    expect(probe.result).toMatchObject({ playwrightDefaultCache: "denied", harnessFile: "denied", harnessDirectory: "denied", productFile: "readable", temporaryWrite: "allowed" });
    // The exact read from the reported run: grep over the checkout's scenarios.
    const invocation = sandboxedInvocation(config, pythonExecutable(), "/bin/sh", ["-c", `grep -rn expected_outcome ${repository}/tests; echo "exit=$?"`], process.env);
    const output = execFileSync(invocation.command, invocation.args, { encoding: "utf8" });
    expect(output).not.toContain("secret");
    expect(output).toMatch(/exit=2/);
    const attemptCheck = sandboxedInvocation(config, pythonExecutable(), "/bin/sh", ["-c", `cat ${attempt}/artifacts-private/server.log; ls ${attempt}/workspace >/dev/null && echo workspace=ok; mkdir ${attempt}/control 2>/dev/null || echo control=blocked`], process.env);
    const attemptOutput = execFileSync(attemptCheck.command, attemptCheck.args, { encoding: "utf8" });
    expect(attemptOutput).not.toContain("secret");
    expect(attemptOutput).toContain("workspace=ok");
    expect(attemptOutput).toContain("control=blocked");
  });

  it("keeps a run's own session and trace and denies every other run's state, the database and secrets", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-sandbox-run-scope-")));
    roots.push(root);
    const home = path.join(root, "attempt", "paperclip-home");
    await mkdir(path.join(home, "instances", "i"), { recursive: true });
    await mkdir(path.join(root, "attempt", "artifacts-private"));
    const config = { hidden: [path.join(root, "attempt", "artifacts-private")], required: true, instanceRoot: path.join(home, "instances", "i") };
    const probe = probeRunScopedSandbox(config, pythonExecutable(), process.env);
    expect(probe.failures).toEqual([]);
    expect(probe.result).toMatchObject({
      "run:otherDurableSession": "denied", "run:durableSessionListing": "denied", "run:ownDurableSession": "allowed",
      "run:otherOpencodeSession": "denied", "run:ownOpencodeSession": "allowed", "run:otherRunLog": "denied",
      "run:databaseWal": "denied", "run:secrets": "denied", "run:controlPlaneState": "denied",
      "run:otherProviderTrace": "denied", "run:ownProviderTrace": "allowed", "run:harnessEnviron": "denied",
    });
    // The fixture instance is removed after the probe.
    expect((await readdir(home)).filter((name) => name.startsWith(".agent-sandbox-probe-"))).toEqual([]);
  });
});
