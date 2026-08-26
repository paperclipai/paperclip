// Test for parseOpenCodeStdoutLine handling of reasoning events
import { test, expect } from "vitest";
import { parseOpenCodeStdoutLine } from "../parse-stdout";

test("parseOpenCodeStdoutLine returns mixed_answers for reasoning", () => {
  const line = JSON.stringify({
    type: "reasoning",
    part: { text: "<think>Plan</think> Final answer" },
  });
  const ts = "2026-08-26T00:00:00Z";
  const result = parseOpenCodeStdoutLine(line, ts);
  expect(result).toEqual([
    { kind: "thinking", ts, text: "<think>Plan</think> Final answer" },
  ]);
});
