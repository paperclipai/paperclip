import { describe, expect, it } from "vitest";
import {
  parseCopilotJsonl,
  describeCopilotFailure,
  detectCopilotLoginRequired,
  isCopilotMaxTurnsResult,
  mapCopilotJsonlLineToLog,
  stripSkillFrontmatter,
} from "./parse.js";

const SIMPLE_JSONL = [
  '{"type":"session.mcp_servers_loaded","data":{"servers":[{"name":"github-mcp-server","status":"connected","source":"builtin"}]},"id":"aaa","timestamp":"2026-03-20T13:38:31.064Z","parentId":"bbb","ephemeral":true}',
  '{"type":"session.tools_updated","data":{"model":"claude-sonnet-4.6"},"id":"ccc","timestamp":"2026-03-20T13:38:34.968Z","parentId":"ddd","ephemeral":true}',
  '{"type":"user.message","data":{"content":"hello","transformedContent":"hello","attachments":[],"interactionId":"eee"},"id":"fff","timestamp":"2026-03-20T13:38:34.969Z","parentId":"ggg"}',
  '{"type":"assistant.turn_start","data":{"turnId":"0","interactionId":"eee"},"id":"hhh","timestamp":"2026-03-20T13:38:34.974Z","parentId":"iii"}',
  '{"type":"assistant.message_delta","data":{"messageId":"jjj","deltaContent":"hello"},"id":"kkk","timestamp":"2026-03-20T13:38:38.505Z","parentId":"lll","ephemeral":true}',
  '{"type":"assistant.message_delta","data":{"messageId":"jjj","deltaContent":" world"},"id":"mmm","timestamp":"2026-03-20T13:38:38.505Z","parentId":"nnn","ephemeral":true}',
  '{"type":"assistant.message","data":{"messageId":"jjj","content":"hello world","toolRequests":[],"interactionId":"eee","outputTokens":5},"id":"ooo","timestamp":"2026-03-20T13:38:38.637Z","parentId":"ppp"}',
  '{"type":"assistant.turn_end","data":{"turnId":"0"},"id":"qqq","timestamp":"2026-03-20T13:38:38.638Z","parentId":"rrr"}',
  '{"type":"result","timestamp":"2026-03-20T13:38:38.640Z","sessionId":"7899ee8f-3271-4de8-9c07-5b40d35a2e7a","exitCode":0,"usage":{"premiumRequests":1,"totalApiDurationMs":2762,"sessionDurationMs":10959,"codeChanges":{"linesAdded":0,"linesRemoved":0,"filesModified":[]}}}',
].join("\n");

const TOOL_USE_JSONL = [
  '{"type":"session.tools_updated","data":{"model":"claude-sonnet-4.6"},"id":"a1","timestamp":"2026-03-20T13:41:00.000Z","parentId":"b1","ephemeral":true}',
  '{"type":"assistant.message","data":{"messageId":"m1","content":"","toolRequests":[{"toolCallId":"tc1","name":"bash","arguments":{"command":"echo test"},"type":"function"}],"interactionId":"i1","outputTokens":20},"id":"c1","timestamp":"2026-03-20T13:41:11.104Z","parentId":"d1"}',
  '{"type":"tool.execution_start","data":{"toolCallId":"tc1","toolName":"bash","arguments":{"command":"echo test"}},"id":"e1","timestamp":"2026-03-20T13:41:11.105Z","parentId":"f1"}',
  '{"type":"tool.execution_complete","data":{"toolCallId":"tc1","model":"claude-sonnet-4.6","interactionId":"i1","success":true,"result":{"content":"test\\n<exited with exit code 0>","detailedContent":"test\\n<exited with exit code 0>"},"toolTelemetry":{}},"id":"g1","timestamp":"2026-03-20T13:41:13.902Z","parentId":"h1"}',
  '{"type":"assistant.message","data":{"messageId":"m2","content":"Done.","toolRequests":[],"interactionId":"i1","outputTokens":3},"id":"j1","timestamp":"2026-03-20T13:41:17.000Z","parentId":"k1"}',
  '{"type":"result","timestamp":"2026-03-20T13:41:17.278Z","sessionId":"session-456","exitCode":0,"usage":{"premiumRequests":1,"totalApiDurationMs":8558,"sessionDurationMs":22087,"codeChanges":{"linesAdded":0,"linesRemoved":0,"filesModified":[]}}}',
].join("\n");

