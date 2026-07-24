import { describe, expect, it } from "vitest";
import { buildErrorClassificationHaystack, stripJsonlEventLines } from "./classification.js";

describe("stripJsonlEventLines", () => {
  it("drops JSONL event lines and keeps plain-text lines", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "We hit a 429 rate limit; try again later." },
      }),
      "Please visit https://example.com/login to authenticate.",
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }),
    ].join("\n");

    expect(stripJsonlEventLines(stdout)).toBe(
      "Please visit https://example.com/login to authenticate.",
    );
  });

  it("keeps lines that look like JSON but do not parse", () => {
    expect(stripJsonlEventLines('{ this is not json "rate limit"')).toBe(
      '{ this is not json "rate limit"',
    );
  });

  it("returns an empty string for null, undefined, and empty input", () => {
    expect(stripJsonlEventLines(null)).toBe("");
    expect(stripJsonlEventLines(undefined)).toBe("");
    expect(stripJsonlEventLines("")).toBe("");
  });
});

describe("buildErrorClassificationHaystack", () => {
  it("joins error message, plain-text stdout, and stderr", () => {
    const haystack = buildErrorClassificationHaystack({
      errorMessage: "structured failure",
      stdout: "plain diagnostic line\n",
      stderr: "stderr line",
    });
    expect(haystack).toBe("structured failure\nplain diagnostic line\nstderr line");
  });

  it("never includes JSONL conversation lines from stdout", () => {
    const haystack = buildErrorClassificationHaystack({
      errorMessage: null,
      stdout: [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "the upstream was overloaded, 429" }] },
        }),
        "cli: fatal error",
      ].join("\n"),
      stderr: "",
    });
    expect(haystack).toBe("cli: fatal error");
    expect(haystack).not.toContain("429");
  });

  it("keeps error text from structured error events in stdout", () => {
    const haystack = buildErrorClassificationHaystack({
      stdout: [
        JSON.stringify({ type: "error", message: "Unknown session id abc" }),
        JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected" } }),
        JSON.stringify({ type: "system", subtype: "error", error: "auth token expired" }),
      ].join("\n"),
      stderr: "",
    });
    expect(haystack).toBe(
      "Unknown session id abc\nstream disconnected\nauth token expired",
    );
  });

  it("keeps error result events but drops success result events", () => {
    const haystack = buildErrorClassificationHaystack({
      stdout: [
        JSON.stringify({ type: "result", subtype: "success", result: "we discussed 429 rate limits" }),
        JSON.stringify({ type: "result", is_error: true, result: "usage limit reached" }),
      ].join("\n"),
      stderr: "",
    });
    expect(haystack).toBe("usage limit reached");
    expect(haystack).not.toContain("429");
  });

  it("ignores non-error system events and unknown event types", () => {
    const haystack = buildErrorClassificationHaystack({
      stdout: [
        JSON.stringify({ type: "system", subtype: "init", model: "rate-limit-9000" }),
        JSON.stringify({ type: "message", role: "assistant", content: "try again later, 429" }),
      ].join("\n"),
      stderr: "",
    });
    expect(haystack).toBe("");
  });

  it("drops blank lines and trims whitespace", () => {
    const haystack = buildErrorClassificationHaystack({
      stdout: "  padded  \n\n\n",
      stderr: "\n  err  \n",
    });
    expect(haystack).toBe("padded\nerr");
  });
});
