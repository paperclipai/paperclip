import { describe, expect, it } from "vitest";

import { parseHermesOutput } from "./execute.js";

/**
 * The session id picked here selects which session the ledger is read for, so
 * it decides what this run is billed. It must come from the CLI's trailing
 * marker and never from the model's own answer.
 */
describe("parseHermesOutput session id", () => {
  it("takes the trailing marker as the session id", () => {
    const parsed = parseHermesOutput("the answer\n\nsession_id: abc123\n", "");
    expect(parsed.sessionId).toBe("abc123");
    expect(parsed.response).toBe("the answer");
  });

  it("ignores a session_id line written by the model itself", () => {
    // An agent explaining session handling writes the marker's own shape. The
    // real marker is still the last line Hermes prints.
    const stdout = [
      "To resume a run, Hermes prints a line like",
      "session_id: example-from-the-answer",
      "which you pass back with --resume.",
      "",
      "session_id: real-session-9f2a",
      "",
    ].join("\n");

    const parsed = parseHermesOutput(stdout, "");
    expect(parsed.sessionId).toBe("real-session-9f2a");
    // The prose survives; `cleanResponse` drops any session_id line from it.
    expect(parsed.response).toContain("To resume a run");
    expect(parsed.response).toContain("--resume");
    expect(parsed.response).not.toContain("session_id:");
  });

  it("has no session id when the CLI printed no marker", () => {
    expect(parseHermesOutput("just an answer\n", "").sessionId).toBeUndefined();
  });
});
