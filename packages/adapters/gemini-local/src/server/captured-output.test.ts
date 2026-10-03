import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { parseGeminiJsonl, parseGeminiProcessOutput } from "./parse.js";

// Gemini v0.38 stream-json result.stats envelope from parse.test.ts.
function completedTurn(inputTokens: number) {
  return [
    { type: "init", session_id: "synthetic-gemini-session", model: "auto-gemini-3" },
    { type: "message", role: "assistant", content: "completed", delta: true },
    { type: "result", status: "success", stats: { input_tokens: inputTokens, output_tokens: 7, cached: 2, duration_ms: 31 } },
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
  return { proc, parsed: parseGeminiProcessOutput(proc), logged: logged.join("") };
}

describe("sanitized Gemini CLI control output", () => {
  it.each([false, true])("preserves result metadata and unaffected accounting (split=%s)", async (split) => {
    const { proc, parsed, logged } = await capture(123456, split);
    expect(proc.exitCode).toBe(0);
    expect(proc.timedOut).toBe(false);
    expect(proc.terminalResultCleanup).toBeNull();
    expect(parsed).toMatchObject({
      sessionId: "synthetic-gemini-session", summary: "completed", errorMessage: null,
      usage: { inputTokens: 0, outputTokens: 7, cachedInputTokens: 2 },
      resultEvent: { type: "result", status: "success", stats: { input_tokens: 0, output_tokens: 7, cached: 2, duration_ms: 31 } },
    });
    expect(proc.controlOutput).toBeDefined();
    expect(proc.controlOutput?.stdout).not.toContain("123456");
    expect(proc.stdout).toContain('"input_tokens":***REDACTED***');
    expect(parseGeminiJsonl(proc.stdout).resultEvent).toBeNull();
    expect(logged).toBe(proc.stdout);
    expect(logged).not.toContain("123456");
  });

  it("preserves the adjacent-counter positive control", async () => {
    const { proc, parsed, logged } = await capture(123455);
    expect(proc.exitCode).toBe(0);
    expect(parsed.usage).toEqual({ inputTokens: 123455, outputTokens: 7, cachedInputTokens: 2 });
    expect(parsed.resultEvent?.status).toBe("success");
    expect(logged).toBe(proc.stdout);
  });

  it("selects control output, supports its absence, and never repairs malformed records", () => {
    const stdout = completedTurn(17);
    expect(parseGeminiProcessOutput({ stdout })).toEqual(parseGeminiJsonl(stdout));
    expect(parseGeminiProcessOutput({ stdout, controlOutput: { stdout: completedTurn(0), stderr: "" } }).usage.inputTokens).toBe(0);
    expect(parseGeminiProcessOutput({ stdout, controlOutput: { stdout: "", stderr: "" } }).resultEvent).toBeNull();
    expect(parseGeminiProcessOutput({ stdout, controlOutput: { stdout: "***REDACTED***", stderr: "" } }).resultEvent).toBeNull();
    const malformed = '{"type":"result","status":"success","stats":{"input_tokens":***REDACTED***}}';
    expect(parseGeminiProcessOutput({ stdout: malformed }).resultEvent).toBeNull();
  });
});
