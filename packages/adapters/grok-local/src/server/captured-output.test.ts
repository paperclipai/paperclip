import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { parseGrokJsonl, parseGrokProcessOutput } from "./parse.js";

// Grok end/usage envelope from parse.test.ts.
function completedTurn(inputTokens: number) {
  return [
    { type: "text", data: "completed" },
    { type: "end", stopReason: "EndTurn", sessionId: "synthetic-grok-session", requestId: "synthetic-request",
      usage: { input_tokens: inputTokens, output_tokens: 7, cache_read_input_tokens: 2 }, total_cost_usd: 0.0025 },
  ].map((event) => JSON.stringify(event)).join("\n");
}

async function capture(inputTokens: number, split = false) {
  const logged: string[] = [];
  const stdout = completedTurn(inputTokens) + "\n";
  const proc = await runAdapterExecutionTargetProcess(randomUUID(), null, process.execPath, ["-e", `
    const fs = require('node:fs');
    const text = ${JSON.stringify(stdout)};
    const cut = ${split} ? text.indexOf('123456') + 3 : text.length;
    fs.writeSync(1, text.slice(0, cut));
    setTimeout(() => { fs.writeSync(1, text.slice(cut)); process.exit(0); }, 30);
  `], {
    cwd: process.cwd(), env: { CLIENT_SECRET: "123456" }, timeoutSec: 3, graceSec: 1,
    onLog: async (stream, text) => { if (stream === "stdout") logged.push(text); },
  });
  return { proc, parsed: parseGrokProcessOutput(proc), logged: logged.join("") };
}

describe("sanitized Grok CLI control output", () => {
  it.each([false, true])("preserves end metadata and unaffected accounting (split=%s)", async (split) => {
    const { proc, parsed, logged } = await capture(123456, split);
    expect(proc.exitCode).toBe(0);
    expect(proc.timedOut).toBe(false);
    expect(proc.terminalResultCleanup).toBeNull();
    expect(parsed).toMatchObject({
      sessionId: "synthetic-grok-session", requestId: "synthetic-request", stopReason: "EndTurn",
      summary: "completed", errorMessage: null,
      inputTokens: 0, outputTokens: 7, cachedInputTokens: 2, costUsd: 0.0025,
    });
    expect(proc.controlOutput).toBeDefined();
    expect(proc.controlOutput?.stdout).not.toContain("123456");
    expect(proc.stdout).toContain('"input_tokens":***REDACTED***');
    expect(parseGrokJsonl(proc.stdout).stopReason).toBeNull();
    expect(logged).toBe(proc.stdout);
    expect(logged).not.toContain("123456");
  });

  it("preserves the adjacent-counter positive control", async () => {
    const { proc, parsed, logged } = await capture(123455);
    expect(proc.exitCode).toBe(0);
    expect(parsed).toMatchObject({ inputTokens: 123455, outputTokens: 7, cachedInputTokens: 2, costUsd: 0.0025, stopReason: "EndTurn" });
    expect(logged).toBe(proc.stdout);
  });

  it("selects control output, supports its absence, and never repairs malformed records", () => {
    const stdout = completedTurn(17);
    expect(parseGrokProcessOutput({ stdout })).toEqual(parseGrokJsonl(stdout));
    expect(parseGrokProcessOutput({ stdout, controlOutput: { stdout: completedTurn(0), stderr: "" } }).inputTokens).toBe(0);
    expect(parseGrokProcessOutput({ stdout, controlOutput: { stdout: "", stderr: "" } }).stopReason).toBeNull();
    expect(parseGrokProcessOutput({ stdout, controlOutput: { stdout: "***REDACTED***", stderr: "" } }).stopReason).toBeNull();
    const malformed = '{"type":"end","stopReason":"EndTurn","usage":{"input_tokens":***REDACTED***}}';
    expect(parseGrokProcessOutput({ stdout: malformed }).stopReason).toBeNull();
  });
});
