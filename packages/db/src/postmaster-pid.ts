import { existsSync, readFileSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export type PostmasterPidInfo = {
  pid: number | null;
  port: number | null;
  status: string | null;
  isStopping: boolean;
};

export function parsePostmasterPidText(text: string): PostmasterPidInfo {
  const lines = text.split("\n");
  const pid = Number(lines[0]?.trim());
  const port = Number(lines[3]?.trim());
  const rawStatus = lines[7]?.trim() ?? "";
  const status = rawStatus.length > 0 ? rawStatus : null;
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    port: Number.isInteger(port) && port > 0 ? port : null,
    status,
    isStopping: status?.toLowerCase().startsWith("stopping") ?? false,
  };
}

export function readPostmasterPidInfo(postmasterPidFile: string): PostmasterPidInfo | null {
  if (!existsSync(postmasterPidFile)) return null;
  try {
    return parsePostmasterPidText(readFileSync(postmasterPidFile, "utf8"));
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number | null | undefined): boolean {
  if (pid == null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readPidFilePort(postmasterPidFile: string): number | null {
  return readPostmasterPidInfo(postmasterPidFile)?.port ?? null;
}

export function readRunningPostmasterPid(postmasterPidFile: string): number | null {
  const info = readPostmasterPidInfo(postmasterPidFile);
  if (!info?.pid || info.isStopping || !isPidAlive(info.pid)) return null;
  return info.pid;
}

async function waitForPidExit(pid: number, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await delay(Math.max(1, pollMs));
  }
  return !isPidAlive(pid);
}

export async function reapStoppingPostmaster(
  postmasterPidFile: string,
  opts: {
    gracePeriodMs?: number;
    pollMs?: number;
  } = {},
): Promise<{ reaped: boolean; forceKilled: boolean; pid: number | null; status: string | null }> {
  const info = readPostmasterPidInfo(postmasterPidFile);
  if (!info?.pid) {
    return { reaped: false, forceKilled: false, pid: null, status: info?.status ?? null };
  }
  if (!info.isStopping) {
    if (!isPidAlive(info.pid) && existsSync(postmasterPidFile)) {
      rmSync(postmasterPidFile, { force: true });
    }
    return { reaped: false, forceKilled: false, pid: info.pid, status: info.status };
  }
  let forceKilled = false;
  if (!(await waitForPidExit(info.pid, opts.gracePeriodMs ?? 1_500, opts.pollMs ?? 100))) {
    try {
      process.kill(info.pid, "SIGKILL");
      forceKilled = true;
    } catch {
      // Ignore already-exited or permission errors; final state check below decides the result.
    }
  }
  const reaped = await waitForPidExit(info.pid, opts.pollMs ?? 100, opts.pollMs ?? 100);
  if (reaped && existsSync(postmasterPidFile)) {
    rmSync(postmasterPidFile, { force: true });
  }
  return {
    reaped,
    forceKilled,
    pid: info.pid,
    status: info.status,
  };
}
