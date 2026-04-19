import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runChildProcess } from "./server-utils.js";

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

describe("runChildProcess", () => {
  it("waits for onSpawn before sending stdin to the child", async () => {
    const spawnDelayMs = 150;
    const startedAt = Date.now();
    let onSpawnCompletedAt = 0;

    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        "let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>process.stdout.write(data));",
      ],
      {
        cwd: process.cwd(),
        env: {},
        stdin: "hello from stdin",
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
        onSpawn: async () => {
          await new Promise((resolve) => setTimeout(resolve, spawnDelayMs));
          onSpawnCompletedAt = Date.now();
        },
      },
    );
    const finishedAt = Date.now();

    expect(result.exitCode).toBe(0);
    expect(result.timedOutReason).toBeNull();
    expect(result.stdout).toBe("hello from stdin");
    expect(onSpawnCompletedAt).toBeGreaterThanOrEqual(startedAt + spawnDelayMs);
    expect(finishedAt - startedAt).toBeGreaterThanOrEqual(spawnDelayMs);
  });

  it.skipIf(process.platform === "win32")("kills descendant processes on timeout via the process group", async () => {
    let descendantPid: number | null = null;

    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
          "process.stdout.write(String(child.pid));",
          "setInterval(() => {}, 1000);",
        ].join(" "),
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 1,
        graceSec: 1,
        onLog: async () => {},
        onSpawn: async () => {},
      },
    );

    descendantPid = Number.parseInt(result.stdout.trim(), 10);
    expect(result.timedOut).toBe(true);
    expect(result.timedOutReason).toBe("wall");
    expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);

    expect(await waitForPidExit(descendantPid!, 2_000)).toBe(true);
  });

  it("does not let a slow onLog stall the child when stdout is high-volume", async () => {
    const chunkSize = 8192;
    const numChunks = 300;
    const onLogDelayMs = 12;
    let logCalls = 0;

    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        `const n=${numChunks};const sz=${chunkSize};const b=Buffer.alloc(sz,120);for(let i=0;i<n;i++)process.stdout.write(b);`,
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 10,
        graceSec: 1,
        onLog: async () => {
          logCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, onLogDelayMs));
        },
      },
    );

    expect(result.timedOut).toBe(false);
    expect(result.timedOutReason).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(logCalls).toBeGreaterThan(0);
    expect(result.stdout.length).toBe(chunkSize * numChunks);
  });

  it("idle watchdog kills a child that emits no stdout/stderr", async () => {
    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      ["-e", "setInterval(() => {}, 500);"],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 0,
        idleTimeoutSec: 1,
        graceSec: 1,
        onLog: async () => {},
      },
    );

    expect(result.timedOut).toBe(true);
    expect(result.timedOutReason).toBe("idle");
  });

  it("idle watchdog resets on child output", async () => {
    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        "let n=0; setInterval(() => { process.stdout.write('.'); n++; if (n>=12) process.exit(0); }, 250);",
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 30,
        idleTimeoutSec: 1,
        graceSec: 1,
        onLog: async () => {},
      },
    );

    expect(result.timedOut).toBe(false);
    expect(result.timedOutReason).toBeNull();
    expect(result.exitCode).toBe(0);
  });
});
