import { expect, test } from "vitest";

import { createPromptEchoFilter } from "./execute.js";

// A real Paperclip-shaped prompt and the echo Hermes actually produced for it:
// captured by running the exact `console.print(f"[bold blue]Query:[/] {query}")`
// from hermes_cli/cli_single_query.py through Rich at its non-TTY width. Note
// what Rich did to it — re-wrapped at 80 columns (splitting the JSON line
// mid-token), ate `[[their-name]]` as markup, left `[Title](doc/file.md)`
// alone — which is why the filter compares with brackets and whitespace gone.
const PROMPT = "You are an agent at Paperclip company.\n\n## Execution Contract\n\n- Start actionable work in the same heartbeat. Do not stop at a plan unless the issue explicitly asks for planning.\n- Include `-H \"Authorization: Bearer $PAPERCLIP_API_KEY\"` on API requests.\n- Include `-H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\"` on mutating issue requests.\n- Link related memories with [[their-name]] so the index stays navigable.\n- See [Title](doc/file.md) for the long form of this contract.\n\nPaperclip task context:\n- Issue: \"Fix the chat transcript\"\n- Title: \"The agent instructions appear in the chat\"\n\n```json\n{\"reason\":\"issue_assigned\",\"categories\":[\"adapter\",\"secrets\",\"runtimeSkills\"],\"freshness\":{\"reset\":false}}\n```\n\nFinal disposition checklist: mark `done` when complete and verified; use `in_review` only with a real reviewer, approval, interaction, or monitor path.";

const ECHO = "Query: You are an agent at Paperclip company.\n\n## Execution Contract\n\n- Start actionable work in the same heartbeat. Do not stop at a plan unless the \nissue explicitly asks for planning.\n- Include `-H \"Authorization: Bearer $PAPERCLIP_API_KEY\"` on API requests.\n- Include `-H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\"` on mutating issue \nrequests.\n- Link related memories with [] so the index stays navigable.\n- See [Title](doc/file.md) for the long form of this contract.\n\nPaperclip task context:\n- Issue: \"Fix the chat transcript\"\n- Title: \"The agent instructions appear in the chat\"\n\n```json\n{\"reason\":\"issue_assigned\",\"categories\":[\"adapter\",\"secrets\",\"runtimeSkills\"],\"f\nreshness\":{\"reset\":false}}\n```\n\nFinal disposition checklist: mark `done` when complete and verified; use \n`in_review` only with a real reviewer, approval, interaction, or monitor path.\n";

test("drops the query echo Hermes writes before the agent starts", () => {
  const strip = createPromptEchoFilter(PROMPT);
  expect(strip(ECHO)).toBe("");
});

test("drops an echo split across stdout chunks", () => {
  const strip = createPromptEchoFilter(PROMPT);
  const split = Math.floor(ECHO.length / 2);
  expect(strip(ECHO.slice(0, split))).toBe("");
  expect(strip(ECHO.slice(split))).toBe("");
});

// A pipe splits wherever it likes, so the filter cannot assume a chunk holds a
// whole line, let alone the whole echo. Greptile flagged both boundaries:
// https://github.com/paperclipai/paperclip/pull/14845#discussion_r4156807261
test("drops an echo delivered in small chunks", () => {
  const strip = createPromptEchoFilter(PROMPT);
  let kept = "";
  for (let i = 0; i < ECHO.length; i += 7) kept += strip(ECHO.slice(i, i + 7));
  expect(kept).toBe("");
});

// https://github.com/paperclipai/paperclip/pull/14845#discussion_r4156807276
test("drops the echo when one chunk holds its tail and the first output", () => {
  const strip = createPromptEchoFilter(PROMPT);
  const split = Math.floor(ECHO.length / 2);
  const answer = "Fixed the launcher path.\r\n";
  expect(strip(ECHO.slice(0, split))).toBe("");
  expect(strip(ECHO.slice(split) + answer)).toBe(answer);
});

test("passes agent output through untouched", () => {
  const strip = createPromptEchoFilter(PROMPT);
  const toolLine = "  \u250a \ud83d\udcbb $         curl -s https://api.example.com/health  0.1s\r\n";
  expect(strip(ECHO)).toBe("");
  expect(strip(toolLine)).toBe(toolLine);
  expect(strip("Fixed the launcher path.\r\n")).toBe("Fixed the launcher path.\r\n");
});

test("keeps stdout that only looks like the start of the prompt", () => {
  const strip = createPromptEchoFilter(PROMPT);
  const quoted = "Query: You are an agent at a rival company, and this is my answer.\n";
  expect(strip(quoted)).toBe(quoted);
});

// A line that still matches the prompt is indistinguishable from the echo, so
// the filter drops it and releases from the line where the two diverge. That
// direction is deliberate: a Rich quirk mid-echo leaks the rest of the echo
// instead of the whole of it, and the real answer always survives.
test("releases from the line where a partial match diverges", () => {
  const strip = createPromptEchoFilter(PROMPT);
  const firstTwoLines = "Query: You are an agent at Paperclip company.\n\n";
  const mine = "## My Own Heading\n\nThis part is the answer.\n";
  expect(strip(firstTwoLines + mine)).toBe(mine);
});

// The filter decides per line, so it holds a line until the newline arrives.
// Nothing may be lost if the child exits first.
test("flush releases a held partial line", () => {
  const strip = createPromptEchoFilter(PROMPT);
  const partial = "Query: and then the process died mid-line";
  expect(strip(partial)).toBe("");
  expect(strip.flush()).toBe(partial);
});

test("flush returns nothing once the echo is gone", () => {
  const strip = createPromptEchoFilter(PROMPT);
  expect(strip(ECHO)).toBe("");
  expect(strip.flush()).toBe("");
});

test("leaves short prompts alone", () => {
  const strip = createPromptEchoFilter("Say only the single word: verified");
  expect(strip("Query: Say only the single word: verified\n")).toBe(
    "Query: Say only the single word: verified\n",
  );
});
