import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isDistillUnknownSessionError, parseDistillJsonl, parseDistillModelsOutput } from "./parse.js";
import { createDistillStdoutParser } from "../ui/parse-stdout.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(here, "__fixtures__", name), "utf8");

describe("parseDistillJsonl", () => {
  it("reports the model that did the work, not the auto-routing classifier", () => {
    const parsed = parseDistillJsonl(fixture("auto-tool-run.jsonl"));
    expect(parsed.primaryModel).toBe("claude-sonnet-5-5");
    expect(parsed.sessionId).toBe("01a1e0d3-678c-78f3-b7fa-c8ac2ee89533");
    expect(parsed.stopReason).toBe("end_turn");
    expect(parsed.summary).toBe("DONE");
    expect(parsed.errorMessage).toBeNull();
  });

  it("keeps cache reads out of input tokens so totals are not double counted", () => {
    const parsed = parseDistillJsonl(fixture("auto-tool-run.jsonl"));
    expect(parsed.inputTokens).toBe(281 + 18967);
    expect(parsed.cacheWriteTokens).toBe(18967);
    expect(parsed.cachedInputTokens).toBe(18862);
    expect(parsed.outputTokens).toBe(93);
  });

  it("turns an error event into the run error message", () => {
    const parsed = parseDistillJsonl('{"type":"error","message":"unknown model id"}\n');
    expect(parsed.errorMessage).toMatch(/unknown model id/);
    expect(parsed.sawEnd).toBe(false);
  });
});

describe("isDistillUnknownSessionError", () => {
  it("detects a vanished session so the adapter can retry fresh, and ignores other failures", () => {
    expect(isDistillUnknownSessionError("", "Error: Session does not exist")).toBe(true);
    expect(isDistillUnknownSessionError("", "Error: rate limited")).toBe(false);
  });
});

describe("parseDistillModelsOutput", () => {
  it("lists every bullet and strips the default marker", () => {
    const { defaultModel, models } = parseDistillModelsOutput(fixture("models.txt"));
    expect(defaultModel).toBe("claude/claude-fable-5-2");
    expect(models).toContain("claude/claude-fable-5-2");
    expect(models).toContain("chatgpt/gpt-6.1-sol");
    expect(models.every((id) => !id.includes("(default)") && !id.includes(" "))).toBe(true);
  });
});

describe("createDistillStdoutParser", () => {
  it("renders tool calls, results and the final message and hides bookkeeping events", () => {
    const parser = createDistillStdoutParser();
    const entries = fixture("auto-tool-run.jsonl")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => parser.parseLine(line, "t"));
    expect(entries.map((entry) => entry.kind)).toEqual(["tool_call", "tool_result", "assistant", "system"]);
    const call = entries[0]!;
    const result = entries[1]!;
    if (call.kind !== "tool_call" || result.kind !== "tool_result") throw new Error("unexpected entry kinds");
    expect(call.name).toBe("run_terminal_command");
    expect(result.toolUseId).toBe(call.toolUseId);
    expect(result.toolName).toBe("run_terminal_command");
    expect(result.content).toMatch(/fixture-ok/);
    expect(result.isError).toBe(false);
  });
});

describe("parseDistillJsonl without an end event", () => {
  it("keeps the token usage already reported per message when the run dies before end", () => {
    const stdout = [
      '{"type":"usage","usage":{"input_tokens":4,"output_tokens":85,"cache_read_input_tokens":0,"cache_creation_input_tokens":100}}',
      '{"type":"usage","usage":{"input_tokens":2,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":10}}',
    ].join("\n");
    const parsed = parseDistillJsonl(stdout);
    expect(parsed.inputTokens).toBe(4 + 2 + 110);
    expect(parsed.outputTokens).toBe(90);
    expect(parsed.cachedInputTokens).toBe(100);
    expect(parsed.cacheWriteTokens).toBe(110);
  });

  it("prefers the final totals from the end event over the per-message sums", () => {
    const parsed = parseDistillJsonl(fixture("auto-tool-run.jsonl"));
    expect(parsed.outputTokens).toBe(93);
  });
});
