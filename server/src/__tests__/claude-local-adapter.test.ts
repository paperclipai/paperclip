import { describe, expect, it, vi } from "vitest";
import {
  isClaudeMaxTurnsResult,
  isClaudeUsageLimitResult,
  extractClaudeUsageLimitReset,
} from "@paperclipai/adapter-claude-local/server";
import { parseClaudeStdoutLine } from "@paperclipai/adapter-claude-local/ui";
import { printClaudeStreamEvent } from "@paperclipai/adapter-claude-local/cli";

describe("claude_local max-turn detection", () => {
  it("detects max-turn exhaustion by subtype", () => {
    expect(
      isClaudeMaxTurnsResult({
        subtype: "error_max_turns",
        result: "Reached max turns",
      }),
    ).toBe(true);
  });

  it("detects max-turn exhaustion by stop_reason", () => {
    expect(
      isClaudeMaxTurnsResult({
        stop_reason: "max_turns",
      }),
    ).toBe(true);
  });

  it("returns false for non-max-turn results", () => {
    expect(
      isClaudeMaxTurnsResult({
        subtype: "success",
        stop_reason: "end_turn",
      }),
    ).toBe(false);
  });
});

describe("claude_local ui stdout parser", () => {
  it("maps assistant text, thinking, tool calls, and tool results into transcript entries", () => {
    const ts = "2026-03-29T00:00:00.000Z";

    expect(
      parseClaudeStdoutLine(
        JSON.stringify({
          type: "system",
          subtype: "init",
          model: "claude-sonnet-4-6",
          session_id: "claude-session-1",
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "init",
        ts,
        model: "claude-sonnet-4-6",
        sessionId: "claude-session-1",
      },
    ]);

    expect(
      parseClaudeStdoutLine(
        JSON.stringify({
          type: "assistant",
          session_id: "claude-session-1",
          message: {
            content: [
              { type: "text", text: "I will inspect the repo." },
              { type: "thinking", thinking: "Checking the adapter wiring" },
              { type: "tool_use", id: "tool_1", name: "bash", input: { command: "ls -1" } },
            ],
          },
        }),
        ts,
      ),
    ).toEqual([
      { kind: "assistant", ts, text: "I will inspect the repo." },
      { kind: "thinking", ts, text: "Checking the adapter wiring" },
      { kind: "tool_call", ts, name: "bash", toolUseId: "tool_1", input: { command: "ls -1" } },
    ]);

    expect(
      parseClaudeStdoutLine(
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_1",
                content: [{ type: "text", text: "AGENTS.md\nREADME.md" }],
                is_error: false,
              },
            ],
          },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "tool_1",
        content: "AGENTS.md\nREADME.md",
        isError: false,
      },
    ]);
  });
});

