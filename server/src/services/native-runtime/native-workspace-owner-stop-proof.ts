import { execFile } from "node:child_process";
import os from "node:os";
import type { NativeControllerIdentity } from "./native-restart-recovery.js";
import { currentProcessProbe, proveOwnerGone, type LocalOwnerStamp, type OwnerProof, type ProcessProbe } from "../owner-proof.js";

/**
 * Same-host proof that a recorded workspace-copyback owner and every child it
 * spawned have stopped. Copyback children (tar, Git) are spawned without
 * `detached`, so they keep the controller's process group after it dies and is
 * reaped. An empty group, or a group whose only members predate the controller
 * or belong to this controller's own process tree, proves no orphan can still
 * write the workspace. Age alone never proves a stop.
 */
export type LocalWorkspaceOwner = {
  hostname: string; pid: number; processStartedAt: string;
  controllerBootId?: string; processGroupId?: number;
  /** PID space of `pid`. Absent on receipts written before it was recorded. */
  hostHash?: string;
};

/** The copyback owner receipt as a shared ownership stamp. A receipt without a
 * PID space names none: it is judged only by `proveCopybackOwnerGone`, on its
 * recorded host. The process group is left out: copyback children are proven
 * separately (`proveLocalWorkspaceOwnerStopped`). */
export function copybackOwnerStamp(owner: LocalWorkspaceOwner): LocalOwnerStamp {
  return { kind: "local", scope: "copyback_owner", generation: null, host: owner.hostname,
    processSpace: owner.hostHash ?? null, bootId: owner.controllerBootId ?? null, pid: owner.pid,
    processStartedAt: owner.processStartedAt, processGroupId: null };
}

// Only a known foreign host or PID space. An unreadable PID space here
// (`unknown_process_space`) is a local owner this server cannot judge, which
// must stay blocked rather than take the board-attestation path.
const HOST_UNPROVABLE = new Set(["different_host", "different_process_space"]);

/** Whether an unprovable verdict only says the owner ran somewhere else. */
export function copybackOwnerOnAnotherHost(proof: OwnerProof): boolean {
  return proof.verdict === "unprovable" && HOST_UNPROVABLE.has(proof.reason);
}

/**
 * Proves the recorded copyback controller gone with the shared prover. Its PID
 * is judged only in the PID space the receipt recorded. A receipt written
 * before that field is judged in this PID space only when it names this host,
 * as the previous same-host proof did. Process start time must match; EPERM
 * is alive.
 */
export async function proveCopybackOwnerGone(owner: LocalWorkspaceOwner, overrides: {
  isProcessAlive?: (pid: number) => boolean;
  readProcessStartedAt?: (pid: number) => Promise<Date | null>;
} = {}): Promise<OwnerProof> {
  const base = currentProcessProbe();
  // No platform-deployment shortcut here: the caller checks deployments first.
  const probe: ProcessProbe = { ...base, deployment: null,
    pidExists: overrides.isProcessAlive ?? base.pidExists,
    readStartedAt: overrides.readProcessStartedAt ?? base.readStartedAt };
  const stamp = copybackOwnerStamp(owner);
  // A known different hostname is decided first: an unreadable PID space
  // (here or on the stamp) must not hide that the owner ran on another host.
  if (owner.hostname !== os.hostname()) return { verdict: "unprovable", reason: "different_host" };
  if (!stamp.processSpace) {
    return proveOwnerGone({ ...stamp, host: null, processSpace: probe.processSpace }, probe);
  }
  return proveOwnerGone(stamp, probe);
}
export type LocalWorkspaceOwnerStop =
  | { status: "verified"; proof: { pid: number; processGroupId: number; reason: string; groupEvidence: "group_empty" | "no_descendant_members" } }
  | { status: "pending"; reason: "controller_live" | "group_members_live" }
  | { status: "unsupported"; reason: string };

type ProcessRow = { pid: number; ppid: number; pgid: number; startedAt: number };

