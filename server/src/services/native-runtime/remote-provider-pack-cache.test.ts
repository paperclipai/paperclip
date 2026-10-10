import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { computerProviderPackCachePath, prepareComputerProviderPackCache } from "./remote-provider-pack-cache.js";

const roots: string[] = [];
const digest = `sha256:${"a".repeat(64)}`;
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
    verify: async (root: string) => { expect(await fs.readFile(join(root, "payload"), "utf8")).toBe("verified bytes"); },
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
