import { describe, expect, it } from "vitest";
import { parsePiJsonl } from "./parse.js";
import {
  createPiStdoutCompactor,
  resolvePiStdoutLogMode,
  type PiStdoutLogMode,
} from "./stdout-compaction.js";
import { parsePiStdoutLine, resetParserState } from "../ui/parse-stdout.js";

function messageUpdate(delta: string, cumulativeText: string) {
  return JSON.stringify({
    type: "message_update",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "x".repeat(5000) },
        { type: "text", text: cumulativeText },
      ],
    },
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 1,
      delta,
      partial: {
        role: "assistant",
        content: [{ type: "text", text: cumulativeText }],
      },
    },
  });
}

function toolExecutionUpdate(toolCallId: string, partial: string) {
  return JSON.stringify({
    type: "tool_execution_update",
    toolCallId,
    toolName: "bash",
    args: { command: "ls" },
    partialResult: {
      content: [{ type: "text", text: partial }],
      details: { truncation: null, fullOutputPath: null },
    },
  });
}

function assistantUpdate(message: Record<string, unknown>, assistantMessageEvent: Record<string, unknown>) {
  return JSON.stringify({
    type: "message_update",
    message,
    assistantMessageEvent: { ...assistantMessageEvent, partial: message },
  });
}

/**
 * Protocol-faithful Pi 0.74 multi-turn sequence derived from pi-agent-core's
 * event order and published AgentEvent/AssistantMessageEvent shapes.
 */