let currentGroup: Promise<number | null> | undefined;
/** This controller's process group, recorded so a successor can find orphans. */
export function currentProcessGroupId(): Promise<number | null> {
  currentGroup ??= readProcessGroupId(process.pid).catch(() => null);
  return currentGroup;
}

async function readProcessGroupId(pid: number): Promise<number | null> {
  if (process.platform === "win32") return null;
  const value = Number((await run("ps", ["-o", "pgid=", "-p", String(pid)])).trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

function run(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => execFile(command, args,
    { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C", TZ: process.env.TZ } },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
}

async function listProcesses(): Promise<ProcessRow[]> {
  const rows: ProcessRow[] = [];
  for (const line of (await run("ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart="])).split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const startedAt = Date.parse(match[4]);
    // An unparseable start time cannot exclude a process from the group check.
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]),
      startedAt: Number.isFinite(startedAt) ? startedAt : Number.POSITIVE_INFINITY });
  }
  if (!rows.some(row => row.pid === process.pid)) throw new Error("process_table_incomplete");
  return rows;
}

function groupAbsent(pgid: number): boolean {
  try { process.kill(-pgid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

export async function proveLocalWorkspaceOwnerStopped(input: {
  owner: LocalWorkspaceOwner; identity: NativeControllerIdentity;
  isProcessAlive?: (pid: number) => boolean;
  readProcessStartedAt?: (pid: number) => Promise<Date | null>;
  isGroupAbsent?: (pgid: number) => boolean;
  listProcesses?: () => Promise<ProcessRow[]>;
}): Promise<LocalWorkspaceOwnerStop> {
  const { owner, identity } = input;
  if (process.platform === "win32") return { status: "unsupported", reason: "platform" };
  if (!owner.hostHash && owner.hostname !== os.hostname()) return { status: "unsupported", reason: "foreign_host" };
  const pgid = owner.processGroupId;
  if (!Number.isInteger(pgid) || pgid! <= 1) return { status: "unsupported", reason: "process_group_unrecorded" };
  // This controller's own receipts are settled by its in-memory join state.
  if (owner.controllerBootId === identity.bootId && owner.pid === identity.pid) {
    return { status: "unsupported", reason: "current_controller" };
  }
  const ownerProof = await proveCopybackOwnerGone(owner, {
    isProcessAlive: input.isProcessAlive, readProcessStartedAt: input.readProcessStartedAt });
  if (copybackOwnerOnAnotherHost(ownerProof)) return { status: "unsupported", reason: "foreign_host" };
  if (ownerProof.verdict !== "gone") return { status: "pending", reason: "controller_live" };
  const proof = { pid: owner.pid, processGroupId: pgid!,
    reason: ownerProof.reason === "pid_reused" ? "controller_pid_recycled" : "controller_process_dead" };
  if ((input.isGroupAbsent ?? groupAbsent)(pgid!)) return { status: "verified", proof: { ...proof, groupEvidence: "group_empty" } };
  let rows: ProcessRow[];
  try { rows = await (input.listProcesses ?? listProcesses)(); }
  catch { return { status: "unsupported", reason: "process_table_unavailable" }; }
  // Exclude this controller's ancestors and descendants: a supervisor that was
  // not detached shares the group but cannot be the dead controller's child.
  // Only this process's own descendants are expanded: an ancestor may be the
  // subreaper that adopted the dead controller's orphans.
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const ours = new Set<number>([process.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (!ours.has(row.pid) && ours.has(row.ppid)) { ours.add(row.pid); grew = true; }
  }
  for (let row = byPid.get(process.pid); row && row.ppid > 1 && !ours.has(row.ppid); row = byPid.get(row.ppid)) ours.add(row.ppid);
  // An orphan was necessarily started after its controller. Whole-second `ps`
  // start times are compared conservatively.
  const controllerStart = Date.parse(owner.processStartedAt) - 1_000;
  const live = rows.some(row => row.pgid === pgid && !ours.has(row.pid) && row.startedAt >= controllerStart);
  return live ? { status: "pending", reason: "group_members_live" }
    : { status: "verified", proof: { ...proof, groupEvidence: "no_descendant_members" } };
}
