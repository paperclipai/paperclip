import { expect, test } from "vitest";

import { createStreamJsonConsumer } from "./execute.js";

/**
 * Real stdout, captured verbatim from Hermes Agent v0.21.5 with:
 *
 *   hermes chat -q "Run the shell command: echo paperclip-stream-json-fixture.
 *     Then tell me exactly what it printed." --format stream-json --source tool --yolo
 *
 * It exercises every event the emitter produces (hermes_cli/stream_json.py):
 * `system`/`init`, a `tool_use`/`tool_result` pair, `text` deltas, and the
 * terminal `result` envelope. Note the deltas split mid-word ("ex" + "actly:")
 * — the protocol makes no promise about where a delta ends, and neither does
 * the pipe about where a chunk ends.
 */
const FIXTURE = [
  `{"type": "system", "subtype": "init", "model": "", "session_id": "20261001_120225_fb6837", "timestamp": 1790870545442}`,
  `{"type": "tool_use", "name": "terminal", "input": {"command": "echo paperclip-stream-json-fixture"}, "timestamp": 1790870551105}`,
  `{"type": "tool_result", "name": "terminal", "output": "{\\"output\\": \\"paperclip-stream-json-fixture\\", \\"exit_code\\": 0, \\"error\\": null}", "duration_ms": 67, "is_error": false, "timestamp": 1790870551169}`,
  `{"type": "text", "text": "\\n\\nIt", "timestamp": 1790870561020}`,
  `{"type": "text", "text": " printed ex", "timestamp": 1790870561024}`,
  `{"type": "text", "text": "actly:\\n\\npaperclip", "timestamp": 1790870561029}`,
  `{"type": "text", "text": "-stream-json-fix", "timestamp": 1790870561029}`,
  `{"type": "text", "text": "ture\\n\\n(exit code 0", "timestamp": 1790870561030}`,
  `{"type": "text", "text": ")", "timestamp": 1790870561030}`,
  `{"type": "result", "session_id": "20261001_120225_fb6837", "exit_code": 0, "text": "It printed exactly:\\n\\npaperclip-stream-json-fixture\\n\\n(exit code 0)", "tokens": {"input": 6, "output": 92, "total": 39641, "cache_read": 36179, "cache_write": 3364}, "duration_ms": 15614, "timestamp": 1790870561056}`,
].join("\n") + "\n";

/** Feed the fixture in one go and hand back the finished consumer plus its transcript. */
function run(chunks: string[]) {
  const consume = createStreamJsonConsumer();
  const shown = chunks.map(consume).join("") + consume.flush();
  return { shown, parsed: consume.parsed };
}

test("parses the session id, usage and final response from a real run", () => {
  const { parsed } = run([FIXTURE]);

  expect(parsed.sessionId).toBe("20261001_120225_fb6837");
  expect(parsed.response).toBe(
    "It printed exactly:\n\npaperclip-stream-json-fixture\n\n(exit code 0)",
  );
  // 6 fresh input + 3364 written to the cache. Writing the cache is billed as
  // input, and UsageSummary has no field of its own for it, so it is counted
  // here the way claude-local counts cacheCreationInputTokens.
  expect(parsed.usage).toEqual({
    inputTokens: 6 + 3364,
    outputTokens: 92,
    cachedInputTokens: 36179,
  });
  expect(parsed.errorMessage).toBeUndefined();
});

// Hermes computes estimated_cost_usd for a run but emit_result does not copy it
// into the envelope, so there is no cost on the wire to read yet. This test is
// the tripwire: when Hermes starts sending it, this flips and the field is
// already wired through to AdapterExecutionResult.costUsd.
test("reports no cost, because the envelope carries none", () => {
  expect(run([FIXTURE]).parsed.costUsd).toBeUndefined();
});

test("shows the answer in the transcript without the raw JSON", () => {
  const { shown } = run([FIXTURE]);

  expect(shown).toContain("It printed exactly:");
  expect(shown).toContain("paperclip-stream-json-fixture");
  expect(shown).not.toContain(`"type"`);
  expect(shown).not.toContain("timestamp");
});

test("renders a completed tool as a line the UI parses into a tool card", () => {
  const { shown } = run([FIXTURE]);
  const toolLine = shown.split("\n").find((line) => line.includes("┊"));

  // "  ┊ {name} {input}  {duration}s" — the shape src/ui/parse-stdout.ts reads.
  expect(toolLine).toBe(
    `  ┊ terminal {"command":"echo paperclip-stream-json-fixture"}  0.1s`,
  );
});

test("marks a failed tool so the card renders as an error", () => {
  const { shown } = run([
    `{"type": "tool_use", "name": "terminal", "input": {"command": "false"}}\n`,
    `{"type": "tool_result", "name": "terminal", "output": "", "duration_ms": 12, "is_error": true}\n`,
  ]);

  expect(shown.trim()).toBe(`┊ terminal {"command":"false"} [error]  0.0s`);
});

