import { spawn } from "node:child_process";
import fsSync from "node:fs";

// "No such pid" and "could not read /proc" mean opposite things — the first is
// proof the process is gone, the second is proof of nothing — but a catch-all
// that returns null reports them identically. A real EMFILE (fd exhaustion in a
// loaded worker) makes readFileSync throw for a pid that is a perfectly live
// zombie, so the distinction is kept rather than flattened.
export type ProcessStateReading =
  | { kind: "state"; state: string }
  | { kind: "gone" }
  | { kind: "unreadable"; code: string };

export function readLinuxProcessStateReading(pid: number): ProcessStateReading {
  let stat: string;
  try {
    stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    // ENOENT is the pid's /proc entry being absent, and ESRCH is the process
    // exiting mid-read. Anything else says nothing about the process.
    if (code === "ENOENT" || code === "ESRCH") return { kind: "gone" };
    return { kind: "unreadable", code: code ?? "UNKNOWN" };
  }
  const commandEnd = stat.lastIndexOf(")");
  const state = commandEnd < 0 ? undefined : stat.slice(commandEnd + 1).trim().split(/\s+/)[0];
  return state ? { kind: "state", state } : { kind: "unreadable", code: "EUNPARSABLE" };
}

export function describeProcessStateReading(reading: ProcessStateReading) {
  return reading.kind === "state"
    ? `state ${reading.state}`
    : reading.kind === "gone"
      ? "gone"
      : `unreadable(${reading.code})`;
}

export function readLinuxProcessState(pid: number) {
  const reading = readLinuxProcessStateReading(pid);
  return reading.kind === "state" ? reading.state : null;
}

// Generous because this bounds fixture setup on a contended runner, not any
// behaviour under test: the zombie appears within milliseconds of the anchor's
// exec, so the only thing this budget buys is scheduling headroom. It stays
// well inside the suite's 15s testTimeout so a genuine failure still surfaces
// as this helper's diagnostic rather than an opaque test timeout.
const ZOMBIE_SETUP_TIMEOUT_MS = 5_000;

async function waitForZombiePid(pid: number, timeoutMs = ZOMBIE_SETUP_TIMEOUT_MS) {
  const isZombie = () => readLinuxProcessState(pid) === "Z";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isZombie()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return isZombie();
}

// A killed process whose parent died with it is reparented to init, and an init
// that does not reap leaves it as a zombie. Waiting for `kill(pid, 0)` to fail
// cannot see that difference, so termination is judged from /proc: gone, or
// present but no longer runnable.
//
// An unreadable /proc entry is not evidence of either. Answering "stopped"
// there would let a termination assertion pass on a process that was never
// observed, so it keeps polling and gives up as not-stopped instead.
export async function waitForPidStopped(
  pid: number,
  timeoutMs = 2_000,
  options: { readState?: (pid: number) => ProcessStateReading } = {},
) {
  const readState = options.readState ?? readLinuxProcessStateReading;
  const stopped = () => {
    const reading = readState(pid);
    if (reading.kind === "gone") return true;
    return reading.kind === "state" && (reading.state === "Z" || reading.state === "X");
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
//
// The ordering is a handshake, not a race. A shell reaps its own background
// children, so if the short-lived child exited while the anchor was still a
// shell there would be no zombie — which is exactly how this helper failed on a
// loaded CI runner that descheduled the anchor before its `exec`.
export async function spawnZombieLeadProcessGroup(
  options: {
    waitForZombie?: (pid: number) => Promise<boolean>;
    // Delays the anchor's `exec`, which is what a contended CI runner does to it
    // for free. Only this helper's own test sets it; see the handshake below.
    anchorExecDelaySeconds?: number;
  } = {},
) {
  const waitForZombie = options.waitForZombie ?? waitForZombiePid;
  const anchorExecDelaySeconds = options.anchorExecDelaySeconds ?? 0;
  const leader = spawn(
    "/bin/sh",
    [
      "-c",
      [
        "sh -c 'exec sleep 300' &",
        "echo descendant:$!",
        // The short-lived child must not exit until the anchor has stopped
        // being a shell: a shell reaps its own background children, so a child
        // that exits first is reaped and no zombie is ever created. It waits
        // for the anchor's `exec` to land, which it sees as its parent's comm
        // turning into `sleep`, and only then exits.
        `sh -c 'while [ "$(cat /proc/$PPID/comm 2>/dev/null)" != sleep ]; do sleep 0.02; done; exit 0' &`,
        "echo zombie:$!",
        ...(anchorExecDelaySeconds > 0 ? [`sleep ${anchorExecDelaySeconds}`] : []),
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

  // Everything past the spawn can fail, and the caller only installs cleanup
  // once this resolves — so a failure here has to dispose the group itself or
  // leave a detached `sleep 300` group running for the rest of the test session.
  const processGroupId = leader.pid ?? Number.NaN;
  try {
    // The anchor's shell buffers both echoes and flushes them when it execs, so
    // a runner that is slow to schedule the exec is also slow to deliver the
    // pids. Same budget, same reason.
    const deadline = Date.now() + ZOMBIE_SETUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (Number.isInteger(readPid("descendant")) && Number.isInteger(readPid("zombie"))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const descendantPid = readPid("descendant");
    const zombiePid = readPid("zombie");
    if (!Number.isInteger(processGroupId) || !Number.isInteger(descendantPid) || !Number.isInteger(zombiePid)) {
      throw new Error(`Failed to capture zombie process group pids: ${stdout}`);
    }

    if (!(await waitForZombie(zombiePid))) {
      // Two very different faults land here: the anchor died and the zombie was
      // reparented to an init that reaped it (reading=gone), or /proc simply
      // could not be read (reading=unreadable), which says nothing about the
      // process. Report the reading and the anchor so the next occurrence names
      // its own mechanism instead of leaving it to be guessed.
      const leaderExit = leader.exitCode === null && leader.signalCode === null
        ? `running, ${describeProcessStateReading(readLinuxProcessStateReading(processGroupId))}`
        : `exited(code=${leader.exitCode}, signal=${leader.signalCode})`;
      throw new Error(
        `Expected pid ${zombiePid} to become an unreaped zombie: ` +
          `reading=${describeProcessStateReading(readLinuxProcessStateReading(zombiePid))}, ` +
          `anchor=pid ${processGroupId} ${leaderExit}, ` +
          `descendant=pid ${descendantPid} ${describeProcessStateReading(readLinuxProcessStateReading(descendantPid))}, ` +
          `stdout=${JSON.stringify(stdout)}`,
      );
    }

    return { leader, processGroupId, descendantPid, zombiePid };
  } catch (error) {
    disposeZombieLeadProcessGroup({ leader, processGroupId });
    throw error;
  }
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
  // The leader's stdout pipe is the helper's only handle on the worker's event
  // loop; drop it so a disposed group cannot keep the suite from exiting.
  group.leader.stdout?.destroy();
}
