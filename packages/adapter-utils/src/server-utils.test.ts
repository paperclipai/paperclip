import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

async function withPatchedPlatform<T>(
  platform: NodeJS.Platform,
  run: () => Promise<T>,
): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  try {
    return await run();
  } finally {
    if (original) {
      Object.defineProperty(process, "platform", original);
    }
  }
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
    expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);

    expect(await waitForPidExit(descendantPid!, 2_000)).toBe(true);
  });

  it("bypasses cmd.exe for thin node wrapper .cmd files on Windows", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "paperclip-adapter-utils-"));
    const scriptPath = path.join(tempDir, "bridge.js");
    const wrapperPath = path.join(tempDir, "bridge.cmd");
    const args = ["literal()", "pipe|value", "ampersand&value"];

    try {
      await writeFile(
        scriptPath,
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
        "utf8",
      );
      await writeFile(
        wrapperPath,
        `@echo off\r\nnode "${scriptPath}" %*\r\n`,
        "utf8",
      );

      const result = await withPatchedPlatform("win32", () =>
        runChildProcess(randomUUID(), wrapperPath, args, {
          cwd: tempDir,
          env: {},
          timeoutSec: 5,
          graceSec: 1,
          onLog: async () => {},
          onSpawn: async () => {},
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(args);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it.skipIf(process.platform === "win32")("does not treat complex .cmd files as thin node wrappers", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "paperclip-adapter-utils-"));
    const scriptPath = path.join(tempDir, "bridge.js");
    const wrapperPath = path.join(tempDir, "bridge.cmd");

    try {
      await writeFile(
        scriptPath,
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
        "utf8",
      );
      await writeFile(
        wrapperPath,
        `@echo off\r\nif "%1"=="ci" (\r\n  node "${scriptPath}" %*\r\n) else (\r\n  node "${scriptPath}" %*\r\n)\r\n`,
        "utf8",
      );

      await expect(
        withPatchedPlatform("win32", () =>
          runChildProcess(randomUUID(), wrapperPath, ["ci"], {
            cwd: tempDir,
            env: {},
            timeoutSec: 5,
            graceSec: 1,
            onLog: async () => {},
            onSpawn: async () => {},
          }),
        ),
      ).rejects.toThrow(/Failed to start command/);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
