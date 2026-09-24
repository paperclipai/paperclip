import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { cleanupGitHubOperationLaunchers } from "@paperclipai/adapter-utils/execution-target";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { describe, expect, it, vi } from "vitest";
import { prepareHeartbeatGitHubLaunchers } from "./heartbeat-github-launchers.js";

const target = { kind: "remote" as const, transport: "sandbox" as const, providerKey: "daytona", remoteCwd: "/workspace" };

describe("heartbeat GitHub launcher lifetime", () => {
  it.each([target, null])("defers native managed authorization/staging to the session owner (%j)", async (target) => {
    const prepare = vi.fn();
    const mint = vi.fn();
    const result = await prepareHeartbeatGitHubLaunchers({
      native: true, githubConfigured: true, agentId: "agent-a", runId: "run-a", target,
      cwd: "/workspace", env: { GH_TOKEN: "ambient" }, brokerUrl: "https://paperclip.test", createBrokerToken: mint,
    }, prepare);
    expect(prepare).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(result.cleanupLocation).toBeNull();
    expect(result.env).toMatchObject({ GH_TOKEN: "", PAPERCLIP_GITHUB_BROKER_TOKEN: "" });
  });
  it("keeps anonymous native sandbox launchers stable without issuing a run capability", async () => {
    const createBrokerToken = vi.fn(() => "run-secret");
    const prepareLaunchers = vi.fn(async (input) => input.env);
    const inputs = { native: true, githubConfigured: false, agentId: "agent-a", target,
      cwd: "/workspace", env: { GH_TOKEN: "ambient-secret" }, brokerUrl: "https://paperclip.test", createBrokerToken };
    const first = await prepareHeartbeatGitHubLaunchers({ ...inputs, runId: "run-one" }, prepareLaunchers);
    const second = await prepareHeartbeatGitHubLaunchers({ ...inputs, runId: "run-two" }, prepareLaunchers);
    expect(createBrokerToken).not.toHaveBeenCalled();
    expect(prepareLaunchers.mock.calls.map(([input]) => input.runId)).toEqual([expect.stringMatching(/^anonymous-agent-a-/), prepareLaunchers.mock.calls[0]?.[0].runId]);
    expect(first.cleanupLocation).toBeNull();
    expect(second.cleanupLocation).toBeNull();
    expect(first.env).toMatchObject({ GH_TOKEN: "", PAPERCLIP_GITHUB_BROKER_TOKEN: "", PAPERCLIP_GITHUB_BROKER_URL: "" });
  });
  it.each([false, true])("cleans partial run-scoped staging and preserves its error (cleanup fails: %s)", async (cleanupFails) => {
    const stagingError = new Error("remote launcher staging failed");
    const prepareLaunchers = vi.fn(async () => { throw stagingError; });
    const cleanupLaunchers = vi.fn(async () => {
      if (cleanupFails) throw new Error("cleanup unavailable");
    });
    await expect(prepareHeartbeatGitHubLaunchers({
      native: false, githubConfigured: true, agentId: "agent-a", target,
      runId: "failed-run", cwd: "/workspace", env: {}, brokerUrl: "https://paperclip.test",
      createBrokerToken: () => "current-run-secret",
    }, prepareLaunchers, cleanupLaunchers)).rejects.toBe(stagingError);
    expect(cleanupLaunchers).toHaveBeenCalledExactlyOnceWith({ runId: "failed-run", target });
  });

  it("does not remove shared anonymous wrappers when staging a later run fails", async () => {
    const stagingError = new Error("remote launcher staging failed");
    const cleanupLaunchers = vi.fn(async () => undefined);
    await expect(prepareHeartbeatGitHubLaunchers({
      native: true, githubConfigured: false, agentId: "agent-a", target,
      runId: "failed-run", cwd: "/workspace", env: {}, brokerUrl: "https://paperclip.test",
      createBrokerToken: () => { throw new Error("must not mint a capability"); },
    }, async () => { throw stagingError; }, cleanupLaunchers)).rejects.toBe(stagingError);
    expect(cleanupLaunchers).not.toHaveBeenCalled();
  });

  it.each([
    { native: false, githubConfigured: true, target },
    { native: false, githubConfigured: false, target },
    { native: true, githubConfigured: false, target: null },
  ])("preserves run-scoped managed capabilities outside anonymous native sandboxes: %j", async (mode) => {
    const createBrokerToken = vi.fn(() => "current-run-secret");
    const prepareLaunchers = vi.fn(async (input) => input.env);
    const result = await prepareHeartbeatGitHubLaunchers({ ...mode, agentId: "agent-a", runId: "run-one",
      cwd: "/workspace", env: {}, brokerUrl: "https://paperclip.test", createBrokerToken }, prepareLaunchers);
    expect(createBrokerToken).toHaveBeenCalledOnce();
    expect(prepareLaunchers.mock.calls[0]?.[0].runId).toBe("run-one");
    expect(result.cleanupLocation).toEqual({ runId: "run-one", target: mode.target });
    expect(result.env.PAPERCLIP_GITHUB_BROKER_TOKEN).toBe("current-run-secret");
  });
});


