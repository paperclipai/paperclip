import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
} from "./agent-filesystem-sandbox.js";
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
});
