import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async (_runId: string, _command: string, args: string[]) => {
    if (args.includes("models")) {
      return { exitCode: 0, signal: null, timedOut: false, stdout: "openai/gpt-4.1\n", stderr: "", pid: 1, startedAt: new Date().toISOString() };
    }
    return {
      exitCode: 0, signal: null, timedOut: false,
      stdout: [
        JSON.stringify({ type: "step_start", sessionID: "s1" }),
        JSON.stringify({ type: "text", sessionID: "s1", part: { text: "done" } }),
        JSON.stringify({ type: "step_finish", sessionID: "s1", part: { cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } }),
      ].join("\n"),
      stderr: "", pid: 2, startedAt: new Date().toISOString(),
    };
  }),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "opencode"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, ensureCommandResolvable, resolveCommandForLogs, runChildProcess };
});

import { execute } from "./execute.js";

describe("opencode execute env handling (GH#7290)", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeWorkspaceDir() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-env-"));
    cleanupDirs.push(dir);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  const baseAgent = {
    id: "agent-1",
    companyId: "company-1",
    name: "Test Agent",
    adapterType: "opencode_local" as const,
    adapterConfig: {},
  };

  const baseRuntime = { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null };
  const noop = async () => {};

  it("sets OPENCODE_DISABLE_PROJECT_CONFIG=true by default when not in adapterConfig.env", async () => {
    const workspaceDir = await makeWorkspaceDir();

    await execute({
      runId: "run-default",
      agent: baseAgent,
      runtime: baseRuntime,
      config: { model: "openai/gpt-4.1" },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "local_path", workspaceId: "ws-1" } },
      onLog: noop,
      onMeta: noop,
      onSpawn: noop,
    });

    const runCall = runChildProcess.mock.calls.find((c) => Array.isArray(c[2]) && c[2].includes("run")) as
      | [string, string, string[], { env: Record<string, string> }]
      | undefined;
    expect(runCall?.[3].env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true");
  });

  it("respects adapterConfig.env.OPENCODE_DISABLE_PROJECT_CONFIG=false override", async () => {
    const workspaceDir = await makeWorkspaceDir();

    await execute({
      runId: "run-override",
      agent: baseAgent,
      runtime: baseRuntime,
      config: { model: "openai/gpt-4.1", env: { OPENCODE_DISABLE_PROJECT_CONFIG: "false" } },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "local_path", workspaceId: "ws-1" } },
      onLog: noop,
      onMeta: noop,
      onSpawn: noop,
    });

    const runCall = runChildProcess.mock.calls.find((c) => Array.isArray(c[2]) && c[2].includes("run")) as
      | [string, string, string[], { env: Record<string, string> }]
      | undefined;
    expect(runCall?.[3].env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("false");
  });
});