it("keeps anonymous wrappers usable after run cleanup and excludes sandbox image credentials", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-anonymous-github-"));
  try {
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await mkdir(path.join(root, ".config", "gh"), { recursive: true });
    await writeFile(path.join(root, ".config", "gh", "hosts.yml"), "ambient-image-secret");
    await writeFile(path.join(bin, "gh"), `#!${process.execPath}
const fs = require('node:fs');
process.stdout.write(JSON.stringify({token:process.env.GH_TOKEN || '', githubToken:process.env.GITHUB_TOKEN || '', ssh:process.env.SSH_AUTH_SOCK, global:process.env.GIT_CONFIG_GLOBAL, imageConfig:fs.existsSync(process.env.GH_CONFIG_DIR + '/hosts.yml')}));`, { mode: 0o700 });
    const imageEnv = { HOME: root, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, GH_TOKEN: "ambient-token", GITHUB_TOKEN: "ambient-other-token", SSH_AUTH_SOCK: "/ambient/socket" };
    const execute: CommandManagedRuntimeRunner["execute"] = async (input) => {
      const startedAt = new Date().toISOString();
      const child = promisify(execFile)(input.command, input.args ?? [], { cwd: input.cwd ?? root, env: { ...imageEnv, ...input.env }, timeout: 15_000 });
      child.child.stdin?.on("error", () => undefined);
      child.child.stdin?.end(input.stdin ?? "");
      const result = await child;
      return { ...result, exitCode: 0, signal: null, timedOut: false, pid: null, startedAt };
    };
    const sandboxTarget = { ...target, remoteCwd: root, runner: { execute } };
    const base = { native: true, githubConfigured: false, agentId: "agent-a", target: sandboxTarget,
      cwd: root, env: imageEnv, brokerUrl: "https://unused.invalid", createBrokerToken: () => { throw new Error("must not mint a capability"); } };
    const first = await prepareHeartbeatGitHubLaunchers({ ...base, runId: "run-one" });
    await cleanupGitHubOperationLaunchers({ runId: "run-one", target: sandboxTarget });
    const second = await prepareHeartbeatGitHubLaunchers({ ...base, runId: "run-two" });
    expect(first.env.PAPERCLIP_GITHUB_LAUNCHER_DIR).toBe(second.env.PAPERCLIP_GITHUB_LAUNCHER_DIR);
    expect(await readFile(path.join(first.env.PAPERCLIP_GITHUB_LAUNCHER_DIR, "gh"), "utf8")).not.toContain("ambient-token");
    // A still-live provider uses its first-turn environment, not the new one.
    const command = await execute({ command: path.join(first.env.PAPERCLIP_GITHUB_LAUNCHER_DIR, "gh"), env: first.env });
    expect(JSON.parse(command.stdout)).toEqual({ token: "", githubToken: "", ssh: "", global: "/dev/null", imageConfig: false });
    const changedPath = await prepareHeartbeatGitHubLaunchers({ ...base, runId: "run-three", env: { ...imageEnv, PATH: `${imageEnv.PATH}:/extra` } });
    expect(changedPath.env.PAPERCLIP_GITHUB_LAUNCHER_DIR).not.toBe(first.env.PAPERCLIP_GITHUB_LAUNCHER_DIR);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