describe("parseCopilotJsonl", () => {
  it("extracts sessionId from result event", () => {
    const result = parseCopilotJsonl(SIMPLE_JSONL);
    expect(result.sessionId).toBe("7899ee8f-3271-4de8-9c07-5b40d35a2e7a");
  });

  it("extracts model from session.tools_updated", () => {
    const result = parseCopilotJsonl(SIMPLE_JSONL);
    expect(result.model).toBe("claude-sonnet-4.6");
  });

  it("collects assistant text content", () => {
    const result = parseCopilotJsonl(SIMPLE_JSONL);
    expect(result.summary).toBe("hello world");
  });

  it("aggregates output tokens across assistant messages", () => {
    const result = parseCopilotJsonl(SIMPLE_JSONL);
    expect(result.usage!.outputTokens).toBe(5);
  });

  it("returns resultJson for result event", () => {
    const result = parseCopilotJsonl(SIMPLE_JSONL);
    expect(result.resultJson).not.toBeNull();
    expect(result.resultJson!.exitCode).toBe(0);
  });

  it("handles tool-use output with multiple assistant messages", () => {
    const result = parseCopilotJsonl(TOOL_USE_JSONL);
    expect(result.sessionId).toBe("session-456");
    expect(result.summary).toBe("Done.");
    expect(result.usage!.outputTokens).toBe(23);
  });

  it("returns null resultJson for empty input", () => {
    const result = parseCopilotJsonl("");
    expect(result.sessionId).toBeNull();
    expect(result.resultJson).toBeNull();
    expect(result.summary).toBe("");
  });

  it("returns premiumRequests count", () => {
    const result = parseCopilotJsonl(SIMPLE_JSONL);
    expect(result.premiumRequests).toBe(1);
  });
});

describe("describeCopilotFailure", () => {
  it("returns null for exit code 0", () => {
    expect(describeCopilotFailure({ exitCode: 0 })).toBeNull();
  });

  it("describes failure for non-zero exit code", () => {
    expect(describeCopilotFailure({ exitCode: 1 })).toBe("Copilot CLI exited with code 1");
  });
});

describe("detectCopilotLoginRequired", () => {
  it("detects login required message", () => {
    expect(
      detectCopilotLoginRequired({
        stdout: "",
        stderr: "Error: not logged in. Please run copilot login.",
      }).requiresLogin,
    ).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(
      detectCopilotLoginRequired({
        stdout: "hello world",
        stderr: "",
      }).requiresLogin,
    ).toBe(false);
  });
});

describe("isCopilotMaxTurnsResult", () => {
  it("returns false for normal results", () => {
    expect(isCopilotMaxTurnsResult({ exitCode: 0 })).toBe(false);
  });
});

// ─── mapCopilotJsonlLineToLog ─────────────────────────────────────────────────

const line = (obj: unknown) => JSON.stringify(obj);

