import { describe, expect, it } from "vitest";
import { parseOpenCodeJsonl, isOpenCodeUnknownSessionError, sanitizeModelText } from "./parse.js";

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

  // SAG-722: leaked tool-call JSON, system-prompt echoes, and internal XML must
  // be filtered from the summary produced by parseOpenCodeJsonl.

  it("drops pure tool-call JSON text events from the summary (AC1, AC5)", () => {
    const toolCallJson = JSON.stringify({
      type: "function",
      name: "fetch_issue",
      parameters: { issue_id: "SAG-704" },
    });
    const stdout = [
      JSON.stringify({ type: "text", sessionID: "s1", part: { text: toolCallJson } }),
      JSON.stringify({ type: "text", sessionID: "s1", part: { text: "Done — updated the issue." } }),
    ].join("\n");
    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.summary).toBe("Done — updated the issue.");
    expect(parsed.summary).not.toContain('"type": "function"');
  });

  it("drops text events whose content is a bare JSON array (AC1)", () => {
    const arrayJson = JSON.stringify([{ tool: "bash", args: ["ls"] }]);
    const stdout = JSON.stringify({ type: "text", sessionID: "s1", part: { text: arrayJson } });
    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.summary).toBe("");
  });

  it("drops echoed system-prompt wakeup text (AC2)", () => {
    const wakeText = "You are woken by reason: issue_assigned for issue SAG-677. Your task is…";
    const stdout = [
      JSON.stringify({ type: "text", sessionID: "s1", part: { text: wakeText } }),
      JSON.stringify({ type: "text", sessionID: "s1", part: { text: "Acknowledged. Moving to in_progress." } }),
    ].join("\n");
    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.summary).toBe("Acknowledged. Moving to in_progress.");
    expect(parsed.summary).not.toContain("You are woken by reason");
  });

  it("drops echoed agent-identity system-prompt lines (AC2)", () => {
    const agentLine = "You are agent f3c48afc running as CTO. Here is your context…";
    const stdout = JSON.stringify({ type: "text", sessionID: "s1", part: { text: agentLine } });
    expect(parseOpenCodeJsonl(stdout).summary).toBe("");
  });

  it("strips <analysis> and <thinking> XML blocks, keeps surrounding text (AC3)", () => {
    const raw = "<analysis>I need to check the issue first.</analysis>\n\nMoved to in_progress.";
    const stdout = JSON.stringify({ type: "text", sessionID: "s1", part: { text: raw } });
    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.summary).toBe("Moved to in_progress.");
    expect(parsed.summary).not.toContain("<analysis>");
  });

  it("drops text events that consist solely of an internal XML block (AC3)", () => {
    const raw = "<thinking>Let me think about this carefully.</thinking>";
    const stdout = JSON.stringify({ type: "text", sessionID: "s1", part: { text: raw } });
    expect(parseOpenCodeJsonl(stdout).summary).toBe("");
  });

  it("passes through normal natural-language update text unchanged", () => {
    const text = "## Update\n\n- Filed sub-task SAG-723\n- Moved status to in_progress";
    const stdout = JSON.stringify({ type: "text", sessionID: "s1", part: { text } });
    expect(parseOpenCodeJsonl(stdout).summary).toBe(text);
  });
});

// SAG-722: regression guard — sanitizeModelText directly

describe("sanitizeModelText", () => {
  it("returns null for pure tool-call JSON (AC5 regression guard)", () => {
    expect(sanitizeModelText('{"type": "function", "name": "fetch_issue", "parameters": {}}')).toBeNull();
  });

  it("returns null for JSON that starts with {\"type\": \"function\" (AC5)", () => {
    const s = JSON.stringify({ type: "function", name: "bash", parameters: { cmd: "ls" } });
    expect(sanitizeModelText(s)).toBeNull();
  });

  it("returns null for a JSON array payload", () => {
    expect(sanitizeModelText('[{"tool":"bash"}]')).toBeNull();
  });

  it("returns null for wake-payload echo lines", () => {
    expect(sanitizeModelText("You are woken by reason: issue_assigned")).toBeNull();
    expect(sanitizeModelText("You are agent abc123 running as CTO")).toBeNull();
    expect(sanitizeModelText("The above agent instructions were loaded from /path")).toBeNull();
    expect(sanitizeModelText("Treat this wake payload as the highest-priority context")).toBeNull();
  });

  it("returns null when the model self-identifies as an agent (internal monologue, SAG-773 evidence)", () => {
    // SSI Director leaked: "I am agent 7cc4dafd... The latest comment on issue SAG-773..."
    const leaked =
      "I am agent 7cc4dafd-b41f-469c-b8ea-7b4110a11fe8 (SSI Director). The latest comment on issue SAG-773 is from agent 3ab7fa06. I will respond with a status update.";
    expect(sanitizeModelText(leaked)).toBeNull();
  });

  it("strips internal XML blocks and returns remaining text", () => {
    expect(sanitizeModelText("<analysis>internal</analysis>\n\nPosted comment.")).toBe("Posted comment.");
    expect(sanitizeModelText("<thinking>internal</thinking>\n\nDone.")).toBe("Done.");
  });

  it("returns null when nothing remains after stripping XML", () => {
    expect(sanitizeModelText("<analysis>only internal content here</analysis>")).toBeNull();
  });

  it("returns natural-language text unchanged", () => {
    const text = "Moved issue to in_progress and posted update.";
    expect(sanitizeModelText(text)).toBe(text);
  });

  it("returns null for whitespace-only input", () => {
    expect(sanitizeModelText("   \n  ")).toBeNull();
  });
});
