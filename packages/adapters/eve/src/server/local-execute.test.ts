import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./local-execute.js";

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "fake-eve-server.mjs",
);

const tempDirs: string[] = [];

/** Make a throwaway project dir seeded with the given relative files. */
function makeProjectDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-local-test-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort only.
    }
  }
});

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

function createContext(
  overrides: Partial<AdapterExecutionContext> = {},
): AdapterExecutionContext & {
  logs: Array<{ stream: "stdout" | "stderr"; chunk: string }>;
  spawns: Array<{ pid: number; processGroupId: number | null; startedAt: string }>;
} {
  const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
  const spawns: Array<{ pid: number; processGroupId: number | null; startedAt: string }> = [];
  const base: AdapterExecutionContext = {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Eve Local Agent",
      adapterType: "eve_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      projectDir: makeProjectDir({ "agent/instructions.md": "You are a test agent." }),
      command: process.execPath,
      commandArgs: [fixturePath],
      promptTemplate: "Do the work for {{agent.name}}",
      readyTimeoutMs: 15_000,
    },
    context: { taskId: "issue-1", wakeReason: "issue_commented" },
    onLog: async (stream, chunk) => {
      logs.push({ stream, chunk });
    },
    onMeta: async () => {},
    onSpawn: async (meta) => {
      spawns.push(meta);
    },
  };
  return { ...base, ...overrides, logs, spawns };
}

describe("eve_local execute", () => {
  it("runs a fresh session end-to-end against the fake server and stops the child", async () => {
    const ctx = createContext();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.sessionParams).toMatchObject({
      eveSessionId: "fake-sess",
      continuationToken: "fake-tok",
      eventIndex: 5,
    });
    expect(result.provider).toBe("eve");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.summary).toBe("Fake turn complete.");

    const stdoutTypes = ctx.logs
      .filter((entry) => entry.stream === "stdout")
      .map((entry) => (JSON.parse(entry.chunk) as { type: string }).type);
    expect(stdoutTypes[0]).toBe("eve.init");
    expect(stdoutTypes[stdoutTypes.length - 1]).toBe("eve.result");

    expect(ctx.spawns).toHaveLength(1);
    const pid = ctx.spawns[0]!.pid;
    const gone = await waitFor(() => processGone(pid), 5_000);
    expect(gone).toBe(true);
  }, 30_000);

  it("fails fast when projectDir is missing without spawning", async () => {
    const ctx = createContext({
      config: { command: process.execPath, commandArgs: [fixturePath] },
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("projectDir");
    expect(ctx.spawns).toHaveLength(0);
  });

  it("fails fast with a shape error for a generic Node project (only package.json) without spawning", async () => {
    const ctx = createContext({
      config: {
        projectDir: makeProjectDir({ "package.json": "{}" }),
        command: process.execPath,
        commandArgs: [fixturePath],
      },
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("does not look like an Eve project");
    expect(result.errorMessage).toContain("npx eve init");
    expect(ctx.spawns).toHaveLength(0);
  });

  it("returns a readiness-timeout error and kills a server that never becomes ready", async () => {
    const ctx = createContext({
      config: {
        // Only agent.ts — proves an agent.ts-only project passes the shape guard.
        projectDir: makeProjectDir({ "agent.ts": "export default {};" }),
        command: process.execPath,
        // Node process that runs but never listens on the port.
        commandArgs: ["-e", "setInterval(() => {}, 1000);"],
        readyTimeoutMs: 1_500,
      },
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toMatch(/did not become ready/);
    expect(ctx.spawns).toHaveLength(1);
    const pid = ctx.spawns[0]!.pid;
    const gone = await waitFor(() => processGone(pid), 15_000);
    expect(gone).toBe(true);
  }, 30_000);
});
