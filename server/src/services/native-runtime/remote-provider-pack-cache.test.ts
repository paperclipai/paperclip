import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { RemoteProviderPackVerificationError, assertRemoteProviderPackVerificationResult, computerProviderPackCachePath, prepareComputerProviderPackCache, pinnedComputerProviderPack, computerAcpxLaunchProfileDigest, readPinnedComputerProviderMetadata, assertPinnedComputerProviderState } from "./remote-provider-pack-cache.js";

const roots: string[] = [];
const digest = `sha256:${"a".repeat(64)}`;
describe("controller-pinned computer provider pack", () => {
  it("checks the retained provider's session and exact launch profile without rewriting it", () => {
    const state = { schema: "paperclip.runner.acpx-provider-state.v3", launchProfileDigest: digest,
      descriptor: { normalizedSessionId: "session", sidecarCommand: "/pack/node", sidecarArgs: ["/pack/sidecar"] } };
    const input = { state, normalizedSessionId: "session", launchProfileDigest: digest, command: "/pack/node", sidecar: "/pack/sidecar" };
    expect(() => assertPinnedComputerProviderState(input)).not.toThrow();
    const before = JSON.stringify(state);
    expect(() => assertPinnedComputerProviderState({ ...input, normalizedSessionId: "foreign" })).toThrow("provenance_mismatch");
    expect(() => assertPinnedComputerProviderState({ ...input, launchProfileDigest: `sha256:${"b".repeat(64)}` })).toThrow("provenance_mismatch");
    expect(JSON.stringify(state)).toBe(before);
  });
  it.each(["valid", "pack-parent-symlink", "state-parent-symlink", "hardlink"])("reads bounded metadata with %s", async (kind) => {
    const home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "provider-provenance-")));
    roots.push(home);
    let packRoot = join(home, "pack"); let stateDirectory = join(home, "runner");
    await fs.mkdir(packRoot); await fs.mkdir(stateDirectory);
    await fs.writeFile(join(packRoot, "provider-pack.json"), JSON.stringify({ digest }));
    await fs.writeFile(join(stateDirectory, "acpx-provider-state.json"), JSON.stringify({ launchProfileDigest: digest }));
    if (kind === "pack-parent-symlink") { await fs.symlink(packRoot, join(home, "pack-link")); packRoot = join(home, "pack-link"); }
    if (kind === "state-parent-symlink") { await fs.symlink(stateDirectory, join(home, "runner-link")); stateDirectory = join(home, "runner-link"); }
    if (kind === "hardlink") await fs.link(join(packRoot, "provider-pack.json"), join(home, "shared.json"));
    const result = readPinnedComputerProviderMetadata({ runner, packRoot, stateDirectory });
    if (kind === "valid") await expect(result).resolves.toEqual([{ digest }, { launchProfileDigest: digest }]);
    else await expect(result).rejects.toThrow("provenance_unavailable");
  });
  it("matches the runner's length-prefixed launch profile contract", () => {
    const profile = { authorityDigest: digest, command: "/pack/node", commandSha256: `sha256:${"b".repeat(64)}`,
      sidecar: "/pack/sidecar", sidecarSha256: `sha256:${"c".repeat(64)}` };
    const expected = "sha256:5d91648a1247fac8633317f80d39ad05e47961894bf8b631c47e10d031753233";
    expect(computerAcpxLaunchProfileDigest(profile)).toBe(expected);
    for (const key of Object.keys(profile) as Array<keyof typeof profile>) {
      expect(computerAcpxLaunchProfileDigest({ ...profile, [key]: `${profile[key]}-changed` })).not.toBe(expected);
    }
  });
  function pinned() {
    const identity = { runId: "prior", normalizedSessionId: "session", runnerInstanceId: "runner", environmentLeaseId: "lease" };
    const root = computerProviderPackCachePath("/agents/a", digest);
    return { agentHome: "/agents/a", identity, provider: { agent: "claude", model: "model" },
      control: { schema: "paperclip.runner.durable.control-plane-state.v1", identity: { ...identity }, runAttachTemplate: { provider: {
        kind: "acpx", provider: "acpx", driver: "acpx_runtime", agent: "claude", model: "model", normalizedSessionId: "session",
        sidecarCommand: `${root}/node_modules/node/bin/node`, sidecarArgs: [`${root}/dist/cli/acpx-runtime-sidecar.cjs`],
      } } } };
  }
  it("retains pack A when the next controller deploys pack B", () => {
    const selected = pinnedComputerProviderPack(pinned());
    expect(selected.digest).toBe(digest);
    expect(selected.root).not.toBe(computerProviderPackCachePath("/agents/a", `sha256:${"b".repeat(64)}`));
  });
  it.each(["pending", "completed", "failed"])("pins the controller-owned %s attachment after a cold epoch rotation", (status) => {
    const input = pinned();
    const provider = { ...input.control.runAttachTemplate.provider, runId: input.identity.runId };
    const control = { ...input.control, runAttachTemplate: null,
      commands: [{ type: "run.attach", controllerSeq: 1, status, payload: { provider } }] };
    expect(pinnedComputerProviderPack({ ...input, control }).digest).toBe(digest);
  });
  it.each(["foreign-run", "foreign-session", "ambiguous", "malformed-template"])("rejects %s command provenance", (kind) => {
    const input = pinned();
    const provider = { ...input.control.runAttachTemplate.provider, runId: input.identity.runId };
    const commands = [{ type: "run.attach", controllerSeq: 1, status: "completed", payload: { provider } }];
    if (kind === "foreign-run") provider.runId = "foreign";
    if (kind === "foreign-session") provider.normalizedSessionId = "foreign";
    if (kind === "ambiguous") commands.push({ ...commands[0]!, controllerSeq: 2,
      payload: { provider: { ...provider, sidecarCommand: provider.sidecarCommand.replace("a".repeat(64), "b".repeat(64)),
        sidecarArgs: provider.sidecarArgs.map(path => path.replace("a".repeat(64), "b".repeat(64))) } } });
    const control = { ...input.control, runAttachTemplate: kind === "malformed-template" ? {} : null, commands };
    expect(() => pinnedComputerProviderPack({ ...input, control })).toThrow("provenance_unavailable");
  });
  it.each(["missing", "identity", "foreign-home", "sidecar", "arguments", "provider"])("rejects %s provenance", (kind) => {
    const input = pinned();
    if (kind === "missing") delete (input.control as { runAttachTemplate?: unknown }).runAttachTemplate;
    if (kind === "identity") input.control.identity.environmentLeaseId = "foreign";
    if (kind === "foreign-home") input.agentHome = "/agents/b";
    if (kind === "sidecar") input.control.runAttachTemplate.provider.sidecarArgs[0] += "/../evil";
    if (kind === "arguments") input.control.runAttachTemplate.provider.sidecarArgs.push("--evil");
    if (kind === "provider") input.provider.agent = "codex";
    expect(() => pinnedComputerProviderPack(input)).toThrow("runner_remote_provider_pack_provenance_unavailable");
  });
});
const runner: CommandManagedRuntimeRunner = {
  execute: (input) => new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, { cwd: input.cwd, env: { ...process.env, ...input.env } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; void input.onLog?.("stdout", String(chunk)); });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr, timedOut: false, pid: child.pid ?? null, startedAt: null }));
    child.stdin.end(input.stdin);
  }),
};
async function fixture() {
  const home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "provider-cache-")));
  roots.push(home);
  return {
    cacheRoot: computerProviderPackCachePath(home, digest), sessionKey: "task-a",
    owner: { ownerId: "owner-a", generation: 1 }, runner,
    verify: async (root: string) => { if (await fs.readFile(join(root, "payload"), "utf8") !== "verified bytes") throw new RemoteProviderPackVerificationError("mismatch", "artifact_digest_mismatch"); },
    stage: async (root: string, guarded: CommandManagedRuntimeRunner) => {
      const result = await guarded.execute({ command: "python3", args: ["-c", "import os,sys;os.mkdir(sys.argv[1],0o700);open(os.path.join(sys.argv[1],'payload'),'w').write(sys.stdin.read())", root], stdin: "verified bytes" });
      if (result.exitCode !== 0) throw new Error(result.stderr);
    },
  };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe("persistent computer provider pack cache", () => {
  it("shares immutable identity across tasks, with separate agents and digests", () => {
    expect(computerProviderPackCachePath("/agents/a", digest)).not.toBe(computerProviderPackCachePath("/agents/b", digest));
    expect(computerProviderPackCachePath("/agents/a", digest)).not.toBe(computerProviderPackCachePath("/agents/a", `sha256:${"b".repeat(64)}`));
    expect(() => computerProviderPackCachePath("/agents/../a", digest)).toThrow("identity_invalid");
  });

  it("verifies a shared hit before the compression/upload callback and excludes its ownership marker", async () => {
    const input = await fixture();
    const stage = vi.fn(input.stage); const verify = vi.fn(input.verify);
    await expect(prepareComputerProviderPackCache({ ...input, stage, verify })).resolves.toBe("published");
    await expect(prepareComputerProviderPackCache({ ...input, stage, verify, sessionKey: "task-b" })).resolves.toBe("reused");
    expect(stage).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(3);
    expect(await fs.readdir(input.cacheRoot)).toEqual(["payload"]);
  });

  it("fails closed on a corrupt published pack, preserving its exact contents", async () => {
    const input = await fixture();
    await fs.mkdir(input.cacheRoot, { recursive: true });
    await fs.writeFile(join(input.cacheRoot, "payload"), "corrupt");
    const stage = vi.fn(input.stage);
    await expect(prepareComputerProviderPackCache({ ...input, stage })).rejects.toThrow("operator remove or quarantine this exact cache");
    expect(stage).not.toHaveBeenCalled();
    expect(await fs.readFile(join(input.cacheRoot, "payload"), "utf8")).toBe("corrupt");
  });

  it.each(["timeout", "transport", "command", "compatibility"])("preserves the shared pack without a deletion recommendation after %s failure", async (kind) => {
    const input = await fixture();
    await fs.mkdir(input.cacheRoot, { recursive: true });
    await fs.writeFile(join(input.cacheRoot, "payload"), "verified bytes");
    const secretCause = new Error("private command/path/token");
    const failure = kind === "transport" ? secretCause
      : new RemoteProviderPackVerificationError(kind === "compatibility" ? "incompatible" : "unavailable",
        kind === "timeout" ? "timeout" : kind === "compatibility" ? "node_version_incompatible" : "command_failed", secretCause);
    const stage = vi.fn(input.stage);
    const error = await prepareComputerProviderPackCache({ ...input, stage, verify: async () => { throw failure; } }).catch(error => error);
    expect(error).toBeInstanceOf(RemoteProviderPackVerificationError);
    expect(error.message).not.toMatch(/corrupt|remove|quarantine|private command/);
    expect(error.cause).toBe(kind === "transport" ? failure : secretCause);
    expect(stage).not.toHaveBeenCalled();
    expect(await fs.readFile(join(input.cacheRoot, "payload"), "utf8")).toBe("verified bytes");
  });

  it("publishes without replacement when two tasks race and verifies the winner", async () => {
    const input = await fixture(); const both = deferred(); let staged = 0;
    const stage = async (root: string, guarded: CommandManagedRuntimeRunner) => {
      await input.stage(root, guarded); if (++staged === 2) both.resolve(); await both.promise;
    };
    await Promise.all(["task-a", "task-b"].map((sessionKey) => prepareComputerProviderPackCache({ ...input, sessionKey, stage })));
    expect(staged).toBe(2);
    await input.verify(input.cacheRoot);
    const directories = await fs.readdir(join(dirname(input.cacheRoot), ".uploads"));
    for (const session of directories) expect(await fs.readdir(join(dirname(input.cacheRoot), ".uploads", session, "a".repeat(64)))).toEqual(["lock"]);
  });

  it("cleans only its marked private upload after failure", async () => {
    const input = await fixture(); const unrelated = join(dirname(input.cacheRoot), ".uploads", "user-data");
    await fs.mkdir(unrelated, { recursive: true }); await fs.writeFile(join(unrelated, "keep"), "mine");
    let attempted = "";
    await expect(prepareComputerProviderPackCache({ ...input, stage: async (root, guarded) => {
      attempted = dirname(root); await input.stage(root, guarded); throw new Error("upload disconnected");
    } })).rejects.toThrow("upload disconnected");
    await expect(fs.stat(attempted)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(join(unrelated, "keep"), "utf8")).toBe("mine");
  });

  it("rejects delayed old writes and keeps the replacement when a session retries", async () => {
    const input = await fixture(); const oldReady = deferred(); const releaseOld = deferred();
    let oldRoot = ""; let oldRunner!: CommandManagedRuntimeRunner;
    const old = prepareComputerProviderPackCache({ ...input, stage: async (root, guarded) => {
      oldRoot = root; oldRunner = guarded; await input.stage(root, guarded); oldReady.resolve(); await releaseOld.promise;
      throw new Error("old attempt retired");
    } });
    const rejectedOld = expect(old).rejects.toThrow("old attempt retired");
    await oldReady.promise;
    await prepareComputerProviderPackCache({ ...input, owner: { ...input.owner, generation: 2 } });
    const staleWrite = await oldRunner.execute({ command: "python3", args: ["-c", "import os,sys;os.makedirs(sys.argv[1],exist_ok=True)", oldRoot] });
    expect(staleWrite.exitCode).not.toBe(0);
    expect(staleWrite.stderr).toContain("stale upload generation");
    releaseOld.resolve(); await rejectedOld;
    await input.verify(input.cacheRoot);
    await expect(fs.stat(dirname(oldRoot))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for an in-flight guarded writer before replacing its receipt", async () => {
    const input = await fixture(); const entered = deferred(); const releaseStage = deferred();
    const releaseFile = join(roots.at(-1)!, "release-writer");
    let write!: Promise<Awaited<ReturnType<CommandManagedRuntimeRunner["execute"]>>>;
    const old = prepareComputerProviderPackCache({ ...input, stage: async (root, guarded) => {
      await input.stage(root, guarded);
      write = guarded.execute({ command: "python3", args: ["-c", "import os,sys,time;print('entered',flush=True)\nwhile not os.path.exists(sys.argv[1]):time.sleep(0.01)", releaseFile], onLog: async (_stream, text) => { if (text.includes("entered")) entered.resolve(); } });
      await releaseStage.promise; await write; throw new Error("old retired");
    } });
    const rejectedOld = expect(old).rejects.toThrow("old retired");
    await entered.promise;
    let replacementStaged = false;
    const replacement = prepareComputerProviderPackCache({ ...input, owner: { ...input.owner, generation: 2 }, stage: async (root, guarded) => {
      replacementStaged = true; await input.stage(root, guarded);
    } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(replacementStaged).toBe(false);
    await fs.writeFile(releaseFile, "release");
    expect((await write).exitCode).toBe(0);
    await replacement; releaseStage.resolve(); await rejectedOld;
    await input.verify(input.cacheRoot);
  });

  it("reclaims an interrupted marked upload on the next attempt", async () => {
    const input = await fixture(); let attempted = "";
    const disconnected: CommandManagedRuntimeRunner = { execute: (command) => {
      if (command.args?.[2] === "cleanup") return Promise.reject(new Error("controller disconnected"));
      return runner.execute(command);
    } };
    await expect(prepareComputerProviderPackCache({ ...input, runner: disconnected, stage: async (root, guarded) => {
      attempted = dirname(root); await input.stage(root, guarded); throw new Error("interrupted");
    } })).rejects.toThrow("interrupted");
    expect((await fs.stat(attempted)).isDirectory()).toBe(true);
    // Another task can publish while this session is disconnected. Retrying
    // this session must reclaim its exact old upload even on the shared hit.
    await prepareComputerProviderPackCache({ ...input, sessionKey: "another-task" });
    await expect(prepareComputerProviderPackCache({ ...input, owner: { ...input.owner, generation: 2 } })).resolves.toBe("reused");
    await expect(fs.stat(attempted)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("remote provider verification result classification", () => {
  const result = { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
  it.each(["manifest_mismatch", "artifact_digest_mismatch", "dist_digest_mismatch", "candidate_digest_mismatch", "package_version_mismatch"])("recognizes only an explicit %s result", (reason) => {
    expect(() => assertRemoteProviderPackVerificationResult({ ...result, exitCode: 42, stderr: `paperclip-provider-pack-verification:${reason}` }))
      .toThrow(expect.objectContaining({ kind: "mismatch", reason }));
  });
  it.each([
    { exitCode: 42, timedOut: true, stderr: "paperclip-provider-pack-verification:artifact_digest_mismatch" },
    { exitCode: 255, timedOut: false, stderr: "private SSH stderr" },
    { exitCode: 1, timedOut: false, stderr: "Error: artifact digest mismatch" },
    { exitCode: 42, timedOut: false, stderr: "paperclip-provider-pack-verification:unknown" },
    { exitCode: 42, timedOut: false, stderr: "paperclip-provider-pack-verification:artifact_digest_mismatch\nprivate stderr" },
  ])("does not classify incomplete or unexpected results as corruption: %j", (failure) => {
    const error = (() => { try { assertRemoteProviderPackVerificationResult({ ...result, ...failure }); } catch (error) { return error; } })();
    expect(error).toMatchObject({ kind: "unavailable" });
    expect((error as Error).message).not.toMatch(/private|digest_mismatch|quarantine/);
  });
  it("distinguishes a completed OpenCode version mismatch from a failed or timed-out version probe", () => {
    expect(() => assertRemoteProviderPackVerificationResult({ ...result, stdout: "1.2.3" }, "1.2.3")).not.toThrow();
    expect(() => assertRemoteProviderPackVerificationResult({ ...result, stdout: "1.2.2" }, "1.2.3")).toThrow(expect.objectContaining({ kind: "mismatch", reason: "opencode_version_mismatch" }));
    for (const failure of [{ exitCode: 1 }, { timedOut: true }])
      expect(() => assertRemoteProviderPackVerificationResult({ ...result, ...failure }, "1.2.3")).toThrow(expect.objectContaining({ kind: "unavailable" }));
  });
  it.each(["node_version_incompatible", "target_mismatch"])("keeps %s distinct from cache corruption", reason => {
    expect(() => assertRemoteProviderPackVerificationResult({ ...result, exitCode: 42, stderr: `paperclip-provider-pack-verification:${reason}` }))
      .toThrow(expect.objectContaining({ kind: "incompatible", reason }));
  });
});
