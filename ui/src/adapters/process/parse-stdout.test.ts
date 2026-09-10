import { describe, expect, it } from "vitest";
import { piLocalUIAdapter } from "../pi-local";
import { buildTranscript, type RunLogChunk } from "../transcript";
import { processUIAdapter } from "./index";
import { parseProcessStdoutLine } from "./parse-stdout";

const TS = "2026-09-09T12:00:00.000Z";

function planLine(overrides: Record<string, unknown> = {}, event: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "tool_execution_end",
    toolCallId: "call_abc",
    toolName: "delivery_update_plan",
    result: {
      content: [{ type: "text", text: "Plan rev 2: 1/3 done" }],
      details: {
        schema: "paperclip.plan.updated.v1",
        planId: "run-plan",
        revision: 2,
        complete: false,
        explanation: "Working through the checklist.",
        steps: [
          { stepId: "s1", body: "Inspect adapter", status: "completed" },
          { stepId: "s2", body: "Wire parser", status: "in_progress" },
        ],
        ...overrides,
      },
    },
    isError: false,
    ...event,
  });
}

function eventChunks(events: Record<string, unknown>[]): RunLogChunk[] {
  return [{
    ts: TS,
    stream: "stdout",
    chunk: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  }];
}

describe("process stdout parser", () => {
  it("keeps plain stdout lines as stdout", () => {
    expect(parseProcessStdoutLine("  plain shell output  ", TS)).toEqual([
      { kind: "stdout", ts: TS, text: "  plain shell output  " },
    ]);
  });

  it("renders recognized Pi events with the Pi parser", () => {
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "src/index.ts" },
    });
    expect(parseProcessStdoutLine(line, TS)).toEqual([
      { kind: "tool_call", ts: TS, name: "read", input: { path: "src/index.ts" }, toolUseId: "call_1" },
    ]);
  });

  it("keeps unknown JSON object events as stdout", () => {
    const line = JSON.stringify({ type: "some_future_event", payload: { n: 1 } });
    expect(parseProcessStdoutLine(line, TS)).toEqual([{ kind: "stdout", ts: TS, text: line }]);
  });

  it("emits the normal tool result plus a structured plan entry for delivery_update_plan", () => {
    const entries = parseProcessStdoutLine(planLine(), TS);
    expect(entries).toEqual([
      expect.objectContaining({ kind: "tool_result", toolUseId: "call_abc", toolName: "delivery_update_plan", isError: false }),
      {
        kind: "provider_activity",
        ts: TS,
        family: "plan",
        eventType: "plan.updated",
        status: "running",
        title: "Plan",
        summary: "Working through the checklist.",
        payload: {
          schema: "paperclip.plan.updated.v1",
          planId: "run-plan",
          revision: 2,
          explanation: "Working through the checklist.",
          steps: [
            { stepId: "s1", body: "Inspect adapter", status: "completed" },
            { stepId: "s2", body: "Wire parser", status: "in_progress" },
          ],
          complete: false,
          syncStatus: "not_applicable",
          documentRevision: null,
        },
      },
    ]);
  });

  it("marks the plan completed when the snapshot is complete", () => {
    const entries = parseProcessStdoutLine(planLine({ complete: true }), TS);
    const plan = entries.find((entry) => entry.kind === "provider_activity");
    expect(plan).toMatchObject({ status: "completed", payload: { complete: true } });
  });

  it("ignores the plan on tool error without swallowing the tool result", () => {
    const entries = parseProcessStdoutLine(planLine({}, { isError: true }), TS);
    expect(entries.some((entry) => entry.kind === "provider_activity")).toBe(false);
    expect(entries).toEqual([
      expect.objectContaining({ kind: "tool_result", toolUseId: "call_abc", isError: true }),
    ]);
  });

  it("ignores other tool names and non-plan schemas without swallowing", () => {
    const otherTool = JSON.parse(planLine());
    otherTool.toolName = "read";
    expect(
      parseProcessStdoutLine(JSON.stringify(otherTool), TS).some(
        (entry) => entry.kind === "provider_activity",
      ),
    ).toBe(false);

    const wrongSchema = planLine({ schema: "paperclip.plan.updated.v0" });
    const entries = parseProcessStdoutLine(wrongSchema, TS);
    expect(entries.some((entry) => entry.kind === "provider_activity")).toBe(false);
    expect(entries).toEqual([
      expect.objectContaining({ kind: "tool_result", toolName: "delivery_update_plan" }),
    ]);
  });

  it("keeps a malformed plan payload visible as a normal tool result", () => {
    const line = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call_bad",
      toolName: "delivery_update_plan",
      result: { content: [{ type: "text", text: "oops" }] },
      isError: false,
    });
    const entries = parseProcessStdoutLine(line, TS);
    expect(entries.some((entry) => entry.kind === "provider_activity")).toBe(false);
    expect(entries).toEqual([
      expect.objectContaining({ kind: "tool_result", toolUseId: "call_bad" }),
    ]);
  });
});

