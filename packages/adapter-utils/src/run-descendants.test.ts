import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findRunMarkedProcesses,
  RUN_ID_ENV_MARKER,
  signalRunProcessIdentity,
  terminateRunMarkedProcesses,
} from "./run-descendants.js";
import { runChildProcess } from "./server-utils.js";

const linuxOnly = process.platform === "linux" ? describe : describe.skip;

const usedRunIds = new Set<string>();
const startedPids = new Set<number>();

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A zombie still answers kill(0) but cannot run.
  return !isZombie(pid);
}

function isZombie(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 1).trim().startsWith("Z");
  } catch {
    return true;
  }
}

function newRunId() {
  const runId = randomUUID();
  usedRunIds.add(runId);
  return runId;
}

/**
 * Starts `script` in a new session (setsid) from a short-lived bash, the way a
 * Claude Code Bash tool backgrounds a server. bash exits at once, so the
 * escaped process is reparented away from its starter and is outside the
 * starter's process group. Returns the escaped PID.
 */
async function startEscapedProcess(env: Record<string, string>, script: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "run-descendants-"));
  const pidFile = path.join(dir, "pid");
  const starter = spawn(
    "bash",
    ["-c", `setsid sh -c ${JSON.stringify(script)} </dev/null >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidFile)}`],
    { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, stdio: "ignore", detached: true },
  );
  await new Promise<void>((resolve, reject) => {
    starter.once("error", reject);
    starter.once("exit", () => resolve());
  });
  const pid = Number.parseInt((await fs.readFile(pidFile, "utf8")).trim(), 10);
  await fs.rm(dir, { recursive: true, force: true });
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  startedPids.add(pid);
  // Let setsid/exec settle so the scan sees the final process image.
  const runId = env[RUN_ID_ENV_MARKER];
  if (runId) await waitFor(() => findRunMarkedProcesses(runId).some((entry) => entry.pid === pid), 2_000);
  return pid;
}

async function waitFor(check: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

function readProcessGroup(pid: number) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number.parseInt(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[2] ?? "", 10);
}

