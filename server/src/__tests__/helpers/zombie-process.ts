import { spawn } from "node:child_process";
import fsSync from "node:fs";

export function readLinuxProcessState(pid: number) {
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    return stat.slice(commandEnd + 1).trim().split(/\s+/)[0] ?? null;
  } catch {
    return null;
  }
}

async function waitForZombiePid(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readLinuxProcessState(pid) === "Z") return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return readLinuxProcessState(pid) === "Z";
}

// A killed process whose parent died with it is reparented to init, and an init
// that does not reap leaves it as a zombie. Waiting for `kill(pid, 0)` to fail
// cannot see that difference, so termination is judged from /proc: gone, or
// present but no longer runnable.
export async function waitForPidStopped(pid: number, timeoutMs = 2_000) {
  const stopped = () => {
    const state = readLinuxProcessState(pid);
    return state === null || state === "Z" || state === "X";
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stopped()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return stopped();
}

export type ZombieLeadProcessGroup = Awaited<ReturnType<typeof spawnZombieLeadProcessGroup>>;

// Reproduces the shape a server restart leaves behind: a recorded pid that has
// exited but that nobody has reaped, so `kill(pid, 0)` still succeeds while the
// process can no longer run.
//
// The zombie is anchored to a parent this helper controls rather than to init:
// the detached shell (a process-group leader thanks to `detached: true`) forks a
// long-lived member and a short-lived one, then `exec`s into `sleep`. `exec`
// keeps the pid, so the short-lived child's parent is now a `sleep` that never
// calls wait(). The zombie therefore survives for the life of the group on any
// host, whatever its init does with adopted orphans.
export async function spawnZombieLeadProcessGroup() {
  const leader = spawn(
    "/bin/sh",
    [
      "-c",
      [
        "sh -c 'exec sleep 300' &",
        "echo descendant:$!",
        "sh -c 'exit 0' &",
        "echo zombie:$!",
        "exec sleep 300",
      ].join("\n"),
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );

  let stdout = "";
  leader.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });

  const readPid = (label: string) => {
    const match = stdout.match(new RegExp(`${label}:(\\d+)`));
    return match ? Number.parseInt(match[1] ?? "", 10) : Number.NaN;
  };

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (Number.isInteger(readPid("descendant")) && Number.isInteger(readPid("zombie"))) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const processGroupId = leader.pid ?? Number.NaN;
  const descendantPid = readPid("descendant");
  const zombiePid = readPid("zombie");
  if (!Number.isInteger(processGroupId) || !Number.isInteger(descendantPid) || !Number.isInteger(zombiePid)) {
    throw new Error(`Failed to capture zombie process group pids: ${stdout}`);
  }

  if (!(await waitForZombiePid(zombiePid))) {
    throw new Error(
      `Expected pid ${zombiePid} to become an unreaped zombie, got state ${readLinuxProcessState(zombiePid)}`,
    );
  }

  return { leader, processGroupId, descendantPid, zombiePid };
}

// Killing the leader would reap the zombie by orphaning it, so the whole group
// goes at once and every test that borrowed a zombie pid cleans up the same way.
//
// The group is signalled only while the leader is still running. Its pid is also
// the group id, so once it exits that number can be recycled and `kill(-pgid)`
// would reach an unrelated group.
export function disposeZombieLeadProcessGroup(group: Pick<ZombieLeadProcessGroup, "leader" | "processGroupId">) {
  const leaderRunning = group.leader.exitCode === null && group.leader.signalCode === null;
  if (leaderRunning && Number.isInteger(group.processGroupId) && group.processGroupId > 0) {
    try {
      process.kill(-group.processGroupId, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  try {
    group.leader.kill("SIGKILL");
  } catch {
    // Already gone.
  }
}
