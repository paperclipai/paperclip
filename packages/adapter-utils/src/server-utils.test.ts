import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPaperclipEnv, runChildProcess } from "./server-utils.js";

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

describe("buildPaperclipEnv PAPERCLIP_API_URL resolution", () => {
  const keys = [
    "PAPERCLIP_API_URL",
    "PAPERCLIP_PUBLIC_URL",
    "PAPERCLIP_LISTEN_HOST",
    "PAPERCLIP_LISTEN_PORT",
    "HOST",
    "PORT",
  ] as const;
  const saved: Partial<Record<(typeof keys)[number], string>> = {};

  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const AGENT = { id: "a-1", companyId: "co-1" };

  it("prefers PAPERCLIP_API_URL when explicitly set", () => {
    process.env.PAPERCLIP_API_URL = "http://internal-api.example:9000";
    process.env.PAPERCLIP_PUBLIC_URL = "https://public.example";
    expect(buildPaperclipEnv(AGENT).PAPERCLIP_API_URL).toBe(
      "http://internal-api.example:9000",
    );
  });

  it("falls back to PAPERCLIP_PUBLIC_URL when PAPERCLIP_API_URL is unset", () => {
    // Setting only PAPERCLIP_PUBLIC_URL is the common operator case — an
    // externally-reachable HTTPS URL that agents + adapters should use to
    // call back to Paperclip. Previously buildPaperclipEnv ignored this
    // variable and fell through to the loopback default, which leaked
    // `http://127.0.0.1:<port>` into envelope bodies and (in paths that
    // sit behind a WAF) tripped SSRF detection rules.
    process.env.PAPERCLIP_PUBLIC_URL = "https://public.example";
    expect(buildPaperclipEnv(AGENT).PAPERCLIP_API_URL).toBe("https://public.example");
  });

  it("falls back to the runtime host:port loopback URL when neither is set", () => {
    process.env.PAPERCLIP_LISTEN_PORT = "3100";
    expect(buildPaperclipEnv(AGENT).PAPERCLIP_API_URL).toBe("http://localhost:3100");
  });

  it("ignores empty-string values and continues the fallback chain", () => {
    process.env.PAPERCLIP_API_URL = "";
    process.env.PAPERCLIP_PUBLIC_URL = "https://public.example";
    expect(buildPaperclipEnv(AGENT).PAPERCLIP_API_URL).toBe("https://public.example");
  });
});
