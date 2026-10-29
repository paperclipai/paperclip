import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import {
  createRemoteRunnerProcessLauncher,
  parseRemoteRunnerProcessIdentity,
  REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT,
  verifyRemoteRunnerReattachment,
} from "./native-session-executor.js";

const nonce = "launch-nonce";
const runnerInstanceId = "92de2b57-70c8-45c0-bfa2-1ce6c4ebe731";
const startedAt = "2026-10-24T18:26:58.123Z";
const expected = { nonce, runnerInstanceId };
type CommandResult = Awaited<ReturnType<CommandManagedRuntimeRunner["execute"]>>;
const ok: CommandResult = {
  exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "",
  pid: null, startedAt: null,
};

function marker(fingerprint: string, overrides: {
  pid?: number; nonce?: string; runnerInstanceId?: string; startedAt?: string;
} = {}) {
  return `${overrides.nonce ?? nonce}\n${overrides.pid ?? 4102}\n${overrides.startedAt ?? startedAt}\n${overrides.runnerInstanceId ?? runnerInstanceId}\n${fingerprint}\n`;
}

function recoveryFixture(processMarker: string) {
  const identity = {
    runId: "run", normalizedSessionId: "session", runnerInstanceId,
    environmentLeaseId: "lease", turnId: "turn", itemId: "item",
  };
  const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async request => {
    const args = request.args ?? [];
    if (args[2] === "paperclip-runner-recovery-identity") {
      return { ...ok, stdout: processMarker };
    }
    if (args[1]?.includes("base64")) {
      return { ...ok, stdout: Buffer.from(JSON.stringify(identity)).toString("base64") };
    }
    const startedAt = new Date().toISOString();
    const result = spawnSync(request.command, args, { encoding: "utf8", timeout: 2_000 });
    return {
      stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status,
      timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
      signal: result.signal, pid: result.pid, startedAt,
    };
  });
  const target = {
    kind: "remote" as const, transport: "sandbox" as const,
    remoteCwd: "/workspace", leaseId: "lease", runner: { execute },
    sandboxLeaseAcquisition: { outcome: "resumed" as const, providerLeaseId: "sandbox" },
  };
  const claim = {
    kind: "reattach_remote_runner" as const, runId: "run",
    remote: { remoteCwd: "/workspace", providerLeaseId: "sandbox" },
  };
  return {
    execute,
    recover: () => verifyRemoteRunnerReattachment({
      claim, target,
      identity, runId: "run", normalizedSessionId: "session",
    }),
  };
}

describe("remote process identity marker contract", () => {
  it.each([
    "linux:abcd-1234:1234",
    "darwin:1792857600.123456:1792866418000",
  ])("accepts the stable process generation %s", (fingerprint) => {
    expect(parseRemoteRunnerProcessIdentity(marker(fingerprint), expected)).toEqual({
      pid: 4102, startedAt, processStartFingerprint: fingerprint,
    });
  });

  it.each([
    "darwin::1792866418000",
    "darwin:1792857600.123456:",
    "darwin:1792857600.123456:NaN",
    "darwin:1792857600.123456:1792866418000:extra",
    "unsupported:1792857600:1792866418000",
  ])("rejects an unavailable or malformed process generation %s", (fingerprint) => {
    expect(parseRemoteRunnerProcessIdentity(marker(fingerprint), expected)).toBeNull();
  });

  it.each([
    { nonce: "another-launch" },
    { runnerInstanceId: randomUUID() },
    { pid: 0 },
    { startedAt: "2026-10-24T18:26:58.3NZ" },
  ])("rejects a Darwin marker with mismatched or invalid identity: %j", (overrides) => {
    expect(parseRemoteRunnerProcessIdentity(marker("darwin:1792857600.123456:1792866418000", overrides), expected)).toBeNull();
  });

  it("refuses recovery when the marker lacks a process generation", async () => {
    const fixture = recoveryFixture(marker(""));
    await expect(fixture.recover()).rejects.toMatchObject({
      message: "runner_remote_process_identity_unavailable",
      remoteRunnerRecovery: { stage: "identity_marker", reason: "fingerprint_missing" },
    });
    expect(fixture.execute).toHaveBeenCalledTimes(2);
  });
});

