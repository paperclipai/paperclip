import { describe, expect, it } from "vitest";
import { processUIAdapter } from "./index";
import { buildTranscript, type RunLogChunk } from "../transcript";

const ts = "2026-06-23T12:00:00.000Z";

// OpenCode runs executed through the generic process adapter (adapterType
// "process", e.g. a wrapper script that ultimately execs an OpenCode harness)
// emit OpenCode JSONL on stdout, usually after a couple of plain bootstrap
// lines. The parser must keep those plain lines as raw stdout, then detect the
// OpenCode JSONL and render the rich "nice view" (messages, tool cards,
// thinking) rather than dumping raw JSON.
function mixedRun(): RunLogChunk[] {
  const lines = [
    "Syncing skills ...",
    "Starting agent ...",
    JSON.stringify({ type: "step_start", sessionID: "ses_x", part: { type: "step-start" } }),
    JSON.stringify({ type: "text", sessionID: "ses_x", part: { type: "text", text: "I need to hire a CTO." } }),
    JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "bash",
        callID: "tool-1",
        state: { status: "completed", input: { command: "ls -la" }, output: "total 0" },
      },
    }),
    JSON.stringify({
      type: "step_finish",
      part: { reason: "tool-calls", tokens: { input: 9338, output: 59, reasoning: 559 } },
    }),
  ];
  return [{ ts, stream: "stdout", chunk: lines.join("\n") + "\n" }];
}

describe("process adapter transcript parsing (OpenCode JSONL detection)", () => {
  it("keeps leading plain wrapper lines as raw stdout", () => {
    const entries = buildTranscript(mixedRun(), processUIAdapter);
    const stdout = entries.filter((e) => e.kind === "stdout").map((e) => (e as { text: string }).text);
    expect(stdout).toEqual(["Syncing skills ...", "Starting agent ..."]);
  });

  it("renders OpenCode JSONL as rich transcript entries once the stream begins", () => {
    const entries = buildTranscript(mixedRun(), processUIAdapter);

    const assistantTexts = entries.filter((e) => e.kind === "assistant").map((e) => (e as { text: string }).text);
    expect(assistantTexts).toEqual(["I need to hire a CTO."]);

    const toolCalls = entries.filter((e) => e.kind === "tool_call");
    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] as { name: string }).name).toBe("bash");

    const toolResults = entries.filter((e) => e.kind === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as { content: string }).content).toContain("total 0");

    expect(entries.some((e) => e.kind === "result")).toBe(true);

    // The raw JSONL must NOT leak through as stdout blocks anymore.
    const stdoutTexts = entries.filter((e) => e.kind === "stdout").map((e) => (e as { text: string }).text);
    expect(stdoutTexts.some((t) => t.includes('"type"'))).toBe(false);
  });

  it("does not lock on for JSON with a matching type but a null part", () => {
    const chunks: RunLogChunk[] = [
      {
        ts,
        stream: "stdout",
        chunk: JSON.stringify({ type: "text", part: null }) + "\n" + "still plain\n",
      },
    ];
    const entries = buildTranscript(chunks, processUIAdapter);
    expect(entries.every((e) => e.kind === "stdout")).toBe(true);
  });

  it("leaves genuinely non-JSONL process output as raw stdout", () => {
    const chunks: RunLogChunk[] = [
      { ts, stream: "stdout", chunk: "plain line one\nplain line two\n" },
    ];
    const entries = buildTranscript(chunks, processUIAdapter);
    expect(entries.every((e) => e.kind === "stdout")).toBe(true);
    expect(entries.map((e) => (e as { text: string }).text)).toEqual(["plain line one", "plain line two"]);
  });
});
