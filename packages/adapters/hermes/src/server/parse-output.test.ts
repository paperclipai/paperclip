import { describe, expect, it } from "vitest";
import { parseHermesOutput } from "./execute.js";

/** One stream-json event line, as Hermes writes it. */
function event(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

const resultEvent = event({
  type: "result",
  session_id: "local-1a4f01603f88",
  exit_code: 0,
  text: "PARSE-TEST",
  tokens: { input: 12522, output: 65, total: 12587, cache_read: 10240, cache_write: 0 },
});

describe("parseHermesOutput with stream-json", () => {
  it("takes the response and session id from the result event, and no usage", () => {
    const stdout = [
      event({ type: "system", model: "k3.1-pro" }),
      event({ type: "text", text: "working" }),
      event({ type: "tool_use", name: "terminal" }),
      resultEvent,
    ].join("\n");

    const parsed = parseHermesOutput(stdout, "");

    expect(parsed.sessionId).toBe("local-1a4f01603f88");
    expect(parsed.response).toBe("PARSE-TEST");
    // `tokens.input` folds the cache into the context of the final call, so it
    // is not a fresh-input count. Usage comes from the Hermes ledger instead.
    expect(parsed.usage).toBeUndefined();
    expect(parsed.errorMessage).toBeUndefined();
  });

  it("uses the last result event when a stream carries more than one", () => {
    const stdout = [
      resultEvent,
      event({ type: "result", session_id: "local-second", text: "final", tokens: { input: 5, output: 6 } }),
    ].join("\n");

    const parsed = parseHermesOutput(stdout, "");

    expect(parsed.sessionId).toBe("local-second");
    expect(parsed.response).toBe("final");
    expect(parsed.usage).toBeUndefined();
  });

  it("surfaces an error reported in the result event", () => {
    const stdout = event({ type: "result", session_id: "local-x", error: "provider unavailable" });
    expect(parseHermesOutput(stdout, "").errorMessage).toBe("provider unavailable");
  });

  it("falls back to quiet-mode text output when no event is present", () => {
    const stdout = "Antwort\n\nsession_id: local-plain-123";

    const parsed = parseHermesOutput(stdout, "");

    expect(parsed.sessionId).toBe("local-plain-123");
    expect(parsed.response).toBe("Antwort");
  });

  it("ignores malformed lines instead of failing the run", () => {
    const stdout = ["{not json", event({ type: "text", text: "x" }), resultEvent].join("\n");
    expect(parseHermesOutput(stdout, "").sessionId).toBe("local-1a4f01603f88");
  });
});

describe("parseHermesOutput against real hermes chat output", () => {
  // Captured from `hermes chat -q "sag nur OK" --format stream-json`. The
  // System/Session banner lines are plain text and must not confuse the parser.
  const captured = [
    '{"type": "system", "subtype": "init", "model": "k3.1-pro", "session_id": "", "timestamp": 1793987485321}',
    "Session: local-cc587d60b69f34e4c19d0094995aa0c2d9081ccb762f06c9609bbabd8235e242",
    '{"type": "text", "text": "OK", "timestamp": 1793987488883}',
    '{"type": "result", "session_id": "local-cc587d60b69f34e4c19d0094995aa0c2d9081ccb762f06c9609bbabd8235e242", "exit_code": 0, "text": "OK", "tokens": {"input": 25181, "output": 48, "total": 25229, "cache_read": 25181, "cache_write": 0}, "duration_ms": 8112, "timestamp": 1793987488883}',
    "",
    "session_id: local-cc587d60b69f34e4c19d0094995aa0c2d9081ccb762f06c9609bbabd8235e242",
  ].join("\n");

  it("reads the session and response of a real run", () => {
    const parsed = parseHermesOutput(captured, "");
    expect(parsed.sessionId).toMatch(/^local-[0-9a-f]{8}/);
    expect(parsed.response).toBe("OK");
    // The captured run reported tokens.input 25181 with cache_read 25181: the
    // input field is the whole context, cache included. Never split it by hand.
    expect(parsed.usage).toBeUndefined();
  });
});
