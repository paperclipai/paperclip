import { describe, expect, it } from "vitest";
import { parseGoogleAdkStdoutLine } from "./parse-stdout.js";

describe("parseGoogleAdkStdoutLine", () => {
  it("turns ADK JSONL into assistant and tool transcript entries", () => {
    const entries = parseGoogleAdkStdoutLine(
      JSON.stringify({
        content: {
          role: "model",
          parts: [
            { text: "Hello from ADK" },
            {
              functionCall: {
                name: "lookup_task",
                id: "call-1",
                args: { issueId: "ISS-123" },
              },
            },
            {
              functionResponse: {
                name: "lookup_task",
                id: "call-1",
                response: { ok: true },
              },
            },
          ],
        },
      }),
      "2026-05-26T00:00:00.000Z",
    );

    expect(entries).toEqual([
      {
        kind: "assistant",
        ts: "2026-05-26T00:00:00.000Z",
        text: "Hello from ADK",
      },
      {
        kind: "tool_call",
        ts: "2026-05-26T00:00:00.000Z",
        name: "lookup_task",
        toolUseId: "call-1",
        input: { issueId: "ISS-123" },
      },
      {
        kind: "tool_result",
        ts: "2026-05-26T00:00:00.000Z",
        toolUseId: "call-1",
        toolName: "lookup_task",
        content: '{\n  "ok": true\n}',
        isError: false,
      },
    ]);
  });
});