describe("mapCopilotJsonlLineToLog", () => {
  // Empty / whitespace
  it("returns [] for empty string", () => {
    expect(mapCopilotJsonlLineToLog("")).toEqual([]);
  });

  it("returns [] for whitespace-only string", () => {
    expect(mapCopilotJsonlLineToLog("   \t  ")).toEqual([]);
  });

  // Non-JSON / malformed
  it("returns [] for plaintext (malformed JSON)", () => {
    expect(mapCopilotJsonlLineToLog("plain text line")).toEqual([]);
  });

  it("returns [] for truncated JSON", () => {
    expect(mapCopilotJsonlLineToLog('{"type":"assistant.message"')).toEqual([]);
  });

  // Non-object JSON root values
  it("returns [] for JSON null", () => {
    expect(mapCopilotJsonlLineToLog("null")).toEqual([]);
  });

  it("returns [] for JSON array", () => {
    expect(mapCopilotJsonlLineToLog('["a","b"]')).toEqual([]);
  });

  it("returns [] for JSON number", () => {
    expect(mapCopilotJsonlLineToLog("42")).toEqual([]);
  });

  it("returns [] for JSON string", () => {
    expect(mapCopilotJsonlLineToLog('"hello"')).toEqual([]);
  });

  // assistant.message – happy path
  it("emits content for assistant.message with trailing newline", () => {
    const result = mapCopilotJsonlLineToLog(
      line({ type: "assistant.message", data: { content: "Hello, world!" } }),
    );
    expect(result).toEqual([{ stream: "stdout", text: "Hello, world!\n" }]);
  });

  // assistant.message – edge cases on content field
  it("returns [] for assistant.message with empty content", () => {
    expect(
      mapCopilotJsonlLineToLog(line({ type: "assistant.message", data: { content: "" } })),
    ).toEqual([]);
  });

  it("returns [] for assistant.message with null content", () => {
    expect(
      mapCopilotJsonlLineToLog(line({ type: "assistant.message", data: { content: null } })),
    ).toEqual([]);
  });

  it("returns [] for assistant.message with numeric content", () => {
    expect(
      mapCopilotJsonlLineToLog(line({ type: "assistant.message", data: { content: 42 } })),
    ).toEqual([]);
  });

  it("returns [] for assistant.message with missing content field", () => {
    expect(
      mapCopilotJsonlLineToLog(line({ type: "assistant.message", data: { outputTokens: 5 } })),
    ).toEqual([]);
  });

  it("returns [] for assistant.message with data as array", () => {
    // data is not an object → falls back to {} → content is "" → suppressed
    expect(
      mapCopilotJsonlLineToLog(
        line({ type: "assistant.message", data: ["should", "be", "ignored"] }),
      ),
    ).toEqual([]);
  });

  it("returns [] for assistant.message with data: null", () => {
    expect(
      mapCopilotJsonlLineToLog(line({ type: "assistant.message", data: null })),
    ).toEqual([]);
  });

  it("emits content with trailing newline when other fields also present", () => {
    const result = mapCopilotJsonlLineToLog(
      line({
        type: "assistant.message",
        data: { messageId: "m1", content: "Done.", toolRequests: [], outputTokens: 3 },
      }),
    );
    expect(result).toEqual([{ stream: "stdout", text: "Done.\n" }]);
  });

  // tool.execution_start
  it("emits [toolName]\\n for tool.execution_start using toolName field", () => {
    const result = mapCopilotJsonlLineToLog(
      line({ type: "tool.execution_start", data: { toolName: "bash", toolCallId: "tc1" } }),
    );
    expect(result).toEqual([{ stream: "stdout", text: "[bash]\n" }]);
  });

  it("falls back to data.tool when toolName is absent", () => {
    const result = mapCopilotJsonlLineToLog(
      line({ type: "tool.execution_start", data: { tool: "read_file", toolCallId: "tc2" } }),
    );
    expect(result).toEqual([{ stream: "stdout", text: "[read_file]\n" }]);
  });

  it("falls back to 'tool' when neither toolName nor tool present", () => {
    const result = mapCopilotJsonlLineToLog(
      line({ type: "tool.execution_start", data: { toolCallId: "tc3" } }),
    );
    expect(result).toEqual([{ stream: "stdout", text: "[tool]\n" }]);
  });

  it("falls back to 'tool' when data is null for tool.execution_start", () => {
    const result = mapCopilotJsonlLineToLog(
      line({ type: "tool.execution_start", data: null }),
    );
    expect(result).toEqual([{ stream: "stdout", text: "[tool]\n" }]);
  });

  // Suppressed event types
  it("returns [] for session.tools_updated", () => {
    expect(
      mapCopilotJsonlLineToLog(line({ type: "session.tools_updated", data: { model: "gpt-5" } })),
    ).toEqual([]);
  });

  it("returns [] for tool.execution_complete", () => {
    expect(
      mapCopilotJsonlLineToLog(
        line({ type: "tool.execution_complete", data: { success: true, result: {} } }),
      ),
    ).toEqual([]);
  });

  it("returns [] for result event", () => {
    expect(
      mapCopilotJsonlLineToLog(
        line({ type: "result", sessionId: "s1", exitCode: 0, usage: {} }),
      ),
    ).toEqual([]);
  });

  it("returns [] for unknown event type", () => {
    expect(
      mapCopilotJsonlLineToLog(line({ type: "client.unknown", data: {} })),
    ).toEqual([]);
  });

  it("returns [] for event with no type field", () => {
    expect(mapCopilotJsonlLineToLog(line({ data: { content: "surprise" } }))).toEqual([]);
  });

  it("returns [] for event with numeric type", () => {
    expect(mapCopilotJsonlLineToLog(line({ type: 42, data: {} }))).toEqual([]);
  });

  // Whitespace around valid JSON
  it("handles leading/trailing whitespace around valid JSON", () => {
    const result = mapCopilotJsonlLineToLog(
      `  ${line({ type: "assistant.message", data: { content: "hi" } })}  `,
    );
    expect(result).toEqual([{ stream: "stdout", text: "hi\n" }]);
  });
});

