import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { describe, expect, it, vi } from "vitest";
import { SANDBOX_DISK_FULL_FAILURE_CODE, isSandboxDiskFullFailure } from "../../vendor/paperclip-runner/index.js";
import { createRemoteRunnerProcessLauncher, stageRemoteRunnerFile } from "./native-session-executor.js";
import {
  createRemoteRunnerDiskReserve,
  holdRemoteRunnerDiskReserve,
  releaseRemoteRunnerDiskReserve,
  remoteRunnerDiskReservePath,
} from "./remote-runner-disk-reserve.js";

type Execute = CommandManagedRuntimeRunner["execute"];
type Request = Parameters<Execute>[0];

const ok = { exitCode: 0, signal: null, timedOut: false, pid: null, startedAt: null, stdout: "", stderr: "" };
// What a Daytona upload reports when the agent has filled the sandbox disk.
const diskFull = () => new Error(
  '{"errors":["/home/daytona/paperclip-workspace/.paperclip-upload-1.tar.gz: create: open /home/daytona/paperclip-workspace/.paperclip-upload-1.tar.gz: no space left on device"],"files":[]}',
);
const label = (request: Request) => request.args?.[2];
const spec = { command: "/controller/runnerd", args: [], cwd: "/controller", environment: {} };
const reservePath = "/workspace/.paperclip-runtime/paperclip-runner/disk-reserve";

/** A sandbox whose disk holds Paperclip's reserve. Staging fits only after the reserve is released. */
function fullSandbox(options: { freedByRelease: boolean; failedReleases?: number }) {
  const disk = { reserveHeld: true, failedReleases: options.failedReleases ?? 0 };
  const execute = vi.fn<Execute>(async request => {
    if (label(request) === "paperclip-runner-disk-reserve-release") {
      if (disk.failedReleases > 0) {
        disk.failedReleases -= 1;
        throw new Error("sandbox_rpc_lost");
      }
      const released = disk.reserveHeld;
      disk.reserveHeld = false;
      return { ...ok, stdout: released ? "released\n" : "not_held\n" };
    }
    return ok;
  });
  const ensureArtifact = vi.fn(async () => {
    if (disk.reserveHeld || !options.freedByRelease) throw diskFull();
  });
  return { disk, execute, ensureArtifact };
}

