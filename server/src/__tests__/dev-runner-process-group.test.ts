import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  killRemainingProcessGroup,
  signalProcessGroup,
  usesProcessGroups,
  waitForProcessGroupExit,
} from "../../../scripts/dev-runner-process-group.ts";

const grandchildScript = "setInterval(() => {}, 1000);";
const parentScript = `
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" });
process.stdout.write(String(grandchild.pid) + "\\n");
process.on("SIGTERM", () => {
  if (grandchild.exitCode !== null || grandchild.signalCode !== null) process.exit(0);
  grandchild.once("exit", () => process.exit(0));
});
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

async function spawnSigtermIgnoringGroup(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);'],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  await once(child.stdout!, "data");
  return child;
}

const spawnedGroups: number[] = [];

afterEach(async () => {
  for (const pid of spawnedGroups.splice(0)) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      continue;
    }
    if (!(await waitForProcessGroupExit(pid, 5_000))) {
      await killRemainingProcessGroup(pid);
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

describe("killRemainingProcessGroup", () => {
  it("ignores missing or invalid process group ids", async () => {
    await expect(killRemainingProcessGroup(undefined)).resolves.toBe(false);
    await expect(killRemainingProcessGroup("123")).resolves.toBe(false);
    await expect(killRemainingProcessGroup(0)).resolves.toBe(false);
    await expect(killRemainingProcessGroup(123, "win32")).resolves.toBe(false);
  });

  it("returns false when the group is already gone", async () => {
    await expect(killRemainingProcessGroup(2 ** 22 - 1)).resolves.toBe(false);
  });

  it.skipIf(process.platform === "win32")("force stops a group that ignores SIGTERM", async () => {
    const child = await spawnSigtermIgnoringGroup();
    spawnedGroups.push(child.pid!);
    signalProcessGroup(child, "SIGTERM");
    await expect(waitForProcessGroupExit(child.pid, 300)).resolves.toBe(false);

    await expect(killRemainingProcessGroup(child.pid)).resolves.toBe(true);
    await expect(waitForProcessGroupExit(child.pid, 5_000)).resolves.toBe(true);
  });
});
