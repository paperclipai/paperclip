import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";
import { materializePath, runChildProcess } from "./server-utils.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

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

describe("materializePath", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("uses directory links when the platform allows them", async () => {
    const root = await makeTempDir("adapter-materialize-link-");
    cleanupDirs.add(root);

    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "# Runtime skill\n", "utf8");

    const result = await materializePath(source, destination);

    expect(result).toMatchObject({
      source,
      destination,
      kind: process.platform === "win32" ? "junction" : "symlink",
      linkType: process.platform === "win32" ? "junction" : "dir",
      fellBack: false,
      fallbackReason: null,
    });
    expect(await fs.readFile(path.join(destination, "SKILL.md"), "utf8")).toBe("# Runtime skill\n");
  });

  it("falls back to a directory copy when link creation is denied", async () => {
    const root = await makeTempDir("adapter-materialize-dir-copy-");
    cleanupDirs.add(root);

    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await fs.mkdir(path.join(source, "nested"), { recursive: true });
    await fs.writeFile(path.join(source, "nested", "fixture.json"), "{\"ok\":true}\n", "utf8");

    const denied = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const result = await materializePath(source, destination, {
      linkPath: async () => {
        throw denied;
      },
    });

    expect(result).toMatchObject({
      kind: "copy",
      linkType: null,
      fellBack: true,
      fallbackReason: "EPERM",
    });
    expect(await fs.readFile(path.join(destination, "nested", "fixture.json"), "utf8")).toBe("{\"ok\":true}\n");
  });

  it("falls back to a hardlink for files when symlink creation is denied", async () => {
    const root = await makeTempDir("adapter-materialize-file-hardlink-");
    cleanupDirs.add(root);

    const source = path.join(root, "source.txt");
    const destination = path.join(root, "destination.txt");
    await fs.writeFile(source, "file asset\n", "utf8");

    const denied = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const result = await materializePath(source, destination, {
      linkPath: async () => {
        throw denied;
      },
    });

    expect(result).toMatchObject({
      kind: "hardlink",
      linkType: null,
      fellBack: true,
      fallbackReason: "EPERM",
    });
    expect(await fs.readFile(destination, "utf8")).toBe("file asset\n");
  });

  it("falls back to a file copy when symlink and hardlink creation are unavailable", async () => {
    const root = await makeTempDir("adapter-materialize-file-copy-");
    cleanupDirs.add(root);

    const source = path.join(root, "source.txt");
    const destination = path.join(root, "destination.txt");
    await fs.writeFile(source, "copied asset\n", "utf8");

    const denied = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const result = await materializePath(source, destination, {
      linkPath: async () => {
        throw denied;
      },
      hardlinkFile: async () => {
        throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
      },
    });

    expect(result).toMatchObject({
      kind: "copy",
      linkType: null,
      fellBack: true,
      fallbackReason: "EPERM",
    });
    expect(await fs.readFile(destination, "utf8")).toBe("copied asset\n");
  });
});

describe("runChildProcess", () => {
  it("starts extensionless Node scripts used as temp adapter commands", async () => {
    const root = await makeTempDir("adapter-temp-command-");
    const commandPath = path.join(root, "fake-adapter");
    try {
      await fs.writeFile(
        commandPath,
        [
          "#!/usr/bin/env node",
          "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin: require('node:fs').readFileSync(0, 'utf8') }));",
        ].join("\n"),
        "utf8",
      );
      await fs.chmod(commandPath, 0o755);

      const result = await runChildProcess(randomUUID(), commandPath, ["--flag", "value"], {
        cwd: process.cwd(),
        env: {},
        stdin: "prompt",
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        argv: ["--flag", "value"],
        stdin: "prompt",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

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
});
