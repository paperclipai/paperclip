import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  filterPreparedAgentQmdEnvOverrides,
  prepareAgentQmdEnvironment,
  runChildProcess,
} from "./server-utils.js";

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

async function writeFakeQmdCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const statePath = process.env.PAPERCLIP_QMD_STATE_PATH;
const args = process.argv.slice(2);
const readState = () => {
  if (!statePath || !fs.existsSync(statePath)) {
    return { path: null, collectionName: null, addCount: 0, removeCount: 0, updateCount: 0, homes: [], sentinels: [] };
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
};
const writeState = (state) => {
  if (!statePath) return;
  fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
};

const state = readState();
state.homes = Array.isArray(state.homes) ? state.homes : [];
state.sentinels = Array.isArray(state.sentinels) ? state.sentinels : [];
state.homes.push(process.env.HOME || null);
state.sentinels.push(process.env.PAPERCLIP_QMD_TEST_SENTINEL || null);
if (args[0] === "collection" && args[1] === "show") {
  if (state.path && state.collectionName === args[2]) {
    writeState(state);
    process.stdout.write("Collection: " + args[2] + "\\n");
    process.stdout.write("  Path:     " + state.path + "\\n");
    process.exit(0);
  }
  writeState(state);
  process.exit(1);
}
if (args[0] === "collection" && args[1] === "remove") {
  state.path = null;
  state.collectionName = null;
  state.removeCount += 1;
  writeState(state);
  process.exit(0);
}
if (args[0] === "collection" && args[1] === "add") {
  const nameIndex = args.indexOf("--name");
  state.path = args[2] || null;
  state.collectionName = nameIndex >= 0 ? args[nameIndex + 1] || null : null;
  state.addCount += 1;
  writeState(state);
  process.exit(0);
}
if (args[0] === "update") {
  state.updateCount += 1;
  writeState(state);
  process.exit(0);
}
process.exit(0);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
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
});

describe("prepareAgentQmdEnvironment", () => {
  it("prefers baseEnv.HOME when resolving the shared qmd cache home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-adapter-utils-qmd-home-"));
    const agentHome = path.join(root, "agent-home");
    const sharedHome = path.join(root, "shared-home");
    const binDir = path.join(root, "bin");
    const qmdPath = path.join(binDir, "qmd");
    const qmdStatePath = path.join(root, "qmd-state.json");
    await fs.mkdir(agentHome, { recursive: true });
    await fs.mkdir(path.join(sharedHome, ".cache", "qmd", "models"), { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeQmdCommand(qmdPath);
    await fs.writeFile(
      qmdStatePath,
      JSON.stringify({ path: null, collectionName: null, addCount: 0, removeCount: 0, updateCount: 0 }),
      "utf8",
    );

    const previousStatePath = process.env.PAPERCLIP_QMD_STATE_PATH;
    process.env.PAPERCLIP_QMD_STATE_PATH = qmdStatePath;
    try {
      const prepared = await prepareAgentQmdEnvironment(agentHome, {
        baseEnv: { HOME: sharedHome },
        qmdCommand: qmdPath,
      });

      expect(prepared.cacheHome).toBe(path.join(agentHome, ".cache"));
      expect(await fs.realpath(path.join(agentHome, ".cache", "qmd", "models"))).toBe(
        await fs.realpath(path.join(sharedHome, ".cache", "qmd", "models")),
      );

      const qmdState = JSON.parse(await fs.readFile(qmdStatePath, "utf8")) as {
        homes: Array<string | null>;
      };
      expect(qmdState.homes).toEqual([sharedHome, sharedHome]);
    } finally {
      if (previousStatePath === undefined) delete process.env.PAPERCLIP_QMD_STATE_PATH;
      else process.env.PAPERCLIP_QMD_STATE_PATH = previousStatePath;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps process env available to qmd bootstrap when baseEnv is omitted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-adapter-utils-qmd-env-"));
    const agentHome = path.join(root, "agent-home");
    const binDir = path.join(root, "bin");
    const qmdPath = path.join(binDir, "qmd");
    const qmdStatePath = path.join(root, "qmd-state.json");
    await fs.mkdir(agentHome, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeQmdCommand(qmdPath);
    await fs.writeFile(
      qmdStatePath,
      JSON.stringify({ path: null, collectionName: null, addCount: 0, removeCount: 0, updateCount: 0 }),
      "utf8",
    );

    const previousStatePath = process.env.PAPERCLIP_QMD_STATE_PATH;
    const previousSentinel = process.env.PAPERCLIP_QMD_TEST_SENTINEL;
    process.env.PAPERCLIP_QMD_STATE_PATH = qmdStatePath;
    process.env.PAPERCLIP_QMD_TEST_SENTINEL = "sentinel-from-process-env";
    try {
      await prepareAgentQmdEnvironment(agentHome, {
        qmdCommand: qmdPath,
      });

      const qmdState = JSON.parse(await fs.readFile(qmdStatePath, "utf8")) as {
        sentinels: Array<string | null>;
      };
      expect(qmdState.sentinels).toEqual([
        "sentinel-from-process-env",
        "sentinel-from-process-env",
      ]);
    } finally {
      if (previousStatePath === undefined) delete process.env.PAPERCLIP_QMD_STATE_PATH;
      else process.env.PAPERCLIP_QMD_STATE_PATH = previousStatePath;
      if (previousSentinel === undefined) delete process.env.PAPERCLIP_QMD_TEST_SENTINEL;
      else process.env.PAPERCLIP_QMD_TEST_SENTINEL = previousSentinel;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("filterPreparedAgentQmdEnvOverrides", () => {
  it("preserves prepared qmd paths while leaving unrelated overrides intact", () => {
    expect(
      filterPreparedAgentQmdEnvOverrides(
        {
          HOME: "/tmp/shared-home",
          QMD_CONFIG_DIR: "/tmp/manual-config",
          XDG_CACHE_HOME: "/tmp/manual-cache",
          NODE_LLAMA_CPP_GPU: "true",
        },
        true,
      ),
    ).toEqual({
      HOME: "/tmp/shared-home",
      NODE_LLAMA_CPP_GPU: "true",
    });
  });

  it("leaves overrides untouched when no prepared qmd env exists", () => {
    expect(
      filterPreparedAgentQmdEnvOverrides(
        {
          QMD_CONFIG_DIR: "/tmp/manual-config",
          XDG_CACHE_HOME: "/tmp/manual-cache",
        },
        false,
      ),
    ).toEqual({
      QMD_CONFIG_DIR: "/tmp/manual-config",
      XDG_CACHE_HOME: "/tmp/manual-cache",
    });
  });
});
