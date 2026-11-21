import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import { execute } from "./execute.js";
import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";

const { runProcessMock } = vi.hoisted(() => {
  return { runProcessMock: vi.fn() };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    startAdapterExecutionTargetPaperclipBridge: async () => null,
    runAdapterExecutionTargetProcess: (...args: unknown[]) => runProcessMock(...args),
  };
});

vi.mock("./remote-command.js", async () => {
  const actual = await vi.importActual<typeof import("./remote-command.js")>("./remote-command.js");
  return {
    ...actual,
    prepareCursorSandboxCommand: async (input: Parameters<typeof actual.prepareCursorSandboxCommand>[0]) => ({
      command: input.command,
      env: input.env,
      remoteSystemHomeDir: null,
      addedPathEntry: null,
      preferredCommandPath: null,
    }),
  };
});

function processResult(overrides: Partial<RunProcessResult>): RunProcessResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: "2026-11-21T00:00:00.000Z",
    ...overrides,
  };
}

const unknownSessionError = '{"type":"error","message":"Unknown session"}\n';
const transcriptWithTriggerPhrase =
  '{"type":"user","message":{"content":[{"type":"text","text":"If the session is not found, start over."}]}}\n';

async function runExecute(options: {
  signal?: AbortSignal;
  results: RunProcessResult[];
}): Promise<{ result: Awaited<ReturnType<typeof execute>>; logs: string[] }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-cancel-retry-"));
  const workspace = path.join(root, "workspace");
  const commandPath = path.join(root, "agent.sh");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(commandPath, "#!/bin/sh\ncat >/dev/null\n", { mode: 0o755 });
  const logs: string[] = [];
  runProcessMock.mockReset();
  const queue = [...options.results];
  runProcessMock.mockImplementation(async (_runId: string, _target: unknown, _command: string, args: string[]) => {
    const next = queue.shift();
    if (!next) throw new Error("mock process runner ran out of scripted results");
    return next;
  });
  try {
    const result = await execute({
      runId: "run-cursor-cancel-retry",
      agent: { id: "agent-1", companyId: "company-1", name: "Cursor Coder", adapterType: "cursor", adapterConfig: {} },
      runtime: { sessionId: "cursor-session-old", sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: commandPath, cwd: workspace, promptTemplate: "Follow the paperclip heartbeat." },
      context: createPromptContextFixture(),
      authToken: "run-jwt-token",
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { result, logs };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("cursor cancelled-run resume retry", () => {
  it("does not retry a resumed run after the operator cancels it", async () => {
    const controller = new AbortController();
    controller.abort();
    const { result, logs } = await runExecute({
      signal: controller.signal,
      results: [processResult({ stdout: unknownSessionError })],
    });
    expect(runProcessMock).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(1);
    expect(logs.join("")).not.toContain("retrying with a fresh session");
  });

  it("does not retry a resumed run killed by a signal", async () => {
    const { result, logs } = await runExecute({
      results: [processResult({ exitCode: 137, signal: "SIGKILL", stdout: unknownSessionError })],
    });
    expect(runProcessMock).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(137);
    expect(logs.join("")).not.toContain("retrying with a fresh session");
  });

  it("does not retry when the transcript mentions a missing session", async () => {
    const { result, logs } = await runExecute({
      results: [processResult({ stdout: transcriptWithTriggerPhrase })],
    });
    expect(runProcessMock).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(1);
    expect(logs.join("")).not.toContain("retrying with a fresh session");
  });

  it("retries a genuine unknown-session error on a live run", async () => {
    const { result, logs } = await runExecute({
      results: [
        processResult({ stdout: unknownSessionError }),
        processResult({
          exitCode: 0,
          stdout:
            '{"type":"system","subtype":"init","session_id":"cursor-session-fresh-2","model":"auto"}\n' +
            '{"type":"result","subtype":"success","session_id":"cursor-session-fresh-2","result":"ok"}\n',
        }),
      ],
    });
    expect(runProcessMock).toHaveBeenCalledTimes(2);
    expect(result.exitCode).toBe(0);
    expect(logs.join("")).toContain("retrying with a fresh session");
    const retryArgs = runProcessMock.mock.calls[1]?.[3] as string[] | undefined;
    expect(retryArgs).toBeDefined();
    expect(retryArgs).not.toContain("--resume");
  });
});
