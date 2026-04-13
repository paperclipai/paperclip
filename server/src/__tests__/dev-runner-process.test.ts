import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createManagedChildSpawnOptions,
  signalChildProcessTree,
} from "../dev-runner-process.js";
import { isPidAlive } from "../services/local-service-supervisor.js";

const spawned: Array<{ pid: number; kill: (signal?: NodeJS.Signals | number) => boolean }> = [];

async function readFirstStdoutLine(child: ReturnType<typeof spawn>) {
  let buffer = "";
  for await (const chunk of child.stdout ?? []) {
    buffer += chunk.toString();
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex >= 0) {
      return buffer.slice(0, newlineIndex).trim();
    }
  }
  throw new Error("child exited before emitting a pid line");
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await delay(50);
  }
  throw new Error(`process ${pid} did not exit within ${timeoutMs}ms`);
}

afterEach(async () => {
  for (const child of spawned.splice(0)) {
    if (isPidAlive(child.pid)) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore cleanup races
        }
      }
    }
  }
});

describe("dev runner process management", () => {
  it("detaches managed child processes on non-Windows platforms", () => {
    expect(createManagedChildSpawnOptions("darwin")).toEqual({ detached: true });
    expect(createManagedChildSpawnOptions("linux")).toEqual({ detached: true });
    expect(createManagedChildSpawnOptions("win32")).toEqual({ detached: false });
  });

  it("signals the entire detached child process tree", async () => {
    if (process.platform === "win32") return;

    const wrapper = spawn(
      process.execPath,
      [
        "-e",
        `
          const { spawn } = require("node:child_process");
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdio: ["ignore", "ignore", "ignore"],
          });
          process.stdout.write(String(child.pid) + "\\n");
          setInterval(() => {}, 1000);
        `,
      ],
      {
        stdio: ["ignore", "pipe", "inherit"],
        ...createManagedChildSpawnOptions(process.platform),
      },
    );
    spawned.push(wrapper);

    const grandchildPid = Number.parseInt(await readFirstStdoutLine(wrapper), 10);
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(isPidAlive(wrapper.pid!)).toBe(true);
    expect(isPidAlive(grandchildPid)).toBe(true);

    signalChildProcessTree(wrapper, "SIGTERM");

    await once(wrapper, "exit");
    await waitForProcessExit(grandchildPid);
  });
});