function launcherFor(sandbox: { execute: Execute; ensureArtifact?: () => Promise<void> }) {
  return createRemoteRunnerProcessLauncher({
    target: { kind: "remote", transport: "sandbox", environmentId: "environment", leaseId: "lease", remoteCwd: "/workspace" },
    runner: { execute: sandbox.execute },
    remoteBinary: "/runtime/runnerd", processIdentityPath: "/runtime/identity",
    stateDirectory: "/runtime/sessions/s/runner", diagnosticsDirectory: "/runtime/sessions/s/diagnostics",
    runnerInstanceId: "runner-disk-reserve",
    diskReservePath: reservePath,
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

  it("fails at once with the shared sandbox_disk_full code when releasing the reserve does not free enough space", async () => {
    const sandbox = fullSandbox({ freedByRelease: false });
    const handle = launcherFor(sandbox)(spec);
    const failure = await handle.completion.catch((error: unknown) => error);
    expect(isSandboxDiskFullFailure(failure)).toBe(true);
    expect(failure).toMatchObject({ code: SANDBOX_DISK_FULL_FAILURE_CODE, message: expect.stringMatching(/^sandbox_disk_full: /) });
    expect(sandbox.ensureArtifact).toHaveBeenCalledTimes(2);
    // No launch RPC ran, so recovery knows no replacement runner exists.
    expect(sandbox.execute.mock.calls.map(([request]) => label(request))).toEqual(["paperclip-runner-disk-reserve-release"]);
    expect(handle.isExitConfirmed?.()).toBe(true);
  });

  it("retries a release whose sandbox command was lost, then stages again", async () => {
    const sandbox = fullSandbox({ freedByRelease: true, failedReleases: 1 });
    const handle = launcherFor(sandbox)(spec);
    handle.child.kill("SIGTERM");
    await expect(handle.completion).resolves.toMatchObject({ stderr: "runner_process_launch_cancelled" });
    expect(sandbox.disk.reserveHeld).toBe(false);
  });

  it("keeps the failure retryable when the release cannot run, because the reserve may still be held", async () => {
    const sandbox = fullSandbox({ freedByRelease: true, failedReleases: 2 });
    const failure = await launcherFor(sandbox)(spec).completion.catch((error: unknown) => error);
    expect(isSandboxDiskFullFailure(failure)).toBe(false);
    expect(failure).toMatchObject({ message: expect.stringContaining("no space left on device") });
    expect(sandbox.disk.reserveHeld).toBe(true);
  });

  it("does not stage twice for a failure that is not a full disk", async () => {
    const sandbox = fullSandbox({ freedByRelease: true });
    const failure = new Error("runner_remote_directory_staging_failed");
    sandbox.ensureArtifact.mockImplementation(async () => { throw failure; });
    await expect(launcherFor(sandbox)(spec).completion).rejects.toBe(failure);
    expect(sandbox.ensureArtifact).toHaveBeenCalledTimes(1);
    expect(sandbox.disk.reserveHeld).toBe(true);
  });

  it("recognizes a full disk reported by a command-based upload, not only by a provider upload", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-disk-reserve-stage-"));
    try {
      const sourcePath = join(root, "runtime-context.json");
      await writeFile(sourcePath, "{}");
      const sandbox = fullSandbox({ freedByRelease: true });
      sandbox.ensureArtifact.mockImplementation(async () => {
        await stageRemoteRunnerFile({
          target: { kind: "remote", transport: "sandbox", remoteCwd: root } as never,
          runner: { execute: async () => (sandbox.disk.reserveHeld
            ? { ...ok, exitCode: 1, stderr: "base64: write error: No space left on device" }
            : ok) } as never,
          sourcePath, targetPath: join(root, "staged.json"), mode: 0o600,
        });
      });
      const handle = launcherFor(sandbox)(spec);
      handle.child.kill("SIGTERM");
      await expect(handle.completion).resolves.toMatchObject({ stderr: "runner_process_launch_cancelled" });
      expect(sandbox.ensureArtifact).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("remote runner disk reserve across launches", () => {
  it("holds the reserve once after the first launch starts, and a relaunch only releases it", async () => {
    let nonce = "";
    const execute = vi.fn<Execute>(async request => {
      const name = label(request);
      if (name === "paperclip-runner-launch") { nonce = request.args![4]!; return ok; }
      if (name === "paperclip-runner-process-identity") {
        return { ...ok, stdout: `${nonce}\n4321\n2026-09-06T00:00:00.000Z\nrunner-disk-reserve\n` };
      }
      // The runner exits at once, so the launch settles.
      if (name === "paperclip-runner-monitor") return { ...ok, exitCode: 45 };
      if (name === "paperclip-runner-disk-reserve-release") return { ...ok, stdout: "released\n" };
      if (name === "paperclip-runner-disk-reserve-hold") return ok;
      return { ...ok, exitCode: 1 };
    });
    const launcher = launcherFor({ execute, ensureArtifact: async () => undefined });
    const holds = () => execute.mock.calls.filter(([request]) => label(request) === "paperclip-runner-disk-reserve-hold");
    const releases = () => execute.mock.calls.filter(([request]) => label(request) === "paperclip-runner-disk-reserve-release");

    await launcher(spec).completion;
    await vi.waitFor(() => expect(holds()).toHaveLength(1));
    expect(holds()[0]![0].args?.[3]).toBe(reservePath);
    expect(releases()).toHaveLength(0);

    await launcher(spec).completion;
    expect(releases()).toHaveLength(1);
    expect(holds()).toHaveLength(1);
    expect(execute.mock.calls.filter(([request]) => label(request) === "paperclip-runner-launch")).toHaveLength(2);
  });

  it("holds no reserve when the launcher has no reserve path, as on a user's own host", async () => {
    let nonce = "";
    const execute = vi.fn<Execute>(async request => {
      const name = label(request);
      if (name === "paperclip-runner-launch") { nonce = request.args![4]!; return ok; }
      if (name === "paperclip-runner-process-identity") {
        return { ...ok, stdout: `${nonce}\n4321\n2026-09-06T00:00:00.000Z\nrunner-ssh\n` };
      }
      if (name === "paperclip-runner-monitor") return { ...ok, exitCode: 45 };
      return { ...ok, exitCode: 1 };
    });
    const launcher = createRemoteRunnerProcessLauncher({
      target: { kind: "remote", transport: "ssh", environmentId: "environment", leaseId: "lease", remoteCwd: "/home/me/ws" } as never,
      runner: { execute }, remoteBinary: "/runtime/runnerd", processIdentityPath: "/runtime/identity",
      stateDirectory: "/runtime", diagnosticsDirectory: "/runtime/diagnostics", runnerInstanceId: "runner-ssh",
      diskReservePath: remoteRunnerDiskReservePath({ transport: "ssh", remoteCwd: "/home/me/ws" }),
      ensureArtifact: async () => undefined,
    });
    await launcher(spec).completion;
    await launcher(spec).completion;
    expect(execute.mock.calls.some(([request]) => String(label(request)).startsWith("paperclip-runner-disk-reserve"))).toBe(false);
  });
});

describe("remote runner disk reserve ordering", () => {
  it("lets a background hold finish before a release, so a relaunch never stages with the space taken back", async () => {
    let finishHold!: () => void;
    const holdGate = new Promise<void>(resolve => { finishHold = resolve; });
    const events: string[] = [];
    const execute = vi.fn<Execute>(async request => {
      if (label(request) === "paperclip-runner-disk-reserve-hold") {
        events.push("hold:start");
        await holdGate;
        events.push("hold:done");
        return ok;
      }
      events.push("release");
      return { ...ok, stdout: "released\n" };
    });
    const reserve = createRemoteRunnerDiskReserve({ execute }, reservePath);
    reserve.hold();
    const released = reserve.release();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(events).toEqual(["hold:start"]);
    finishHold();
    await expect(released).resolves.toBe("released");
    expect(events).toEqual(["hold:start", "hold:done", "release"]);
  });

  it("starts no hold once a release was requested", async () => {
    const execute = vi.fn<Execute>(async () => ({ ...ok, stdout: "not_held\n" }));
    const reserve = createRemoteRunnerDiskReserve({ execute }, reservePath);
    await reserve.release();
    reserve.hold();
    expect(execute.mock.calls.map(([request]) => label(request))).toEqual(["paperclip-runner-disk-reserve-release"]);
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
      await holdRemoteRunnerDiskReserve({ execute }, reserve, { bytes: 1024 * 1024, minimumFreeBytes: 0 });
      expect(statSync(reserve).size).toBe(1024 * 1024);
      await holdRemoteRunnerDiskReserve({ execute }, reserve, { bytes: 1024 * 1024, minimumFreeBytes: 0 });
      expect(existsSync(`${reserve}.partial`)).toBe(false);
      await expect(releaseRemoteRunnerDiskReserve({ execute }, reserve)).resolves.toBe("released");
      expect(existsSync(reserve)).toBe(false);
      await expect(releaseRemoteRunnerDiskReserve({ execute }, reserve)).resolves.toBe("not_held");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never takes space the agent needs: no reserve below the free-space floor", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-disk-reserve-"));
    const reserve = join(root, "disk-reserve");
    try {
      await holdRemoteRunnerDiskReserve({ execute: localExecute }, reserve,
        { bytes: 1024 * 1024, minimumFreeBytes: Number.MAX_SAFE_INTEGER });
      expect(existsSync(reserve)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("holds a reserve only in a managed sandbox, under the runtime directory saves exclude", () => {
    expect(remoteRunnerDiskReservePath({ transport: "sandbox", remoteCwd: "/home/daytona/ws/" }))
      .toBe("/home/daytona/ws/.paperclip-runtime/paperclip-runner/disk-reserve");
    expect(remoteRunnerDiskReservePath({ transport: "ssh", remoteCwd: "/home/me/ws" })).toBeUndefined();
  });
});
