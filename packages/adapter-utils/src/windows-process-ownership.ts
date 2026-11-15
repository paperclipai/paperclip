import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WINDOWS_SNAPSHOT_TIMEOUT_MS = 60_000;
const WINDOWS_CREATED_AT_TIMEOUT_MS = 15_000;
const WINDOWS_SNAPSHOT_MAX_BUFFER = 16 * 1024 * 1024;
const WINDOWS_CREATED_AT_MAX_BUFFER = 1024 * 1024;
const WINDOWS_OWNERSHIP_TOLERANCE_MS = 100;
const WINDOWS_OWNERSHIP_LOWER_SLACK_MS = 1;
const WINDOWS_TERMINATION_MAX_PASSES = 3;
const WINDOWS_TERMINATION_VERIFY_MS = 5_000;
const DOTNET_TICKS_PER_MILLISECOND = 10_000n;
const DOTNET_EPOCH_OFFSET_MS = 62_135_596_800_000n;

export interface WindowsProcessSnapshotEntry {
  pid: number;
  parentPid: number;
  createdAtMs: number | null;
}

export interface WindowsProcessSnapshot {
  entries: WindowsProcessSnapshotEntry[];
  byPid: Map<number, WindowsProcessSnapshotEntry>;
}

export type WindowsTreeRootState = "ours" | "foreign" | "gone" | "unknown";

export type WindowsOwnershipFailureReason =
  | "missing_creation_bound"
  | "missing_root_creation_time"
  | "process_snapshot_unavailable"
  | "unverified_descendants"
  | "tree_still_alive";

export interface WindowsOwnedTreeResolution {
  status: "resolved" | "already_gone" | "unproven";
  rootState: WindowsTreeRootState;
  rootCreatedAtMs: number | null;
  upperBoundMs: number | null;
  rootPidSignallable: boolean;
  killPids: number[];
  excludedPids: number[];
  unresolvedPids: number[];
  reason?: WindowsOwnershipFailureReason;
}

export type WindowsTreeTerminationStatus =
  | "terminated"
  | "already_gone"
  | "unproven"
  | "failed";

export interface WindowsTreeTerminationResult {
  status: WindowsTreeTerminationStatus;
  killedPids: number[];
  remainingPids: number[];
  reason?: WindowsOwnershipFailureReason;
}

export type WindowsCreatedAtBatchReader = (
  pids: number[],
) => Promise<Map<number, number | null>>;

export interface TerminateWindowsOwnedTreeOptions {
  rootPid: number;
  rootCreatedAtMs?: number | null;
  killRoot?: boolean;
  killRootByHandle?: () => void;
  maxPasses?: number;
  verifyMs?: number;
  toleranceMs?: number;
  isPidAlive?: (pid: number) => boolean;
  killPid?: (pid: number) => void;
  readSnapshot?: () => Promise<WindowsProcessSnapshot | null>;
  readCreatedAtMsBatch?: WindowsCreatedAtBatchReader;
}

function parseDotNetTicks(value: string): bigint | null {
  const match = /-?\d+/.exec(value.trim());
  if (!match) return null;
  try {
    return BigInt(match[0]);
  } catch {
    return null;
  }
}

function dotNetTicksToEpochMs(ticks: bigint): number {
  const whole = ticks / DOTNET_TICKS_PER_MILLISECOND - DOTNET_EPOCH_OFFSET_MS;
  const remainder = ticks % DOTNET_TICKS_PER_MILLISECOND;
  return Number(whole) + Number(remainder) / 10_000;
}

export function parseProcessCreatedAtMs(
  value: string | number | null | undefined,
): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function readWindowsProcessCreatedAtMs(
  pid: number,
  options?: { timeoutMs?: number },
): Promise<number | null> {
  const batch = await readWindowsCreatedAtMsBatch([pid], options);
  return batch.get(pid) ?? null;
}

export function parseWindowsCreatedAtBatch(
  stdout: string,
): Map<number, number | null> {
  const result = new Map<number, number | null>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf("|");
    if (separator <= 0) continue;
    const pid = Number.parseInt(line.slice(0, separator), 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const ticksText = line.slice(separator + 1).trim();
    const ticks = ticksText ? parseDotNetTicks(ticksText) : null;
    result.set(pid, ticks === null ? null : dotNetTicksToEpochMs(ticks));
  }
  return result;
}

