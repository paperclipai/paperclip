import { describe, expect, it, vi } from "vitest";
import {
  isAntigravityTurnLimitResult,
  isAntigravityUnknownSessionError,
  parseAntigravityOutput,
  detectAntigravityQuotaExhausted,
  parseAgyResetDurationMs,
} from "@paperclipai/adapter-antigravity-local/server";
import { parseAntigravityStdoutLine } from "@paperclipai/adapter-antigravity-local/ui";
import { printAntigravityStreamEvent } from "@paperclipai/adapter-antigravity-local/cli";

describe("antigravity_local parser", () => {
  it("extracts session, summary, and terminal error message from text output", () => {
    const stdout = [
      "Antigravity CLI init (session: 45127642-4fab-4b98-9928-dc5527f2222a)",
      "Checking codebase...",
      "Done with task.",
    ].join("\n");
    const stderr = "Warning: low API budget";

    const parsed = parseAntigravityOutput(stdout, stderr);
    expect(parsed.sessionId).toBe("45127642-4fab-4b98-9928-dc5527f2222a");
    expect(parsed.summary).toContain("Done with task.");
    expect(parsed.errorMessage).toBeNull();
  });

  it("extracts session from fallback uuid", () => {
    const stdout = "Traversed workspace for conversation 36fb199d-4706-4eb4-ad46-653e9db5af2a";
    const parsed = parseAntigravityOutput(stdout, "");
    expect(parsed.sessionId).toBe("36fb199d-4706-4eb4-ad46-653e9db5af2a");
  });

  it("extracts errors from stderr", () => {
    const stdout = "Antigravity CLI output";
    const stderr = "Error: Anthropic API key is invalid";
    const parsed = parseAntigravityOutput(stdout, stderr);
    expect(parsed.errorMessage).toBe("Error: Anthropic API key is invalid");
  });
});

describe("antigravity_local stale session detection", () => {
  it("treats missing session messages as an unknown session error", () => {
    expect(isAntigravityUnknownSessionError("", "unknown conversation abc")).toBe(true);
    expect(isAntigravityUnknownSessionError("", "conversation not found")).toBe(true);
    expect(isAntigravityUnknownSessionError("", "cannot resume")).toBe(true);
  });
});

describe("antigravity_local turn-limit detection", () => {
  it("detects structured turn-limit signals and exit code 53", () => {
    expect(isAntigravityTurnLimitResult("turn_limit_exhausted", "")).toBe(true);
    expect(isAntigravityTurnLimitResult("", "", 53)).toBe(true);
  });
});

describe("antigravity_local quota detection", () => {
  it("detects individual quota reached message and computes retryNotBefore", () => {
    const before = Date.now();
    const result = detectAntigravityQuotaExhausted({
      stdout: "",
      stderr: "Individual quota reached. Contact your administrator to enable overages. Resets in 4h3m21s.",
    });
    expect(result.exhausted).toBe(true);
    expect(result.resetHint).toMatch(/resets?\s+in/i);
    // retryNotBefore should be ~4h3m21s + 60s from now
    expect(result.retryNotBefore).not.toBeNull();
    const retryMs = new Date(result.retryNotBefore!).getTime();
    const expectedMs = before + (4 * 3600 + 3 * 60 + 21 + 60) * 1000;
    expect(retryMs).toBeGreaterThanOrEqual(expectedMs - 1000);
    expect(retryMs).toBeLessThanOrEqual(expectedMs + 5000);
  });

  it("detects resource_exhausted and rate-limit errors", () => {
    expect(detectAntigravityQuotaExhausted({ stdout: "resource_exhausted", stderr: "" }).exhausted).toBe(true);
    expect(detectAntigravityQuotaExhausted({ stdout: "", stderr: "rate limit exceeded" }).exhausted).toBe(true);
    expect(detectAntigravityQuotaExhausted({ stdout: "", stderr: "429 Too Many Requests" }).exhausted).toBe(true);
  });

  it("does not flag normal output as quota exhausted", () => {
    const r = detectAntigravityQuotaExhausted({ stdout: "Task completed successfully", stderr: "" });
    expect(r.exhausted).toBe(false);
    expect(r.retryNotBefore).toBeNull();
  });

  it("parseAgyResetDurationMs handles mixed durations", () => {
    expect(parseAgyResetDurationMs("4h3m21s")).toBe((4 * 3600 + 3 * 60 + 21) * 1000);
    expect(parseAgyResetDurationMs("30m")).toBe(30 * 60 * 1000);
    expect(parseAgyResetDurationMs("90s")).toBe(90 * 1000);
    expect(parseAgyResetDurationMs("2h")).toBe(2 * 3600 * 1000);
    expect(parseAgyResetDurationMs("")).toBeNull();
  });
});

describe("antigravity_local ui stdout parser", () => {
  it("parses assistant message and result events", () => {
    const ts = "2026-03-08T00:00:00.000Z";

    expect(
      parseAntigravityStdoutLine(
        JSON.stringify({
          type: "assistant",
          text: "I checked the repo.",
        }),
        ts,
      ),
    ).toEqual([
      { kind: "assistant", ts, text: "I checked the repo." },
    ]);

    expect(
      parseAntigravityStdoutLine("raw text line", ts),
    ).toEqual([
      { kind: "stdout", ts, text: "raw text line" },
    ]);
  });
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("antigravity_local cli formatter", () => {
  it("prints stream events", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    let joined = "";

    try {
      printAntigravityStreamEvent(
        JSON.stringify({ type: "system", subtype: "init", sessionId: "45127642-4fab-4b98-9928-dc5527f2222a" }),
        false,
      );
      printAntigravityStreamEvent(
        JSON.stringify({
          type: "assistant",
          text: "hello",
        }),
        false,
      );
      printAntigravityStreamEvent("plain stdout text", false);
      joined = spy.mock.calls.map((call) => stripAnsi(call.join(" "))).join("\n");
    } finally {
      spy.mockRestore();
    }

    expect(joined).toContain("Antigravity CLI init");
    expect(joined).toContain("assistant: hello");
    expect(joined).toContain("plain stdout text");
  });
});
