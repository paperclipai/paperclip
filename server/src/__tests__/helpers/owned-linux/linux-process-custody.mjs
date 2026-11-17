// Private fixture provider custody. Reads the real Linux kernel only; no polling,
// synthetic /proc data, host PID signal or public/product authority is added.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readlink, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const closed = (code) => Object.assign(new Error(code), { code });
const inside = (root, value) => path.isAbsolute(value) && path.resolve(root) === root && path.resolve(value) === value && (value === root || value.startsWith(root + "/"));
export async function fileDigest(file) {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest("hex");
}
export async function kernelIdentity(pid) {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid < 1) throw closed("linux_identity_required");
  const stat = await readFile(`/proc/${pid}/stat`, "utf8"), end = stat.lastIndexOf(") ");
  if (end < 0) throw closed("kernel_stat_invalid");
  const fields = stat.slice(end + 2).trim().split(/\s+/), ticks = fields[19];
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (!/^[-a-f0-9]+$/.test(bootId) || !/^\d+$/.test(ticks ?? "")) throw closed("kernel_start_invalid");
  return { pid, ppid: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]),
    ticks, bootId, fingerprint: `linux:${bootId}:${ticks}`, pidNamespace: await readlink("/proc/self/ns/pid"),
    executable: await readlink(`/proc/${pid}/exe`), argv: (await readFile(`/proc/${pid}/cmdline`)).toString().split("\0").filter(Boolean) };
}
export function launchFromActualCommand(resource, command) {
  const args = command.args ?? [];
  if (command.command !== "sh" || args[2] !== "paperclip-runner-launch") return null;
  const marker = args[3], nonce = args[4], runnerId = args[5], binary = args[8];
  if (!inside(resource.root, marker) || path.basename(marker) !== "runner-process.identity" || !nonce || !runnerId
      || binary !== path.join(resource.root, ".paperclip-runtime/paperclip-runner/bin/paperclip-runnerd")) throw closed("foreign_launch_descriptor");
  const stateRoot = path.dirname(marker), index = args.indexOf("--state-dir", 9);
  if (index < 0 || args[index + 1] !== stateRoot || !stateRoot.startsWith(path.join(resource.root, ".paperclip-runtime/paperclip-runner/sessions/"))) throw closed("foreign_runner_state_root");
  // Record this before executing the ORIGINAL command. A lost launch response is
  // UNKNOWN, never an inference that no detached process exists.
  return { marker, nonce, runnerId, binary, stateRoot, runId: resource.runId, companyId: resource.companyId, environmentId: resource.environmentId,
    providerLeaseId: resource.id, containerId: resource.containerId, status: "dispatch_recorded" };
}
export async function readActualRunnerProof(resource, launch) {
  if (!launch || launch.containerId !== resource.containerId || launch.providerLeaseId !== resource.id) throw closed("launch_custody_missing");
  const stat = await lstat(launch.marker);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid() || await realpath(launch.marker) !== launch.marker) throw closed("marker_owner_unknown");
  const rawMarker = await readFile(launch.marker, "utf8");
  const [nonce, rawPid, startedAt, runnerId, fingerprint, ...extra] = rawMarker.trim().split("\n");
  if (extra.length || nonce !== launch.nonce || runnerId !== launch.runnerId || !startedAt || Number.isNaN(Date.parse(startedAt)) || !/^linux:[-a-f0-9]+:\d+$/.test(fingerprint ?? "")) throw closed("marker_identity_mismatch");
  const kernel = await kernelIdentity(Number(rawPid));
  const arg = (flag) => { const index = kernel.argv.indexOf(flag); return index < 0 ? undefined : kernel.argv[index + 1]; };
  if (kernel.fingerprint !== fingerprint || arg("--runner-id") !== runnerId || arg("--state-dir") !== launch.stateRoot
      || kernel.executable !== launch.binary || await fileDigest(`/proc/${kernel.pid}/exe`) !== resource.expectedRunnerSHA256) throw closed("live_runner_identity_mismatch");
  const { argv: _privateArgv, ...safeKernel } = kernel;
  return { rawMarker, startedAt, kernel: safeKernel, marker: launch.marker, stateRoot: launch.stateRoot, nonce, runnerId,
    providerLeaseId: resource.id, companyId: resource.companyId, environmentId: resource.environmentId, runId: resource.runId, containerId: resource.containerId };
}
export async function proveListener(proof, port) {
  const current = await kernelIdentity(proof.kernel.pid);
  if (current.pidNamespace !== proof.kernel.pidNamespace || current.fingerprint !== proof.kernel.fingerprint || current.group !== proof.kernel.group) throw closed("ingress_process_replaced");
  const fds = await readdir(`/proc/${current.pid}/fd`); if (fds.length > 4096) throw closed("ingress_fd_inventory_overflow");
  const inodes = new Set();
  for (const fd of fds) { try { const target = await readlink(`/proc/${current.pid}/fd/${fd}`), match = /^socket:\[(\d+)\]$/.exec(target); if (match) inodes.add(match[1]); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  for (const table of ["tcp", "tcp6"]) {
    const rows = (await readFile(`/proc/${current.pid}/net/${table}`, "utf8")).trim().split("\n").slice(1);
    for (const row of rows) { const fields = row.trim().split(/\s+/), address = fields[1]?.split(":");
      if (fields[3] === "0A" && Number.parseInt(address?.[1] ?? "", 16) === port && inodes.has(fields[9])) return;
    }
  }
  throw closed("owned_runner_listener_not_proven");
}
export async function groupMembers(group) {
  const entries = (await readdir("/proc")).filter(value => /^\d+$/.test(value));
  if (entries.length > 256) throw closed("owned_pid_inventory_overflow");
  const members = [];
  for (const entry of entries) {
    try {
      // Stat-only inventory retains zombies too: exe/cmdline may disappear
      // before wait/reaping. A missing exe is never group-absence proof.
      const stat = await readFile(`/proc/${entry}/stat`, "utf8"), end = stat.lastIndexOf(") ");
      if (end < 0) throw closed("kernel_stat_invalid");
      const fields = stat.slice(end + 2).trim().split(/\s+/);
      if (Number(fields[2]) === group) members.push({ pid: Number(entry), group, state: fields[0], ticks: fields[19] });
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  return members;
}
export async function proveRetirement(resource, ledger) {
  if (!ledger.launches.length || ledger.launches.some(launch => !launch.verified)) throw closed("native_launch_unknown_retained");
  if (ledger.commands.some(command => !command.joined || !Number.isSafeInteger(command.pid) || command.group !== command.pid)) throw closed("command_join_unknown_retained");
  for (const launch of ledger.launches) {
    try { await readFile(`/proc/${launch.verified.kernel.pid}/stat`, "utf8"); throw closed("runner_live_zombie_or_reused_retained"); }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  for (const group of new Set([...ledger.commands.map(command => command.group), ...ledger.launches.map(launch => launch.verified.kernel.group)])) {
    if ((await groupMembers(group)).length) throw closed("owned_group_still_present_retained");
  }
  if (ledger.usedIngressSockets !== 0) throw closed("ingress_close_not_joined_retained");
  return { providerLeaseId: resource.id, state: "stopped", containerId: resource.containerId,
    companyId: resource.companyId, environmentId: resource.environmentId, runId: resource.runId, pidNamespace: await readlink("/proc/self/ns/pid") };
}