export async function readWindowsCreatedAtMsBatch(
  pids: number[],
  options?: { timeoutMs?: number },
): Promise<Map<number, number | null>> {
  const ids = [
    ...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0)),
  ];
  const result = new Map<number, number | null>();
  if (ids.length === 0) return result;
  if (process.platform !== "win32") return result;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$ids = @(${ids.join(",")})`,
    "Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object {",
    "  $ticks = ''",
    "  try { $ticks = $_.StartTime.ToUniversalTime().Ticks } catch { }",
    "  '{0}|{1}' -f $_.Id, $ticks",
    "}",
  ].join("\n");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        timeout: options?.timeoutMs ?? WINDOWS_CREATED_AT_TIMEOUT_MS,
        maxBuffer: WINDOWS_CREATED_AT_MAX_BUFFER,
        windowsHide: true,
      },
    );
    return parseWindowsCreatedAtBatch(stdout);
  } catch {
    return result;
  }
}

const WINDOWS_PROCESS_SNAPSHOT_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "Get-CimInstance Win32_Process | ForEach-Object {",
  "  $ticks = ''",
  "  if ($_.CreationDate) { $ticks = $_.CreationDate.ToUniversalTime().Ticks }",
  "  '{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, $ticks",
  "}",
].join("\n");

export function parseWindowsProcessSnapshot(
  stdout: string,
): WindowsProcessSnapshot {
  const entries: WindowsProcessSnapshotEntry[] = [];
  const byPid = new Map<number, WindowsProcessSnapshotEntry>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split("|");
    if (parts.length < 3) continue;
    const pid = Number.parseInt(parts[0] ?? "", 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const parentPid = Number.parseInt(parts[1] ?? "", 10);
    const ticksText = (parts[2] ?? "").trim();
    let createdAtMs: number | null = null;
    if (ticksText) {
      const ticks = parseDotNetTicks(ticksText);
      if (ticks !== null) createdAtMs = dotNetTicksToEpochMs(ticks);
    }
    const entry: WindowsProcessSnapshotEntry = {
      pid,
      parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : 0,
      createdAtMs,
    };
    entries.push(entry);
    byPid.set(pid, entry);
  }
  return { entries, byPid };
}

export async function readWindowsProcessSnapshot(): Promise<WindowsProcessSnapshot | null> {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_SNAPSHOT_SCRIPT],
      {
        timeout: WINDOWS_SNAPSHOT_TIMEOUT_MS,
        maxBuffer: WINDOWS_SNAPSHOT_MAX_BUFFER,
        windowsHide: true,
      },
    );
    return parseWindowsProcessSnapshot(stdout);
  } catch {
    return null;
  }
}

export function resolveWindowsOwnedTree(input: {
  rootPid: number;
  rootCreatedAtMs?: number | null;
  killRoot?: boolean;
  snapshot: WindowsProcessSnapshot;
  toleranceMs?: number;
}): WindowsOwnedTreeResolution {
  const toleranceMs = input.toleranceMs ?? WINDOWS_OWNERSHIP_TOLERANCE_MS;
  const rootPid = input.rootPid;
  const recordedBound = parseProcessCreatedAtMs(input.rootCreatedAtMs ?? null);
  const rootEntry = input.snapshot.byPid.get(rootPid) ?? null;
  const rootEntryCreatedAt = rootEntry?.createdAtMs ?? null;

  let rootState: WindowsTreeRootState;
  let bound: number;
  let upperBound: number | null = null;
  let rootPidSignallable = false;

  if (rootEntry) {
    if (recordedBound === null) {
      return {
        status: "unproven",
        rootState: "unknown",
        rootCreatedAtMs: null,
        upperBoundMs: null,
        rootPidSignallable: false,
        killPids: [],
        excludedPids: [],
        unresolvedPids: [],
        reason: "missing_creation_bound",
      };
    } else if (rootEntryCreatedAt === null) {
      return {
        status: "unproven",
        rootState: "unknown",
        rootCreatedAtMs: null,
        upperBoundMs: null,
        rootPidSignallable: false,
        killPids: [],
        excludedPids: [],
        unresolvedPids: [],
        reason: "missing_root_creation_time",
      };
    } else if (Math.abs(rootEntryCreatedAt - recordedBound) <= toleranceMs) {
      bound = rootEntryCreatedAt;
      rootState = "ours";
      rootPidSignallable = true;
    } else {
      bound = recordedBound;
      upperBound = rootEntryCreatedAt;
      rootState = "foreign";
    }
  } else if (recordedBound === null) {
    const referencing = input.snapshot.entries.filter(
      (entry) => entry.parentPid === rootPid,
    );
    if (referencing.length === 0) {
      return {
        status: "already_gone",
        rootState: "gone",
        rootCreatedAtMs: null,
        upperBoundMs: null,
        rootPidSignallable: false,
        killPids: [],
        excludedPids: [],
        unresolvedPids: [],
      };
    }
    return {
      status: "unproven",
      rootState: "unknown",
      rootCreatedAtMs: null,
      upperBoundMs: null,
      rootPidSignallable: false,
      killPids: [],
      excludedPids: referencing.map((entry) => entry.pid),
      unresolvedPids: [],
      reason: "missing_creation_bound",
    };
  } else {
    bound = recordedBound;
    rootState = "gone";
  }

  const childrenByParent = new Map<number, number[]>();
  for (const entry of input.snapshot.entries) {
    const siblings = childrenByParent.get(entry.parentPid);
    if (siblings) siblings.push(entry.pid);
    else childrenByParent.set(entry.parentPid, [entry.pid]);
  }

  const ownedDepths = new Map<number, number>();
  const excludedPids: number[] = [];
  const unresolvedPids: number[] = [];
  const visited = new Set<number>([rootPid]);
  const queue: Array<{ pid: number; depth: number }> = [
    { pid: rootPid, depth: 0 },
  ];

  while (queue.length > 0) {
    const current = queue.shift() as { pid: number; depth: number };
    for (const childPid of childrenByParent.get(current.pid) ?? []) {
      if (visited.has(childPid)) continue;
      visited.add(childPid);
      const child = input.snapshot.byPid.get(childPid);
      if (!child) continue;
      if (child.createdAtMs === null) {
        unresolvedPids.push(childPid);
        continue;
      }
      const withinLowerBound =
        child.createdAtMs > bound - WINDOWS_OWNERSHIP_LOWER_SLACK_MS;
      const withinUpperBound =
        upperBound === null || child.createdAtMs < upperBound;
      if (!withinLowerBound || !withinUpperBound) {
        excludedPids.push(childPid);
        continue;
      }
      ownedDepths.set(childPid, current.depth + 1);
      queue.push({ pid: childPid, depth: current.depth + 1 });
    }
  }

  const killPids = [...ownedDepths.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([pid]) => pid);
  if (input.killRoot !== false && rootState === "ours") killPids.push(rootPid);

  return {
    status: "resolved",
    rootState,
    rootCreatedAtMs: bound,
    upperBoundMs: upperBound,
    rootPidSignallable,
    killPids,
    excludedPids,
    unresolvedPids,
  };
}

export function defaultWindowsIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

export function defaultWindowsKillPid(pid: number): void {
  process.kill(pid, "SIGKILL");
}

export async function terminateWindowsOwnedTree(
  options: TerminateWindowsOwnedTreeOptions,
): Promise<WindowsTreeTerminationResult> {
  const rootPid = options.rootPid;
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return { status: "already_gone", killedPids: [], remainingPids: [] };
  }
  const maxPasses = Math.max(
    1,
    options.maxPasses ?? WINDOWS_TERMINATION_MAX_PASSES,
  );
  const verifyMs = Math.max(
    0,
    options.verifyMs ?? WINDOWS_TERMINATION_VERIFY_MS,
  );
  const toleranceMs = options.toleranceMs ?? WINDOWS_OWNERSHIP_TOLERANCE_MS;
  const isPidAlive = options.isPidAlive ?? defaultWindowsIsPidAlive;
  const killPid = options.killPid ?? defaultWindowsKillPid;
  const readSnapshot = options.readSnapshot ?? readWindowsProcessSnapshot;
  const readCreatedAtMsBatch =
    options.readCreatedAtMsBatch ?? readWindowsCreatedAtMsBatch;
  const killRoot = options.killRoot !== false;
  const killRootByHandle = options.killRootByHandle;
  const killedPids = new Set<number>();

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const snapshot = await readSnapshot();
    if (!snapshot) {
      return {
        status: "failed",
        killedPids: [...killedPids],
        remainingPids: [],
        reason: "process_snapshot_unavailable",
      };
    }
    const resolution = resolveWindowsOwnedTree({
      rootPid,
      rootCreatedAtMs: options.rootCreatedAtMs ?? null,
      killRoot,
      snapshot,
      toleranceMs,
    });
    if (resolution.status === "unproven") {
      return {
        status: "unproven",
        killedPids: [...killedPids],
        remainingPids: [],
        reason: resolution.reason,
      };
    }
    if (resolution.status === "already_gone") {
      return {
        status: "already_gone",
        killedPids: [...killedPids],
        remainingPids: [],
      };
    }

    const descendants = resolution.killPids.filter((pid) => pid !== rootPid);
    const rootInKillSet = resolution.killPids.includes(rootPid);
    const handleKillsRoot = rootInKillSet && Boolean(killRootByHandle);
    const candidates = [
      ...descendants,
      ...(rootInKillSet && !handleKillsRoot ? [rootPid] : []),
    ].filter((pid) => isPidAlive(pid));

    const verified: number[] = [];
    const unverifiable: number[] = [];
    if (candidates.length > 0) {
      const probed = await readCreatedAtMsBatch(candidates);
      for (const pid of candidates) {
        const expected =
          pid === rootPid
            ? resolution.rootCreatedAtMs
            : (snapshot.byPid.get(pid)?.createdAtMs ?? null);
        const actual = probed.get(pid) ?? null;
        if (actual === null) {
          if (isPidAlive(pid)) unverifiable.push(pid);
          continue;
        }
        if (expected === null) {
          unverifiable.push(pid);
          continue;
        }
        if (Math.abs(actual - expected) > toleranceMs) continue;
        verified.push(pid);
      }
    }
    if (unverifiable.length > 0) {
      return {
        status: "failed",
        killedPids: [...killedPids],
        remainingPids: unverifiable,
        reason: "unverified_descendants",
      };
    }

    for (const pid of descendants) {
      if (!verified.includes(pid)) continue;
      try {
        killPid(pid);
        killedPids.add(pid);
      } catch {}
    }
    if (rootInKillSet && !handleKillsRoot && verified.includes(rootPid)) {
      try {
        killPid(rootPid);
        killedPids.add(rootPid);
      } catch {}
    }
    if (handleKillsRoot) {
      try {
        killRootByHandle?.();
      } catch {}
    }

    const awaited = [
      ...descendants.filter((pid) => verified.includes(pid)),
      ...(rootInKillSet && !handleKillsRoot && verified.includes(rootPid)
        ? [rootPid]
        : []),
      ...(handleKillsRoot ? [rootPid] : []),
    ];
    if (awaited.length > 0) {
      const deadline = Date.now() + verifyMs;
      while (Date.now() < deadline) {
        if (awaited.every((pid) => !isPidAlive(pid))) break;
        await delay(100);
      }
      if (awaited.some((pid) => isPidAlive(pid))) continue;
    }

    const unresolvedAlive = resolution.unresolvedPids.filter((pid) =>
      isPidAlive(pid),
    );
    if (unresolvedAlive.length > 0) {
      return {
        status: "failed",
        killedPids: [...killedPids],
        remainingPids: unresolvedAlive,
        reason: "unverified_descendants",
      };
    }
    return {
      status: "terminated",
      killedPids: [...killedPids],
      remainingPids: [],
    };
  }

  return {
    status: "failed",
    killedPids: [...killedPids],
    remainingPids: [],
    reason: "tree_still_alive",
  };
}