function buildTranscript() {
  const usage1 = {
    input: 100,
    output: 20,
    cacheRead: 10,
    cacheWrite: 0,
    totalTokens: 130,
    cost: { input: 0.001, output: 0.0004, cacheRead: 0.0001, cacheWrite: 0, total: 0.0015 },
  };
  const usage2 = {
    input: 120,
    output: 40,
    cacheRead: 12,
    cacheWrite: 0,
    totalTokens: 172,
    cost: { input: 0.0012, output: 0.0008, cacheRead: 0.00012, cacheWrite: 0, total: 0.00212 },
  };
  const userMessage = { role: "user", content: "List files, then summarize.", timestamp: 1 };
  const firstAssistant = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "I should inspect the workspace." },
      { type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "ls" } },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5",
    usage: usage1,
    stopReason: "toolUse",
    timestamp: 2,
  };
  const toolResult = {
    role: "toolResult",
    toolCallId: "tc-1",
    toolName: "bash",
    content: [{ type: "text", text: "file1\nfile2" }],
    details: { truncation: null, fullOutputPath: null },
    isError: false,
    timestamp: 3,
  };
  const finalAssistant = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "The directory contains two files." },
      { type: "text", text: "Hello world!" },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5",
    responseId: "resp-final",
    usage: usage2,
    stopReason: "stop",
    timestamp: 4,
  };

  const thinkingStart = { ...firstAssistant, content: [{ type: "thinking", thinking: "" }] };
  const thinkingPartial = { ...firstAssistant, content: [{ type: "thinking", thinking: "I should inspect" }] };
  const thinkingComplete = {
    ...firstAssistant,
    content: [{ type: "thinking", thinking: "I should inspect the workspace." }],
  };
  const toolCallStart = {
    ...firstAssistant,
    content: [
      { type: "thinking", thinking: "I should inspect the workspace." },
      { type: "toolCall", id: "tc-1", name: "bash", arguments: {} },
    ],
  };
  const toolCallPartial = {
    ...firstAssistant,
    content: [
      { type: "thinking", thinking: "I should inspect the workspace." },
      { type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "l" } },
    ],
  };
  const finalThinkingStart = {
    ...finalAssistant,
    content: [{ type: "thinking", thinking: "" }],
  };
  const finalThinkingPartial = {
    ...finalAssistant,
    content: [{ type: "thinking", thinking: "The directory contains" }],
  };
  const finalThinkingComplete = {
    ...finalAssistant,
    content: [{ type: "thinking", thinking: "The directory contains two files." }],
  };
  const finalTextStart = {
    ...finalAssistant,
    content: [
      { type: "thinking", thinking: "The directory contains two files." },
      { type: "text", text: "" },
    ],
  };
  const finalTextPartial = {
    ...finalAssistant,
    content: [
      { type: "thinking", thinking: "The directory contains two files." },
      { type: "text", text: "Hello" },
    ],
  };

  return [
    JSON.stringify({ type: "session", id: "s-1", cwd: "/tmp/work" }),
    JSON.stringify({ type: "agent_start" }),
    JSON.stringify({ type: "turn_start" }),
    JSON.stringify({ type: "message_start", message: { ...firstAssistant, content: [] } }),
    assistantUpdate(thinkingStart, { type: "thinking_start", contentIndex: 0 }),
    assistantUpdate(thinkingPartial, { type: "thinking_delta", contentIndex: 0, delta: "I should inspect" }),
    assistantUpdate(thinkingComplete, {
      type: "thinking_end",
      contentIndex: 0,
      content: "I should inspect the workspace.",
    }),
    assistantUpdate(toolCallStart, { type: "toolcall_start", contentIndex: 1 }),
    assistantUpdate(toolCallPartial, { type: "toolcall_delta", contentIndex: 1, delta: '"ls"' }),
    assistantUpdate(firstAssistant, {
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: firstAssistant.content[1],
    }),
    JSON.stringify({ type: "message_end", message: firstAssistant }),
    JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "tc-1",
      toolName: "bash",
      args: { command: "ls" },
    }),
    toolExecutionUpdate("tc-1", "file"),
    toolExecutionUpdate("tc-1", "file1\nfile2"),
    JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "tc-1",
      toolName: "bash",
      result: { content: toolResult.content, details: toolResult.details },
      isError: false,
    }),
    JSON.stringify({ type: "message_start", message: toolResult }),
    JSON.stringify({ type: "message_end", message: toolResult }),
    JSON.stringify({ type: "turn_end", message: firstAssistant, toolResults: [toolResult] }),
    JSON.stringify({ type: "turn_start" }),
    JSON.stringify({ type: "message_start", message: { ...finalAssistant, content: [] } }),
    assistantUpdate(finalThinkingStart, { type: "thinking_start", contentIndex: 0 }),
    assistantUpdate(finalThinkingPartial, {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "The directory contains",
    }),
    assistantUpdate(finalThinkingComplete, {
      type: "thinking_end",
      contentIndex: 0,
      content: "The directory contains two files.",
    }),
    assistantUpdate(finalTextStart, { type: "text_start", contentIndex: 1 }),
    assistantUpdate(finalTextPartial, { type: "text_delta", contentIndex: 1, delta: "Hello" }),
    assistantUpdate(finalAssistant, { type: "text_delta", contentIndex: 1, delta: " world!" }),
    assistantUpdate(finalAssistant, { type: "text_end", contentIndex: 1, content: "Hello world!" }),
    JSON.stringify({ type: "message_end", message: finalAssistant }),
    JSON.stringify({ type: "turn_end", message: finalAssistant, toolResults: [] }),
    JSON.stringify({
      type: "agent_end",
      messages: [userMessage, firstAssistant, toolResult, finalAssistant],
    }),
    JSON.stringify({ type: "agent_settled" }),
  ];
}

function filterTranscript(lines: string[], mode: PiStdoutLogMode): string[] {
  const compact = createPiStdoutCompactor(mode);
  return lines.map((l) => compact(l)).filter((l): l is string => l !== null);
}

describe("resolvePiStdoutLogMode", () => {
  it("defaults missing values to compact but fails invalid values safely to raw", () => {
    expect(resolvePiStdoutLogMode({})).toBe("compact");
    expect(resolvePiStdoutLogMode({ stdoutLogMode: undefined })).toBe("compact");
    expect(resolvePiStdoutLogMode({ stdoutLogMode: "bogus" })).toBe("raw");
    expect(resolvePiStdoutLogMode({ stdoutLogMode: 42 })).toBe("raw");
  });

  it("accepts explicit modes case-insensitively", () => {
    expect(resolvePiStdoutLogMode({ stdoutLogMode: "raw" })).toBe("raw");
    expect(resolvePiStdoutLogMode({ stdoutLogMode: " Compact " })).toBe("compact");
  });
});

describe("raw mode", () => {
  it("passes all input through unchanged", () => {
    const lines = [
      ...buildTranscript(),
      "not json at all",
      "{broken",
      "42",
      "[1,2,3]",
      '"just a string"',
      "line with \u2028 separator",
    ];
    expect(filterTranscript(lines, "raw")).toEqual(lines);
  });
});

