import { afterEach, describe, expect, it, vi } from "vitest";

// Regression coverage for the poisoned-session retry: the mid-run
// session-observed tracker used to be created once for the whole run and
// shared across the poisoned-session retry attempt, so it latched onto the
// first (poisoned) session's init event and silently ignored the retry's
// replacement session. A process loss during the retry then resumed the
// poisoned session instead of the active replacement, losing conversation
// context. See the Greptile review on PR #11585.
const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => {
  let call = 0;
  return {
    runChildProcess: vi.fn(async (_runId: string, _command: string, _args: string[], options: Record<string, unknown>) => {
      call += 1;
      const onLog = options.onLog as (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      if (call === 1) {
        // First attempt: resumes "claude-session-poisoned" and observes its
        // init event mid-run, then fails with a poisoned previous_message_id.
        await onLog(
          "stdout",
          `${JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-poisoned", model: "claude-sonnet" })}\n`,
        );
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: JSON.stringify({
            type: "result",
            session_id: "claude-session-poisoned",
            is_error: true,
            result: "Error: diagnostics.previous_message_id starts with `msg_`",
          }),
          stderr: "",
          pid: 123,
          startedAt: new Date().toISOString(),
        };
      }
      // Retry attempt: starts a brand new session and must be observed too.
      await onLog(
        "stdout",
        `${JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-replacement", model: "claude-sonnet" })}\n`,
      );
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-replacement", model: "claude-sonnet" }),
          JSON.stringify({
            type: "assistant",
            session_id: "claude-session-replacement",
            message: { content: [{ type: "text", text: "hello" }] },
          }),
          JSON.stringify({
            type: "result",
            session_id: "claude-session-replacement",
            result: "hello",
            usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
          }),
        ].join("\n"),
        stderr: "",
        pid: 124,
        startedAt: new Date().toISOString(),
      };
    }),
    ensureCommandResolvable: vi.fn(async () => undefined),
    resolveCommandForLogs: vi.fn(async () => "claude"),
  };
});

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

describe("claude_local poisoned-session retry", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("observes the replacement session's init event, not just the poisoned session's", async () => {
    const onSessionObserved = vi.fn(async () => {});

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "12345678-1234-4abc-9def-123456789012",
        sessionParams: { sessionId: "12345678-1234-4abc-9def-123456789012" },
        sessionDisplayId: "12345678-1234-4abc-9def-123456789012",
        taskKey: null,
      },
      config: { engine: "cli" },
      context: {},
      onLog: async () => {},
      onSessionObserved,
    } as never);

    expect(result.exitCode).toBe(0);
    expect(runChildProcess).toHaveBeenCalledTimes(2);

    // Both the poisoned session and its replacement must have been reported,
    // in order, so a process loss mid-retry resumes the replacement instead
    // of the discarded poisoned session.
    expect(onSessionObserved).toHaveBeenCalledTimes(2);
    expect(onSessionObserved).toHaveBeenNthCalledWith(1, { sessionId: "claude-session-poisoned" });
    expect(onSessionObserved).toHaveBeenNthCalledWith(2, { sessionId: "claude-session-replacement" });
  });
});
