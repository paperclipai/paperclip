import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runChildProcess } from "../packages/adapter-utils/src/server-utils.js";
import { runAdapterExecutionTargetProcess } from "../packages/adapter-utils/src/execution-target.js";
import { createSecretEnvRedactionScanner } from "../packages/adapter-utils/src/secret-env-redaction.js";
import { parseClaudeStreamJson } from "../packages/adapters/claude-local/src/server/parse.js";
import { parseCursorJsonl, parseCursorProcessOutput } from "../packages/adapters/cursor-local/src/server/parse.js";

const producer = `let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => { const data = JSON.parse(input); require('node:fs').writeSync(data.pipe === 'stderr' ? 2 : 1, data.text); if (data.wait) setTimeout(() => process.exit(0), data.wait); });`;
function options(text: string, pipe: "stdout" | "stderr" = "stdout", wait = 0, env: Record<string, string> = {}) {
  return { cwd: process.cwd(), env, stdin: JSON.stringify({ text, pipe, wait }), timeoutSec: 5, graceSec: 1, onLog: async () => {} };
}

describe("captured-output execution-target callback boundary", () => {
  it("direct child delivers complete and EOF records once", async () => {
    const records: string[] = [];
    const text = '{"type":"assistant","message":"first"}\n{"type":"assistant","message":"last"}';
    const result = await runChildProcess(randomUUID(), process.execPath, ["-e", producer], {
      ...options(text), onControlOutput: async (pipe, value) => { records.push(pipe + ":" + value); },
    });
    expect(result.exitCode).toBe(0);
    expect(records.map(x => x.slice("stdout:".length)).join("")).toBe(text);
    expect(records.every(x => x.startsWith("stdout:"))).toBe(true);
  });
  it("real local wrapper forwards the identical callback", async () => {
    const records: string[] = [];
    const text = '{"type":"assistant","message":"first"}\n{"type":"assistant","message":"last"}';
    const result = await runAdapterExecutionTargetProcess(randomUUID(), null, process.execPath, ["-e", producer], {
      ...options(text), onControlOutput: async (pipe, value) => { records.push(pipe + ":" + value); },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(text);
    expect(records.map(x => x.slice("stdout:".length)).join("")).toBe(text);
  });
});

function exactResult(length: number) {
  const empty = JSON.stringify({ type: "result", result: "" });
  return JSON.stringify({ type: "result", result: "A".repeat(length - empty.length) });
}
describe("captured-output clipped-record provenance", () => {
  it.each([65536, 4 * 1024 * 1024])("scanner does not promote the retained suffix at cap %i", (cap) => {
    const valid = exactResult(cap);
    const invalid = "x" + valid;
    expect(valid.length).toBe(cap);
    expect(parseClaudeStreamJson(valid).resultJson).not.toBeNull();
    expect(parseClaudeStreamJson(invalid).resultJson).toBeNull();
    const scanner = createSecretEnvRedactionScanner(["A".repeat(64)], cap);
    let inspected = "";
    scanner.append(invalid, value => { inspected = value; });
    expect(parseClaudeStreamJson(inspected).resultJson).toBeNull();
    expect(parseClaudeStreamJson(scanner.snapshot()).resultJson).toBeNull();
  });
  it.each(["stdout", "stderr"] as const)("malformed original on %s does not trigger cleanup after clipping", async (pipe) => {
    const malformed = "x" + exactResult(65536);
    const result = await runChildProcess(randomUUID(), process.execPath, ["-e", producer], {
      ...options(malformed, pipe, 300, { CLIENT_SECRET: "A".repeat(64) }),
      terminalResultCleanup: { graceMs: 20, hasTerminalResult: output => parseClaudeStreamJson(output[pipe]).resultJson !== null },
    });
    expect(parseClaudeStreamJson(result[pipe]).resultJson).toBeNull();
    expect(result[pipe]).not.toContain("A".repeat(64));
    expect(result.terminalResultCleanup).toBeNull();
    expect(result.exitCode).toBe(0);
  });
  it.each(["stdout", "stderr"] as const)("genuine compacted result on %s still triggers cleanup", async (pipe) => {
    const result = await runChildProcess(randomUUID(), process.execPath, ["-e", producer], {
      ...options(exactResult(65536), pipe, 300, { CLIENT_SECRET: "A".repeat(64) }),
      terminalResultCleanup: { graceMs: 20, hasTerminalResult: output => parseClaudeStreamJson(output[pipe]).resultJson !== null },
    });
    expect(parseClaudeStreamJson(result[pipe]).resultJson).not.toBeNull();
    expect(result.terminalResultCleanup).not.toBeNull();
  });
});

describe("captured-output supported Cursor framing", () => {
  it("prefixed malformed original does not become accepted evidence", async () => {
    const secret = 'BAD"DATA';
    const text = 'stdout: {"type":"result","result":"before ' + secret + ' after"}\n';
    expect(parseCursorJsonl(text).summary).toBe("");
    const result = await runChildProcess(randomUUID(), process.execPath, ["-e", producer], options(text, "stdout", 0, { CLIENT_SECRET: secret }));
    expect(result.stdout).not.toContain(secret);
    expect(result.controlOutput?.displayFallbackSafe).toBe(false);
    expect(parseCursorProcessOutput(result).summary).toBe("");
  });
  it("prefixed valid numeric collision preserves summary and unaffected accounting", async () => {
    const text = "stdout: " + JSON.stringify({ type: "result", result: "completed", usage: { input_tokens: 123456, output_tokens: 7 } }) + "\n";
    expect(parseCursorJsonl(text)).toMatchObject({ summary: "completed", usage: { inputTokens: 123456, outputTokens: 7 } });
    const result = await runChildProcess(randomUUID(), process.execPath, ["-e", producer], options(text, "stdout", 0, { CLIENT_SECRET: "123456" }));
    expect(result.stdout).not.toContain("123456");
    expect(parseCursorProcessOutput(result)).toMatchObject({ summary: "completed", usage: { inputTokens: 0, outputTokens: 7 } });
  });
  it("unaffected prefixed result and accounting survive", async () => {
    const text = "stdout: " + JSON.stringify({ type: "result", result: "completed", usage: { input_tokens: 17, output_tokens: 7 } }) + "\n";
    const result = await runChildProcess(randomUUID(), process.execPath, ["-e", producer], options(text, "stdout", 0, { CLIENT_SECRET: "unused-value" }));
    expect(parseCursorProcessOutput(result)).toMatchObject({ summary: "completed", usage: { inputTokens: 17, outputTokens: 7 } });
  });
});
