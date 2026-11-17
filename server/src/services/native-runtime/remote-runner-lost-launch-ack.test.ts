import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { describe, expect, it, vi } from "vitest";
import { createRemoteRunnerProcessLauncher } from "./native-session-executor.js";

type Execute = CommandManagedRuntimeRunner["execute"];

/** Runs each sandbox command on this machine, the way a sandbox command RPC would. */
const localExecute: Execute = request => new Promise(resolve => {
  const child = spawn(request.command, request.args ?? [], { cwd: request.cwd,
    env: { ...process.env, ...request.env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  child.once("close", (code, signal) => resolve({ exitCode: code, signal, timedOut: false, pid: child.pid ?? null,
    startedAt: null, stdout, stderr }));
});

const alive = (pid: number) => {
  try { return !readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.startsWith("Z"); } catch { return false; }
};

/** Every live `paperclip-runnerd` that serves this state folder, read from /proc as the launch fence does. */
function runnersServing(stateDirectory: string): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (String(Number(entry)) !== entry) continue;
    let argv: string[];
    try { argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0"); } catch { continue; }
    if (basename(argv[0] ?? "") !== "paperclip-runnerd" || argv[1] === "reap-lineage") continue;
    if (argv.some((value, index) => value === "--state-dir" && argv[index + 1] === stateDirectory) && alive(Number(entry))) {
      pids.push(Number(entry));
    }
  }
  return pids;
}

// The server can stop after the launch command reached the sandbox but before
// it read back the Runner's process identity (a lost acknowledgement). The
// database then holds no PID for the run, and the successor launches again.
// This guards that a relaunch never leaves two Runners on the run's state.
describe.skipIf(!existsSync("/proc/self/cmdline"))("remote Runner launch whose acknowledgement was lost", () => {
  it("leaves exactly one Runner on the run's state folder after the successor relaunches", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-lost-launch-ack-"));
    const stateDirectory = join(root, "sandbox", "state");
    const binary = join(root, "bin", "paperclip-runnerd");
    await mkdir(join(root, "bin"), { recursive: true });
    await mkdir(stateDirectory, { recursive: true });
    // Stands in for runnerd: a long-lived process whose argv[0] is the Runner
    // binary. `reap-lineage` reports a verified, empty lineage.
    await writeFile(binary, [
      "#!/bin/bash",
      'if test "$1" = reap-lineage; then',
      `  printf '%s\\n' '${JSON.stringify({ schema: "paperclip.runner.process-lineage-reap.v1", verified: true, reason: null, journals: 1, signalled: 0, remaining: [] })}'`,
      "  exit 0",
      "fi",
      `exec -a "$0" ${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 1000)' -- "$@"`,
      "",
    ].join("\n"), { mode: 0o755 });
    const launcherInput = {
      target: { kind: "remote" as const, transport: "sandbox" as const, environmentId: "environment", leaseId: "lease",
        remoteCwd: join(root, "sandbox") },
      remoteBinary: binary,
      processIdentityPath: join(stateDirectory, "runner-process.identity"),
      stateDirectory,
      diagnosticsDirectory: join(root, "sandbox", "diagnostics"),
      runnerInstanceId: "runner-lost-ack",
    };
    const spec = { command: binary, args: ["--runner-id", "runner-lost-ack", "--state-dir", stateDirectory],
      cwd: root, environment: {} };

    // The old server: its launch command runs in the sandbox, then the
    // connection is lost before the acknowledgement, and the server is gone.
    let serverGone = false;
    const oldExecute = vi.fn<Execute>(async request => {
      if (serverGone) throw new Error("old_controller_gone");
      if (request.args?.[2] !== "paperclip-runner-launch") return localExecute(request);
      await localExecute(request);
      serverGone = true;
      throw new Error("remote_launch_ack_lost");
    });
    const oldHandle = createRemoteRunnerProcessLauncher({ ...launcherInput, runner: { execute: oldExecute } })(spec);
    const successorSpawned = vi.fn<(meta: { pid: number }) => Promise<void>>(async () => undefined);
    let successorHandle: ReturnType<ReturnType<typeof createRemoteRunnerProcessLauncher>> | undefined;
    let orphanPid = 0;
    try {
      await expect(oldHandle.completion).rejects.toThrow("remote_launch_ack_lost");
      // The Runner the old server started is alive, and nothing recorded its PID.
      await vi.waitFor(() => expect(runnersServing(stateDirectory)).toHaveLength(1), { timeout: 10_000 });
      orphanPid = runnersServing(stateDirectory)[0]!;
      expect(oldHandle.child.pid).toBeUndefined();

      // The successor relaunches the same run on the same sandbox.
      successorHandle = createRemoteRunnerProcessLauncher({ ...launcherInput, runner: { execute: localExecute },
        onSpawn: successorSpawned })(spec);
      void successorHandle.completion.catch(() => undefined);
      await vi.waitFor(() => expect(successorSpawned).toHaveBeenCalledTimes(1), { timeout: 30_000 });
      const successorPid = successorSpawned.mock.calls[0]![0].pid;

      expect(successorPid).not.toBe(orphanPid);
      await vi.waitFor(() => expect(alive(orphanPid)).toBe(false), { timeout: 10_000 });
      expect(runnersServing(stateDirectory)).toEqual([successorPid]);
      expect((await readFile(launcherInput.processIdentityPath, "utf8")).split("\n")[1]).toBe(String(successorPid));
    } finally {
      // Fresh /proc reads only: a saved PID may have been reused by now.
      for (const pid of runnersServing(stateDirectory)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
      // The successor's supervision settles once it observes its Runner gone.
      if (successorHandle) await Promise.race([successorHandle.completion.catch(() => undefined),
        new Promise(resolve => setTimeout(resolve, 15_000))]);
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
