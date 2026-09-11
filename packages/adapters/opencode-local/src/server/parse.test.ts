import { describe, expect, it } from "vitest";
import { parseOpenCodeJsonl, isOpenCodeUnknownSessionError } from "./parse.js";

describe("parseOpenCodeJsonl", () => {
  it("parses assistant text, usage, cost, and errors", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Hello from OpenCode" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_123",
        part: {
          reason: "done",
          cost: 0.0025,
          tokens: {
            input: 120,
            output: 40,
            reasoning: 10,
            cache: { read: 20, write: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "error",
        sessionID: "session_123",
        error: { message: "model unavailable" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Hello from OpenCode");
    expect(parsed.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
    expect(parsed.costUsd).toBeCloseTo(0.0025, 6);
    expect(parsed.errorMessage).toContain("model unavailable");
    expect(parsed.toolErrors).toEqual([]);
  });

  it("keeps failed tool calls separate from fatal run errors", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_123",
        part: {
          state: {
            status: "error",
            error: "File not found: e2b-adapter-result.txt",
          },
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Recovered and completed the task" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Recovered and completed the task");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.toolErrors).toEqual(["File not found: e2b-adapter-result.txt"]);
  });

  it("detects unknown session errors", () => {
    expect(isOpenCodeUnknownSessionError("Session not found: s_123", "")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOpenCodeUnknownSessionError("all good", "")).toBe(false);
  });

  // Gemma 4 harmony token regression — SAG-3393/SAG-3395
  // Run dd1f4e1f/14650921 (SAG-3391) showed Gemma 4 emitting OpenAI-harmony channel
  // control tokens as type:"text" parts, leaking raw reasoning into posted comments.

  it("strips Gemma harmony — degenerate thought/channel loop yields empty summary", () => {
    // Exact token shape from SAG-3391 leaked comment: repeated thought<channel|> tail
    const degenerateLoop = "thought<channel|>thought<channel|>thought<channel|>thought<channel|>";
    const stdout = JSON.stringify({
      type: "text",
      sessionID: "session_gem",
      part: { text: degenerateLoop },
    });

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.summary).toBe("");
    expect(parsed.summary).not.toMatch(/<\|?channel\|?>/);
    expect(parsed.summary).not.toMatch(/<\|?message\|?>/);
    expect(parsed.summary).not.toContain("thought");
  });

  it("strips Gemma harmony — analysis channel discarded, final channel kept (canonical tokens)", () => {
    const harmonyText =
      "<|channel|>analysis<|message|>Internal reasoning: step 1, step 2." +
      "<|channel|>final<|message|>The answer is 42.";
    const stdout = JSON.stringify({
      type: "text",
      sessionID: "session_gem",
      part: { text: harmonyText },
    });

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.summary).toBe("The answer is 42.");
    expect(parsed.summary).not.toMatch(/<\|?channel\|?>/);
    expect(parsed.summary).not.toMatch(/<\|?message\|?>/);
    expect(parsed.summary).not.toContain("Internal reasoning");
  });

  it("strips Gemma harmony — mangled single-pipe <channel|> variant", () => {
    const harmonyText =
      "<channel|>analysis<|message|>Some internal thoughts." +
      "<channel|>final<|message|>Final answer here.";
    const stdout = JSON.stringify({
      type: "text",
      sessionID: "session_gem",
      part: { text: harmonyText },
    });

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.summary).toBe("Final answer here.");
    expect(parsed.summary).not.toMatch(/<\|?channel\|?>/);
    expect(parsed.summary).not.toContain("Some internal thoughts");
  });

  it("strips Gemma harmony — thought channel discarded (no final channel → empty)", () => {
    // Only a non-final channel present — entire text is reasoning, discard
    const harmonyText = "<|channel|>thought<|message|>I am thinking about things.<|channel|>commentary<|message|>More thoughts.";
    const stdout = JSON.stringify({
      type: "text",
      sessionID: "session_gem",
      part: { text: harmonyText },
    });

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.summary).toBe("");
    expect(parsed.summary).not.toContain("thinking");
  });

  it("strips Gemma harmony — plain pre-marker text preserved alongside final channel", () => {
    const harmonyText =
      "Preamble text. " +
      "<|channel|>analysis<|message|>Private reasoning." +
      "<|channel|>final<|message|>Public answer.";
    const stdout = JSON.stringify({
      type: "text",
      sessionID: "session_gem",
      part: { text: harmonyText },
    });

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.summary).toContain("Preamble text.");
    expect(parsed.summary).toContain("Public answer.");
    expect(parsed.summary).not.toContain("Private reasoning");
    expect(parsed.summary).not.toMatch(/<\|?channel\|?>/);
  });

  it("plain text with no harmony markers passes through byte-for-byte (no regression)", () => {
    for (const text of ["Hello from OpenCode", "Recovered and completed the task", "No special tokens here."]) {
      const stdout = JSON.stringify({ type: "text", sessionID: "s", part: { text } });
      const parsed = parseOpenCodeJsonl(stdout);
      expect(parsed.summary).toBe(text);
    }
  });
});
