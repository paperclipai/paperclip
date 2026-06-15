import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mirrors execute.remote.test.ts: mock the low-level helpers in server-utils so
// the real execution-target implementations run against fakes. The local path
// flows execute() -> runAdapterExecutionTargetProcess() -> runChildProcess().
const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "gemini-session-local", model: "gemini-2.5-pro" }),
      JSON.stringify({ type: "message", role: "assistant", content: "hello" }),
      JSON.stringify({
        type: "result",
        status: "success",
        session_id: "gemini-session-local",
        stats: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 4242,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "gemini"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

import { execute } from "./execute.js";

describe("gemini local execution — prompt passed via stdin (TWB-931)", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function runLocal(promptTemplate: string) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-local-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    await execute({
      runId: "run-local-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Gemini Builder",
        adapterType: "gemini_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "gemini", env: { GEMINI_API_KEY: "test-key" }, promptTemplate },
      context: {
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[], { stdin?: string }];
    const args = call[2];
    const options = call[3];
    return { args, options };
  }

  it("pipes the prompt via stdin and never adds a --prompt argv", async () => {
    const { args, options } = await runLocal("Heartbeat instructions: do the work.");
    expect(args).not.toContain("--prompt");
    expect(options.stdin).toContain("Heartbeat instructions: do the work.");
  });

  it("keeps a >128KiB prompt out of argv so spawn never throws E2BIG", async () => {
    // A single argv entry is capped at MAX_ARG_STRLEN (128 KiB). Routing the
    // prompt through stdin is the only way a full heartbeat prompt survives.
    const huge = "x".repeat(200_000);
    const { args, options } = await runLocal(huge);
    expect(args).not.toContain("--prompt");
    // No argv entry may carry the huge prompt.
    for (const arg of args) {
      expect(arg.length).toBeLessThan(131_072);
    }
    expect((options.stdin ?? "").length).toBeGreaterThanOrEqual(200_000);
  });
});