afterEach(async () => {
  // Never leave test processes behind, whatever the test outcome.
  for (const runId of usedRunIds) await terminateRunMarkedProcesses(runId, { graceMs: 0 });
  for (const pid of startedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  usedRunIds.clear();
  startedPids.clear();
});

linuxOnly("run descendant teardown", () => {
  it("finds and stops a setsid process that left the run's process group", async () => {
    const runId = newRunId();
    const pid = await startEscapedProcess({ [RUN_ID_ENV_MARKER]: runId }, "exec sleep 300");
    expect(readProcessGroup(pid)).toBe(pid);
    expect(findRunMarkedProcesses(runId).map((entry) => entry.pid)).toContain(pid);

    const result = await terminateRunMarkedProcesses(runId, { graceMs: 2_000 });

    expect(result.found.map((entry) => entry.pid)).toContain(pid);
    expect(result.forceKilled).toEqual([]);
    expect(result.survivors).toEqual([]);
    expect(await waitFor(() => !isAlive(pid), 2_000)).toBe(true);
    expect(findRunMarkedProcesses(runId)).toEqual([]);
  });

  it("force-kills an escaped process that ignores SIGTERM after the grace period", async () => {
    const runId = newRunId();
    const pid = await startEscapedProcess(
      { [RUN_ID_ENV_MARKER]: runId },
      "trap '' TERM; while :; do sleep 1; done",
    );

    const result = await terminateRunMarkedProcesses(runId, { graceMs: 300 });

    expect(result.forceKilled.map((entry) => entry.pid)).toContain(pid);
    expect(result.survivors).toEqual([]);
    expect(await waitFor(() => !isAlive(pid), 2_000)).toBe(true);
  });

  it("leaves other runs, unmarked processes and excluded owners alone", async () => {
    const runId = newRunId();
    const otherRunId = newRunId();
    const target = await startEscapedProcess({ [RUN_ID_ENV_MARKER]: runId }, "exec sleep 300");
    const otherRun = await startEscapedProcess({ [RUN_ID_ENV_MARKER]: otherRunId }, "exec sleep 300");
    const unmarked = await startEscapedProcess({ PAPERCLIP_RUN_ID_OTHER: runId }, "exec sleep 300");
    const prefixMatch = await startEscapedProcess({ [RUN_ID_ENV_MARKER]: `${runId}-suffix` }, "exec sleep 300");
    const ownedService = await startEscapedProcess({ [RUN_ID_ENV_MARKER]: runId }, "exec sleep 300");
    const excludedPid = await startEscapedProcess({ [RUN_ID_ENV_MARKER]: runId }, "exec sleep 300");

    const result = await terminateRunMarkedProcesses(runId, {
      graceMs: 2_000,
      excludeProcessGroupIds: [readProcessGroup(ownedService)],
      excludePids: [excludedPid],
    });

    expect(result.found.map((entry) => entry.pid)).toEqual([target]);
    expect(await waitFor(() => !isAlive(target), 2_000)).toBe(true);
    for (const pid of [otherRun, unmarked, prefixMatch, ownedService, excludedPid]) {
      expect(isAlive(pid)).toBe(true);
    }
  });

  it("never matches the current process or its ancestors", async () => {
    const runId = newRunId();
    // The initial environment of this process is fixed, so prove the ancestor
    // guard with a procfs fixture that marks this process.
    const procRoot = await fs.mkdtemp(path.join(os.tmpdir(), "run-descendants-proc-"));
    try {
      const self = String(process.pid);
      await fs.mkdir(path.join(procRoot, self));
      await fs.writeFile(
        path.join(procRoot, self, "stat"),
        `${self} (node) S 1 ${self} ${self} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 12345 0 0`,
      );
      await fs.writeFile(path.join(procRoot, self, "environ"), `A=1\0${RUN_ID_ENV_MARKER}=${runId}\0`);
      expect(findRunMarkedProcesses(runId, { procRoot })).toEqual([]);
    } finally {
      await fs.rm(procRoot, { recursive: true, force: true });
    }
  });

  it("does not signal a reused PID whose start time changed", async () => {
    const pid = await startEscapedProcess({}, "exec sleep 300");
    const liveStartTime = readFileSync(`/proc/${pid}/stat`, "utf8")
      .slice(readFileSync(`/proc/${pid}/stat`, "utf8").lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/)[19];
    expect(liveStartTime).toMatch(/^\d+$/);
    // An identity recorded for an earlier process that had the same PID.
    const staleIdentity = { pid, startTime: String(Number(liveStartTime) - 1) };

    expect(signalRunProcessIdentity(staleIdentity, "SIGKILL")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isAlive(pid)).toBe(true);

    expect(signalRunProcessIdentity({ pid, startTime: liveStartTime! }, "SIGKILL")).toBe(true);
    expect(await waitFor(() => !isAlive(pid), 2_000)).toBe(true);
  });

  // Root cause: runChildProcess signals only the CLI's process group, and on a
  // normal exit it signals nothing. These tests show the escaped process
  // survives runChildProcess and that the marker teardown then stops it.
  it("stops a setsid descendant that survives a successful run", async () => {
    const runId = newRunId();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "run-descendants-run-"));
    const pidFile = path.join(dir, "pid");
    try {
      const result = await runChildProcess(
        runId,
        "bash",
        ["-c", `setsid sh -c 'exec sleep 300' </dev/null >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidFile)}; exit 0`],
        {
          cwd: dir,
          env: { [RUN_ID_ENV_MARKER]: runId },
          timeoutSec: 30,
          graceSec: 1,
          onLog: async () => {},
        },
      );
      expect(result.exitCode).toBe(0);
      const pid = Number.parseInt((await fs.readFile(pidFile, "utf8")).trim(), 10);
      startedPids.add(pid);
      expect(isAlive(pid)).toBe(true);

      await terminateRunMarkedProcesses(runId, { graceMs: 2_000 });

      expect(await waitFor(() => !isAlive(pid), 2_000)).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("stops a setsid descendant that survives a timed-out run", async () => {
    const runId = newRunId();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "run-descendants-run-"));
    const pidFile = path.join(dir, "pid");
    try {
      const result = await runChildProcess(
        runId,
        "bash",
        ["-c", `setsid sh -c 'exec sleep 300' </dev/null >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidFile)}; exec sleep 300`],
        {
          cwd: dir,
          env: { [RUN_ID_ENV_MARKER]: runId },
          timeoutSec: 1,
          graceSec: 1,
          onLog: async () => {},
        },
      );
      expect(result.timedOut).toBe(true);
      const pid = Number.parseInt((await fs.readFile(pidFile, "utf8")).trim(), 10);
      startedPids.add(pid);
      expect(isAlive(pid)).toBe(true);

      await terminateRunMarkedProcesses(runId, { graceMs: 2_000 });

      expect(await waitFor(() => !isAlive(pid), 2_000)).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
