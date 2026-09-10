import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { SIMPLE_RUN, TOOL_RUN } from "./fixtures.test-util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const uiParserPath = path.resolve(__dirname, "../../ui-parser.cjs");
const { parseStdoutLine } = require(uiParserPath);

const TS = "2026-01-01T00:00:00.000Z";

function parseAll(stream: string) {
  return stream
    .split("\n")
    .flatMap((line) => parseStdoutLine(line, TS));
}

describe("agy ui-parser contract 1.0.0", () => {
  it("emits an init entry carrying the conversation id", () => {
    const entries = parseAll(SIMPLE_RUN);
    const init = entries.find((entry: any) => entry.kind === "init");
    expect(init).toBeDefined();
    expect(init.sessionId).toBe("1d4068bc-62e4-47ec-ad8b-6e83372b5f32");
    expect(typeof init.model).toBe("string");
  });

  it("marks assistant text as deltas so the UI concatenates them", () => {
    const assistant = parseAll(TOOL_RUN).filter((entry: any) => entry.kind === "assistant");
    expect(assistant.length).toBe(2);
    expect(assistant.every((entry: any) => entry.delta === true)).toBe(true);
    expect(assistant.map((entry: any) => entry.text).join("")).toBe(
      "I have created probe.txt and read it back.",
    );
  });

  it("pairs tool_call and tool_result on a shared toolUseId", () => {
    const entries = parseAll(TOOL_RUN);
    const calls = entries.filter((entry: any) => entry.kind === "tool_call");
    const results = entries.filter((entry: any) => entry.kind === "tool_result");
    expect(calls.length).toBe(2);
    expect(results.length).toBe(2);
    for (const call of calls) {
      expect(
        results.some((result: any) => result.toolUseId === call.toolUseId),
      ).toBe(true);
    }
    expect(calls[0].name).toBe("write_to_file");
    expect(calls[0].input).toEqual({ TargetFile: "/tmp/agyprobe/probe.txt" });
    expect(results[1].content).toBe("2 lines, 7 bytes");
    expect(results[1].isError).toBe(false);
  });

  it("falls back to a parameter summary when a tool reports no output", () => {
    const result = parseStdoutLine(
      '{"event":"step_update","step_update":{"conversation_id":"c","step_index":2,"state":"DONE","step_type":"tool","tool_name":"write_to_file","tool_info":{"name":"write_to_file","parameters":{"TargetFile":"/tmp/x.txt"}}}}',
      TS,
    );
    expect(result[0].kind).toBe("tool_result");
    expect(result[0].content).toBe("write_to_file /tmp/x.txt");
  });

  it("flags a failed tool call as an error result", () => {
    const result = parseStdoutLine(
      '{"event":"step_update","step_update":{"conversation_id":"c","step_index":3,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","error":"exit 1"}}}',
      TS,
    );
    expect(result[0].isError).toBe(true);
  });

  it("emits a result entry with token counts", () => {
    const entries = parseAll(SIMPLE_RUN);
    const result = entries.find((entry: any) => entry.kind === "result");
    expect(result).toBeDefined();
    expect(result.inputTokens).toBe(5286);
    expect(result.outputTokens).toBe(90);
    expect(result.cachedTokens).toBe(8128);
    expect(result.isError).toBe(false);
    expect(result.subtype).toBe("success");
  });

  it("marks a non-SUCCESS result as an error and carries the message", () => {
    const entries = parseStdoutLine(
      '{"event":"result","result":{"status":"ERROR","error":"boom","usage":{}}}',
      TS,
    );
    expect(entries[0].isError).toBe(true);
    expect(entries[0].errors).toEqual(["boom"]);
  });

  it("surfaces non-JSON output instead of dropping it", () => {
    expect(parseStdoutLine("some banner text", TS)).toEqual([
      { kind: "stdout", ts: TS, text: "some banner text" },
    ]);
    expect(parseStdoutLine("Error: agy exploded", TS)[0].kind).toBe("stderr");
    expect(parseStdoutLine("{not json", TS)[0].kind).toBe("stdout");
    expect(parseStdoutLine("   ", TS)).toEqual([]);
  });

  it("surfaces an unknown event type rather than silently dropping it", () => {
    const entries = parseStdoutLine('{"event":"future_event","payload":{}}', TS);
    expect(entries.length).toBe(1);
    expect(entries[0].kind).toBe("stdout");
  });

  it("is self-contained: evaluates with no require, module scope only", () => {
    const source = fs.readFileSync(uiParserPath, "utf8");
    expect(/\brequire\s*\(/.test(source)).toBe(false);
    expect(/\bimport\s*[({]/.test(source)).toBe(false);

    const exportsObj: Record<string, unknown> = {};
    const moduleObj = { exports: exportsObj };
    const context = vm.createContext({ exports: exportsObj, module: moduleObj });
    vm.runInContext(`"use strict";\n{\n${source}\n}`, context);
    const resolved: any = Object.keys(moduleObj.exports).length > 0 ? moduleObj.exports : exportsObj;
    expect(typeof resolved.parseStdoutLine).toBe("function");
    expect(resolved.parseStdoutLine('{"event":"init","conversation_id":"z"}', TS)[0].sessionId).toBe("z");
  });
});
