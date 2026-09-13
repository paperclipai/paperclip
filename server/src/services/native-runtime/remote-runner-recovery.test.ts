import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { adoptVerifiedRemoteRunner, REMOTE_RECOVERY_PROBE, verifyRemoteRunnerRecovery } from "./remote-runner-recovery.js";

const require = createRequire(import.meta.url);
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "remote-recovery-")));
  directories.push(root);
  const dir = join(root, "runner"), proc = join(root, "proc", "4321");
  fs.mkdirSync(dir); fs.mkdirSync(proc, { recursive: true });
  const identity = { runId: "run-a", normalizedSessionId: "session-a", runnerInstanceId: "runner-a", environmentLeaseId: "lease-a" };
  const marker = "ec0e1ae3-0614-44fc-a352-bb03d89134d7\n4321\n2026-09-10T17:00:00.000Z\nrunner-a\n";
  fs.writeFileSync(join(dir, "runner-process.identity"), marker);
  fs.writeFileSync(join(dir, "runner-state.json"), JSON.stringify({ schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "ready", privateJournal: "must not leave sandbox" }));
  const fields = ["S", ...Array(18).fill("0"), "13579"];
  fs.writeFileSync(join(proc, "stat"), "4321 (paperclip runner) " + fields.join(" "));
  fs.writeFileSync(join(proc, "cmdline"), ["runnerd", "--runner-id", "runner-a", "--state-dir", dir, "--run-id", "run-a", "--session-id", "session-a", "--environment-lease-id", "lease-a"].join("\0"));
  const kill = vi.fn();
  // Real bounded file-descriptor reads and path checks on every OS; only the
  // Linux process table and signal syscall are replaced by this fixture.
  const remoteFs = {
    ...fs,
    realpathSync: (path: string) => path.startsWith("/proc/") ? path : fs.realpathSync(path),
    openSync: (path: string, flags: number) => fs.openSync(path.startsWith("/proc/") ? join(root, path.slice(1)) : path, flags),
  };
  const invoke = (overrides: Record<string, unknown> = {}) => {
    let stdout = "";
    runInNewContext(REMOTE_RECOVERY_PROBE, {
      require: (name: string) => name === "node:fs" ? remoteFs : require(name),
      Buffer,
      process: { argv: ["node", JSON.stringify({ identity, stateDirectory: dir, mode: "state", ...overrides })], kill },
      console: { log: (value: string) => { stdout += value; } },
    }, { timeout: 1000 });
    return JSON.parse(stdout);
  };
  return { root, dir, proc, identity, invoke, kill };
}

describe("remote recovery evidence", () => {
  it("reads the remote authority and exact process without returning the journal", () => {
    const f = fixture(), result = f.invoke();
    expect(result).toMatchObject({ identity: f.identity, alive: true, lifecycle: "ready", process: { pid: 4321, startTicks: "13579" } });
    expect(JSON.stringify(result)).not.toContain("privateJournal");
    expect(f.kill).toHaveBeenCalledExactlyOnceWith(4321, 0);
  });

  it.each(["runId", "normalizedSessionId", "runnerInstanceId", "environmentLeaseId"])("rejects a different %s", (field) => {
    const f = fixture();
    expect(() => f.invoke({ identity: { ...f.identity, [field]: "other" } })).toThrow();
  });

  it("adopts a warm process whose launch run preceded its current durable run", () => {
    const f = fixture(), file = join(f.proc, "cmdline");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("run-a", "original-cold-run"));
    expect(f.invoke()).toMatchObject({ identity: f.identity, alive: true });
  });

  it.each(["runner-state.json", "runner-process.identity"])("rejects a symlink for %s", (name) => {
    const f = fixture(), original = join(f.dir, name), elsewhere = join(f.root, "private");
    fs.renameSync(original, elsewhere); fs.symlinkSync(elsewhere, original);
    expect(() => f.invoke()).toThrow();
  });

  it("rejects an ancestor symlink", () => {
    const f = fixture(), alias = join(f.root, "alias"); fs.symlinkSync(f.dir, alias);
    expect(() => f.invoke({ stateDirectory: alias })).toThrow();
  });

  it("bounds reads and rejects malformed or oversized state", () => {
    const f = fixture(), path = join(f.dir, "runner-state.json");
    fs.writeFileSync(path, ""); expect(() => f.invoke()).toThrow();
    fs.truncateSync(path, 16 * 1024 * 1024 + 1); expect(() => f.invoke()).toThrow();
  });

  it("rejects a recycled process before signalling", () => {
    const f = fixture(), observed = f.invoke();
    const stat = join(f.proc, "stat"); fs.writeFileSync(stat, fs.readFileSync(stat, "utf8").replace("13579", "24680"));
    expect(() => f.invoke({ mode: "process", process: observed.process, signal: "SIGTERM" })).toThrow();
    expect(f.kill.mock.calls.every((call) => call[1] === 0)).toBe(true);
  });

  it("rejects a changed process marker before signalling", () => {
    const f = fixture(), observed = f.invoke();
    expect(() => f.invoke({ mode: "process", process: { ...observed.process, nonce: "other" }, signal: "SIGTERM" })).toThrow();
    expect(f.kill.mock.calls.every((call) => call[1] === 0)).toBe(true);
  });

  it("only signals a process with all original fingerprints intact", () => {
    const f = fixture(), observed = f.invoke();
    f.invoke({ mode: "process", process: observed.process, signal: "SIGTERM" });
    expect(f.kill).toHaveBeenLastCalledWith(4321, "SIGTERM");
  });

  it.each(["cmdline", "stat"])("treats a vanished %s as dead", (name) => {
    const f = fixture(); fs.unlinkSync(join(f.proc, name));
    expect(f.invoke().alive).toBe(false);
  });

  it("requires suspended state for a dead remote process", async () => {
    const f = fixture(), proof = f.invoke();
    const execute = vi.fn(async () => ({ exitCode: 0, timedOut: false, stdout: JSON.stringify({ ...proof, alive: false }) }));
    const runner = { execute } as unknown as CommandManagedRuntimeRunner;
    await expect(verifyRemoteRunnerRecovery({ runner, identity: f.identity, stateDirectory: f.dir })).rejects.toThrow("runner_remote_recovery_unverified");
    proof.lifecycle = "suspended";
    await expect(verifyRemoteRunnerRecovery({ runner, identity: f.identity, stateDirectory: f.dir })).resolves.toMatchObject({ alive: false });
    expect(() => adoptVerifiedRemoteRunner(runner, { ...proof, alive: false })).toThrow();
  });

  it("coalesces concurrent liveness calls and propagates provider failures", async () => {
    const f = fixture(), proof = f.invoke();
    const execute = vi.fn(async () => ({ exitCode: 0, timedOut: false, stdout: JSON.stringify(proof) }));
    const runner = { execute } as unknown as CommandManagedRuntimeRunner;
    const adopted = adoptVerifiedRemoteRunner(runner, proof);
    expect(await Promise.all([adopted.isAlive(), adopted.isAlive(), adopted.isAlive()])).toEqual([true, true, true]);
    expect(execute).toHaveBeenCalledOnce();
    execute.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(adopted.signal("SIGTERM")).rejects.toThrow("runner_remote_recovery_unavailable");
  });
});
