/**
 * UI transcript-parser tests.
 *
 * Verifies that:
 *   - The §4.1 envelope (final stdout line) yields init + result entries.
 *   - The 9 wire notifications on stderr map to the right TranscriptEntry kinds.
 *   - Non-JSON / malformed lines fall through to a stdout entry.
 */

import { describe, expect, it } from "vitest";
import { parseAmplifierLocalStdoutLine } from "../ui/parse-stdout.js";

const TS = "2026-06-03T17:00:00.000Z";

describe("parseAmplifierLocalStdoutLine — envelope path", () => {
  it("yields init + result entries for a successful envelope", () => {
    const envelope = {
      protocolVersion: "0.3.0",
      sessionId: "sess-1",
      turnId: "turn-1",
      reply: "Hello from Amplifier",
      error: null,
      metadata: {
        tokensIn: 100,
        tokensOut: 200,
        durationMs: 1500,
        bundleDigest: "abc123",
        engineVersion: "0.4.1",
      },
    };
    const entries = parseAmplifierLocalStdoutLine(JSON.stringify(envelope), TS);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "init", sessionId: "sess-1" });
    expect(entries[1]).toMatchObject({
      kind: "result",
      text: "Hello from Amplifier",
      inputTokens: 100,
      outputTokens: 200,
      isError: false,
    });
  });

  it("marks the result as error when the envelope has an error block", () => {
    const envelope = {
      protocolVersion: "0.3.0",
      sessionId: "sess-1",
      turnId: "turn-1",
      reply: "",
      error: {
        code: "provider_init_failed",
        message: "OpenAI 401",
        classification: "transport",
      },
      metadata: {},
    };
    const entries = parseAmplifierLocalStdoutLine(JSON.stringify(envelope), TS);
    const result = entries.find((e) => e.kind === "result");
    expect(result).toMatchObject({
      isError: true,
      subtype: "transport",
      errors: ["OpenAI 401"],
    });
  });
});

describe("parseAmplifierLocalStdoutLine — wire notifications", () => {
  function notif(method: string, params: Record<string, unknown>): string {
    return JSON.stringify({ method, params });
  }

  it("maps result/delta to assistant entry", () => {
    const entries = parseAmplifierLocalStdoutLine(
      notif("result/delta", { sessionId: "s", turnId: "t", text: "partial reply" }),
      TS,
    );
    expect(entries).toEqual([{ kind: "assistant", ts: TS, text: "partial reply" }]);
  });

  it("maps tool/started to tool_call entry", () => {
    const entries = parseAmplifierLocalStdoutLine(
      notif("tool/started", {
        sessionId: "s",
        turnId: "t",
        toolCallId: "tc-1",
        name: "bash",
        args: { command: "ls" },
      }),
      TS,
    );
    expect(entries).toEqual([
      {
        kind: "tool_call",
        ts: TS,
        name: "bash",
        input: { command: "ls" },
        toolUseId: "tc-1",
      },
    ]);
  });

  it("maps tool/completed to tool_result with stringified result", () => {
    const entries = parseAmplifierLocalStdoutLine(
      notif("tool/completed", {
        sessionId: "s",
        turnId: "t",
        toolCallId: "tc-1",
        name: "bash",
        result: { stdout: "ok\n" },
        durationMs: 42,
      }),
      TS,
    );
    expect(entries[0]).toMatchObject({
      kind: "tool_result",
      toolUseId: "tc-1",
      isError: false,
    });
    expect((entries[0] as { content: string }).content).toContain("ok");
  });

  it("maps thinking/delta and thinking/final to thinking entries", () => {
    const a = parseAmplifierLocalStdoutLine(
      notif("thinking/delta", { sessionId: "s", turnId: "t", text: "I should..." }),
      TS,
    );
    const b = parseAmplifierLocalStdoutLine(
      notif("thinking/final", { sessionId: "s", turnId: "t", text: "done thinking" }),
      TS,
    );
    expect(a).toEqual([{ kind: "thinking", ts: TS, text: "I should..." }]);
    expect(b).toEqual([{ kind: "thinking", ts: TS, text: "done thinking" }]);
  });

  it("maps progress to system entry with percentage", () => {
    const entries = parseAmplifierLocalStdoutLine(
      notif("progress", {
        sessionId: "s",
        turnId: "t",
        message: "Loading bundle",
        percent: 42,
      }),
      TS,
    );
    expect(entries).toEqual([
      { kind: "system", ts: TS, text: "Loading bundle (42%)" },
    ]);
  });

  it("maps error notification to stderr entry", () => {
    const entries = parseAmplifierLocalStdoutLine(
      notif("error", {
        sessionId: "s",
        turnId: "t",
        code: "tool_execution_failed",
        message: "bash: command not found",
        recoverable: true,
      }),
      TS,
    );
    expect(entries).toEqual([
      { kind: "stderr", ts: TS, text: "bash: command not found" },
    ]);
  });

  it("falls back to stdout entry for non-JSON lines", () => {
    const entries = parseAmplifierLocalStdoutLine("not even json", TS);
    expect(entries).toEqual([{ kind: "stdout", ts: TS, text: "not even json" }]);
  });

  it("returns nothing for blank lines", () => {
    expect(parseAmplifierLocalStdoutLine("", TS)).toEqual([]);
    expect(parseAmplifierLocalStdoutLine("   \t  ", TS)).toEqual([]);
  });
});
