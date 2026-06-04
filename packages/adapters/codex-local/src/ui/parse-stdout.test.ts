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
});
