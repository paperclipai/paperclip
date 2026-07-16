import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyJsonlText,
  classifyRow,
  encodeClaudeCwd,
  jsonlPathFor,
  resolveClaudeConfigDir,
} from "./clean-poisoned-claude-sessions.js";

describe("classifyJsonlText", () => {
  it("returns healthy when the last assistant message.id starts with msg_", () => {
    const text = [
      JSON.stringify({ type: "user" }),
      JSON.stringify({ type: "assistant", message: { id: "msg_first" } }),
      JSON.stringify({ type: "user" }),
      JSON.stringify({ type: "assistant", message: { id: "msg_last" } }),
    ].join("\n");
    const result = classifyJsonlText(text);
    expect(result).toEqual({ kind: "healthy", lastAssistantId: "msg_last" });
  });

  it("returns poisoned when the last assistant message.id is a synthetic UUID", () => {
    const text = [
      JSON.stringify({ type: "user" }),
      JSON.stringify({ type: "assistant", message: { id: "msg_real" } }),
      JSON.stringify({
        type: "assistant",
        message: { id: "f649efd6-1837-4c52-981f-b81fdc0c2ddb" },
      }),
    ].join("\n");
    const result = classifyJsonlText(text);
    expect(result).toEqual({
      kind: "poisoned",
      lastAssistantId: "f649efd6-1837-4c52-981f-b81fdc0c2ddb",
    });
  });

  it("ignores trailing whitespace, blank lines, and malformed JSON", () => {
    const text = [
      "",
      "  ",
      "this-is-not-json",
      JSON.stringify({ type: "assistant", message: { id: "msg_only" } }),
      "",
    ].join("\n");
    expect(classifyJsonlText(text)).toEqual({
      kind: "healthy",
      lastAssistantId: "msg_only",
    });
  });

  it("returns no_assistant_entries when the transcript has no assistant rows", () => {
    const text = [
      JSON.stringify({ type: "user" }),
      JSON.stringify({ type: "attachment" }),
      JSON.stringify({ type: "last-prompt", lastPrompt: "x" }),
    ].join("\n");
    expect(classifyJsonlText(text)).toEqual({ kind: "no_assistant_entries" });
  });

  it("treats a CRLF-encoded transcript the same as LF", () => {
    const text = [
      JSON.stringify({ type: "assistant", message: { id: "msg_first" } }),
      JSON.stringify({ type: "assistant", message: { id: "synthetic-uuid" } }),
    ].join("\r\n");
    expect(classifyJsonlText(text)).toEqual({
      kind: "poisoned",
      lastAssistantId: "synthetic-uuid",
    });
  });
});

describe("encodeClaudeCwd", () => {
  it("mirrors the claude-local adapter encoding rule", () => {
    expect(encodeClaudeCwd("/Users/dj/.paperclip/instances/default/workspaces/abc")).toBe(
      "-Users-dj--paperclip-instances-default-workspaces-abc",
    );
  });
});

describe("jsonlPathFor", () => {
  it("returns <root>/projects/<encoded-cwd>/<sessionId>.jsonl", () => {
    const result = jsonlPathFor({
      claudeConfigDir: "/tmp/.claude",
      cwd: "/Users/dj/work",
      sessionId: "abc-123",
    });
    expect(result).toBe(path.join("/tmp/.claude", "projects", "-Users-dj-work", "abc-123.jsonl"));
  });
});

describe("resolveClaudeConfigDir", () => {
  it("prefers the explicit override", () => {
    expect(resolveClaudeConfigDir({}, "/tmp/custom")).toBe(path.resolve("/tmp/custom"));
  });
  it("uses CLAUDE_CONFIG_DIR when no override is given", () => {
    expect(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: "/tmp/from-env" } as NodeJS.ProcessEnv)).toBe(
      path.resolve("/tmp/from-env"),
    );
  });
  it("falls back to ~/.claude when no override and no env var", () => {
    const result = resolveClaudeConfigDir({} as NodeJS.ProcessEnv);
    expect(result.endsWith(`${path.sep}.claude`)).toBe(true);
  });
});

describe("classifyRow", () => {
  const claudeConfigDir = "/tmp/.claude";
  const cwd = "/Users/dj/work";
  const sessionId = "session-1";
  const expectedJsonl = jsonlPathFor({ claudeConfigDir, cwd, sessionId });

  it("returns skipped_no_session_id when sessionId is null", () => {
    const result = classifyRow(
      { sessionId: null, cwd, isRemote: false },
      { claudeConfigDir, readJsonl: () => null },
    );
    expect(result.kind).toBe("skipped_no_session_id");
  });

  it("returns skipped_remote when the row has remoteExecution params", () => {
    const result = classifyRow(
      { sessionId, cwd, isRemote: true },
      { claudeConfigDir, readJsonl: () => null },
    );
    expect(result.kind).toBe("skipped_remote");
  });

  it("returns missing_jsonl with the expected path when the file does not exist", () => {
    const result = classifyRow(
      { sessionId, cwd, isRemote: false },
      { claudeConfigDir, readJsonl: () => null },
    );
    expect(result.kind).toBe("missing_jsonl");
    if (result.kind === "missing_jsonl") {
      expect(result.jsonlPath).toBe(expectedJsonl);
    }
  });

  it("flags rows whose JSONL last assistant id is non-msg_", () => {
    const jsonl = [
      JSON.stringify({ type: "assistant", message: { id: "msg_first" } }),
      JSON.stringify({ type: "assistant", message: { id: "synthetic-uuid" } }),
    ].join("\n");
    const result = classifyRow(
      { sessionId, cwd, isRemote: false },
      { claudeConfigDir, readJsonl: () => jsonl },
    );
    expect(result.kind).toBe("poisoned");
    if (result.kind === "poisoned") {
      expect(result.lastAssistantId).toBe("synthetic-uuid");
    }
  });

  it("leaves valid msg_-prefixed sessions classified as healthy", () => {
    const jsonl = [
      JSON.stringify({ type: "assistant", message: { id: "msg_only" } }),
    ].join("\n");
    const result = classifyRow(
      { sessionId, cwd, isRemote: false },
      { claudeConfigDir, readJsonl: () => jsonl },
    );
    expect(result.kind).toBe("healthy");
  });
});
