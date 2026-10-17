import { expect, test } from "vitest";

import { parseHermesOutput } from "./execute.js";

// The exit summary Hermes actually prints after a non-quiet turn, captured by
// driving the real `_print_exit_summary(clear_screen=False)` in
// hermes_cli/cli_session_mixin.py — the same method cli_single_query.py calls
// on the `-q` path — against the en locale. The labels are plain `print()`
// calls rather than Rich output, so unlike the query echo nothing re-wraps
// them. Note the label is "Session:", not "session_id:" or "session saved:".
const EXIT_SUMMARY =
  "\nResume this session with:\n  hermes --resume 20261001_120157_05292c\n\nSession:        20261001_120157_05292c\nDuration:       1m 13s\nMessages:       3 (1 user, 1 tool calls)\n";

// Same method under a non-default profile (HERMES_HOME pointed at
// <root>/profiles/work), which appends the profile flag to the resume command.
const EXIT_SUMMARY_PROFILE =
  "\nResume this session with:\n  hermes --resume 20261001_120114_861653 -p work\n\nSession:        20261001_120114_861653\nDuration:       1m 13s\nMessages:       3 (1 user, 1 tool calls)\n";

test("captures the session id from a non-quiet exit summary", () => {
  const parsed = parseHermesOutput(`Done.\n${EXIT_SUMMARY}`, "");
  expect(parsed.sessionId).toBe("20261001_120157_05292c");
});

test("captures the session id when a profile flag follows it", () => {
  const parsed = parseHermesOutput(`Done.\n${EXIT_SUMMARY_PROFILE}`, "");
  expect(parsed.sessionId).toBe("20261001_120114_861653");
});

// These agents write about Hermes, so a response quoting a resume command is
// ordinary traffic. Hermes prints the summary last, so the last match is the
// real one. The decoy has to sit on its own indented line: a command inside
// backticks mid-sentence never matches the pattern, so it would test nothing.
const QUOTED_DECOY = "Resume it with:\n  hermes --resume 20250101_000000_decoy\n";

test("prefers the trailing summary over a resume command quoted in the response", () => {
  const parsed = parseHermesOutput(QUOTED_DECOY + EXIT_SUMMARY, "");
  expect(parsed.sessionId).toBe("20261001_120157_05292c");
});

// An older Hermes prints "session saved:" and no resume hint. The quoted decoy
// then has no real hint to lose to, so position — not which pattern matched —
// has to decide, or the next turn resumes the wrong session.
test("keeps a trailing legacy id over a resume command quoted above it", () => {
  const parsed = parseHermesOutput(
    `${QUOTED_DECOY}\nsession saved: 20261001_120157_05292c\n`,
    "",
  );
  expect(parsed.sessionId).toBe("20261001_120157_05292c");
});

test("still reads the quiet-mode session_id line", () => {
  const parsed = parseHermesOutput("Done.\n\nsession_id: 20261001_120157_05292c\n", "");
  expect(parsed.sessionId).toBe("20261001_120157_05292c");
  expect(parsed.response).toBe("Done.");
});