// A delta almost never ends on a newline, and parse-stdout.ts only reads a
// line as a tool card when `┊` opens it. Without a break the card would be
// glued to the answer and shown as raw text.
// https://github.com/paperclipai/paperclip/pull/14860#discussion_r4157187829
test("opens a new line for a tool card that follows an unfinished answer", () => {
  const { shown } = run([
    `{"type": "text", "text": "Let me check that"}\n`,
    `{"type": "tool_use", "name": "terminal", "input": {"command": "ls"}}\n`,
    `{"type": "tool_result", "name": "terminal", "output": "a", "duration_ms": 30}\n`,
  ]);

  expect(shown).toBe(`Let me check that\n  ┊ terminal {"command":"ls"}  0.0s\n`);
  // The card must be the whole line for the UI to read it as one.
  expect(shown.split("\n")[1].trimStart().startsWith("┊")).toBe(true);
});

test("does not add a blank line when the answer already ended one", () => {
  const { shown } = run([
    `{"type": "text", "text": "Checking.\\n"}\n`,
    `{"type": "tool_use", "name": "terminal", "input": {"command": "ls"}}\n`,
    `{"type": "tool_result", "name": "terminal", "output": "a", "duration_ms": 30}\n`,
  ]);

  expect(shown).toBe(`Checking.\n  ┊ terminal {"command":"ls"}  0.0s\n`);
});

// Hermes sends tool_call_id only when the provider supplies one, so two live
// calls to the same tool can share a key. The first start must still pair with
// the first completion.
// https://github.com/paperclipai/paperclip/pull/14860#discussion_r4157187835
test("keeps each input with its own call when two of the same tool overlap", () => {
  const { shown } = run([
    `{"type": "tool_use", "name": "terminal", "input": {"command": "first"}}\n`,
    `{"type": "tool_use", "name": "terminal", "input": {"command": "second"}}\n`,
    `{"type": "tool_result", "name": "terminal", "output": "", "duration_ms": 10}\n`,
    `{"type": "tool_result", "name": "terminal", "output": "", "duration_ms": 20}\n`,
  ]);

  const lines = shown.trimEnd().split("\n");
  expect(lines[0]).toContain(`{"command":"first"}`);
  expect(lines[1]).toContain(`{"command":"second"}`);
});

// A pipe splits wherever it likes, so a chunk can hold half an event — the same
// boundary problem the prompt-echo filter has (PR #14845).
test("parses the same run when stdout is split into small chunks", () => {
  const chunks: string[] = [];
  for (let i = 0; i < FIXTURE.length; i += 7) chunks.push(FIXTURE.slice(i, i + 7));

  const split = run(chunks);
  const whole = run([FIXTURE]);
  expect(split.parsed).toEqual(whole.parsed);
  expect(split.shown).toBe(whole.shown);
});

test("keeps the session id from init when the run dies before the result event", () => {
  const initOnly = FIXTURE.slice(0, FIXTURE.indexOf("\n") + 1);
  const { parsed } = run([initOnly]);

  expect(parsed.sessionId).toBe("20261001_120225_fb6837");
  expect(parsed.response).toBeUndefined();
});

// Anything Hermes writes that is not an event is still output worth seeing;
// swallowing it is how a transcript loses an answer.
test("passes non-JSON stdout through untouched", () => {
  const noise = "Traceback (most recent call last):\n  File \"hermes\", line 1\n";
  expect(run([noise]).shown).toBe(noise);
});

test("passes through a JSON line that is not an event object", () => {
  expect(run(["[1,2,3]\n"]).shown).toBe("[1,2,3]\n");
  expect(run(["42\n"]).shown).toBe("42\n");
});

test("flushes a final line that never got its newline", () => {
  const unterminated = FIXTURE.trimEnd();
  const { parsed } = run([unterminated]);

  expect(parsed.sessionId).toBe("20261001_120225_fb6837");
  expect(parsed.usage?.outputTokens).toBe(92);
});

// Not every provider streams. Without the fallback the user would see an empty
// chat next to a run that answered fine.
test("shows the final text when the run produced no deltas", () => {
  const { shown, parsed } = run([
    `{"type": "result", "session_id": "s1", "text": "Done.", "tokens": {"input": 1, "output": 2}}\n`,
  ]);

  expect(shown).toBe("Done.\n");
  expect(parsed.response).toBe("Done.");
});

test("surfaces an error reported in the result envelope", () => {
  const { parsed } = run([
    `{"type": "result", "session_id": "s1", "exit_code": 1, "text": "", "error": "provider refused the request"}\n`,
  ]);

  expect(parsed.errorMessage).toBe("provider refused the request");
});
