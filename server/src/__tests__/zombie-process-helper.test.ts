import fsSync from "node:fs";
import { describe, expect, it } from "vitest";
import { spawnZombieLeadProcessGroup, waitForPidStopped } from "./helpers/zombie-process.js";

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
});
