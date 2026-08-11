import { describe, expect, it } from "vitest";
import {
  NativeToolCallTelemetryCollector,
  parseNativeToolCallLine,
} from "./native-tool-call-telemetry.js";

describe("native tool-call telemetry", () => {
  it("normalizes ACPX tool calls without retaining arguments", () => {
    expect(parseNativeToolCallLine(JSON.stringify({
      type: "acpx.tool_call",
      toolCallId: "call-1",
      name: "Terminal",
      status: "completed",
      input: { command: "secret command" },
    }))).toEqual({
      toolCallId: "call-1",
      toolName: "Terminal",
      protocolType: "acpx.tool_call",
      status: "completed",
      eventType: "call_completed",
      outcome: "success",
    });
  });

  it("handles chunk boundaries and deduplicates repeated updates", () => {
    const collector = new NativeToolCallTelemetryCollector();
    expect(collector.ingest("stdout", '{"type":"acpx.tool_call","toolCallId":"call-2",')).toEqual([]);
    expect(collector.ingest("stdout", '"name":"Read","status":"in_progress"}\n')).toHaveLength(1);
    expect(collector.ingest("stdout", JSON.stringify({
      type: "acpx.tool_call",
      toolCallId: "call-2",
      name: "Read",
      status: "completed",
    }) + "\n")).toEqual([]);
  });

  it("recognizes Codex item events and ignores ordinary assistant text", () => {
    expect(parseNativeToolCallLine(JSON.stringify({
      type: "item.started",
      item: { id: "item-1", type: "mcp_tool_call", name: "paperclip.update_issue" },
    }))?.toolName).toBe("paperclip.update_issue");
    expect(parseNativeToolCallLine(JSON.stringify({
      type: "item.started",
      item: { id: "item-2", type: "command_execution", command: "git status" },
    }))).toMatchObject({
      toolCallId: "item-2",
      toolName: "command_execution",
      eventType: "call_started",
    });
    expect(parseNativeToolCallLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }))).toBeNull();
  });
});
