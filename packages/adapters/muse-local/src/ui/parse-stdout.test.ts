import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMuseStdoutParser, parseMuseStdoutLine } from "./parse-stdout.js";

const lines = (name: string) =>
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../server/__fixtures__", name), "utf8")
    .split(/\r?\n/).filter(Boolean);
const run = (name: string) => {
  const parser = createMuseStdoutParser();
  return lines(name).flatMap((line) => parser.parseLine(line, "2026-09-26T00:00:00Z"));
};

describe("muse stdout parser", () => {
  it("emits init, assistant deltas and a completion line for a basic run", () => {
    const entries = run("exec-basic.jsonl");
    expect(entries[0]).toMatchObject({ kind: "init", model: "muse-spark-1.3", sessionId: "01a0df95-ddaf-7cd0-91f4-246c59f925e8" });
    expect(entries.filter((e) => e.kind === "assistant").map((e) => (e as { text: string }).text).join("")).toBe("MUSE OK");
    expect(entries.at(-1)).toMatchObject({ kind: "system", text: "Muse run completed" });
  });

  it("emits a tool_result for tool runs", () => {
    const toolResults = run("exec-tool.jsonl").filter((e) => e.kind === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({ kind: "tool_result", toolUseId: "call_01a0df9defc4748786ec3e88dd3873f0", isError: false });
    expect((toolResults[0] as { content: string }).content).toContain("a.txt");
  });

  it("surfaces failures as stderr", () => {
    const stderr = run("exec-badkey.jsonl").filter((e) => e.kind === "stderr").map((e) => (e as { text: string }).text);
    expect(stderr.some((t) => t.includes("META_API_KEY was rejected"))).toBe(true);
    expect(stderr.some((t) => t.startsWith("Muse run failed"))).toBe(true);
  });

  it("does not echo the user prompt", () => {
    const entries = run("exec-basic.jsonl");
    expect(JSON.stringify(entries)).not.toContain("Reply with exactly");
  });

  it("passes non-JSON lines through as stdout", () => {
    expect(parseMuseStdoutLine("plain text", "t")).toEqual([{ kind: "stdout", ts: "t", text: "plain text" }]);
  });
});
