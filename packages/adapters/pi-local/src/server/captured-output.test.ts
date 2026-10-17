import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { parsePiJsonl, parsePiProcessOutput } from "./parse.js";

// Pi turn_end message/usage envelope from parse.test.ts.
function completedTurn(inputTokens: number) {
  return JSON.stringify({
    type: "turn_end", message: {
      role: "assistant", content: [{ type: "text", text: "completed" }],
      usage: { input: inputTokens, output: 7, cacheRead: 2, cost: { total: 0.0025 } },
    }, toolResults: [],
  });
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
  return { proc, parsed: parsePiProcessOutput(proc), logged: logged.join("") };
}

describe("sanitized Pi CLI control output", () => {
  it.each([false, true])("preserves final message and unaffected accounting (split=%s)", async (split) => {
    const { proc, parsed, logged } = await capture(123456, split);
    expect(proc.exitCode).toBe(0);
    expect(proc.timedOut).toBe(false);
    expect(proc.terminalResultCleanup).toBeNull();
    expect(parsed).toMatchObject({
      finalMessage: "completed", messages: ["completed"], errors: [],
      usage: { inputTokens: 0, outputTokens: 7, cachedInputTokens: 2, costUsd: 0.0025 },
    });
    expect(proc.controlOutput).toBeDefined();
    expect(proc.controlOutput?.stdout).not.toContain("123456");
    expect(proc.stdout).toContain('"input":***REDACTED***');
    expect(parsePiJsonl(proc.stdout).finalMessage).toBeNull();
    expect(logged).toBe(proc.stdout);
    expect(logged).not.toContain("123456");
  });

  it("preserves the adjacent-counter positive control", async () => {
    const { proc, parsed, logged } = await capture(123455);
    expect(proc.exitCode).toBe(0);
    expect(parsed.usage).toEqual({ inputTokens: 123455, outputTokens: 7, cachedInputTokens: 2, costUsd: 0.0025 });
    expect(parsed.finalMessage).toBe("completed");
    expect(logged).toBe(proc.stdout);
  });

  it("selects control output, supports its absence, and never repairs malformed records", () => {
    const stdout = completedTurn(17);
    expect(parsePiProcessOutput({ stdout })).toEqual(parsePiJsonl(stdout));
    expect(parsePiProcessOutput({ stdout, controlOutput: { stdout: completedTurn(0), stderr: "" } }).usage.inputTokens).toBe(0);
    expect(parsePiProcessOutput({ stdout, controlOutput: { stdout: "", stderr: "" } }).finalMessage).toBeNull();
    expect(parsePiProcessOutput({ stdout, controlOutput: { stdout: "***REDACTED***", stderr: "" } }).finalMessage).toBeNull();
    const malformed = '{"type":"turn_end","message":{"role":"assistant","content":"completed","usage":{"input":***REDACTED***}}}';
    expect(parsePiProcessOutput({ stdout: malformed }).finalMessage).toBeNull();
  });
});
