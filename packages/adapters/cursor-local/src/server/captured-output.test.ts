import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { parseCursorJsonl, parseCursorProcessOutput } from "./parse.js";

// Result/usage envelope from server/src/__tests__/cursor-local-adapter.test.ts.
function completedResult(inputTokens: number) {
  return JSON.stringify({
    type: "result", subtype: "success", session_id: "synthetic-cursor-session",
    result: "completed", usage: { input_tokens: inputTokens, output_tokens: 7, cached_input_tokens: 2 },
    total_cost_usd: 0.0025,
  });
}

async function capture(inputTokens: number, split = false) {
  const logged: string[] = [];
  const stdout = completedResult(inputTokens) + "\n";
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
  return { proc, parsed: parseCursorProcessOutput(proc), logged: logged.join("") };
}

describe("sanitized Cursor CLI control output", () => {
  it.each([false, true])("preserves result metadata and unaffected accounting (split=%s)", async (split) => {
    const { proc, parsed, logged } = await capture(123456, split);
    expect(proc.exitCode).toBe(0);
    expect(proc.timedOut).toBe(false);
    expect(proc.terminalResultCleanup).toBeNull();
    expect(parsed).toMatchObject({
      sessionId: "synthetic-cursor-session", summary: "completed", errorMessage: null,
      usage: { inputTokens: 0, outputTokens: 7, cachedInputTokens: 2 }, costUsd: 0.0025,
    });
    expect(proc.controlOutput).toBeDefined();
    expect(proc.controlOutput?.stdout).not.toContain("123456");
    expect(proc.stdout).toContain('"input_tokens":***REDACTED***');
    expect(parseCursorJsonl(proc.stdout).sessionId).toBeNull();
    expect(logged).toBe(proc.stdout);
    expect(logged).not.toContain("123456");
  });

  it("preserves the adjacent-counter positive control", async () => {
    const { proc, parsed, logged } = await capture(123455);
    expect(proc.exitCode).toBe(0);
    expect(parsed.usage).toEqual({ inputTokens: 123455, outputTokens: 7, cachedInputTokens: 2 });
    expect(parsed.sessionId).toBe("synthetic-cursor-session");
    expect(parsed.costUsd).toBe(0.0025);
    expect(logged).toBe(proc.stdout);
  });

  it("selects control output, supports its absence, and never repairs malformed records", () => {
    const stdout = completedResult(17);
    expect(parseCursorProcessOutput({ stdout })).toEqual(parseCursorJsonl(stdout));
    expect(parseCursorProcessOutput({ stdout, controlOutput: { stdout: completedResult(0), stderr: "" } }).usage.inputTokens).toBe(0);
    expect(parseCursorProcessOutput({ stdout, controlOutput: { stdout: "", stderr: "" } }).sessionId).toBeNull();
    expect(parseCursorProcessOutput({ stdout, controlOutput: { stdout: "***REDACTED***", stderr: "" } }).sessionId).toBeNull();
    const malformed = '{"type":"result","session_id":"synthetic-cursor-session","usage":{"input_tokens":***REDACTED***}}';
    expect(parseCursorProcessOutput({ stdout: malformed }).sessionId).toBeNull();
  });
});