describe("compact mode", () => {
  it("strips cumulative message and partial from message_update, keeps delta", () => {
    const out = filterTranscript([messageUpdate("Hello", "Hello")], "compact");
    expect(out).toHaveLength(1);
    const event = JSON.parse(out[0]);
    expect(event.type).toBe("message_update");
    expect(event.message).toBeUndefined();
    expect(event.assistantMessageEvent.type).toBe("text_delta");
    expect(event.assistantMessageEvent.delta).toBe("Hello");
    expect(event.assistantMessageEvent.contentIndex).toBe(1);
    expect(event.assistantMessageEvent.partial).toBeUndefined();
  });

  it("preserves terminal and unknown events byte-for-byte (including CRLF)", () => {
    const terminal = buildTranscript().filter((l) => {
      const t = JSON.parse(l).type;
      return !["message_update", "tool_execution_update"].includes(t);
    });
    const unknown = JSON.stringify({ type: "brand_new_pi_event", payload: { big: "z".repeat(1000) } });
    // Add CRLF to a terminal line and verify it survives byte-for-byte.
    const crlfLine = terminal[0] + "\r";
    const out = filterTranscript([...terminal, unknown, crlfLine], "compact");
    expect(out).toEqual([...terminal, unknown, crlfLine]);
  });

  it("passes malformed lines through unchanged", () => {
    const weird = ["not json", "{broken", "42", "[1,2]"];
    expect(filterTranscript(weird, "compact")).toEqual(weird);
  });

  it("shrinks a cumulative transcript to ~linear size", () => {
    const n = 50;
    const lines: string[] = [];
    let text = "";
    for (let i = 0; i < n; i++) {
      text += `chunk-${i} `;
      lines.push(messageUpdate(`chunk-${i} `, text));
    }
    const rawBytes = lines.join("\n").length;
    const compactBytes = filterTranscript(lines, "compact").join("\n").length;
    expect(compactBytes).toBeLessThan(rawBytes / 10);
  });
});

describe("tool_execution_update liveness", () => {
  it("compact emits schema-distinct Paperclip progress at 0/5000ms boundaries", () => {
    let now = 0;
    const compact = createPiStdoutCompactor("compact", { now: () => now });
    const line = toolExecutionUpdate("tc-1", "a".repeat(50_000));

    const first = compact(line);
    now = 4_999;
    const beforeBoundary = compact(line);
    now = 5_000;
    const atBoundary = compact(line);

    expect(first).not.toBeNull();
    expect(beforeBoundary).toBeNull();
    expect(atBoundary).not.toBeNull();
    expect(JSON.parse(first!)).toEqual({
      type: "paperclip_progress",
      sourceEventType: "tool_execution_update",
      toolCallId: "tc-1",
    });
    expect(JSON.parse(atBoundary!)).toEqual(JSON.parse(first!));
  });

  it("raw mode passes partialResult through unchanged", () => {
    const line = toolExecutionUpdate("tc-4", "c".repeat(100));
    expect(filterTranscript([line], "raw")).toEqual([line]);
  });
});

describe("replay through Paperclip parsers", () => {
  const raw = buildTranscript();

  it("compact preserves full parsePiJsonl output (finalMessage, usage, toolCalls, errors, messages)", () => {
    const filtered = filterTranscript(raw, "compact");
    const fromRaw = parsePiJsonl(raw.join("\n"));
    const fromFiltered = parsePiJsonl(filtered.join("\n"));

    expect(fromFiltered).toEqual(fromRaw);
    expect(fromFiltered.finalMessage).toBe("Hello world!");
  });

  it("compact produces identical full UI transcript entries", () => {
    const render = (lines: string[]) => {
      resetParserState();
      return lines.flatMap((line) => parsePiStdoutLine(line, "2026-07-24T00:00:00Z"));
    };
    expect(render(filterTranscript(raw, "compact"))).toEqual(render(raw));
  });

  it("Paperclip progress events stay out of the UI transcript", () => {
    const event = {
      type: "paperclip_progress",
      sourceEventType: "tool_execution_update",
      toolCallId: "tc-1",
    };
    expect(parsePiStdoutLine(JSON.stringify(event), "2026-07-24T00:00:00Z")).toEqual([]);
  });
});
