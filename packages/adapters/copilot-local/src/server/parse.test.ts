import { describe, it, expect } from "vitest";
import {
  parseCopilotJsonl,
  describeCopilotFailure,
  isCopilotUnknownSessionError,
  detectCopilotAuthRequired,
} from "./parse.js";

const SAMPLE_OUTPUT = [
  '{"type":"session.mcp_server_status_changed","data":{"serverName":"notion","status":"connected"},"id":"44e92345","timestamp":"2026-03-29T07:47:51.203Z","parentId":"604aceed","ephemeral":true}',
  '{"type":"session.tools_updated","data":{"model":"gpt-5.4"},"id":"aae3898e","timestamp":"2026-03-29T07:47:52.669Z","parentId":"ff8fb69d","ephemeral":true}',
  '{"type":"user.message","data":{"content":"Respond with just the word hello.","attachments":[],"interactionId":"25ad8a5b"},"id":"846db770","timestamp":"2026-03-29T07:47:52.670Z"}',
  '{"type":"assistant.turn_start","data":{"turnId":"0","interactionId":"25ad8a5b"},"id":"e9b2c186","timestamp":"2026-03-29T07:47:52.672Z"}',
  '{"type":"assistant.message","data":{"messageId":"c46b7398","content":"hello","toolRequests":[],"interactionId":"25ad8a5b","phase":"final_answer","outputTokens":31},"id":"f6f819d5","timestamp":"2026-03-29T07:47:59.311Z"}',
  '{"type":"assistant.turn_end","data":{"turnId":"0"},"id":"f1784f6a","timestamp":"2026-03-29T07:47:59.311Z"}',
  '{"type":"result","timestamp":"2026-03-29T07:47:59.313Z","sessionId":"efc9f463-38c1-464a-8c7f-d28ac8993ffa","exitCode":0,"usage":{"premiumRequests":1,"totalApiDurationMs":6046,"sessionDurationMs":9803,"codeChanges":{"linesAdded":0,"linesRemoved":0,"filesModified":[]}}}',
].join("\n");

describe("parseCopilotJsonl", () => {
  it("extracts sessionId from result event", () => {
    const result = parseCopilotJsonl(SAMPLE_OUTPUT);
    expect(result.sessionId).toBe("efc9f463-38c1-464a-8c7f-d28ac8993ffa");
  });

  it("extracts model from session.tools_updated", () => {
    const result = parseCopilotJsonl(SAMPLE_OUTPUT);
    expect(result.model).toBe("gpt-5.4");
  });

  it("extracts assistant text as summary", () => {
    const result = parseCopilotJsonl(SAMPLE_OUTPUT);
    expect(result.summary).toBe("hello");
  });

  it("tracks output tokens from assistant.message", () => {
    const result = parseCopilotJsonl(SAMPLE_OUTPUT);
    expect(result.usage?.outputTokens).toBe(31);
  });

  it("extracts premiumRequests from usage", () => {
    const result = parseCopilotJsonl(SAMPLE_OUTPUT);
    expect(result.premiumRequests).toBe(1);
  });

  it("extracts totalApiDurationMs", () => {
    const result = parseCopilotJsonl(SAMPLE_OUTPUT);
    expect(result.totalApiDurationMs).toBe(6046);
  });

  it("returns null resultJson when no result event", () => {
    const result = parseCopilotJsonl(
      '{"type":"assistant.message","data":{"content":"hi","outputTokens":5}}',
    );
    expect(result.resultJson).toBeNull();
    expect(result.summary).toBe("hi");
  });

  it("handles empty stdout", () => {
    const result = parseCopilotJsonl("");
    expect(result.sessionId).toBeNull();
    expect(result.model).toBe("");
    expect(result.summary).toBe("");
  });

  it("handles multi-message conversation", () => {
    const lines = [
      '{"type":"assistant.message","data":{"content":"first","outputTokens":10}}',
      '{"type":"assistant.message","data":{"content":"second","outputTokens":20}}',
      '{"type":"result","sessionId":"abc","exitCode":0,"usage":{"premiumRequests":2,"totalApiDurationMs":1000,"sessionDurationMs":2000}}',
    ].join("\n");
    const result = parseCopilotJsonl(lines);
    expect(result.summary).toBe("first\n\nsecond");
    expect(result.usage?.outputTokens).toBe(30);
    expect(result.premiumRequests).toBe(2);
  });

  it("ignores malformed JSON lines gracefully", () => {
    const lines = [
      "this is not json",
      '{"type":"assistant.message","data":{"content":"ok","outputTokens":5}}',
      "{broken json",
      '{"type":"result","sessionId":"x","exitCode":0,"usage":{"premiumRequests":1}}',
    ].join("\n");
    const result = parseCopilotJsonl(lines);
    expect(result.summary).toBe("ok");
    expect(result.sessionId).toBe("x");
  });

  it("handles Windows-style line endings", () => {
    const lines = [
      '{"type":"assistant.message","data":{"content":"win","outputTokens":3}}',
      '{"type":"result","sessionId":"w","exitCode":0,"usage":{"premiumRequests":1}}',
    ].join("\r\n");
    const result = parseCopilotJsonl(lines);
    expect(result.summary).toBe("win");
    expect(result.sessionId).toBe("w");
  });

  it("handles JSON lines that are not objects (arrays, primitives)", () => {
    const lines = [
      "42",
      '"hello"',
      "[1,2,3]",
      '{"type":"assistant.message","data":{"content":"ok","outputTokens":1}}',
    ].join("\n");
    const result = parseCopilotJsonl(lines);
    expect(result.summary).toBe("ok");
  });

  it("last model wins when multiple session.tools_updated events", () => {
    const lines = [
      '{"type":"session.tools_updated","data":{"model":"gpt-5.2"}}',
      '{"type":"session.tools_updated","data":{"model":"gpt-5.4"}}',
    ].join("\n");
    const result = parseCopilotJsonl(lines);
    expect(result.model).toBe("gpt-5.4");
  });

  it("handles result event with missing usage fields", () => {
    const lines = '{"type":"result","sessionId":"s","exitCode":0,"usage":{}}';
    const result = parseCopilotJsonl(lines);
    expect(result.premiumRequests).toBe(0);
    expect(result.totalApiDurationMs).toBe(0);
  });
});

