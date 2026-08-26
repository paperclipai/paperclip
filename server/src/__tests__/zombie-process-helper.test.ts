import fsSync from "node:fs";
import { describe, expect, it } from "vitest";
import {
  disposeZombieLeadProcessGroup,
  readLinuxProcessStateReading,
  spawnZombieLeadProcessGroup,
  waitForPidStopped,
} from "./helpers/zombie-process.js";

// /proc/<pid>/stat after the command field is `state ppid pgrp …`, and every
// member of the detached group shares the leader's pid as its group id.
function readLinuxProcessGroupId(pid: number) {
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return Number.NaN;
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    return Number.parseInt(fields[2] ?? "", 10);
  } catch {
    return Number.NaN;
  }
}

const describeLinux = process.platform === "linux" ? describe : describe.skip;

describeLinux("spawnZombieLeadProcessGroup", () => {
  // Setup runs after the detached group is already running, so a failure there
  // has to take the group down with it: the caller never receives the handle
  // that disposeZombieLeadProcessGroup needs, and a leaked `sleep 300` leader
  // would outlive the suite.
  it("kills the group it started when setup fails after the spawn", async () => {
    let processGroupId = Number.NaN;

    await expect(
      spawnZombieLeadProcessGroup({
        // Stands in for a host that reaped the short-lived child before this
        // helper could observe the zombie state.
        waitForZombie: async (pid) => {
          processGroupId = readLinuxProcessGroupId(pid);
          return false;
        },
      }),
    ).rejects.toThrow(/unreaped zombie/);

    expect(processGroupId).toBeGreaterThan(0);
    // The leader's pid is the group id, so this is the group's own liveness.
    await expect(waitForPidStopped(processGroupId)).resolves.toBe(true);
  });

  // A CI failure reported only `got state null`, which is what this helper
  // prints both for a pid that is genuinely gone and for a /proc entry it could
  // not read. The two have opposite meanings, so the message has to say which
  // one happened, and against which anchor.
  it("reports the last /proc reading and the anchor's fate when the zombie never appears", async () => {
    let message = "";
    await spawnZombieLeadProcessGroup({ waitForZombie: async () => false }).catch((error: unknown) => {
      message = error instanceof Error ? error.message : String(error);
    });

    expect(message).toMatch(/unreaped zombie/);
    // The reading is named, not flattened to null.
    expect(message).toMatch(/reading=(?:state |gone|unreadable)/);
    // And the parent the zombie is anchored to is reported, because a dead
    // anchor is the one mechanism that makes a real zombie disappear.
    expect(message).toMatch(/anchor=/);
  });

  // The zombie only survives because its parent never calls wait(), and the
  // parent stops being able to wait() at the moment it `exec`s into `sleep`.
  // If the short-lived child exits while the parent is still a shell, the shell
  // reaps it and there is no zombie at all — verified directly: the pre-fix
  // shape under a delayed `exec` leaves /proc/<pid> at ENOENT.
  //
  // A loaded CI runner delays that `exec` for free, which is how this helper
  // failed there while winning the race hundreds of times locally. The fixture
  // must not depend on winning it.
  it("still produces a zombie when the anchor is slow to exec", async () => {
    const zombie = await spawnZombieLeadProcessGroup({ anchorExecDelaySeconds: 1 });
    try {
      expect(readLinuxProcessStateReading(zombie.zombiePid)).toEqual({ kind: "state", state: "Z" });
    } finally {
      disposeZombieLeadProcessGroup(zombie);
    }
  }, 20_000);
});

describeLinux("readLinuxProcessStateReading", () => {
  it("separates a pid that is gone from a /proc entry that could not be read", async () => {
    const zombie = await spawnZombieLeadProcessGroup();
    try {
      expect(readLinuxProcessStateReading(zombie.zombiePid)).toEqual({ kind: "state", state: "Z" });
    } finally {
      disposeZombieLeadProcessGroup(zombie);
    }

    // pid_max is well below this, so the entry is absent rather than unreadable.
    expect(readLinuxProcessStateReading(0x7fff_fffe)).toEqual({ kind: "gone" });
  });
});

describeLinux("waitForPidStopped", () => {
  // Verified against a real EMFILE: readFileSync("/proc/<pid>/stat") throws
  // while the pid is a perfectly live zombie. Treating that as "stopped" lets a
  // termination assertion pass on a process that was never observed at all.
  it("does not report a pid as stopped when its /proc state could not be read", async () => {
    // The pid is absent for real, so a reader that ignored the unreadable
    // reading would answer "stopped" — that is the failure being pinned.
    await expect(
      waitForPidStopped(0x7fff_fffe, 100, { readState: () => ({ kind: "unreadable", code: "EMFILE" }) }),
    ).resolves.toBe(false);
  });

  it("reports a pid as stopped once its /proc entry is genuinely gone", async () => {
    await expect(waitForPidStopped(1, 100, { readState: () => ({ kind: "gone" }) })).resolves.toBe(true);
  });
});
