import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "agy"),
  runAdapterExecutionTargetProcess: vi.fn(),
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

/** An agy stream-json turn: {"event":"result","result":{...}} — the real shape. */
function agyTurn(response: string, status = "SUCCESS", conversationId = "conv-1") {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    // Real agy emits the conversation id on the `init` event (root level) and
    // the text on `result.response` — both are needed, and only the init event
    // gives the parser a session id to resume.
    stdout: [
      JSON.stringify({ event: "init", conversation_id: conversationId, init: {} }),
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: conversationId,
          status,
          response,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0 },
        },
      }),
    ].join("\n"),
    stderr: "",
    pid: 4242,
    startedAt: new Date().toISOString(),
  };
}

function ctx() {
  return {
    runId: "run-ag-1",
    agent: {
      id: "agent-1", companyId: "company-1", name: "Auditor-Gemini",
      adapterType: "antigravity_local", adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {},
    context: { issueId: "11111111-2222-4333-8444-555566667777" },
    onLog: vi.fn(async () => {}),
  } as never;
}

const MARKER = 'PAPERCLIP_DISPOSITION: {"status":"done","hasBlocker":false}';

describe("antigravity in-run disposition re-ask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runAdapterExecutionTargetProcess.mockReset();
  });

  it("asks once more in the same conversation when a clean turn states nothing", async () => {
    runAdapterExecutionTargetProcess
      .mockResolvedValueOnce(agyTurn("Wrote the note and closed the card."))
      .mockResolvedValueOnce(agyTurn(MARKER));

    const result: never = await execute(ctx());

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(2);
    const reaskArgs = runAdapterExecutionTargetProcess.mock.calls[1]?.[3] as string[];
    // Same conversation, so the model still has the work it just did in context.
    expect(reaskArgs).toContain("--conversation");
    expect(reaskArgs[reaskArgs.indexOf("--conversation") + 1]).toBe("conv-1");
    expect(reaskArgs.join(" ")).toContain("PAPERCLIP_DISPOSITION");
    expect((result as { resultJson?: { disposition?: { status?: string } } }).resultJson?.disposition)
      .toMatchObject({ status: "done" });
  });

  it("does not re-ask when the turn already stated a disposition", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(agyTurn(`All done.\n\n${MARKER}`));
    const result: never = await execute(ctx());
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect((result as { resultJson?: { disposition?: { status?: string } } }).resultJson?.disposition)
      .toMatchObject({ status: "done" });
  });

  it("does not re-ask a turn the CLI itself reported CANCELED — there is no work to report", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(agyTurn("", "CANCELED"));
    await execute(ctx());
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
  });

  it("does not re-ask an ERROR turn either", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValue(agyTurn("boom", "ERROR"));
    await execute(ctx());
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
  });

  it("leaves the run clean when the re-ask itself states nothing", async () => {
    runAdapterExecutionTargetProcess
      .mockResolvedValueOnce(agyTurn("Did the work."))
      .mockResolvedValueOnce(agyTurn("Still nothing structured."));
    const result: never = await execute(ctx());
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(2);
    expect((result as { resultJson?: { disposition?: unknown } }).resultJson?.disposition).toBeUndefined();
    expect((result as { errorMessage?: string | null }).errorMessage).toBeNull();
  });
});