describe("process Pi transcript integration", () => {
  it("renders streamed text and thinking once across every terminal snapshot", () => {
    const userMessage = {
      role: "user",
      content: [{ type: "text", text: "Inspect the transcript." }],
    };
    const assistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Checking the parser" },
        { type: "text", text: "Fixed once." },
      ],
      usage: {
        input: 11,
        output: 7,
        cacheRead: 3,
        cost: { total: 0.012 },
      },
    };
    const entries = buildTranscript(
      eventChunks([
        { type: "agent_start" },
        { type: "turn_start" },
        { type: "message_start", message: userMessage },
        { type: "message_end", message: userMessage },
        { type: "message_start", message: { role: "assistant", content: [] } },
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_delta",
            contentIndex: 0,
            delta: "Checking the parser",
          },
        },
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_delta",
            contentIndex: 0,
            delta: "\n\n",
          },
        },
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_end",
            contentIndex: 0,
            content: "Checking the parser",
          },
        },
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 1,
            delta: "Fixed ",
          },
        },
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 1,
            delta: "once.",
          },
        },
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_end",
            contentIndex: 1,
            content: "Fixed once.",
          },
        },
        { type: "message_end", message: assistantMessage },
        { type: "turn_end", message: assistantMessage, toolResults: [] },
        { type: "agent_end", messages: [userMessage, assistantMessage] },
      ]),
      processUIAdapter,
    );

    expect(entries.filter((entry) => entry.kind === "user").map((entry) => entry.text))
      .toEqual(["Inspect the transcript."]);
    expect(entries.filter((entry) => entry.kind === "thinking").map((entry) => entry.text))
      .toEqual(["Checking the parser"]);
    expect(entries.filter((entry) => entry.kind === "assistant").map((entry) => entry.text))
      .toEqual(["Fixed once."]);
    expect(entries.filter((entry) => entry.kind === "result")).toEqual([{
      kind: "result",
      ts: TS,
      text: "Run completed",
      inputTokens: 11,
      outputTokens: 7,
      cachedTokens: 3,
      costUsd: 0.012,
      subtype: "end",
      isError: false,
      errors: [],
    }]);
  });

  it("uses an authoritative terminal snapshot to repair a divergent streamed block", () => {
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
    };
    const entries = buildTranscript(
      eventChunks([
        { type: "turn_start" },
        { type: "message_start", message: { role: "assistant", content: [] } },
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "Helo",
          },
        },
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_end",
            contentIndex: 0,
            content: "Hello",
          },
        },
        { type: "message_end", message: assistantMessage },
        { type: "turn_end", message: assistantMessage },
      ]),
      processUIAdapter,
    );

    expect(entries.filter((entry) => entry.kind === "assistant").map((entry) => entry.text))
      .toEqual(["Hello"]);
  });

  it("keeps user, assistant, tool call, and tool result roles distinct", () => {
    const toolCall = {
      type: "toolCall",
      id: "call-role",
      name: "read",
      arguments: { path: "src/index.ts" },
    };
    const assistantMessage = { role: "assistant", content: [toolCall] };
    const toolResultMessage = {
      role: "toolResult",
      toolCallId: "call-role",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      isError: false,
    };
    const entries = buildTranscript(
      eventChunks([
        { type: "turn_start" },
        { type: "message_start", message: { role: "assistant", content: [] } },
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall,
          },
        },
        { type: "message_end", message: assistantMessage },
        {
          type: "tool_execution_end",
          toolCallId: "call-role",
          toolName: "read",
          result: { content: [{ type: "text", text: "file contents" }] },
          isError: false,
        },
        { type: "message_end", message: toolResultMessage },
        {
          type: "turn_end",
          message: assistantMessage,
          toolResults: [toolResultMessage],
        },
        {
          type: "agent_end",
          messages: [assistantMessage, toolResultMessage],
        },
      ]),
      processUIAdapter,
    );

    expect(entries.filter((entry) => entry.kind === "assistant")).toEqual([]);
    expect(entries.filter((entry) => entry.kind === "tool_call")).toEqual([{
      kind: "tool_call",
      ts: TS,
      name: "read",
      input: { path: "src/index.ts" },
      toolUseId: "call-role",
    }]);
    expect(entries.filter((entry) => entry.kind === "tool_result")).toEqual([{
      kind: "tool_result",
      ts: TS,
      toolUseId: "call-role",
      toolName: "read",
      content: "file contents",
      isError: false,
    }]);
  });

  it("preserves identical streamed messages from different turns", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Same answer." }],
    };
    const entries = buildTranscript(
      eventChunks([
        { type: "turn_start" },
        { type: "message_start", message: { role: "assistant", content: [] } },
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "Same answer.",
          },
        },
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_end",
            contentIndex: 0,
            content: "Same answer.",
          },
        },
        { type: "message_end", message },
        { type: "turn_end", message },
        { type: "turn_start" },
        { type: "message_start", message: { role: "assistant", content: [] } },
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "Same answer.",
          },
        },
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_end",
            contentIndex: 0,
            content: "Same answer.",
          },
        },
        { type: "message_end", message },
        { type: "turn_end", message },
      ]),
      processUIAdapter,
    );

    expect(entries.filter((entry) => entry.kind === "assistant").map((entry) => entry.text))
      .toEqual(["Same answer.", "Same answer."]);
  });

  it("keeps an unseen same-role message from an agent-end subset", () => {
    const firstMessage = {
      role: "assistant",
      content: [{ type: "text", text: "First answer." }],
      timestamp: 1,
    };
    const secondMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Second answer." }],
      timestamp: 2,
    };
    const entries = buildTranscript(
      eventChunks([
        {
          type: "message_start",
          message: { ...firstMessage, content: [] },
        },
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "First answer.",
          },
        },
        { type: "message_end", message: firstMessage },
        { type: "agent_end", messages: [secondMessage] },
      ]),
      processUIAdapter,
    );

    expect(entries.filter((entry) => entry.kind === "assistant").map((entry) => entry.text))
      .toEqual(["First answer.", "Second answer."]);
  });

  it("preserves identical terminal-only messages from different turns", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Repeat this." }] },
      { role: "assistant", content: [{ type: "text", text: "Same answer." }] },
      { role: "user", content: [{ type: "text", text: "Repeat this." }] },
      { role: "assistant", content: [{ type: "text", text: "Same answer." }] },
    ];
    const chunks = eventChunks([{ type: "agent_end", messages }]);

    for (const adapter of [processUIAdapter, piLocalUIAdapter]) {
      const entries = buildTranscript(chunks, adapter);
      expect(entries.filter((entry) => entry.kind === "user").map((entry) => entry.text))
        .toEqual(["Repeat this.", "Repeat this."]);
      expect(entries.filter((entry) => entry.kind === "assistant").map((entry) => entry.text))
        .toEqual(["Same answer.", "Same answer."]);
    }
  });

  it("does not carry pending tool metadata into another transcript build", () => {
    buildTranscript(
      eventChunks([{
        type: "tool_execution_start",
        toolCallId: "shared-id",
        toolName: "first-run-tool",
        args: {},
      }]),
      processUIAdapter,
    );

    const secondRun = buildTranscript(
      eventChunks([{
        type: "turn_end",
        toolResults: [{
          toolCallId: "shared-id",
          content: "second run result",
          isError: false,
        }],
      }]),
      processUIAdapter,
    );

    expect(secondRun.filter((entry) => entry.kind === "tool_result")).toEqual([{
      kind: "tool_result",
      ts: TS,
      toolUseId: "shared-id",
      toolName: "tool",
      content: "second run result",
      isError: false,
    }]);
  });
});
