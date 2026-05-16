import { describe, expect, it } from "vitest";
import { parseHermesObservableStdoutLine } from "./parse-stdout.js";

describe("parseHermesObservableStdoutLine", () => {
  it("parses text deltas into assistant transcript entries", () => {
    const [entry] = parseHermesObservableStdoutLine(
      JSON.stringify({
        type: "hermes_observable.text_delta",
        channel: "assistant",
        text: "hello",
      }),
      "2026-05-08T00:00:00.000Z",
    );

    expect(entry).toMatchObject({
      kind: "assistant",
      text: "hello",
      delta: true,
    });
  });

  it("parses tool calls and results", () => {
    const toolCall = parseHermesObservableStdoutLine(
      JSON.stringify({
        type: "hermes_observable.tool_call",
        name: "terminal",
        toolCallId: "call_1",
        input: { cmd: "pwd" },
      }),
      "2026-05-08T00:00:00.000Z",
    );
    const toolResult = parseHermesObservableStdoutLine(
      JSON.stringify({
        type: "hermes_observable.tool_result",
        name: "terminal",
        toolCallId: "call_1",
        content: "ok",
        isError: false,
      }),
      "2026-05-08T00:00:01.000Z",
    );

    expect(toolCall[0]).toMatchObject({
      kind: "tool_call",
      name: "terminal",
      toolUseId: "call_1",
    });
    expect(toolResult[0]).toMatchObject({
      kind: "tool_result",
      toolUseId: "call_1",
      content: "ok",
      isError: false,
    });
  });

  it("treats watchdog lines as system entries", () => {
    const [entry] = parseHermesObservableStdoutLine(
      "[hermes] still running: 30s, lastEvent=response.output_text.delta, activeTool=terminal",
      "2026-05-08T00:00:00.000Z",
    );

    expect(entry).toMatchObject({
      kind: "system",
      text: "[hermes] still running: 30s, lastEvent=response.output_text.delta, activeTool=terminal",
    });
  });
});
