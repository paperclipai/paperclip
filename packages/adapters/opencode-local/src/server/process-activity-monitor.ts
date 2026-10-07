import fs from "node:fs/promises";

export const OPENCODE_PROCESS_ACTIVITY_POLL_INTERVAL_MS = 15_000;

export interface OpenCodeProcessActivitySnapshot {
  cpuTicks: number;
  ioBytes: number;
  processIds: string;
}

export interface OpenCodeProcessActivityMonitorOptions {
  pid: number;
  processGroupId: number | null;
  onActivity: () => void;
  intervalMs?: number;
  sample?: () => Promise<OpenCodeProcessActivitySnapshot | null>;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface OpenCodeProcessActivityMonitorHandle {
  stop(): void;
}

function parseProcStat(stat: string): { processGroupId: number; cpuTicks: number } | null {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return null;
  const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
  const processGroupId = Number(fields[2]);
  const userTicks = Number(fields[11]);
  const systemTicks = Number(fields[12]);
  if (![processGroupId, userTicks, systemTicks].every(Number.isFinite)) return null;
  return { processGroupId, cpuTicks: userTicks + systemTicks };
}

function parseProcIo(io: string): number {
  let bytes = 0;
  for (const line of io.split("\n")) {
    const match = /^(?:read_bytes|write_bytes):\s+(\d+)$/.exec(line.trim());
    if (match) bytes += Number(match[1]);
  }
  return bytes;
}

export async function sampleOpenCodeProcessActivity(
  pid: number,
  processGroupId: number | null,
): Promise<OpenCodeProcessActivitySnapshot | null> {
  if (process.platform !== "linux") return null;
  const targetProcessGroupId = processGroupId && processGroupId > 0 ? processGroupId : null;
  const entries = targetProcessGroupId ? await fs.readdir("/proc") : [String(pid)];
  const processIds: number[] = [];
  let cpuTicks = 0;
  let ioBytes = 0;

  await Promise.all(
    entries.map(async (entry) => {
      if (!/^\d+$/.test(entry)) return;
      try {
        const parsed = parseProcStat(await fs.readFile(`/proc/${entry}/stat`, "utf8"));
        if (!parsed) return;
        if (targetProcessGroupId !== null && parsed.processGroupId !== targetProcessGroupId) return;
        if (targetProcessGroupId === null && Number(entry) !== pid) return;
        const io = await fs.readFile(`/proc/${entry}/io`, "utf8").catch(() => "");
        processIds.push(Number(entry));
        cpuTicks += parsed.cpuTicks;
        ioBytes += parseProcIo(io);
      } catch {
        // Processes can exit between listing /proc and reading their stat file.
      }
    }),
  );

  if (processIds.length === 0) return null;
  processIds.sort((left, right) => left - right);
  return { cpuTicks, ioBytes, processIds: processIds.join(",") };
}

export function createOpenCodeProcessActivityMonitor(
  options: OpenCodeProcessActivityMonitorOptions,
): OpenCodeProcessActivityMonitorHandle {
  const intervalMs = options.intervalMs ?? OPENCODE_PROCESS_ACTIVITY_POLL_INTERVAL_MS;
  const sample = options.sample ?? (() => sampleOpenCodeProcessActivity(options.pid, options.processGroupId));
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const minimumCpuTickDelta = Math.max(1, Math.floor(intervalMs / 1_000));
  let previous: OpenCodeProcessActivitySnapshot | null = null;
  let timer: unknown = null;
  let stopped = false;

  const schedule = () => {
    if (stopped) return;
    timer = setTimer(() => {
      void poll();
    }, intervalMs);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  };

  const poll = async () => {
    if (stopped) return;
    const current = await sample().catch(() => null);
    if (stopped) return;
    if (
      current &&
      previous &&
      (current.cpuTicks - previous.cpuTicks >= minimumCpuTickDelta ||
        current.ioBytes > previous.ioBytes ||
        current.processIds !== previous.processIds)
    ) {
      options.onActivity();
    }
    previous = current;
    schedule();
  };

  void poll();

  return {
    stop() {
      stopped = true;
      if (timer != null) {
        clearTimer(timer);
        timer = null;
      }
    },
  };
}

function parseProcStateAndGroup(stat: string): { state: string; processGroupId: number } | null {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return null;
  const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
  const state = fields[0] ?? "";
  const processGroupId = Number(fields[2]);
  if (state.length === 0 || !Number.isFinite(processGroupId)) return null;
  return { state, processGroupId };
}

/**
 * Whether any live (non-zombie) member of the process group still exists.
 *
 * A zombie holds no memory, file descriptors, or workspace access, so it
 * cannot keep writing after its death — but `kill(-pgid, 0)` keeps reporting
 * the group as existing while an unreaped zombie remains a member (orphaned
 * grandchildren are reaped by pid 1, which on some hosts never reaps). The
 * teardown wait must treat "zombies only" as torn down, or it would hold
 * every monitor-killed run until its deadline on those hosts.
 *
 * Returns false when the platform cannot scan /proc (non-Linux) or the group
 * id is unusable; callers fall back to signal-based liveness in those cases.
 */
export async function hasLiveProcessGroupMember(processGroupId: number): Promise<boolean> {
  if (process.platform !== "linux" || !(processGroupId > 0)) return false;
  let entries: string[];
  try {
    entries = await fs.readdir("/proc");
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const parsed = parseProcStateAndGroup(await fs.readFile(`/proc/${entry}/stat`, "utf8"));
      if (!parsed || parsed.processGroupId !== processGroupId) continue;
      if (parsed.state === "Z") continue;
      return true;
    } catch {
      // Processes can exit between listing /proc and reading their stat file.
    }
  }
  return false;
}
