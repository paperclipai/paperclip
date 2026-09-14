import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { readProcessStartedAt } from "../hot-restart.js";
import { readLocalServiceProcessCwd } from "../local-service-supervisor.js";
import { RuntimeServiceFault } from "./fault.js";
import type { RuntimeServiceProvider } from "./provider.js";

const exec = promisify(execFile);
const processSchema = z.object({ pid: z.number().int().min(2), identity: z.string().min(1) }).strict();
const receiptSchema = z.object({
  version: z.literal(1), host: z.string().regex(/^[a-f0-9]{64}$/), groupId: z.number().int().min(2),
  leaderIdentity: z.string().min(1), members: z.array(processSchema).min(1).max(512),
}).strict().refine((receipt) => new Set(receipt.members.map((member) => member.pid)).size === receipt.members.length
  && receipt.members.some((member) => member.pid === receipt.groupId && member.identity === receipt.leaderIdentity));
interface ProcessRow { pid: number; parent: number; group: number; uid: number; state: string }
const ownershipFailure = () => new RuntimeServiceFault("process_ownership_unverified");
const handoffFailure = () => new RuntimeServiceFault("process_handoff_unverified");

/** Numeric process metadata only: never inspect argv or another process's environment. */
async function processTable(): Promise<Map<number, ProcessRow>> {
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,pgid=,uid=,stat="], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
  const rows = new Map<number, ProcessRow>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (match) rows.set(Number(match[1]), { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), uid: Number(match[4]), state: match[5]! });
  }
  return rows;
}
function live(row: ProcessRow) { return !row.state.startsWith("Z"); }
function descendant(rows: Map<number, ProcessRow>, pid: number, ancestor: number) {
  for (let count = 0; count < 256; count++) {
    const row = rows.get(pid);
    if (!row || row.parent <= 1 || row.parent === pid) return false;
    if (row.parent === ancestor) return true;
    pid = row.parent;
  }
  return false;
}
function inside(root: string, cwd: string) {
  const relative = path.relative(root, cwd);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function hostIdentity() {
  let boot: string;
  if (process.platform === "linux") boot = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  else if (process.platform === "darwin") {
    const { stdout } = await exec("/usr/sbin/sysctl", ["-n", "kern.boottime"], { timeout: 3000 });
    const match = /sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/.exec(stdout);
    if (!match) throw ownershipFailure();
    boot = `${match[1]}:${match[2]}`;
  } else throw new RuntimeServiceFault("registration_unavailable");
  return createHash("sha256").update(`${process.platform}:${os.hostname()}:${process.getuid?.()}:${boot}`).digest("hex");
}
async function identity(pid: number): Promise<string | null> {
  try {
    if (process.platform === "linux") {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
    }
    return await readProcessStartedAt(pid);
  } catch { return null; }
}

/** Recheck a captured member immediately before signalling, without an async
 * yield. POSIX still has a residual kernel check-to-signal race: a numeric PGID
 * cannot be atomically bound to a birth identity. This narrows that window; it
 * does not claim the stronger identity-bound signalling contract. */
function signalVerifiedGroup(receipt: z.infer<typeof receiptSchema>, signal: "SIGTERM" | "SIGKILL") {
  for (const member of receipt.members) {
    let group: number, birth: string;
    try {
      if (process.platform === "linux") {
        const stat = readFileSync(`/proc/${member.pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (fields[0] === "Z") continue;
        group = Number(fields[2]); birth = fields[19]!;
      } else {
        const stat = execFileSync("ps", ["-o", "pgid=,lstart=", "-p", String(member.pid)], { encoding: "utf8", timeout: 3000 }).trim();
        const match = /^(\d+)\s+(.+)$/.exec(stat);
        if (!match) continue;
        group = Number(match[1]); birth = new Date(match[2]!).toISOString();
      }
    } catch { continue; }
    if (group !== receipt.groupId || birth !== member.identity) continue;
    try { process.kill(-receipt.groupId, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw handoffFailure(); }
    return;
  }
  // A group that vanished during verification needs no signal. A still-live
  // group without a freshly matching captured member remains unverified.
  try { process.kill(-receipt.groupId, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; }
  throw handoffFailure();
}

export function createLocalProcessHandoff(): Required<Pick<RuntimeServiceProvider, "captureExistingProcess" | "stopExistingProcess">> {
  return {
    async captureExistingProcess(input) {
      const host = await hostIdentity();
      const rows = await processTable();
      const owner = rows.get(input.owner.pid); const source = rows.get(input.pid);
      if (!owner || !source || !live(owner) || !live(source) || input.pid === owner.pid || source.uid !== process.getuid?.() || owner.uid !== source.uid) throw ownershipFailure();
      if (await readProcessStartedAt(owner.pid).catch(() => null) !== input.owner.startedAt) throw ownershipFailure();
      const leader = rows.get(source.group);
      if (!leader || !live(leader) || source.group === owner.group || leader.uid !== owner.uid || !descendant(rows, leader.pid, owner.pid)) throw ownershipFailure();
      // The caller selects the whole original command, never one listener whose
      // siblings might be unrelated services in the same terminal group.
      if (source.pid !== leader.pid) throw ownershipFailure();
      const [cwd, root, actual, leaderCwd] = await Promise.all([
        fs.realpath(input.cwd), fs.realpath(input.workspaceRoot), readLocalServiceProcessCwd(source.pid), readLocalServiceProcessCwd(leader.pid),
      ]);
      if (!inside(root, cwd) || actual !== cwd || !leaderCwd || !inside(root, leaderCwd)) throw ownershipFailure();
      const members = [...rows.values()].filter((row) => row.group === source.group && live(row));
      if (!members.length || members.length > 512 || members.some((row) => row.uid !== owner.uid || (row.pid !== leader.pid && !descendant(rows, row.pid, leader.pid)))) throw ownershipFailure();
      const captured = await Promise.all(members.map(async (row) => ({ pid: row.pid, identity: await identity(row.pid) })));
      if (captured.some((row) => !row.identity)) throw ownershipFailure();
      const final = await processTable();
      const finalMembers = [...final.values()].filter((row) => row.group === source.group && live(row));
      if (finalMembers.length !== captured.length || finalMembers.some((row) => !members.some((old) => old.pid === row.pid && old.parent === row.parent && old.uid === row.uid))) throw ownershipFailure();
      if (await readProcessStartedAt(owner.pid).catch(() => null) !== input.owner.startedAt) throw ownershipFailure();
      const leaderIdentity = captured.find((row) => row.pid === leader.pid)!.identity!;
      if (await identity(leader.pid) !== leaderIdentity) throw ownershipFailure();
      const receipt = receiptSchema.parse({ version: 1, host, groupId: source.group, leaderIdentity, members: captured });
      const key = createHash("sha256").update(`${host}:${source.group}:${leaderIdentity}`).digest("hex");
      return { key, receipt };
    },
    async stopExistingProcess(value) {
      const parsed = receiptSchema.safeParse(value);
      if (!parsed.success) throw handoffFailure();
      const receipt = parsed.data;
      if (receipt.host !== await hostIdentity()) throw handoffFailure();
      // This durable receipt remains useful after the originating runner exits.
      // A lost termination response is retried against the same birth identities.
      async function remaining() {
        const rows = await processTable();
        for (const member of receipt.members) {
          const current = rows.get(member.pid);
          if (current && live(current) && await identity(member.pid) === member.identity && current.group !== receipt.groupId) throw handoffFailure();
        }
        const members = [...rows.values()].filter((row) => row.group === receipt.groupId && live(row));
        if (!members.length) return false;
        const sameLeader = await identity(receipt.groupId) === receipt.leaderIdentity;
        for (const member of members) {
          if (member.uid !== process.getuid?.()) throw handoffFailure();
          const currentIdentity = await identity(member.pid);
          if (currentIdentity === null) {
            // SIGTERM can finish a child between the table snapshot and this
            // identity read. Confirm its exit instead of treating disappearance
            // as PID reuse. A still-live process with unreadable identity fails.
            const current = (await processTable()).get(member.pid);
            if (!current || !live(current)) continue;
            throw handoffFailure();
          }
          const known = receipt.members.find((old) => old.pid === member.pid);
          if (known && currentIdentity === known.identity) continue;
          if (sameLeader && descendant(rows, member.pid, receipt.groupId)) continue;
          // An unrelated/reused PID or an orphan we cannot attribute is never killed.
          throw handoffFailure();
        }
        return true;
      }
      if (!await remaining()) return;
      signalVerifiedGroup(receipt, "SIGTERM");
      for (let attempt = 0; attempt < 60; attempt++) { if (!await remaining()) return; await delay(50); }
      // Recheck the group after graceful shutdown before escalating the same claim.
      if (await remaining()) {
        signalVerifiedGroup(receipt, "SIGKILL");
      }
      for (let attempt = 0; attempt < 40; attempt++) { if (!await remaining()) return; await delay(50); }
      throw handoffFailure();
    },
  };
}
