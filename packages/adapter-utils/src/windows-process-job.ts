import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WINDOWS_PROCESS_JOB_SOURCE } from "./windows-process-job-source.js";
import { resolveCommandPath, windowsCommandTarget } from "./process-command.js";

const execute = promisify(execFile);
let supervisor: Promise<string> | undefined;
type OwnedJob = {
  child?: ChildProcess;
  forceKill?: () => boolean;
  stopTimer?: NodeJS.Timeout;
  stopRequested?: boolean;
  startedAt: string;
  executable: string;
  event: string;
  settled: boolean;
  closed: boolean;
};
const ownedJobs = new Map<number, OwnedJob>();
const closingJobs = new WeakMap<ChildProcess, Promise<void>>();
const WINDOWS_PROCESS_JOB_STOP_TIMEOUT_MS = 5_000;

async function prepareSupervisor(): Promise<string> {
  supervisor ??= (async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-supervisor-"));
    const source = path.join(dir, "ProcessJob.cs");
    const executable = path.join(dir, "ProcessJob.exe");
    await fs.writeFile(source, WINDOWS_PROCESS_JOB_SOURCE);
    const windows = process.env.SystemRoot ?? "C:\\Windows";
    let compiler = path.join(windows, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    if (!(await fs.stat(compiler).catch(() => null))?.isFile()) {
      compiler = path.join(windows, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe");
    }
    await execute(compiler, ["/nologo", "/target:exe", `/out:${executable}`, source], { windowsHide: true, timeout: 30000 });
    return executable;
  })().catch(error => { supervisor = undefined; throw error; });
  return supervisor;
}

export async function prepareWindowsProcessJob(command: string, args: string[], cwd = process.cwd(), env = process.env) {
  const resolved = await resolveCommandPath(command, cwd, env);
  if (!resolved) throw new Error(`Command not found in PATH: "${command}"`);
  const target = windowsCommandTarget(resolved, args, env);
  const executable = await prepareSupervisor();
  const pipe = `\\\\.\\pipe\\paperclip-process-job-${randomUUID()}`;
  const token = randomUUID();
  const event = `Local\\paperclip-stop-${randomUUID()}`;
  let received: string | undefined;
  let finishReceipt!: () => void;
  const receiptReady = new Promise<void>(resolve => { finishReceipt = resolve; });
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    if (sockets.size >= 8) { socket.destroy(); return; }
    sockets.add(socket);
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      data += chunk;
      if (data.length > 128) socket.destroy();
    });
    socket.on("error", () => {});
    socket.on("close", () => { sockets.delete(socket); });
    socket.on("end", () => {
      if (data.startsWith(`${token}:`)) { received = data; finishReceipt(); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipe, () => { server.removeListener("error", reject); resolve(); });
  });
  server.on("error", () => { finishReceipt(); });
  server.unref();
  let pid: number | undefined;
  let owned: OwnedJob | undefined;
  let settling: Promise<void> | undefined;
  return {
    command: executable,
    args: ["run", event, pipe, "", target.command, ...target.args],
    // Only the supervisor receives this secret; it erases it before creating the provider.
    env: { ...env, PAPERCLIP_PROCESS_JOB_SECRET: token },
    attach(child: ChildProcess, startedAt: string) {
      const processPid = child.pid;
      if (!processPid) return;
      pid = processPid;
      // Retain recent closed generations for heartbeat teardown; never evict live jobs.
      if (ownedJobs.size >= 512) {
        for (const [oldPid, job] of ownedJobs) { if (job.closed) { ownedJobs.delete(oldPid); break; } }
      }
      owned = {
        child,
        forceKill: child.kill.bind(child, "SIGKILL"),
        startedAt,
        executable,
        event,
        settled: false,
        closed: false,
      };
      ownedJobs.set(pid, owned);
    },
    settle() {
      return settling ??= (async () => {
        if (owned) {
          if (owned.stopTimer) clearTimeout(owned.stopTimer);
          owned.stopTimer = undefined;
          const child = owned.child;
          let timer: NodeJS.Timeout | undefined;
          if (child?.exitCode !== null && child?.exitCode !== undefined && child.signalCode === null) {
            await Promise.race([receiptReady, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
          }
          if (timer) clearTimeout(timer);
          owned.settled = Boolean(child && child.exitCode !== null && child.signalCode === null
            && received === `${token}:${child.exitCode >>> 0}`);
          owned.closed = true;
          owned.child = undefined;
          owned.forceKill = undefined;
        }
        for (const socket of sockets) socket.destroy();
        if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      })();
    },
  };
}

export function forceWindowsProcessJobStop(child: ChildProcess): boolean {
  const job = child.pid ? ownedJobs.get(child.pid) : undefined;
  if (!job || job.child !== child || job.closed || !job.forceKill) return false;
  if (job.stopTimer) clearTimeout(job.stopTimer);
  job.stopTimer = undefined;
  job.stopRequested = true;
  return job.forceKill();
}

export function requestWindowsProcessJobStop(child: ChildProcess, signal?: NodeJS.Signals | number): boolean {
  const job = child.pid ? ownedJobs.get(child.pid) : undefined;
  if (!job || job.child !== child || job.closed) return false;
  if (signal === "SIGKILL") return forceWindowsProcessJobStop(child);
  if (job.stopRequested) return true;

  let stop: ChildProcess;
  try {
    stop = spawn(job.executable, ["stop", job.event], { windowsHide: true, stdio: "ignore", shell: false });
  } catch {
    return false;
  }

  job.stopRequested = true;
  const forceStop = () => { forceWindowsProcessJobStop(child); };
  stop.once("error", forceStop);
  stop.once("close", code => { if (code !== 0) forceStop(); });
  job.stopTimer = setTimeout(forceStop, WINDOWS_PROCESS_JOB_STOP_TIMEOUT_MS);
  job.stopTimer.unref?.();
  return true;
}

export function hasStoppedWindowsProcessJob(pid: number, startedAt: Date): boolean {
  const job = ownedJobs.get(pid);
  return Boolean(job?.settled && job.startedAt === startedAt.toISOString());
}

export async function spawnWindowsProcessJob(command: string, args: string[], options: SpawnOptions): Promise<ChildProcess> {
  const job = await prepareWindowsProcessJob(command, args, String(options.cwd ?? process.cwd()), options.env ?? process.env);
  const child = spawn(job.command, job.args, { ...options, env: job.env, shell: false, windowsHide: true });
  if (child.pid) job.attach(child, new Date().toISOString());
  const kill = child.kill.bind(child);
  child.kill = signal => {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    return requestWindowsProcessJobStop(child, signal) || kill(signal);
  };
  const closing = new Promise<void>(resolve => {
    child.once("close", () => { void job.settle().catch(() => {}).finally(resolve); });
  });
  closingJobs.set(child, closing);
  return child;
}

export function recordWindowsProcessJobIdentity(child: ChildProcess | undefined, startedAt: string): void {
  const job = child?.pid ? ownedJobs.get(child.pid) : undefined;
  if (job && job.child === child && !job.closed) job.startedAt = startedAt;
}

export function observeWindowsProcessJobIdentity(pid: number, launchedAt: string, observedAt: string): void {
  const job = ownedJobs.get(pid);
  if (job?.startedAt === launchedAt) job.startedAt = observedAt;
}

export async function settleWindowsProcessJob(child: ChildProcess | undefined): Promise<void> {
  if (child && (child.exitCode !== null || child.signalCode !== null)) await closingJobs.get(child);
}
