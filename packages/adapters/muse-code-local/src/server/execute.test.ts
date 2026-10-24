import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, runAdapterExecutionTargetProcess: vi.fn() };
});

import { execute } from "./execute.js";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";

const runProcessMock = vi.mocked(runAdapterExecutionTargetProcess);

function eventLine(payloadType: string, payload: Record<string, unknown>, sessionId: string): string {
  return JSON.stringify({ stream: { kind: "session", id: sessionId }, payload_type: payloadType, payload });
}

function successStdout(sessionId: string): string {
  return [
    eventLine("run.model.configured", { kind: "run_model_configured", provider_id: "meta", model_id: "muse-wonder-full-1.0" }, sessionId),
    eventLine("run.output.delta", { kind: "run_output_delta", text: "done" }, sessionId),
    eventLine("run.usage", { kind: "run_usage", models: [{ model: "muse-wonder-full-1.0", input_tokens: 100, cached_tokens: 40, output_tokens: 10, reasoning_tokens: 0 }] }, sessionId),
    eventLine("run.terminal.completed", { kind: "run_terminal", terminal: "completed", text: "done", reason: null }, sessionId),
  ].join("\n");
}

function procResult(stdout: string, overrides: Record<string, unknown> = {}) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
    ...overrides,
  } as never;
}

describe("Muse execute", () => {
  let homeDir: string;
  let cwd: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-muse-home-"));
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-muse-cwd-"));
    runProcessMock.mockReset();
  });

  afterEach(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  });

  function baseContext(sessionParams: Record<string, unknown> | null) {
    return {
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1", name: "Muse", adapterType: "muse_code_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams, sessionDisplayId: null, taskKey: null },
      config: { cwd, env: { HOME: homeDir } },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never;
  }

  it("runs muse exec headlessly and persists the session", async () => {
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      const sessionId = args[args.indexOf("--session-id") + 1];
      return procResult(successStdout(sessionId));
    });

    const result = await execute(baseContext(null));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("done");
    expect(result.model).toBe("muse-wonder-full-1.0");
    expect(result.usage).toEqual({ inputTokens: 60, outputTokens: 10, cachedInputTokens: 40 });
    expect(result.sessionParams).toMatchObject({ cwd });
    expect(typeof result.sessionParams?.sessionId).toBe("string");

    const [, , command, args, options] = runProcessMock.mock.calls[0] as unknown as [string, unknown, string, string[], { cwd: string; env: Record<string, string> }];
    expect(command).toBe("muse");
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args).toContain("--disable-approval");
    expect(args).toContain("--disable-request-user-input");
    expect(args).toContain("--disable-reminders");
    expect(options.cwd).toBe(cwd);
    const promptFile = args[args.indexOf("--prompt-file") + 1];
    await expect(fs.access(promptFile)).rejects.toThrow();
  });

  it("resumes a stored session for the same cwd and retries fresh when it is gone", async () => {
    runProcessMock
      .mockResolvedValueOnce(procResult("", { exitCode: 1, stderr: 'muse: session "sess-1" not found' }))
      .mockImplementationOnce(async (_runId, _target, _command, args) => {
        const sessionId = (args as string[])[(args as string[]).indexOf("--session-id") + 1];
        return procResult(successStdout(sessionId));
      });

    const result = await execute(baseContext({ sessionId: "sess-1", cwd }));

    expect(runProcessMock).toHaveBeenCalledTimes(2);
    const firstArgs = (runProcessMock.mock.calls[0] as unknown[])[3] as string[];
    expect(firstArgs[firstArgs.indexOf("--session-id") + 1]).toBe("sess-1");
    expect(result.exitCode).toBe(0);
    expect(result.sessionParams?.sessionId).not.toBe("sess-1");
  });

  it("does not resume a session saved for a different cwd", async () => {
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      const sessionId = (args as string[])[(args as string[]).indexOf("--session-id") + 1];
      return procResult(successStdout(sessionId));
    });

    await execute(baseContext({ sessionId: "sess-1", cwd: "/some/other/workspace" }));

    const args = (runProcessMock.mock.calls[0] as unknown[])[3] as string[];
    expect(args[args.indexOf("--session-id") + 1]).not.toBe("sess-1");
  });
});
