import { describe, expect, it } from "vitest";
import { parseAgyStdoutLine } from "@paperclipai/adapter-agy-local/ui";
import { agyLocalUIAdapter } from "./agy-local";
import { buildTranscript, type RunLogChunk } from "./transcript";
import { transcriptToTaskChatItems } from "../components/task-chat/transcript-adapter";

const ts = "2026-09-30T12:00:00.000Z";

function lines(...events: unknown[]): RunLogChunk[] {
  return [{ ts, stream: "stdout", chunk: events.map((e) => JSON.stringify(e)).join("\n") + "\n" }];
}

describe("AGY UI transcript coalescing and tool identity", () => {
  it("coalesces streamed text deltas into a single 'Hello' message without extra spaces or newlines", () => {
    const chunks = lines(
      {
        event: "step_update",
        step_update: {
          conversation_id: "conv-1",
          step_index: 1,
          step_type: "agent_response",
          state: "ACTIVE",
          text_delta: "Hel",
        },
      },
      {
        event: "step_update",
        step_update: {
          conversation_id: "conv-1",
          step_index: 1,
          step_type: "agent_response",
          state: "DONE",
          text_delta: "lo",
        },
      },
    );

    const entries = buildTranscript(chunks, agyLocalUIAdapter);
    expect(entries).toEqual([
      {
        kind: "assistant",
        ts,
        text: "Hello",
        delta: true,
        itemId: "conv-1:1",
      },
    ]);

    const items = transcriptToTaskChatItems(entries, { running: false, runId: "run-1" });
    const messages = items.filter((item) => item.kind === "message");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "message",
      text: "Hello",
    });
  });

  it("does not merge distinct assistant responses with different step itemIds", () => {
    const chunks = lines(
      {
        event: "step_update",
        step_update: {
          conversation_id: "conv-1",
          step_index: 1,
          step_type: "agent_response",
          state: "DONE",
          text_delta: "Hello",
        },
      },
      {
        event: "step_update",
        step_update: {
          conversation_id: "conv-1",
          step_index: 3,
          step_type: "agent_response",
          state: "DONE",
          text_delta: "World",
        },
      },
    );

    const entries = buildTranscript(chunks, agyLocalUIAdapter);
    expect(entries).toEqual([
      {
        kind: "assistant",
        ts,
        text: "Hello",
        delta: true,
        itemId: "conv-1:1",
      },
      {
        kind: "assistant",
        ts,
        text: "World",
        delta: true,
        itemId: "conv-1:3",
      },
    ]);

    const items = transcriptToTaskChatItems(entries, { running: false, runId: "run-1" });
    const messages = items.filter((item) => item.kind === "message");
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => (m as { text: string }).text)).toEqual(["Hello", "World"]);
  });

  it("preserves toolUseId across ACTIVE -> DONE transition, updates a single tool card, and marks completed", () => {
    const chunks = lines(
      {
        event: "step_update",
        step_update: {
          conversation_id: "conv-tool",
          step_index: 2,
          step_type: "tool",
          state: "ACTIVE",
          tool_name: "run_command",
          tool_info: {
            name: "run_command",
            parameters: { CommandLine: "echo 42" },
          },
        },
      },
      {
        event: "step_update",
        step_update: {
          conversation_id: "conv-tool",
          step_index: 2,
          step_type: "tool",
          state: "DONE",
          tool_name: "run_command",
          tool_info: {
            name: "run_command",
            parameters: { CommandLine: "echo 42" },
            output: "42\n",
          },
        },
      },
    );

    const entries = buildTranscript(chunks, agyLocalUIAdapter);
    expect(entries.filter((e) => e.kind === "tool_call")).toHaveLength(2);
    expect(entries.filter((e) => e.kind === "tool_result")).toHaveLength(1);
    expect(entries.find((e) => e.kind === "tool_result")).toMatchObject({
      toolUseId: "conv-tool:2",
      content: "42\n",
      isError: false,
    });

    const items = transcriptToTaskChatItems(entries, { running: false, runId: "run-1" });
    const toolItems = items.filter((item) => item.kind === "tool");
    expect(toolItems).toHaveLength(1);
    expect(toolItems[0]).toMatchObject({
      kind: "tool",
      name: "Run command",
      rawName: "run_command",
      status: "completed",
      detail: "42",
    });
    expect(toolItems[0].status).not.toBe("interrupted");
  });

  it("marks tool as failed when DONE contains an error, updating a single tool card", () => {
    const chunks = lines(
      {
        event: "step_update",
        step_update: {
          conversation_id: "conv-tool",
          step_index: 5,
          step_type: "tool",
          state: "ACTIVE",
          tool_name: "file_write",
          tool_info: {
            name: "file_write",
            parameters: { path: "/root/secret" },
          },
        },
      },
      {
        event: "step_update",
        step_update: {
          conversation_id: "conv-tool",
          step_index: 5,
          step_type: "tool",
          state: "DONE",
          tool_name: "file_write",
          tool_info: {
            name: "file_write",
            parameters: { path: "/root/secret" },
            error: { message: "Permission denied" },
          },
        },
      },
    );

    const entries = buildTranscript(chunks, agyLocalUIAdapter);
    const items = transcriptToTaskChatItems(entries, { running: false, runId: "run-1" });
    const toolItems = items.filter((item) => item.kind === "tool");
    expect(toolItems).toHaveLength(1);
    expect(toolItems[0]).toMatchObject({
      kind: "tool",
      name: "File write",
      rawName: "file_write",
      status: "failed",
      detail: "Permission denied",
    });
    expect(toolItems[0].status).not.toBe("interrupted");
  });

  it("marks an unfinished ACTIVE tool as interrupted when the run ends before completion", () => {
    const chunks = lines({
      event: "step_update",
      step_update: {
        conversation_id: "conv-tool",
        step_index: 7,
        step_type: "tool",
        state: "ACTIVE",
        tool_name: "run_command",
        tool_info: {
          name: "run_command",
          parameters: { CommandLine: "sleep 100" },
        },
      },
    });

    const entries = buildTranscript(chunks, agyLocalUIAdapter);
    const items = transcriptToTaskChatItems(entries, { running: false, runId: "run-1" });
    const toolItems = items.filter((item) => item.kind === "tool");
    expect(toolItems).toHaveLength(1);
    expect(toolItems[0]).toMatchObject({
      kind: "tool",
      name: "Run command",
      rawName: "run_command",
      status: "interrupted",
    });
  });

  it("preserves error message when tool.output is empty string alongside error", () => {
    const chunks = lines(
      {
        event: "step_update",
        step_update: {
          conversation_id: "conv-tool",
          step_index: 8,
          step_type: "tool",
          state: "ACTIVE",
          tool_name: "run_command",
          tool_info: {
            name: "run_command",
            parameters: { CommandLine: "bad_cmd" },
          },
        },
      },
      {
        event: "step_update",
        step_update: {
          conversation_id: "conv-tool",
          step_index: 8,
          step_type: "tool",
          state: "DONE",
          tool_name: "run_command",
          tool_info: {
            name: "run_command",
            parameters: { CommandLine: "bad_cmd" },
            output: "",
            error: { message: "Command not found" },
          },
        },
      },
    );

    const entries = buildTranscript(chunks, agyLocalUIAdapter);
    const items = transcriptToTaskChatItems(entries, { running: false, runId: "run-1" });
    const toolItems = items.filter((item) => item.kind === "tool");
    expect(toolItems).toHaveLength(1);
    expect(toolItems[0]).toMatchObject({
      kind: "tool",
      name: "Run command",
      status: "failed",
      detail: "Command not found",
    });
  });

  it("coalesces thinking deltas into a single thinking item without breaking lines inappropriately", () => {
    const chunks = lines(
      {
        event: "step_update",
        step_update: {
          conversation_id: "conv-think",
          step_index: 1,
          step_type: "thinking",
          state: "ACTIVE",
          text_delta: "Analyzing ",
        },
      },
      {
        event: "step_update",
        step_update: {
          conversation_id: "conv-think",
          step_index: 1,
          step_type: "thinking",
          state: "DONE",
          text_delta: "codebase...",
        },
      },
    );

    const entries = buildTranscript(chunks, agyLocalUIAdapter);
    expect(entries).toEqual([
      {
        kind: "thinking",
        ts,
        text: "Analyzing codebase...",
        delta: true,
        itemId: "conv-think:1",
      },
    ]);

    const items = transcriptToTaskChatItems(entries, { running: false, runId: "run-1" });
    const thinkItems = items.filter((item) => item.kind === "thinking");
    expect(thinkItems).toHaveLength(1);
    expect(thinkItems[0]).toMatchObject({
      kind: "thinking",
      lines: ["Analyzing codebase..."],
    });
  });
});
