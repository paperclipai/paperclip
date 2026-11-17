import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { describe, expect, it, vi } from "vitest";
import { createRemoteRunnerProcessLauncher } from "./native-session-executor.js";

type Execute = CommandManagedRuntimeRunner["execute"];
type Request = Parameters<Execute>[0];

const ok = { exitCode: 0, signal: null, timedOut: false, pid: null, startedAt: null, stdout: "", stderr: "" };
// What a Daytona upload reports when the agent has filled the sandbox disk.
const diskFull = () => new Error(
  '{"errors":["/home/daytona/paperclip-workspace/.paperclip-upload-1.tar.gz: create: open /home/daytona/paperclip-workspace/.paperclip-upload-1.tar.gz: no space left on device"],"files":[]}',
);
const label = (request: Request) => request.args?.[2];
const spec = { command: "/controller/runnerd", args: [], cwd: "/controller", environment: {} };

/** A sandbox whose disk holds Paperclip's reserve. Staging fits only after the reserve is released. */
function fullSandbox(options: { freedByRelease: boolean }) {
  const disk = { reserveHeld: true };
  const execute = vi.fn<Execute>(async request => {
    if (label(request) === "paperclip-runner-disk-reserve-release") {
      const released = disk.reserveHeld;
      disk.reserveHeld = false;
      return { ...ok, stdout: released ? "released\n" : "" };
    }
    return ok;
  });
  const ensureArtifact = vi.fn(async () => {
    if (disk.reserveHeld || !options.freedByRelease) throw diskFull();
  });
  return { disk, execute, ensureArtifact };
}

function launcherFor(sandbox: ReturnType<typeof fullSandbox>) {
  return createRemoteRunnerProcessLauncher({
    target: { kind: "remote", transport: "sandbox", environmentId: "environment", leaseId: "lease", remoteCwd: "/workspace" },
    runner: { execute: sandbox.execute },
    remoteBinary: "/runtime/runnerd", processIdentityPath: "/runtime/identity",
    stateDirectory: "/runtime/sessions/s/runner", diagnosticsDirectory: "/runtime/sessions/s/diagnostics",
    runnerInstanceId: "runner-disk-reserve",
    diskReservePath: "/workspace/.paperclip-runtime/paperclip-runner/disk-reserve",
    ensureArtifact: sandbox.ensureArtifact,
  });
}

// An agent filled a managed sandbox's disk, runnerd exited, and every
// relaunch failed to upload its launch files for the whole reconnect grace.
describe("remote runner launch on a full sandbox disk", () => {
  it("releases Paperclip's disk reserve and stages again", async () => {
    const sandbox = fullSandbox({ freedByRelease: true });
    const handle = launcherFor(sandbox)(spec);
    // Stop before dispatch: this test covers staging only.
    handle.child.kill("SIGTERM");
    await expect(handle.completion).resolves.toMatchObject({ stderr: "runner_process_launch_cancelled" });
    expect(sandbox.ensureArtifact).toHaveBeenCalledTimes(2);
    expect(sandbox.disk.reserveHeld).toBe(false);
  });

  it("releases the reserve before a relaunch stages, since the lost runner may have died on a full disk", async () => {
    const sandbox = fullSandbox({ freedByRelease: true });
    const launcher = launcherFor(sandbox);
    sandbox.disk.reserveHeld = false;
    const first = launcher(spec);
    first.child.kill("SIGTERM");
    await first.completion;
    sandbox.disk.reserveHeld = true;
    sandbox.ensureArtifact.mockClear();

    const relaunch = launcher(spec);
    relaunch.child.kill("SIGTERM");
    await expect(relaunch.completion).resolves.toMatchObject({ stderr: "runner_process_launch_cancelled" });
    expect(sandbox.ensureArtifact).toHaveBeenCalledTimes(1);
    expect(sandbox.disk.reserveHeld).toBe(false);
  });

  it("fails at once with sandbox_disk_full when releasing the reserve does not free enough space", async () => {
    const sandbox = fullSandbox({ freedByRelease: false });
    const handle = launcherFor(sandbox)(spec);
    await expect(handle.completion).rejects.toThrow(/^sandbox_disk_full: /);
    expect(sandbox.ensureArtifact).toHaveBeenCalledTimes(2);
    // No launch RPC ran, so recovery knows no replacement runner exists.
    expect(sandbox.execute.mock.calls.map(([request]) => label(request))).toEqual(["paperclip-runner-disk-reserve-release"]);
    expect(handle.isExitConfirmed?.()).toBe(true);
  });

  it("does not stage twice for a failure that is not a full disk", async () => {
    const sandbox = fullSandbox({ freedByRelease: true });
    const failure = new Error("runner_remote_directory_staging_failed");
    sandbox.ensureArtifact.mockImplementation(async () => { throw failure; });
    await expect(launcherFor(sandbox)(spec).completion).rejects.toBe(failure);
    expect(sandbox.ensureArtifact).toHaveBeenCalledTimes(1);
    expect(sandbox.disk.reserveHeld).toBe(true);
  });
});

const localExecute: Execute = request => new Promise(resolve => {
  const child = spawn(request.command, request.args ?? [], { cwd: request.cwd, env: { ...process.env, ...request.env },
    stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  child.once("close", (code, signal) => resolve({ exitCode: code, signal, timedOut: false, pid: child.pid ?? null,
    startedAt: null, stdout, stderr }));
});

describe("remote runner disk reserve scripts", () => {
  it("holds the reserve once, then the release frees it", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-disk-reserve-"));
    const reserve = join(root, "runtime", "disk-reserve");
    const execute = vi.fn<Execute>(localExecute);
    try {
      const { holdRemoteRunnerDiskReserve, releaseRemoteRunnerDiskReserve } = await import("./native-session-executor.js");
      await holdRemoteRunnerDiskReserve({ execute }, reserve, { bytes: 1024 * 1024, minimumFreeBytes: 0 });
      expect(statSync(reserve).size).toBe(1024 * 1024);
      await holdRemoteRunnerDiskReserve({ execute }, reserve, { bytes: 1024 * 1024, minimumFreeBytes: 0 });
      expect(existsSync(`${reserve}.partial`)).toBe(false);
      await expect(releaseRemoteRunnerDiskReserve({ execute }, reserve)).resolves.toBe(true);
      expect(existsSync(reserve)).toBe(false);
      await expect(releaseRemoteRunnerDiskReserve({ execute }, reserve)).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never takes space the agent needs: no reserve below the free-space floor", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-disk-reserve-"));
    const reserve = join(root, "disk-reserve");
    try {
      const { holdRemoteRunnerDiskReserve } = await import("./native-session-executor.js");
      await holdRemoteRunnerDiskReserve({ execute: localExecute }, reserve,
        { bytes: 1024 * 1024, minimumFreeBytes: Number.MAX_SAFE_INTEGER });
      expect(existsSync(reserve)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
