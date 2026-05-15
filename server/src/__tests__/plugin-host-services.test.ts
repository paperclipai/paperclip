import { describe, expect, it } from "vitest";
import { extractAssistantMessageFromRunResult } from "../services/plugin-host-services.js";

describe("extractAssistantMessageFromRunResult", () => {
  it("extracts the final Codex agent_message from JSONL stdout", () => {
    const stdout = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first draft" } }),
      JSON.stringify({ type: "item.completed", item: { type: "tool_call", text: "ignored" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final Telegram reply" } }),
    ].join("\n");

    expect(extractAssistantMessageFromRunResult({ stdout })).toBe("final Telegram reply");
  });

  it("falls back to stored result text when stdout has no agent message", () => {
    expect(extractAssistantMessageFromRunResult({ result: "host reply" })).toBe("host reply");
  });
});
