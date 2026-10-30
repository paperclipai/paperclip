import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  signalProcessGroup,
  usesProcessGroups,
  waitForProcessGroupExit,
} from "../../../scripts/dev-runner-process-group.ts";

const grandchildScript = "setInterval(() => {}, 1000);";
const parentScript = `
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" });
process.stdout.write(String(grandchild.pid) + "\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function spawnGroupWithGrandchild(): Promise<{ parent: ChildProcess; grandchildPid: number }> {
  const parent = spawn(process.execPath, ["-e", parentScript], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const [chunk] = await once(parent.stdout!, "data");
  return { parent, grandchildPid: Number(String(chunk).trim()) };
}

const spawnedGroups: number[] = [];

afterEach(() => {
  for (const pid of spawnedGroups.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      continue;
    }
  }
});

describe("usesProcessGroups", () => {
  it("is disabled on Windows only", () => {
    expect(usesProcessGroups("win32")).toBe(false);
    expect(usesProcessGroups("darwin")).toBe(true);
    expect(usesProcessGroups("linux")).toBe(true);
  });
});

describe("signalProcessGroup", () => {
  it("signals the direct child on Windows", () => {
    const kill = vi.fn();
    signalProcessGroup({ pid: 123, kill } as unknown as ChildProcess, "SIGTERM", "win32");
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("falls back to the direct child when the group is gone", () => {
    const kill = vi.fn();
    signalProcessGroup({ pid: 2 ** 22 - 1, kill } as unknown as ChildProcess, "SIGTERM", "linux");
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.skipIf(process.platform === "win32")("stops grandchildren that the direct child does not forward signals to", async () => {
    const { parent, grandchildPid } = await spawnGroupWithGrandchild();
    spawnedGroups.push(parent.pid!);
    expect(isAlive(grandchildPid)).toBe(true);

    signalProcessGroup(parent, "SIGTERM");

    await expect(waitForProcessGroupExit(parent.pid, 5_000)).resolves.toBe(true);
    expect(isAlive(grandchildPid)).toBe(false);
  });
});

describe("waitForProcessGroupExit", () => {
  it("returns immediately without a process group id", async () => {
    await expect(waitForProcessGroupExit(undefined, 1_000)).resolves.toBe(true);
  });

  it.skipIf(process.platform === "win32")("reports a timeout while the group is still running", async () => {
    const { parent } = await spawnGroupWithGrandchild();
    spawnedGroups.push(parent.pid!);

    await expect(waitForProcessGroupExit(parent.pid, 200)).resolves.toBe(false);
  });
});
