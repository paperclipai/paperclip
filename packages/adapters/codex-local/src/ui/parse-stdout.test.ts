import { describe, expect, it } from "vitest";
import { parseCodexStdoutLine } from "./parse-stdout.js";

describe("parseCodexStdoutLine", () => {
  it("marks completed tool_use items as resolved tool results", () => {
    const started = parseCodexStdoutLine(JSON.stringify({
      type: "item.started",
      item: {
        id: "tool-1",
        type: "tool_use",
        name: "search",
        input: { query: "paperclip" },
      },
    }), "2026-04-08T12:00:00.000Z");

    const completed = parseCodexStdoutLine(JSON.stringify({
      type: "item.completed",
      item: {
        id: "tool-1",
        type: "tool_use",
        name: "search",
        status: "completed",
      },
    }), "2026-04-08T12:00:01.000Z");

    expect(started).toEqual([{
      kind: "tool_call",
      ts: "2026-04-08T12:00:00.000Z",
      name: "search",
      toolUseId: "tool-1",
      input: { query: "paperclip" },
    }]);
    expect(completed).toEqual([{
      kind: "tool_result",
      ts: "2026-04-08T12:00:01.000Z",
      toolUseId: "tool-1",
      content: "search completed",
      isError: false,
    }]);
  });

  it("keeps explicit tool_result payloads authoritative after tool_use completion", () => {
    const completed = parseCodexStdoutLine(JSON.stringify({
      type: "item.completed",
      item: {
        id: "tool-2",
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "final payload",
        status: "completed",
      },
    }), "2026-04-08T12:00:02.000Z");

    expect(completed).toEqual([{
      kind: "tool_result",
      ts: "2026-04-08T12:00:02.000Z",
      toolUseId: "tool-1",
      content: "final payload",
      isError: false,
    }]);
  });

  it("marks failed completed tool_use items as error results", () => {
    const completed = parseCodexStdoutLine(JSON.stringify({
      type: "item.completed",
      item: {
        id: "tool-3",
        type: "tool_use",
        name: "write_file",
        status: "error",
        error: { message: "permission denied" },
      },
    }), "2026-04-08T12:00:03.000Z");

    expect(completed).toEqual([{
      kind: "tool_result",
      ts: "2026-04-08T12:00:03.000Z",
      toolUseId: "tool-3",
      content: "permission denied",
      isError: true,
    }]);
  });

  it("parses app-server camelCase agent messages and command executions", () => {
    expect(parseCodexStdoutLine(JSON.stringify({
      type: "item.completed",
      item: {
        id: "msg-1",
        type: "agentMessage",
        text: "done",
      },
    }), "2026-04-08T12:00:04.000Z")).toEqual([{
      kind: "assistant",
      ts: "2026-04-08T12:00:04.000Z",
      text: "done",
    }]);

    expect(parseCodexStdoutLine(JSON.stringify({
      type: "item.completed",
      item: {
        id: "cmd-1",
        type: "commandExecution",
        command: "pnpm test",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "ok\n",
      },
    }), "2026-04-08T12:00:05.000Z")).toEqual([{
      kind: "tool_result",
      ts: "2026-04-08T12:00:05.000Z",
      toolUseId: "cmd-1",
      content: "command: pnpm test\nstatus: completed\nexit_code: 0\n\nok",
      isError: false,
    }]);
  });

  it("parses goal updates including blocked and usageLimited terminal states", () => {
    expect(parseCodexStdoutLine(JSON.stringify({
      type: "goal.updated",
      goal: {
        threadId: "thread-1",
        objective: "Finish the task",
        status: "usageLimited",
        tokenBudget: 100,
        tokensUsed: 80,
        timeUsedSeconds: 12,
      },
    }), "2026-04-08T12:00:06.000Z")).toEqual([{
      kind: "goal_update",
      ts: "2026-04-08T12:00:06.000Z",
      phase: "final",
      status: "usageLimited",
      objective: "Finish the task",
      tokensUsed: 80,
      tokenBudget: 100,
      timeUsedSeconds: 12,
      reason: undefined,
    }]);

    expect(parseCodexStdoutLine(JSON.stringify({
      type: "goal.updated",
      goal: {
        threadId: "thread-1",
        objective: "Finish the task",
        status: "blocked",
        tokensUsed: 10,
      },
    }), "2026-04-08T12:00:07.000Z")).toEqual([{
      kind: "goal_update",
      ts: "2026-04-08T12:00:07.000Z",
      phase: "final",
      status: "blocked",
      objective: "Finish the task",
      tokensUsed: 10,
      tokenBudget: null,
      timeUsedSeconds: 0,
      reason: undefined,
    }]);
  });
});