// ─── mapCopilotJsonlLineToLog – assistant.message_delta ───────────────────────

describe("mapCopilotJsonlLineToLog – assistant.message_delta", () => {
  it("emits deltaContent for streaming delta event", () => {
    const result = mapCopilotJsonlLineToLog(
      line({ type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "hello" } }),
    );
    expect(result).toEqual([{ stream: "stdout", text: "hello" }]);
  });

  it("emits deltaContent without trailing newline (raw streaming)", () => {
    const result = mapCopilotJsonlLineToLog(
      line({ type: "assistant.message_delta", data: { messageId: "m1", deltaContent: " world" } }),
    );
    expect(result).toEqual([{ stream: "stdout", text: " world" }]);
  });

  it("returns [] for delta with empty deltaContent", () => {
    expect(
      mapCopilotJsonlLineToLog(
        line({ type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "" } }),
      ),
    ).toEqual([]);
  });

  it("returns [] for delta with null deltaContent", () => {
    expect(
      mapCopilotJsonlLineToLog(
        line({ type: "assistant.message_delta", data: { messageId: "m1", deltaContent: null } }),
      ),
    ).toEqual([]);
  });

  it("returns [] for delta with missing deltaContent", () => {
    expect(
      mapCopilotJsonlLineToLog(
        line({ type: "assistant.message_delta", data: { messageId: "m1" } }),
      ),
    ).toEqual([]);
  });

  it("tracks messageId in seenDeltaMessageIds set when provided", () => {
    const seen = new Set<string>();
    mapCopilotJsonlLineToLog(
      line({ type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "hi" } }),
      seen,
    );
    expect(seen.has("m1")).toBe(true);
  });

  it("does not track when seenDeltaMessageIds is not provided", () => {
    // Just verifies no error and still emits content
    const result = mapCopilotJsonlLineToLog(
      line({ type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "hi" } }),
    );
    expect(result).toEqual([{ stream: "stdout", text: "hi" }]);
  });

  it("does not track empty messageId", () => {
    const seen = new Set<string>();
    mapCopilotJsonlLineToLog(
      line({ type: "assistant.message_delta", data: { messageId: "", deltaContent: "hi" } }),
      seen,
    );
    expect(seen.size).toBe(0);
  });

  it("does not track missing messageId", () => {
    const seen = new Set<string>();
    mapCopilotJsonlLineToLog(
      line({ type: "assistant.message_delta", data: { deltaContent: "hi" } }),
      seen,
    );
    expect(seen.size).toBe(0);
  });
});

// ─── mapCopilotJsonlLineToLog – deduplication ─────────────────────────────────