describe.skipIf(process.platform !== "darwin")("Darwin remote runner process identity", () => {
  function executeShell(command: string, args: string[], timeout = 2_000): Promise<CommandResult> {
    return new Promise(resolve => {
      const startedAt = new Date().toISOString();
      const child = execFile(command, args, { timeout }, (error, stdout, stderr) => resolve({
        exitCode: error ? typeof error.code === "number" ? error.code : null : 0,
        signal: error?.signal ?? null, timedOut: error?.killed ?? false,
        stdout, stderr, pid: child.pid ?? null, startedAt,
      }));
    });
  }

  async function liveRunner(
    argv: string[] = ["--runner-id", runnerInstanceId],
    fixtureSource = 'process.stdout.write("ready\\n");setInterval(()=>{},1000);',
  ) {
    const root = await mkdtemp(join(tmpdir(), "darwin-remote-process-"));
    const markerPath = join(root, "runner-process.identity");
    const fixture = join(root, "runner.cjs");
    await writeFile(fixture, fixtureSource);
    const child = spawn("/bin/sh", [
      "-c", REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT, "paperclip-test-launch",
      markerPath, nonce, runnerInstanceId, join(root, "diagnostics"),
      process.execPath, fixture, ...argv,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit");
    try {
      await Promise.race([
        once(child.stdout!, "data"),
        exited.then(([code]) => { throw new Error(`runner fixture exited before readiness: ${code}`); }),
      ]);
      return {
        child, root, markerPath, processMarker: await readFile(markerPath, "utf8"),
        cleanup: async () => {
          child.kill("SIGKILL");
          await exited;
          await rm(root, { recursive: true, force: true });
        },
      };
    } catch (error) {
      child.kill("SIGKILL");
      await exited;
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  // Read the process generation independently of the launch script, so recovery
  // rejection tests cannot pass merely because launch failed to write a marker.
  function observedFingerprint(pid: number) {
    const boot = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8" });
    const seconds = /sec\s*=\s*(\d+)/.exec(boot)?.[1];
    const microseconds = /usec\s*=\s*(\d+)/.exec(boot)?.[1];
    const start = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
    }).trim();
    expect(seconds).toBeDefined();
    expect(microseconds).toBeDefined();
    expect(Number.isFinite(Date.parse(start))).toBe(true);
    return `darwin:${seconds}.${microseconds}:${Date.parse(start)}`;
  }

  async function recoverLive(fixture: Awaited<ReturnType<typeof liveRunner>>, fingerprint: string) {
    const processMarker = marker(fingerprint, { pid: fixture.child.pid! });
    await writeFile(fixture.markerPath, processMarker);
    const recovery = recoveryFixture(processMarker);
    // Only substitute the local test marker path. Execute the production
    // ownership probe unchanged against the real child process and OS tools.
    const execute = recovery.execute.getMockImplementation()!;
    recovery.execute.mockImplementation(async request => {
      if (request.args?.[2] !== "paperclip-runner-recovery-check") return execute(request);
      const args = [...request.args];
      args[3] = fixture.markerPath;
      return execute({ ...request, args });
    });
    return recovery.recover();
  }

  it("parses a real sh launch marker with an ISO timestamp and stable macOS identity", async () => {
    const beforeLaunch = Date.now();
    const fixture = await liveRunner();
    try {
      const lines = fixture.processMarker.trim().split("\n");
      expect(lines[2]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const identity = parseRemoteRunnerProcessIdentity(fixture.processMarker, expected);
      expect(identity).toEqual({
        pid: fixture.child.pid, startedAt: lines[2],
        processStartFingerprint: observedFingerprint(fixture.child.pid!),
      });
      expect(Date.parse(identity!.startedAt)).toBeGreaterThanOrEqual(beforeLaunch);
      expect(Date.parse(identity!.startedAt)).toBeLessThanOrEqual(Date.now());
      const adopted = await recoverLive(fixture, identity!.processStartFingerprint!);
      expect(await adopted.isAlive()).toBe(true);
      expect(await adopted.isAlive()).toBe(true);
    } finally { await fixture.cleanup(); }
  });

  it.each([
    ["missing runner option", []],
    ["wrong UUID", ["--runner-id", "bda169a0-f117-40df-b744-f3ebd8a371bb"]],
    ["UUID prefix", ["--runner-id", `${runnerInstanceId}-other`]],
    ["option prefix", ["--runner-id-other", runnerInstanceId]],
    ["separate unrelated UUID", ["--runner-id", "other", "--unrelated", runnerInstanceId]],
  ] as const)("rejects a live process with %s", async (_reason, argv) => {
    const fixture = await liveRunner([...argv]);
    try {
      await expect(recoverLive(fixture, observedFingerprint(fixture.child.pid!)))
        .rejects.toMatchObject({
          message: "runner_remote_process_identity_unavailable",
          remoteRunnerRecovery: { stage: "process_verification" },
        });
      expect(() => process.kill(fixture.child.pid!, 0)).not.toThrow();
    } finally { await fixture.cleanup(); }
  });

  it.each(["boot", "start"] as const)("rejects a changed %s generation while the PID is still live", async changed => {
    const fixture = await liveRunner();
    try {
      const fingerprint = observedFingerprint(fixture.child.pid!);
      const [platform, boot, start] = fingerprint.split(":");
      const changedFingerprint = changed === "boot"
        ? `${platform}:${Number(boot!.split(".")[0]) + 1}.0:${start}`
        : `${platform}:${boot}:${Number(start) + 1_000}`;
      await expect(recoverLive(fixture, changedFingerprint)).rejects.toMatchObject({
        message: "runner_remote_process_identity_unavailable",
        remoteRunnerRecovery: { stage: "process_verification", reason: "process_generation_changed" },
      });
      expect(() => process.kill(fixture.child.pid!, 0)).not.toThrow();
    } finally { await fixture.cleanup(); }
  });

  it.each(["another runner", "a changed generation", "a legacy marker"] as const)("checks Stop ownership for %s", async kind => {
    const fixture = await liveRunner(["--runner-id", kind === "another runner" ? randomUUID() : runnerInstanceId]);
    let releaseMonitor!: () => void;
    const monitorRelease = new Promise<void>(resolve => { releaseMonitor = resolve; });
    let signalCompleted!: (result: CommandResult) => void;
    const signalResult = new Promise<CommandResult>(resolve => { signalCompleted = resolve; });
    let spawned!: () => void;
    const ready = new Promise<void>(resolve => { spawned = resolve; });
    const observed = observedFingerprint(fixture.child.pid!);
    const [platform, boot, start] = observed.split(":");
    const fingerprint = kind === "a legacy marker" ? ""
      : kind === "a changed generation" ? `${platform}:${boot}:${Number(start) + 1_000}` : observed;
    let savedMarker = "";
    const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async request => {
      const args = request.args ?? [];
      if (args[2] === "paperclip-runner-launch") {
        // Independently vary live argv, the saved generation and an old marker
        // without a fingerprint while preserving the nonce, runner ID and PID.
        savedMarker = marker(fingerprint, {
          nonce: args[4], pid: fixture.child.pid!,
        });
        await writeFile(fixture.markerPath, savedMarker);
        return ok;
      }
      if (args[2] === "paperclip-runner-process-identity") {
        return { ...ok, stdout: await readFile(fixture.markerPath, "utf8") };
      }
      if (args[2] === "paperclip-runner-monitor") {
        await monitorRelease;
        return { ...ok, exitCode: 44 };
      }
      if (args[2] === "paperclip-runner-signal") {
        const result = await executeShell(request.command, args);
        signalCompleted(result);
        return result;
      }
      throw new Error(`unexpected command: ${args[2]}`);
    });
    const handle = createRemoteRunnerProcessLauncher({
      target: { kind: "remote", transport: "sandbox", environmentId: "environment", leaseId: "lease", remoteCwd: "/workspace" },
      runner: { execute }, remoteBinary: process.execPath,
      processIdentityPath: fixture.markerPath, stateDirectory: "/runtime",
      diagnosticsDirectory: "/runtime/diagnostics", runnerInstanceId,
      requireProcessStartFingerprint: kind !== "a legacy marker", onSpawn: async () => { spawned(); },
    })({ command: process.execPath, args: ["--runner-id", runnerInstanceId], cwd: "/workspace", environment: {} });
    const completion = handle.completion.catch(error => error);
    try {
      await ready;
      expect(handle.child.kill("SIGTERM")).toBe(true);
      const result = await signalResult;
      // Allow a delivered signal and Node's child-reaping callback to settle.
      await new Promise(resolve => setTimeout(resolve, 50));
      if (kind === "a legacy marker") {
        expect(result.exitCode).toBe(0);
        expect(fixture.child.signalCode).toBe("SIGTERM");
        expect(() => process.kill(fixture.child.pid!, 0)).toThrow();
      } else {
        expect(() => process.kill(fixture.child.pid!, 0)).not.toThrow();
        expect(result.exitCode).not.toBe(0);
      }
      expect(handle.isExitConfirmed?.()).toBe(false);
      expect(handle.child.exitCode).toBeNull();
      expect(await readFile(fixture.markerPath, "utf8")).toBe(savedMarker);
    } finally {
      releaseMonitor();
      await completion;
      await fixture.cleanup();
    }
  });

  it.each(["another runner", "ownership changing after TERM"] as const)("protects failed-launch cleanup against %s", async kind => {
    const otherRunnerId = randomUUID();
    const fixture = kind === "another runner"
      ? await liveRunner(["--runner-id", otherRunnerId])
      : await liveRunner(["--runner-id", runnerInstanceId],
        `process.on("SIGTERM",()=>{process.title="node --runner-id ${otherRunnerId}";const command=require("node:child_process").execFileSync("/bin/ps",["-ww","-p",String(process.pid),"-o","command="],{encoding:"utf8"}).trim();require("node:fs").writeFileSync(__dirname+"/term-received",command);});process.stdout.write("ready\\n");setInterval(()=>{},1000);`);
    let identityRead!: () => void;
    const firstIdentityRead = new Promise<void>(resolve => { identityRead = resolve; });
    let restoreClock: (() => void) | undefined;
    const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async request => {
      const args = request.args ?? [];
      if (args[2] === "paperclip-runner-launch") {
        await writeFile(fixture.markerPath, marker("", { nonce: args[4], pid: fixture.child.pid! }));
        return ok;
      }
      if (args[2] === "paperclip-runner-process-identity") {
        const stdout = await readFile(fixture.markerPath, "utf8");
        identityRead();
        return { ...ok, stdout };
      }
      if (args[2] === "paperclip-runner-identity-failure-cleanup") {
        return executeShell(request.command, args, kind === "another runner" ? 2_000 : 8_000);
      }
      throw new Error(`unexpected command: ${args[2]}`);
    });
    try {
      const handle = createRemoteRunnerProcessLauncher({
        target: { kind: "remote", transport: "sandbox", environmentId: "environment", leaseId: "lease", remoteCwd: "/workspace" },
        runner: { execute }, remoteBinary: process.execPath,
        processIdentityPath: fixture.markerPath, stateDirectory: "/runtime",
        diagnosticsDirectory: "/runtime/diagnostics", runnerInstanceId,
        requireProcessStartFingerprint: true,
      })({ command: process.execPath, args: ["--runner-id", runnerInstanceId], cwd: "/workspace", environment: {} });
      const completion = handle.completion.catch(error => error);
      await firstIdentityRead;
      // Expire only the identity deadline. Keep real timers and filesystem I/O
      // so the ownership cleanup runs against the actual operating system.
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20_001);
      restoreClock = () => { clock.mockRestore(); };
      const result = await completion;
      if (kind === "ownership changing after TERM") {
        expect(await readFile(join(fixture.root, "term-received"), "utf8")).toBe(`node --runner-id ${otherRunnerId}`);
      }
      expect(() => process.kill(fixture.child.pid!, 0)).not.toThrow();
      expect(result).toMatchObject({ message: "runner_remote_process_identity_unavailable_cleanup_failed" });
      expect(handle.isExitConfirmed?.()).toBe(false);
      expect(await readFile(fixture.markerPath, "utf8")).toContain(String(fixture.child.pid));
    } finally {
      restoreClock?.();
      await fixture.cleanup();
    }
  });
});
