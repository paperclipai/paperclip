import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  executeClaudeAcp,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  executeClaudeAcp: vi.fn(async () => {
    throw new Error("ACP unavailable in this test");
  }),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => executeClaudeAcp,
  formatClaudeAcpFallbackMessage: () => "[paperclip] falling back to CLI\n",
  resolveClaudeExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

function streamJson(finalText: string, sessionId = "claude-session-1") {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet-5" }),
      JSON.stringify({
        type: "assistant",
        session_id: sessionId,
        message: { content: [{ type: "text", text: finalText }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        terminal_reason: "completed",
        session_id: sessionId,
        result: finalText,
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  };
}

function buildContext(context: Record<string, unknown>) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { engine: "cli" },
    context,
    onLog: vi.fn(async () => {}),
  };
}

const ISSUE_CONTEXT = { issueId: "11111111-2222-3333-4444-555555555555" };

describe("claude_local in-run disposition re-ask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runAdapterExecutionTargetProcess.mockReset();
  });

  it("carries the disposition contract in the prompt for issue-scoped runs", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(
      streamJson('Done.\nPAPERCLIP_DISPOSITION: {"status":"done","hasBlocker":false}'),
    );
    const ctx = buildContext(ISSUE_CONTEXT) as any;
    const onMeta = vi.fn(async (_meta: { prompt: string }) => {});
    await execute({ ...ctx, onMeta });
    expect(onMeta).toHaveBeenCalled();
    expect(onMeta.mock.calls[0]?.[0]?.prompt ?? "").toContain("PAPERCLIP_DISPOSITION");
  });

  it("omits the contract when the run is not issue-scoped", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(streamJson("no issue here"));
    const onMeta = vi.fn(async (_meta: { prompt: string }) => {});
    await execute({ ...(buildContext({}) as any), onMeta });
    expect(onMeta.mock.calls[0]?.[0]?.prompt ?? "").not.toContain("PAPERCLIP_DISPOSITION");
  });

  it("asks once more in the same session when a clean run states nothing", async () => {
    runAdapterExecutionTargetProcess
      .mockResolvedValueOnce(streamJson("I updated the issue and left a comment."))
      .mockResolvedValueOnce(
        streamJson('PAPERCLIP_DISPOSITION: {"status":"in_review","hasBlocker":false}'),
      );

    const result: any = await execute(buildContext(ISSUE_CONTEXT) as any);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(2);
    const reaskArgs = runAdapterExecutionTargetProcess.mock.calls[1][3] as string[];
    expect(reaskArgs).toContain("--resume");
    expect(reaskArgs[reaskArgs.indexOf("--resume") + 1]).toBe("claude-session-1");
    expect(reaskArgs[reaskArgs.indexOf("--max-turns") + 1]).toBe("2");
    const reaskOpts = runAdapterExecutionTargetProcess.mock.calls[1][4] as { stdin: string };
    expect(reaskOpts.stdin).toContain("PAPERCLIP_DISPOSITION");
    expect(result.resultJson.disposition).toMatchObject({ status: "in_review" });
  });

  it("does not re-ask when the run already stated a disposition", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(
      streamJson('All set.\nPAPERCLIP_DISPOSITION: {"status":"done","hasBlocker":false}'),
    );
    const result: any = await execute(buildContext(ISSUE_CONTEXT) as any);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(result.resultJson.disposition).toMatchObject({ status: "done" });
  });

  it("keeps the run clean when the re-ask itself states nothing", async () => {
    runAdapterExecutionTargetProcess
      .mockResolvedValueOnce(streamJson("Left a comment."))
      .mockResolvedValueOnce(streamJson("Still nothing structured."));
    const result: any = await execute(buildContext(ISSUE_CONTEXT) as any);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(2);
    expect(result.resultJson.disposition).toBeUndefined();
    expect(result.errorMessage).toBeNull();
  });
});