describe("mapCopilotJsonlLineToLog – deduplication", () => {
  it("suppresses assistant.message content when deltas were already seen for that messageId", () => {
    const seen = new Set<string>(["m1"]);
    const result = mapCopilotJsonlLineToLog(
      line({ type: "assistant.message", data: { messageId: "m1", content: "hello world" } }),
      seen,
    );
    // Should emit only a newline (terminates the streamed block)
    expect(result).toEqual([{ stream: "stdout", text: "\n" }]);
  });

  it("emits full content when messageId was NOT seen in deltas", () => {
    const seen = new Set<string>(["m-other"]);
    const result = mapCopilotJsonlLineToLog(
      line({ type: "assistant.message", data: { messageId: "m1", content: "fresh content" } }),
      seen,
    );
    expect(result).toEqual([{ stream: "stdout", text: "fresh content\n" }]);
  });

  it("emits full content when seenDeltaMessageIds is not provided", () => {
    const result = mapCopilotJsonlLineToLog(
      line({ type: "assistant.message", data: { messageId: "m1", content: "no dedup" } }),
    );
    expect(result).toEqual([{ stream: "stdout", text: "no dedup\n" }]);
  });

  it("emits full content when message has no messageId", () => {
    const seen = new Set<string>(["m1"]);
    const result = mapCopilotJsonlLineToLog(
      line({ type: "assistant.message", data: { content: "no id" } }),
      seen,
    );
    expect(result).toEqual([{ stream: "stdout", text: "no id\n" }]);
  });

  it("end-to-end: delta → delta → full message deduplication", () => {
    const seen = new Set<string>();
    // Stream two deltas
    const d1 = mapCopilotJsonlLineToLog(
      line({ type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "Hello" } }),
      seen,
    );
    const d2 = mapCopilotJsonlLineToLog(
      line({ type: "assistant.message_delta", data: { messageId: "m1", deltaContent: " world" } }),
      seen,
    );
    // Full message arrives — should be deduplicated
    const full = mapCopilotJsonlLineToLog(
      line({ type: "assistant.message", data: { messageId: "m1", content: "Hello world" } }),
      seen,
    );
    expect(d1).toEqual([{ stream: "stdout", text: "Hello" }]);
    expect(d2).toEqual([{ stream: "stdout", text: " world" }]);
    expect(full).toEqual([{ stream: "stdout", text: "\n" }]);
  });
});

// ─── stripSkillFrontmatter ────────────────────────────────────────────────────

describe("stripSkillFrontmatter", () => {
  it("strips a standard YAML frontmatter block", () => {
    const input = "---\nname: paperclip\ndescription: test\n---\n# Body Content\n\nSome text.";
    expect(stripSkillFrontmatter(input)).toBe("# Body Content\n\nSome text.");
  });

  it("strips frontmatter when there is no trailing newline after closing ---", () => {
    const input = "---\nname: test\n---\nBody only.";
    expect(stripSkillFrontmatter(input)).toBe("Body only.");
  });

  it("returns the whole string when no frontmatter present", () => {
    const input = "# Just a heading\n\nSome content here.";
    expect(stripSkillFrontmatter(input)).toBe("# Just a heading\n\nSome content here.");
  });

  it("returns empty string for input containing only frontmatter", () => {
    const input = "---\nname: only-meta\n---\n";
    expect(stripSkillFrontmatter(input)).toBe("");
  });

  it("returns empty string for input containing only frontmatter with no trailing newline", () => {
    const input = "---\nname: only-meta\n---";
    expect(stripSkillFrontmatter(input)).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(stripSkillFrontmatter("")).toBe("");
  });

  it("strips multi-line description-style frontmatter", () => {
    const input =
      "---\nname: paperclip\ndescription: >\n  Multi-line\n  description here.\n---\n\n# Heading\n";
    expect(stripSkillFrontmatter(input)).toBe("# Heading");
  });

  it("strips frontmatter containing backticks in values", () => {
    const input = "---\nexample: `code`\n---\nContent after.";
    expect(stripSkillFrontmatter(input)).toBe("Content after.");
  });

  it("trims leading whitespace from body", () => {
    const input = "---\nkey: val\n---\n\n\n  Body with leading blank lines.";
    expect(stripSkillFrontmatter(input)).toBe("Body with leading blank lines.");
  });

  it("does not strip a lone --- appearing mid-document", () => {
    // A string starting with `---` but not having a closing `---` is not treated as frontmatter
    // because the regex is non-greedy and requires a second `---`
    const input = "---\nOnly one delimiter";
    // Regex does NOT match (no closing ---) → content is returned as-is but trimmed
    expect(stripSkillFrontmatter(input)).toBe("---\nOnly one delimiter");
  });
});