describe("describeCopilotFailure", () => {
  it("returns null for exit code 0", () => {
    expect(describeCopilotFailure({ exitCode: 0 }, "")).toBeNull();
  });

  it("includes stderr in error message", () => {
    const msg = describeCopilotFailure(
      { exitCode: 1 },
      "Error: No session or task matched 'FAKE-ID'\nThe value is not a valid UUID.",
    );
    expect(msg).toContain("No session or task matched");
    expect(msg).toContain("code 1");
  });

  it("falls back to exit code when stderr is empty", () => {
    expect(describeCopilotFailure({ exitCode: 1 }, "")).toBe("Copilot exited with code 1");
  });

  it("handles null parsed result", () => {
    const msg = describeCopilotFailure(null, "something went wrong");
    expect(msg).toContain("something went wrong");
  });

  it("extracts first meaningful stderr line when first lines are blank", () => {
    const msg = describeCopilotFailure(
      { exitCode: 1 },
      "\n\n  \nActual error message here\nMore details",
    );
    expect(msg).toContain("Actual error message here");
    expect(msg).not.toContain("More details");
  });

  it("detects auth required in stdout", () => {
    const result = detectCopilotAuthRequired({
      stdout: "not logged in",
      stderr: "",
    });
    expect(result.requiresLogin).toBe(true);
  });
});

describe("isCopilotUnknownSessionError", () => {
  it("detects 'No session or task matched' in stderr", () => {
    expect(
      isCopilotUnknownSessionError(
        "Error: No session or task matched 'abc-123'\nThe value is not a valid UUID.",
      ),
    ).toBe(true);
  });

  it("detects 'session not found'", () => {
    expect(isCopilotUnknownSessionError("session abc not found")).toBe(true);
  });

  it("returns false for normal errors", () => {
    expect(isCopilotUnknownSessionError("network timeout")).toBe(false);
  });

  it("returns false for empty stderr", () => {
    expect(isCopilotUnknownSessionError("")).toBe(false);
  });
});

describe("detectCopilotAuthRequired", () => {
  it("detects login required in stderr", () => {
    const result = detectCopilotAuthRequired({
      stdout: "",
      stderr: "Error: not logged in. Run `copilot login`",
    });
    expect(result.requiresLogin).toBe(true);
  });

  it("detects 'copilot login' hint", () => {
    const result = detectCopilotAuthRequired({
      stdout: "",
      stderr: "Please run copilot login to authenticate",
    });
    expect(result.requiresLogin).toBe(true);
  });

  it("returns false for normal output", () => {
    const result = detectCopilotAuthRequired({
      stdout: '{"type":"result","exitCode":0}',
      stderr: "",
    });
    expect(result.requiresLogin).toBe(false);
  });
});