function stripAnsi(value: string) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("claude_local cli formatter", () => {
  it("prints the user-visible and background transcript events from stream-json output", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      printClaudeStreamEvent(
        JSON.stringify({
          type: "system",
          subtype: "init",
          model: "claude-sonnet-4-6",
          session_id: "claude-session-1",
        }),
        false,
      );
      printClaudeStreamEvent(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "I will inspect the repo." },
              { type: "thinking", thinking: "Checking the adapter wiring" },
              { type: "tool_use", id: "tool_1", name: "bash", input: { command: "ls -1" } },
            ],
          },
        }),
        false,
      );
      printClaudeStreamEvent(
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_1",
                content: [{ type: "text", text: "AGENTS.md\nREADME.md" }],
                is_error: false,
              },
            ],
          },
        }),
        false,
      );
      printClaudeStreamEvent(
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "Done",
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
          total_cost_usd: 0.00042,
        }),
        false,
      );

      const lines = spy.mock.calls
        .map((call) => call.map((value) => String(value)).join(" "))
        .map(stripAnsi);

      expect(lines).toEqual(
        expect.arrayContaining([
          "Claude initialized (model: claude-sonnet-4-6, session: claude-session-1)",
          "assistant: I will inspect the repo.",
          "thinking: Checking the adapter wiring",
          "tool_call: bash",
          '{\n  "command": "ls -1"\n}',
          "tool_result",
          "AGENTS.md\nREADME.md",
          "result:",
          "Done",
          "tokens: in=10 out=5 cached=2 cost=$0.000420",
        ]),
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe("claude_local usage-limit detection", () => {
  it("detects the observed 'You've hit your limit' phrasing", () => {
    expect(
      isClaudeUsageLimitResult({
        subtype: "success",
        result: "You've hit your limit · resets 10am (UTC)",
      }),
    ).toBe(true);
  });

  it("detects the apostrophe-less variant", () => {
    expect(
      isClaudeUsageLimitResult({
        subtype: "success",
        result: "Youve hit your limit — try again later",
      }),
    ).toBe(true);
  });

  it("detects 'usage limit reached' phrasing", () => {
    expect(
      isClaudeUsageLimitResult({
        result: "Claude usage limit reached for this subscription window",
      }),
    ).toBe(true);
  });

  it("detects 'rate limit exceeded' phrasing", () => {
    expect(
      isClaudeUsageLimitResult({
        result: "Rate limit exceeded — please slow down",
      }),
    ).toBe(true);
  });

  it("detects the marker in an errors[] entry", () => {
    expect(
      isClaudeUsageLimitResult({
        result: "",
        errors: [{ message: "You've hit your limit · resets at 10am UTC" }],
      }),
    ).toBe(true);
  });

  it("detects the marker from a plain-string errors[] entry", () => {
    expect(
      isClaudeUsageLimitResult({
        errors: ["usage limit reached"],
      }),
    ).toBe(true);
  });

  it("returns false for unrelated failures", () => {
    expect(
      isClaudeUsageLimitResult({
        subtype: "error_max_turns",
        result: "Reached max turns",
      }),
    ).toBe(false);
  });

  it("returns false for auth-required failures", () => {
    expect(
      isClaudeUsageLimitResult({
        result: "Please log in with `claude login` to continue",
      }),
    ).toBe(false);
  });

  it("returns false for null/empty input", () => {
    expect(isClaudeUsageLimitResult(null)).toBe(false);
    expect(isClaudeUsageLimitResult(undefined)).toBe(false);
    expect(isClaudeUsageLimitResult({})).toBe(false);
  });

  it("does not match 'limit' in unrelated contexts", () => {
    expect(
      isClaudeUsageLimitResult({
        result: "Updated the time limit constant in config.ts",
      }),
    ).toBe(false);
  });
});

describe("extractClaudeUsageLimitReset", () => {
  const NOW = new Date("2026-04-08T06:00:00.000Z");

  it("parses 'resets 10am (UTC)'", () => {
    const out = extractClaudeUsageLimitReset(
      { result: "You've hit your limit · resets 10am (UTC)" },
      NOW,
    );
    expect(out).toBe("2026-04-08T10:00:00.000Z");
  });

  it("rolls forward to tomorrow when reset hour is already past", () => {
    const afternoon = new Date("2026-04-08T14:00:00.000Z");
    const out = extractClaudeUsageLimitReset(
      { result: "You've hit your limit · resets 10am (UTC)" },
      afternoon,
    );
    expect(out).toBe("2026-04-09T10:00:00.000Z");
  });

  it("parses 'resets 3pm (UTC)'", () => {
    const out = extractClaudeUsageLimitReset(
      { result: "You've hit your limit · resets 3pm (UTC)" },
      NOW,
    );
    expect(out).toBe("2026-04-08T15:00:00.000Z");
  });

  it("parses '12pm' as noon", () => {
    const out = extractClaudeUsageLimitReset(
      { result: "You've hit your limit · resets 12pm (UTC)" },
      NOW,
    );
    expect(out).toBe("2026-04-08T12:00:00.000Z");
  });

  it("parses '12am' as midnight", () => {
    const out = extractClaudeUsageLimitReset(
      { result: "You've hit your limit · resets 12am (UTC)" },
      NOW,
    );
    expect(out).toBe("2026-04-09T00:00:00.000Z");
  });

  it("parses 'resets 2:30pm (UTC)' with minutes", () => {
    const out = extractClaudeUsageLimitReset(
      { result: "You've hit your limit · resets 2:30pm (UTC)" },
      NOW,
    );
    expect(out).toBe("2026-04-08T14:30:00.000Z");
  });

  it("parses 24-hour format 'resets 14:00 UTC'", () => {
    const out = extractClaudeUsageLimitReset(
      { result: "Usage limit reached — resets 14:00 UTC" },
      NOW,
    );
    expect(out).toBe("2026-04-08T14:00:00.000Z");
  });

  it("tolerates 'resets at 10am UTC'", () => {
    const out = extractClaudeUsageLimitReset(
      { result: "Usage limit reached — resets at 10am UTC" },
      NOW,
    );
    expect(out).toBe("2026-04-08T10:00:00.000Z");
  });

  it("extracts from errors[] entries", () => {
    const out = extractClaudeUsageLimitReset(
      { result: "", errors: [{ message: "You've hit your limit · resets 10am (UTC)" }] },
      NOW,
    );
    expect(out).toBe("2026-04-08T10:00:00.000Z");
  });

  it("returns null when usage-limit marker is absent", () => {
    expect(
      extractClaudeUsageLimitReset({ result: "Max turns exceeded" }, NOW),
    ).toBeNull();
  });

  it("returns null when marker present but time unparseable", () => {
    expect(
      extractClaudeUsageLimitReset({ result: "You've hit your limit" }, NOW),
    ).toBeNull();
  });

  it("returns null for null/undefined/empty input", () => {
    expect(extractClaudeUsageLimitReset(null, NOW)).toBeNull();
    expect(extractClaudeUsageLimitReset(undefined, NOW)).toBeNull();
    expect(extractClaudeUsageLimitReset({}, NOW)).toBeNull();
  });

  it("returns null for unrelated text containing 'resets 10am'", () => {
    expect(
      extractClaudeUsageLimitReset(
        { result: "The cron resets 10am UTC every day — this is just docs" },
        NOW,
      ),
    ).toBeNull();
  });
});
