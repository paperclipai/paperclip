/**
 * Tests for parseHermesOutput — the Hermes quiet-mode output parser.
 *
 * Imports the production parser from execute.ts directly (no re-implemented
 * regexes here) so these tests fail if the shipped parsing behavior changes.
 *
 * Covers the two edges from the quiet-output parsing bug:
 *   1. session_id emitted before response text in quiet mode
 *   2. session_id emitted on stderr (cancelled sessions)
 *
 * Also preserves the existing false-green/error semantics:
 *   - Successful terminal narration must not become an adapter error
 *   - Real stderr errors must be retained
 *   - Prose or placeholder tokens must never become resumable session metadata
 */

import { describe, expect, it } from "vitest";

import { isResumableSessionId, parseHermesOutput } from "./execute.js";

describe("parseHermesOutput", () => {
  describe("session_id extraction", () => {
    it("extracts session_id from stdout (normal quiet mode)", () => {
      const parsed = parseHermesOutput(
        "Task completed successfully.\n\nsession_id: abc123\n",
        "",
      );
      expect(parsed.sessionId).toBe("abc123");
      expect(parsed.response).toBe("Task completed successfully.");
    });

    it("extracts session_id from stderr (cancelled session edge)", () => {
      // Hermes 0.18.2 may emit session_id on stderr for cancelled sessions
      const parsed = parseHermesOutput(
        "Task completed successfully.\n",
        "session_id: abc123\n",
      );
      expect(parsed.sessionId).toBe("abc123");
      expect(parsed.response).toBe("Task completed successfully.");
    });

    it("extracts session_id when it appears before response text", () => {
      // Hermes 0.18.2 edge: session_id first, then response
      const parsed = parseHermesOutput(
        "session_id: abc123\nTask completed successfully.\n",
        "",
      );
      expect(parsed.sessionId).toBe("abc123");
      // cleanResponse strips session_id lines, so response should be clean
      expect(parsed.response).toBe("Task completed successfully.");
    });

    it("extracts session_id when it appears after response text", () => {
      const parsed = parseHermesOutput(
        "Task completed successfully.\n\nsession_id: abc123\n",
        "",
      );
      expect(parsed.sessionId).toBe("abc123");
      expect(parsed.response).toBe("Task completed successfully.");
    });

    it("extracts legacy session format", () => {
      const parsed = parseHermesOutput(
        "Some output\nsession saved: legacy-456\n",
        "",
      );
      expect(parsed.sessionId).toBe("legacy-456");
    });

    it("returns undefined sessionId when no session line present", () => {
      const parsed = parseHermesOutput("Just some output.\n", "");
      expect(parsed.sessionId).toBeUndefined();
    });

    it("does not match inline prose mentioning session_id (anchor guard)", () => {
      // The line anchors on the session regex prevent matching prose like:
      //   "I checked the session_id: it was valid."
      // Only a genuine "session_id: <single-token>" on its own line should match.
      const parsed = parseHermesOutput(
        "I checked the session_id: it was valid.\n\nsession_id: abc123\n",
        "",
      );
      expect(parsed.sessionId).toBe("abc123");
      // The prose line should be preserved in the response (not stripped as metadata)
      expect(parsed.response).toContain("session_id: it was valid");
    });

    it("does not extract a sessionId from multi-token prose", () => {
      // "session_id: this is response text" is agent prose. The anchored quiet
      // regex cannot match it (non-whitespace remains after "this"), and the
      // legacy fallback's "this" candidate fails isResumableSessionId(), so no
      // session metadata is produced at all.
      const parsed = parseHermesOutput(
        "session_id: this is response text\n",
        "",
      );
      expect(parsed.sessionId).toBeUndefined();
      // The response keeps the prose (not stripped by cleanResponse
      // since the line isn't a pure session_id line)
      expect(parsed.response).toContain("session_id: this is response text");
    });

    it("does not persist placeholder tokens as session metadata", () => {
      // "session_id: unavailable" is a single token and matches the quiet
      // regex shape, but it is a placeholder, not a session id. Persisting it
      // would make the next run attempt `--resume unavailable`.
      const parsed = parseHermesOutput(
        "I could not create a session.\n\nsession_id: unavailable\n",
        "",
      );
      expect(parsed.sessionId).toBeUndefined();
      expect(parsed.response).toContain("I could not create a session.");
    });

    it("skips an invalid candidate and still finds a later real session id", () => {
      const parsed = parseHermesOutput(
        "session_id: unavailable\nRetried and succeeded.\n\nsession_id: abc123\n",
        "",
      );
      expect(parsed.sessionId).toBe("abc123");
    });

    it("does not extract legacy sessionId from mid-line (anchor guard)", () => {
      // The ^ anchor on the legacy session regex prevents matching inline text.
      const parsed = parseHermesOutput(
        "The session id: fake-123 was mentioned inline\nsession saved: real-456\n",
        "",
      );
      expect(parsed.sessionId).toBe("real-456");
    });
  });

  describe("isResumableSessionId", () => {
    it.each(["abc123", "session-1", "20260718_200327_457d83", "crlf-1"])(
      "accepts id-shaped token %s",
      (token) => {
        expect(isResumableSessionId(token)).toBe(true);
      },
    );

    it.each(["unavailable", "Unavailable", "none", "null", "unknown", "n/a"])(
      "rejects placeholder token %s",
      (token) => {
        expect(isResumableSessionId(token)).toBe(false);
      },
    );

    it.each(["this", "ab", "", "has space", "-leading"])(
      "rejects non-id-shaped token %j",
      (token) => {
        expect(isResumableSessionId(token)).toBe(false);
      },
    );
  });

  describe("response preservation (false-green prevention)", () => {
    it("preserves successful terminal narration", () => {
      const narration = "The live checks are conclusive: JAC-3307 is done. I am closing the incident now.";
      const parsed = parseHermesOutput(
        `${narration}\n\nsession_id: session-1\n`,
        `Captured reasoning: ${narration}\n`,
      );
      expect(parsed.response).toContain("JAC-3307 is done");
      expect(parsed.errorMessage).toBeUndefined();
    });

    it("preserves multi-paragraph responses", () => {
      const parsed = parseHermesOutput(
        "First paragraph.\n\nSecond paragraph.\n\nsession_id: abc123\n",
        "",
      );
      expect(parsed.response).toContain("First paragraph.");
      expect(parsed.response).toContain("Second paragraph.");
    });

    it("strips tool noise from response", () => {
      const parsed = parseHermesOutput(
        "[tool] Running search...\nActual response text.\n\nsession_id: abc123\n",
        "",
      );
      expect(parsed.response).toBe("Actual response text.");
      expect(parsed.response).not.toContain("[tool]");
    });

    it("preserves inline session_id prose (not a genuine session_id line)", () => {
      // A mid-line "session_id: abc123" mention is agent prose, not metadata,
      // because the line doesn't consist solely of "session_id: <token>".
      const parsed = parseHermesOutput(
        "The session_id: abc123 was the one I used.\n\nsession_id: real-session-id\n",
        "",
      );
      expect(parsed.sessionId).toBe("real-session-id");
      expect(parsed.response).toContain("session_id: abc123 was the one I used");
    });
  });

  describe("error detection", () => {
    it("retains stderr failure diagnostics", () => {
      const parsed = parseHermesOutput("", "ERROR: provider unavailable\n");
      expect(parsed.errorMessage).toBe("ERROR: provider unavailable");
    });

    it("does not flag session_id on stderr as an error", () => {
      const parsed = parseHermesOutput(
        "Task completed.\n",
        "session_id: abc123\n",
      );
      expect(parsed.errorMessage).toBeUndefined();
    });

    it("filters INFO/DEBUG/WARN noise from error detection", () => {
      const parsed = parseHermesOutput(
        "",
        "INFO: Starting up\nERROR: real failure\nDEBUG: some detail\n",
      );
      expect(parsed.errorMessage).toBe("ERROR: real failure");
    });

    it("returns undefined errorMessage for clean stderr", () => {
      const parsed = parseHermesOutput("All good.\n", "");
      expect(parsed.errorMessage).toBeUndefined();
    });
  });

  describe("usage and cost extraction", () => {
    it("extracts token usage", () => {
      const parsed = parseHermesOutput(
        "Response.\n\nsession_id: abc123\n",
        "tokens: 150 input, 80 output\n",
      );
      expect(parsed.usage).toEqual({ inputTokens: 150, outputTokens: 80 });
    });

    it("extracts cost", () => {
      const parsed = parseHermesOutput(
        "Response.\n",
        "cost: $0.042\n",
      );
      expect(parsed.costUsd).toBe(0.042);
    });
  });
});
