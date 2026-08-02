import { describe, expect, it } from "vitest";
import { parseAgentskyCloudStdoutLine } from "./parse-stdout.js";

const TS = "2026-01-01T00:00:00.000Z";

function line(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function apiEventLine(event: Record<string, unknown>): string {
  return line({ type: "agentsky_cloud.message", event });
}

describe("parseAgentskyCloudStdoutLine", () => {
  it("parses init lines", () => {
    const entries = parseAgentskyCloudStdoutLine(
      line({
        type: "agentsky_cloud.init",
        sessionId: "sess-1",
        agentSlug: "slug-1",
        harness: "claude_code",
        model: "claude-opus-5",
      }),
      TS,
    );
    expect(entries).toEqual([{ kind: "init", ts: TS, model: "claude-opus-5", sessionId: "sess-1" }]);
  });

  it("parses status lines as system entries", () => {
    const entries = parseAgentskyCloudStdoutLine(
      line({ type: "agentsky_cloud.status", status: "running", message: "Sent wake message" }),
      TS,
    );
    expect(entries).toEqual([{ kind: "system", ts: TS, text: "running: Sent wake message" }]);
  });

  it("maps agent.message to an assistant entry", () => {
    const entries = parseAgentskyCloudStdoutLine(
      apiEventLine({ id: "m2", type: "agent.message", text: "All done" }),
      TS,
    );
    expect(entries).toEqual([{ kind: "assistant", ts: TS, text: "All done" }]);
  });

  it("maps agent.reasoning to a thinking entry", () => {
    const entries = parseAgentskyCloudStdoutLine(
      apiEventLine({ id: "m2#0", type: "agent.reasoning", part: { text: "hmm" } }),
      TS,
    );
    expect(entries).toEqual([{ kind: "thinking", ts: TS, text: "hmm" }]);
  });

  it("maps agent.tool_use and agent.tool_result", () => {
    const call = parseAgentskyCloudStdoutLine(
      apiEventLine({ id: "m2#1", type: "agent.tool_use", part: { tool_name: "bash", args: { cmd: "ls" } } }),
      TS,
    );
    expect(call).toEqual([
      { kind: "tool_call", ts: TS, name: "bash", toolUseId: "m2#1", input: { cmd: "ls" } },
    ]);

    const result = parseAgentskyCloudStdoutLine(
      apiEventLine({ id: "m2#2", type: "agent.tool_result", part: { tool_name: "bash", status: "error", text: "boom" } }),
      TS,
    );
    expect(result).toEqual([
      { kind: "tool_result", ts: TS, toolUseId: "m2#2", toolName: "bash", content: "boom", isError: true },
    ]);
  });

  it("suppresses the adapter's own user.message echo", () => {
    const entries = parseAgentskyCloudStdoutLine(
      apiEventLine({ id: "m1", type: "user.message", text: "the wake prompt", channel: "api" }),
      TS,
    );
    expect(entries).toEqual([]);
  });

  it("maps error events to stderr entries", () => {
    const entries = parseAgentskyCloudStdoutLine(
      apiEventLine({ id: "e1", type: "error", code: "pod_crash", message: "pod restarted" }),
      TS,
    );
    expect(entries).toEqual([{ kind: "stderr", ts: TS, text: "error: pod restarted" }]);
  });

  it("parses result lines with error status", () => {
    const entries = parseAgentskyCloudStdoutLine(
      line({ type: "agentsky_cloud.result", status: "timeout", error: "took too long" }),
      TS,
    );
    expect(entries).toEqual([
      {
        kind: "result",
        ts: TS,
        text: "",
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        subtype: "timeout",
        isError: true,
        errors: ["took too long"],
      },
    ]);
  });

  it("passes non-JSON lines through as stdout", () => {
    expect(parseAgentskyCloudStdoutLine("plain text", TS)).toEqual([
      { kind: "stdout", ts: TS, text: "plain text" },
    ]);
  });
});
