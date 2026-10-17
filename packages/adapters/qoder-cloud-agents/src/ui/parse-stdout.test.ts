import { describe, expect, it } from "vitest";
import { parseQoderCloudAgentsStdoutLine } from "./parse-stdout.js";

const ts = "2026-01-01T00:00:00.000Z";

function parseEvent(event: Record<string, unknown>) {
  return parseQoderCloudAgentsStdoutLine(JSON.stringify({ type: "qoder_cloud_agents.event", event }), ts);
}

describe("parseQoderCloudAgentsStdoutLine", () => {
  it("passes non-JSON and unknown lines through as stdout", () => {
    expect(parseQoderCloudAgentsStdoutLine("plain text", ts)).toEqual([{ kind: "stdout", ts, text: "plain text" }]);
    expect(parseQoderCloudAgentsStdoutLine('{"type":"other"}', ts)).toEqual([
      { kind: "stdout", ts, text: '{"type":"other"}' },
    ]);
  });

  it("parses init, status and result lines", () => {
    expect(parseQoderCloudAgentsStdoutLine(JSON.stringify({
      type: "qoder_cloud_agents.init",
      sessionId: "sess_1",
      agentId: "agent_1",
      model: "ultimate",
    }), ts)).toEqual([{ kind: "init", ts, model: "ultimate", sessionId: "sess_1" }]);

    expect(parseQoderCloudAgentsStdoutLine(JSON.stringify({
      type: "qoder_cloud_agents.status",
      status: "running",
      message: "Started a turn.",
    }), ts)).toEqual([{ kind: "system", ts, text: "running: Started a turn." }]);

    expect(parseQoderCloudAgentsStdoutLine(JSON.stringify({
      type: "qoder_cloud_agents.result",
      status: "finished",
      result: "All done",
    }), ts)).toEqual([{
      kind: "result",
      ts,
      text: "All done",
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      subtype: "finished",
      isError: false,
      errors: [],
    }]);

    expect(parseQoderCloudAgentsStdoutLine(JSON.stringify({
      type: "qoder_cloud_agents.result",
      status: "error",
      error: "Model overloaded",
    }), ts)[0]).toMatchObject({ kind: "result", isError: true, errors: ["Model overloaded"] });
  });

  it("maps agent messages and tool traffic to transcript entries", () => {
    expect(parseEvent({
      id: "evt_1",
      type: "agent.message",
      content: [{ type: "text", text: "Working on it" }, { type: "image", source: {} }],
    })).toEqual([{ kind: "assistant", ts, text: "Working on it\n[image]" }]);

    expect(parseEvent({
      id: "evt_2",
      type: "agent.tool_use",
      name: "Bash",
      input: { command: "ls" },
      evaluated_permission: "allow",
    })).toEqual([{ kind: "tool_call", ts, name: "Bash", toolUseId: "evt_2", input: { command: "ls" } }]);

    expect(parseEvent({
      id: "evt_3",
      type: "agent.mcp_tool_use",
      mcp_server_name: "weather",
      name: "get_forecast",
      input: {},
    })).toEqual([{ kind: "tool_call", ts, name: "weather/get_forecast", toolUseId: "evt_3", input: {} }]);

    expect(parseEvent({
      id: "evt_4",
      type: "agent.tool_result",
      tool_use_id: "evt_2",
      content: [{ type: "text", text: "file.txt" }],
      is_error: false,
    })).toEqual([{ kind: "tool_result", ts, toolUseId: "evt_2", content: "file.txt", isError: false }]);

    expect(parseEvent({
      id: "evt_5",
      type: "agent.mcp_tool_result",
      mcp_tool_use_id: "evt_3",
      is_error: true,
    })).toEqual([{ kind: "tool_result", ts, toolUseId: "evt_3", content: "", isError: true }]);
  });

  it("surfaces session errors and lifecycle changes", () => {
    expect(parseEvent({
      type: "session.error",
      error: { type: "model_error", message: "Model overloaded", retry_status: { type: "retrying" } },
    })).toEqual([{ kind: "stderr", ts, text: "Model overloaded (retrying)" }]);
    expect(parseEvent({ type: "session.status_idle", stop_reason: { type: "end_turn" } })).toEqual([
      { kind: "system", ts, text: "idle: end_turn" },
    ]);
    expect(parseEvent({ type: "session.status_terminated" })).toEqual([{ kind: "system", ts, text: "terminated" }]);
    expect(parseEvent({ type: "agent.artifact_delivered", file_id: "file_1", original_filename: "report.pdf" })).toEqual([
      { kind: "system", ts, text: "artifact delivered: report.pdf" },
    ]);
  });

  it("drops events that carry nothing to show", () => {
    expect(parseEvent({ type: "agent.thinking" })).toEqual([]);
    expect(parseEvent({ type: "user.message", content: [{ type: "text", text: "the prompt" }] })).toEqual([]);
    expect(parseEvent({ type: "span.model_request_end", model_usage: { credits: 1.25 } })).toEqual([]);
    expect(parseEvent({ type: "agent.message", content: [] })).toEqual([]);
  });
});
