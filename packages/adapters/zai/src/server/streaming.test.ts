import { describe, expect, it } from "vitest";
import { consumeSseStream, encodeEvent } from "./streaming.js";
import type { ZaiStdoutEvent } from "../shared/types.js";

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("encodeEvent", () => {
  it("prefixes with [zai:event] and appends newline", () => {
    const line = encodeEvent({ kind: "assistant_delta", text: "hi" });
    expect(line).toBe('[zai:event] {"kind":"assistant_delta","text":"hi"}\n');
  });
});

describe("consumeSseStream", () => {
  it("accumulates content deltas into final assistant message", async () => {
    const frames = [
      'data: {"id":"c1","model":"glm-4.6","choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n',
      'data: {"id":"c1","model":"glm-4.6","choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
      'data: {"id":"c1","model":"glm-4.6","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const events: ZaiStdoutEvent[] = [];
    const response = await consumeSseStream(sseStream(frames), (e) => {
      events.push(e);
    });

    expect(response.choices[0].message.content).toBe("Hello");
    expect(response.model).toBe("glm-4.6");
    expect(events.filter((e) => e.kind === "assistant_delta").length).toBe(2);
  });

  it("assembles streamed tool_call deltas into a single tool_call event", async () => {
    const frames = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"id\\""}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"abc\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const events: ZaiStdoutEvent[] = [];
    const response = await consumeSseStream(sseStream(frames), (e) => {
      events.push(e);
    });

    const toolCallEvents = events.filter((e) => e.kind === "tool_call");
    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0]).toMatchObject({
      kind: "tool_call",
      id: "call_1",
      name: "lookup",
      input: { id: "abc" },
    });

    const assembled = response.choices[0].message.tool_calls;
    expect(assembled).toHaveLength(1);
    expect(assembled![0].function.arguments).toBe('{"id":"abc"}');
  });

  it("captures usage from the final frame", async () => {
    const frames = [
      'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":7}}}\n\n',
      "data: [DONE]\n\n",
    ];
    const response = await consumeSseStream(sseStream(frames), () => {});
    expect(response.usage?.prompt_tokens).toBe(12);
    expect(response.usage?.completion_tokens).toBe(3);
    expect(response.usage?.prompt_tokens_details?.cached_tokens).toBe(7);
  });

  it("ignores frames without data: prefix", async () => {
    const frames = ["retry: 1000\n\n", 'data: {"choices":[{"index":0,"delta":{"content":"x"}}]}\n\n', "data: [DONE]\n\n"];
    const response = await consumeSseStream(sseStream(frames), () => {});
    expect(response.choices[0].message.content).toBe("x");
  });
});
