/**
 * Tests for JSON stream parser
 */

import { describe, it, expect, vi } from "vitest";
import { parseJsonStream, isJsonStream, parseWithFallback } from "../parse-json-stream.js";
import type { BobStreamResult } from "../parse-stdout.js";

describe("JSON Stream Parser", () => {
  describe("isJsonStream", () => {
    it("should return true for valid JSON stream", () => {
      const stdout = `
{"type":"system","subtype":"session_init","session_id":"abc123","model":"claude-3-5-sonnet-20241022"}
{"type":"assistant","text":"Hello"}
      `.trim();
      
      expect(isJsonStream(stdout)).toBe(true);
    });

    it("should return false for XML format", () => {
      const stdout = `
<thinking>Analyzing the task...</thinking>
<read_file>
<file_path>/path/to/file</file_path>
</read_file>
      `.trim();
      
      expect(isJsonStream(stdout)).toBe(false);
    });

    it("should return false for plain text", () => {
      const stdout = "This is just plain text output";
      expect(isJsonStream(stdout)).toBe(false);
    });

    it("should return true even with mixed content", () => {
      const stdout = `
Some plain text
{"type":"assistant","text":"Hello"}
More plain text
      `.trim();
      
      expect(isJsonStream(stdout)).toBe(true);
    });
  });

  describe("parseJsonStream", () => {
    it("should return null for non-JSON content", () => {
      const stdout = "Plain text output";
      const result = parseJsonStream(stdout);
      expect(result).toBeNull();
    });

    it("should parse session initialization", () => {
      const stdout = `
{"type":"system","subtype":"session_init","session_id":"test-session-123","model":"claude-3-5-sonnet-20241022"}
{"type":"result","result":"Task completed"}
      `.trim();
      
      const result = parseJsonStream(stdout);
      
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe("test-session-123");
      expect(result!.model).toBe("claude-3-5-sonnet-20241022");
    });

    it("should parse assistant messages", () => {
      const stdout = `
{"type":"assistant","text":"First message"}
{"type":"assistant","text":"Second message"}
{"type":"assistant","text":"Third message"}
      `.trim();
      
      const result = parseJsonStream(stdout);
      
      expect(result).not.toBeNull();
      expect(result!.assistantTexts).toEqual([
        "First message",
        "Second message",
        "Third message",
      ]);
    });

    it("should parse thinking blocks", () => {
      const stdout = `
{"type":"thinking","text":"Analyzing requirements..."}
{"type":"thinking","text":"Planning implementation..."}
      `.trim();
      
      const result = parseJsonStream(stdout);
      
      expect(result).not.toBeNull();
      expect(result!.thinkingTexts).toEqual([
        "Analyzing requirements...",
        "Planning implementation...",
      ]);
    });

    it("should parse usage information", () => {
      const stdout = `
{"type":"usage","input_tokens":1000,"cached_input_tokens":500,"output_tokens":200}
{"type":"result","result":"Done"}
      `.trim();
      
      const result = parseJsonStream(stdout);
      
      expect(result).not.toBeNull();
      expect(result!.usage).toEqual({
        inputTokens: 1000,
        cachedInputTokens: 500,
        outputTokens: 200,
      });
    });

    it("should parse cost information", () => {
      const stdout = `
{"type":"cost","cost_usd":0.05}
{"type":"result","result":"Done"}
      `.trim();
      
      const result = parseJsonStream(stdout);
      
      expect(result).not.toBeNull();
      expect(result!.costUsd).toBe(0.05);
    });

    it("should parse final result", () => {
      const stdout = `
{"type":"assistant","text":"Working on it..."}
{"type":"result","result":"Task completed successfully"}
      `.trim();
      
      const result = parseJsonStream(stdout);
      
      expect(result).not.toBeNull();
      expect(result!.finalResult).toBe("Task completed successfully");
    });

    it("should generate summary from final result", () => {
      const stdout = `
{"type":"result","result":"Task completed successfully"}
      `.trim();
      
      const result = parseJsonStream(stdout);
      
      expect(result).not.toBeNull();
      expect(result!.summary).toBe("Task completed successfully");
    });

    it("should generate summary from assistant messages when no result", () => {
      const stdout = `
{"type":"assistant","text":"First message"}
{"type":"assistant","text":"Second message"}
{"type":"assistant","text":"Third message"}
      `.trim();
      
      const result = parseJsonStream(stdout);
      
      expect(result).not.toBeNull();
      expect(result!.summary).toBe("First message\n\nSecond message\n\nThird message");
    });

    it("should generate summary from thinking when no messages", () => {
      const stdout = `
{"type":"thinking","text":"Analyzing the problem..."}
      `.trim();
      
      const result = parseJsonStream(stdout);
      
      expect(result).not.toBeNull();
      expect(result!.summary).toBe("Analyzing the problem...");
    });

    it("should not truncate long summaries", () => {
      const longText = "a".repeat(600);
      const stdout = `
{"type":"result","result":"${longText}"}
      `.trim();

      const result = parseJsonStream(stdout);

      expect(result).not.toBeNull();
      expect(result!.summary).toHaveLength(600);
      expect(result!.summary.endsWith("...")).toBe(false);
    });

    it("should handle complete execution flow", () => {
      const stdout = `
{"type":"system","subtype":"session_init","session_id":"session-123","model":"claude-3-5-sonnet-20241022"}
{"type":"assistant","text":"Let me help you with that task."}
{"type":"thinking","text":"I need to read the file first."}
{"type":"tool_use","name":"read_file","input":{"file_path":"/path/to/file"}}
{"type":"tool_result","content":"file contents","is_error":false}
{"type":"assistant","text":"I've read the file. Now processing..."}
{"type":"usage","input_tokens":1500,"cached_input_tokens":800,"output_tokens":300}
{"type":"cost","cost_usd":0.08}
{"type":"result","result":"Task completed successfully. File processed."}
      `.trim();
      
      const result = parseJsonStream(stdout);
      
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe("session-123");
      expect(result!.model).toBe("claude-3-5-sonnet-20241022");
      expect(result!.assistantTexts).toHaveLength(2);
      expect(result!.thinkingTexts).toHaveLength(1);
      expect(result!.usage).toEqual({
        inputTokens: 1500,
        cachedInputTokens: 800,
        outputTokens: 300,
      });
      expect(result!.costUsd).toBe(0.08);
      expect(result!.finalResult).toBe("Task completed successfully. File processed.");
      expect(result!.summary).toBe("Task completed successfully. File processed.");
    });

    it("should ignore tool_use and tool_result events", () => {
      const stdout = `
{"type":"tool_use","name":"read_file","input":{"file_path":"/test"}}
{"type":"tool_result","content":"file contents","is_error":false}
{"type":"result","result":"Done"}
      `.trim();
      
      const result = parseJsonStream(stdout);
      
      expect(result).not.toBeNull();
      // Tool events don't contribute to assistant texts or thinking
      expect(result!.assistantTexts).toHaveLength(0);
      expect(result!.thinkingTexts).toHaveLength(0);
    });

    it("should handle malformed JSON lines gracefully", () => {
      const stdout = `
{"type":"assistant","text":"Valid message"}
{invalid json}
{"type":"result","result":"Done"}
      `.trim();
      
      const result = parseJsonStream(stdout);
      
      expect(result).not.toBeNull();
      expect(result!.assistantTexts).toEqual(["Valid message"]);
      expect(result!.finalResult).toBe("Done");
    });

    it("should handle empty lines", () => {
      const stdout = `
{"type":"assistant","text":"Message 1"}

{"type":"assistant","text":"Message 2"}

      `.trim();
      
      const result = parseJsonStream(stdout);
      
      expect(result).not.toBeNull();
      expect(result!.assistantTexts).toEqual(["Message 1", "Message 2"]);
    });

    it("should handle usage without cached tokens", () => {
      const stdout = `
{"type":"usage","input_tokens":1000,"output_tokens":200}
{"type":"result","result":"Done"}
      `.trim();
      
      const result = parseJsonStream(stdout);
      
      expect(result).not.toBeNull();
      expect(result!.usage).toEqual({
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 200,
      });
    });
  });

  describe("parseWithFallback", () => {
    it("should use JSON parser when JSON is detected", () => {
      const stdout = `
{"type":"assistant","text":"JSON message"}
{"type":"result","result":"JSON result"}
      `.trim();
      
      const xmlParser = vi.fn().mockReturnValue({
        summary: "XML summary",
        finalResult: "XML result",
        assistantTexts: [],
        thinkingTexts: [],
      });
      
      const result = parseWithFallback(stdout, xmlParser);
      
      expect(result.finalResult).toBe("JSON result");
      expect(xmlParser).not.toHaveBeenCalled();
    });

    it("should fall back to XML parser when JSON parsing fails", () => {
      const stdout = `
<thinking>XML thinking</thinking>
<attempt_completion>
<result>XML result</result>
</attempt_completion>
      `.trim();
      
      const xmlParser = vi.fn().mockReturnValue({
        summary: "XML summary",
        finalResult: "XML result",
        assistantTexts: [],
        thinkingTexts: ["XML thinking"],
      });
      
      const result = parseWithFallback(stdout, xmlParser);
      
      expect(result.finalResult).toBe("XML result");
      expect(xmlParser).toHaveBeenCalledWith(stdout);
    });

    it("should fall back to XML parser for plain text", () => {
      const stdout = "Plain text output";

      const xmlParser = vi.fn().mockReturnValue({
        summary: "Plain text",
        finalResult: null,
        assistantTexts: ["Plain text output"],
        thinkingTexts: [],
      });

      const result = parseWithFallback(stdout, xmlParser);

      expect(xmlParser).toHaveBeenCalledWith(stdout);
    });

    it("should fall back to XML parser when XML output contains embedded JSON in a tool result", () => {
      // Bob XML output where a tool result contains valid JSON — isJsonStream must not
      // mistake this for a JSON stream and select the wrong parser.
      const stdout = `
<thinking>Analyzing the task...</thinking>
<read_file>
<file_path>/path/to/file</file_path>
</read_file>
Tool <read_file> status: Success
tool response is wrapped in 'response' xml tag:
<response>{"some_key":"some_value","count":42}</response>
<attempt_completion>
<result>Task done via XML path</result>
</attempt_completion>
      `.trim();

      const xmlParser = vi.fn().mockReturnValue({
        summary: "Task done via XML path",
        finalResult: "Task done via XML path",
        assistantTexts: [],
        thinkingTexts: ["Analyzing the task..."],
      });

      const result = parseWithFallback(stdout, xmlParser);

      expect(xmlParser).toHaveBeenCalledWith(stdout);
      expect(result.finalResult).toBe("Task done via XML path");
    });

    it("should not trigger isJsonStream on XML output with unknown-type JSON", () => {
      const stdout = `
<thinking>Thinking...</thinking>
{"random_json":true,"no_type_field":1}
<attempt_completion><result>Done</result></attempt_completion>
      `.trim();

      const xmlParser = vi.fn().mockReturnValue({
        summary: "Done",
        finalResult: "Done",
        assistantTexts: [],
        thinkingTexts: [],
      });

      const result = parseWithFallback(stdout, xmlParser);
      expect(xmlParser).toHaveBeenCalledWith(stdout);
    });
  });
});
