import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import {
  findRunMarkedProcesses,
  readBootId,
  readRunProcessTable,
  readRunProcessTableAsync,
  RUN_ID_ENV_MARKER,
  RunProcessLineage,
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

const MIN_PATH = "/usr/bin:/bin";

/**
 * Starts a marked "run CLI" that spawns a detached child through
 * `env -i`, so the child has its own session and group and no marker, the
 * way a clean-environment tool command does. The CLI prints the child PID
 * and stays alive until it is sent "exit" on stdin.
 */
async function startCliWithEnvClearedChild(runId: string, childArgs: string[] = ["sleep", "300"]) {
  const code = `const {spawn}=require('node:child_process');
const c=spawn('/usr/bin/env',['-i','PATH=${MIN_PATH}',...${JSON.stringify(childArgs)}],{detached:true,stdio:'ignore'});
c.unref();console.log(c.pid);
process.stdin.on('data',()=>process.exit(0));`;
  const cli = spawn(process.execPath, ["-e", code], {
    env: { PATH: MIN_PATH, [RUN_ID_ENV_MARKER]: runId },
    stdio: ["pipe", "pipe", "ignore"],
    detached: true,
  });
  startedPids.add(cli.pid!);
  const childPid = await new Promise<number>((resolve, reject) => {
    let text = "";
    cli.stdout!.on("data", (chunk) => {
      text += chunk;
      const pid = Number.parseInt(text, 10);
      if (text.includes("\n") && Number.isInteger(pid)) resolve(pid);
    });
    cli.once("error", reject);
    setTimeout(() => reject(new Error("cli did not report its child")), 5_000).unref();
  });
  startedPids.add(childPid);
  // Wait until env has exec'd the final image (its environment is cleared).
  await waitFor(() => {
    try {
      return !readFileSync(`/proc/${childPid}/environ`, "utf8").includes(RUN_ID_ENV_MARKER);
    } catch {
      return false;
    }
  }, 2_000);
  const exitCli = async () => {
    if (cli.exitCode !== null || cli.signalCode !== null) return;
    const exited = new Promise((resolve) => cli.once("exit", resolve));
    cli.stdin!.write("exit\n");
    await exited;
  };
  return { cli, childPid, exitCli };
}

async function writeFixtureProcess(
  procRoot: string,
  entry: { pid: number; ppid: number; pgid: number; sid: number; startTime: number; environ?: string },
) {
  const dir = path.join(procRoot, String(entry.pid));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "stat"),
    `${entry.pid} (proc) S ${entry.ppid} ${entry.pgid} ${entry.sid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${entry.startTime} 0 0`,
  );
  await fs.writeFile(path.join(dir, "environ"), entry.environ ?? "PATH=/usr/bin\0");
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

  it("stops an environment-cleared detached child that the recorded lineage saw", async () => {
    const runId = newRunId();
    const { cli, childPid, exitCli } = await startCliWithEnvClearedChild(runId);
    const lineage = new RunProcessLineage(runId);
    lineage.addRoot(cli.pid!);
    expect(lineage.sample(readRunProcessTable()).map((entry) => entry.pid)).toEqual(
      expect.arrayContaining([cli.pid, childPid]),
    );

    // The CLI exits: the child is reparented and carries no marker.
    await exitCli();
    expect(isAlive(childPid)).toBe(true);
    expect(findRunMarkedProcesses(runId)).toEqual([]);
    expect((await terminateRunMarkedProcesses(runId, { graceMs: 200 })).found).toEqual([]);
    expect(isAlive(childPid)).toBe(true);

    const result = await terminateRunMarkedProcesses(runId, { graceMs: 2_000, lineage });

    expect(result.found.map((entry) => entry.pid)).toEqual([childPid]);
    expect(result.forceKilled).toEqual([]);
    expect(result.survivors).toEqual([]);
    expect(await waitFor(() => !isAlive(childPid), 2_000)).toBe(true);
  });

  it("restores recorded lineage from a snapshot", async () => {
    const runId = newRunId();
    const { cli, childPid, exitCli } = await startCliWithEnvClearedChild(runId);
    const lineage = new RunProcessLineage(runId);
    lineage.addRoot(cli.pid!);
    lineage.sample(readRunProcessTable());
    await exitCli();
    lineage.sample(readRunProcessTable());

    const restored = RunProcessLineage.fromSnapshot(JSON.parse(JSON.stringify(lineage.toSnapshot())));
    expect(restored?.runId).toBe(runId);
    const result = await terminateRunMarkedProcesses(runId, { graceMs: 2_000, lineage: restored! });

    expect(result.found.map((entry) => entry.pid)).toEqual([childPid]);
    expect(await waitFor(() => !isAlive(childPid), 2_000)).toBe(true);
  });

  it("rejects a saved lineage from another boot", () => {
    const runId = newRunId();
    const lineage = new RunProcessLineage(runId, [{ pid: 4_000_001, startTime: "1000", leader: true }]);
    const snapshot = lineage.toSnapshot();
    expect(snapshot.bootId).toBe(readBootId());
    expect(RunProcessLineage.fromSnapshot(snapshot)?.toSnapshot().entries).toEqual(snapshot.entries);
    expect(RunProcessLineage.fromSnapshot({ ...snapshot, bootId: "another-boot" })).toBeNull();
    expect(RunProcessLineage.fromSnapshot({ ...snapshot, bootId: undefined })).toBeNull();
  });

  it("scans asynchronously so other work keeps running during a large scan", async () => {
    const procRoot = await fs.mkdtemp(path.join(os.tmpdir(), "run-descendants-proc-"));
    try {
      await fs.writeFile(path.join(procRoot, "uptime"), "50.00 0.00\n");
      const count = 1_500;
      for (let index = 0; index < count; index += 100) {
        await Promise.all(
          Array.from({ length: 100 }, (_, offset) => 4_100_000 + index + offset).map((pid) =>
            writeFixtureProcess(procRoot, { pid, ppid: 1, pgid: pid, sid: pid, startTime: 1_000 }),
          ),
        );
      }
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
      }, 1);
      const histogram = monitorEventLoopDelay({ resolution: 1 });
      histogram.enable();
      try {
        const table = await readRunProcessTableAsync({ procRoot });
        const lineage = new RunProcessLineage(newRunId());
        expect(table.entries.size).toBe(count);
        expect(await lineage.sampleAsync(table)).toEqual([]);
      } finally {
        histogram.disable();
        clearInterval(timer);
      }
      // Timers ran while the scan was in progress, and no single step held
      // the event loop for long.
      expect(ticks).toBeGreaterThan(0);
      expect(histogram.max / 1e6).toBeLessThan(250);
    } finally {
      await fs.rm(procRoot, { recursive: true, force: true });
    }
  });

  it("stops an environment-cleared child of a live run process without prior sampling", async () => {
    const runId = newRunId();
    const { cli, childPid } = await startCliWithEnvClearedChild(runId);

    const result = await terminateRunMarkedProcesses(runId, { graceMs: 2_000 });

    expect(result.found.map((entry) => entry.pid).sort()).toEqual([cli.pid, childPid].sort());
    expect(result.survivors).toEqual([]);
    expect(await waitFor(() => !isAlive(childPid) && !isAlive(cli.pid!), 2_000)).toBe(true);
  });

  it("gives a cleanup child started from a SIGTERM handler the first signal and the grace period", async () => {
    const runId = newRunId();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "run-descendants-term-"));
    const evidence = path.join(dir, "child-term");
    try {
      const childCode = `const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(evidence)},'TERM');process.exit(0)});console.log('ready');setInterval(()=>{},1000);`;
      const parentCode = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{const p=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:['ignore','pipe','ignore']});p.stdout.once('data',()=>process.exit(0));});console.log('ready');setInterval(()=>{},1000);`;
      const parent = spawn(process.execPath, ["-e", parentCode], {
        detached: true,
        env: { PATH: MIN_PATH, [RUN_ID_ENV_MARKER]: runId },
        stdio: ["ignore", "pipe", "ignore"],
      });
      startedPids.add(parent.pid!);
      await new Promise<void>((resolve) => parent.stdout!.once("data", () => resolve()));

      const startedAt = Date.now();
      const result = await terminateRunMarkedProcesses(runId, { graceMs: 2_000, pollMs: 25 });

      expect(result.found.length).toBe(2);
      expect(result.forceKilled).toEqual([]);
      expect(result.survivors).toEqual([]);
      expect(readFileSync(evidence, "utf8")).toBe("TERM");
      expect(Date.now() - startedAt).toBeLessThan(2_000 + 1_500);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the grace period bounded when late children keep appearing", async () => {
    const runId = newRunId();
    // Each process ignores SIGTERM and starts a new marked child every 50 ms.
    const code = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});setInterval(()=>{spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref()},50);console.log('ready');`;
    const parent = spawn(process.execPath, ["-e", code], {
      detached: true,
      env: { PATH: MIN_PATH, [RUN_ID_ENV_MARKER]: runId },
      stdio: ["ignore", "pipe", "ignore"],
    });
    startedPids.add(parent.pid!);
    await new Promise<void>((resolve) => parent.stdout!.once("data", () => resolve()));

    const startedAt = Date.now();
    const result = await terminateRunMarkedProcesses(runId, { graceMs: 500, pollMs: 25 });

    expect(Date.now() - startedAt).toBeLessThan(500 + 1_500);
    expect(result.forceKilled.map((entry) => entry.pid)).toContain(parent.pid);
    expect(await waitFor(() => !isAlive(parent.pid!), 2_000)).toBe(true);
  });

  describe("session and group ownership (procfs fixture)", () => {
    // Fixture PIDs far above any real PID so the ancestor walk never meets them.
    const leader = { pid: 4_000_001, ppid: 4_000_000, pgid: 4_000_001, sid: 4_000_001, startTime: 1_000 };

    async function withFixture(run: (procRoot: string) => Promise<void>) {
      const procRoot = await fs.mkdtemp(path.join(os.tmpdir(), "run-descendants-proc-"));
      try {
        await fs.writeFile(path.join(procRoot, "uptime"), "50.00 0.00\n");
        await run(procRoot);
      } finally {
        await fs.rm(procRoot, { recursive: true, force: true });
      }
    }

    it("owns an unmarked member of a dead leader's session that started before the leader was seen gone", async () => {
      await withFixture(async (procRoot) => {
        const runId = newRunId();
        await writeFixtureProcess(procRoot, { ...leader, environ: `${RUN_ID_ENV_MARKER}=${runId}\0` });
        const lineage = new RunProcessLineage(runId);
        expect(lineage.sample(readRunProcessTable({ procRoot })).map((entry) => entry.pid)).toEqual([leader.pid]);

        // The leader exits; a member it started (cleared env, reparented to
        // init) keeps its session. Another member starts after the leader
        // was seen gone (uptime 50 s = 5000 ticks).
        await fs.rm(path.join(procRoot, String(leader.pid)), { recursive: true });
        const member = { pid: 4_000_002, ppid: 1, pgid: 4_000_002, sid: leader.sid, startTime: 1_200 };
        await writeFixtureProcess(procRoot, member);
        expect(lineage.sample(readRunProcessTable({ procRoot })).map((entry) => entry.pid)).toEqual([member.pid]);

        const late = { pid: 4_000_003, ppid: 1, pgid: 4_000_003, sid: leader.sid, startTime: 6_000 };
        await writeFixtureProcess(procRoot, late);
        expect(lineage.sample(readRunProcessTable({ procRoot })).map((entry) => entry.pid)).toEqual([member.pid]);
      });
    });

    it("does not own members once the leader PID is reused by another process", async () => {
      await withFixture(async (procRoot) => {
        const runId = newRunId();
        await writeFixtureProcess(procRoot, { ...leader, environ: `${RUN_ID_ENV_MARKER}=${runId}\0` });
        const lineage = new RunProcessLineage(runId);
        lineage.sample(readRunProcessTable({ procRoot }));

        await writeFixtureProcess(procRoot, { ...leader, ppid: 1, startTime: 9_000 });
        const member = { pid: 4_000_002, ppid: 1, pgid: leader.pid, sid: leader.sid, startTime: 9_100 };
        await writeFixtureProcess(procRoot, member);
        expect(lineage.sample(readRunProcessTable({ procRoot }))).toEqual([]);
      });
    });

    it("never owns through the session or group of this process or its ancestors", async () => {
      await withFixture(async (procRoot) => {
        const runId = newRunId();
        const self = process.pid;
        // This process is (in the fixture) a marked session leader.
        await writeFixtureProcess(procRoot, {
          pid: self, ppid: 1, pgid: self, sid: self, startTime: 100, environ: `${RUN_ID_ENV_MARKER}=${runId}\0`,
        });
        await writeFixtureProcess(procRoot, { pid: 4_000_005, ppid: 1, pgid: self, sid: self, startTime: 200 });
        const lineage = new RunProcessLineage(runId, [{ pid: self, startTime: "100", leader: true }]);
        expect(lineage.sample(readRunProcessTable({ procRoot }))).toEqual([]);
      });
    });

    it("does not let an older table forget a child that a newer table recorded", async () => {
      await withFixture(async (procRoot) => {
        const runId = newRunId();
        await writeFixtureProcess(procRoot, { ...leader, environ: `${RUN_ID_ENV_MARKER}=${runId}\0` });
        const lineage = new RunProcessLineage(runId);
        const older = readRunProcessTable({ procRoot });

        // A child that cleared its environment and started its own session.
        const child = { pid: 4_000_020, ppid: leader.pid, pgid: 4_000_020, sid: 4_000_020, startTime: 1_300 };
        await writeFixtureProcess(procRoot, child);
        const newer = readRunProcessTable({ procRoot });
        expect(lineage.sample(newer).map((entry) => entry.pid).sort()).toEqual([leader.pid, child.pid]);
        // The older read finishes last (overlapping samples).
        lineage.sample(older);

        // The leader exits and the child is reparented: only the record links it to the run.
        await fs.rm(path.join(procRoot, String(leader.pid)), { recursive: true });
        await writeFixtureProcess(procRoot, { ...child, ppid: 1 });
        expect(lineage.sample(readRunProcessTable({ procRoot })).map((entry) => entry.pid)).toEqual([child.pid]);
      });
    });

    it("absorbs a saved lineage of the same run without losing what it already recorded", async () => {
      await withFixture(async (procRoot) => {
        const runId = newRunId();
        const child = { pid: 4_000_030, ppid: 1, pgid: 4_000_030, sid: 4_000_030, startTime: 1_400 };
        await writeFixtureProcess(procRoot, leader);
        await writeFixtureProcess(procRoot, child);
        const lineage = new RunProcessLineage(runId, [{ pid: leader.pid, startTime: String(leader.startTime), leader: true }]);
        lineage.absorb(new RunProcessLineage(runId, [{ pid: child.pid, startTime: String(child.startTime) }]));
        lineage.absorb(new RunProcessLineage(newRunId(), [{ pid: 4_000_031, startTime: "1500" }]));
        expect(lineage.takeChanged()).toBe(true);
        expect(lineage.toSnapshot().entries.map((entry) => entry.pid).sort()).toEqual([leader.pid, child.pid]);
        expect(lineage.sample(readRunProcessTable({ procRoot })).map((entry) => entry.pid).sort()).toEqual([leader.pid, child.pid]);
      });
    });

    it("does not own an excluded process group or a child of it", async () => {
      await withFixture(async (procRoot) => {
        const runId = newRunId();
        await writeFixtureProcess(procRoot, { ...leader, environ: `${RUN_ID_ENV_MARKER}=${runId}\0` });
        const service = { pid: 4_000_010, ppid: leader.pid, pgid: 4_000_010, sid: leader.sid, startTime: 1_100 };
        await writeFixtureProcess(procRoot, service);
        await writeFixtureProcess(procRoot, { pid: 4_000_011, ppid: service.pid, pgid: service.pid, sid: leader.sid, startTime: 1_200 });
        const lineage = new RunProcessLineage(runId);
        expect(
          lineage.sample(readRunProcessTable({ procRoot }), { excludeProcessGroupIds: [service.pgid] }).map((entry) => entry.pid),
        ).toEqual([leader.pid]);
      });
    });
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
