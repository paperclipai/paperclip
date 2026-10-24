import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { parseOpenCodeJsonl, parseOpenCodeProcessOutput } from "./parse.js";

// OpenCode step_finish part.tokens envelope from parse.test.ts.
function completedStep(inputTokens: number) {
  return [
    { type: "text", part: { text: "completed" } },
    { type: "step_finish", sessionID: "synthetic-opencode-session", part: {
      reason: "done", cost: 0.0025,
      tokens: { input: inputTokens, output: 7, reasoning: 3, cache: { read: 2, write: 0 } },
    } },
  ].map((event) => JSON.stringify(event)).join("\n");
}

async function capture(inputTokens: number, split = false) {
  const logged: string[] = [];
  const stdout = completedStep(inputTokens) + "\n";
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
  return { proc, parsed: parseOpenCodeProcessOutput(proc), logged: logged.join("") };
}

describe("sanitized OpenCode CLI control output", () => {
  it.each([false, true])("preserves session metadata and unaffected accounting (split=%s)", async (split) => {
    const { proc, parsed, logged } = await capture(123456, split);
    expect(proc.exitCode).toBe(0);
    expect(proc.timedOut).toBe(false);
    expect(proc.terminalResultCleanup).toBeNull();
    expect(parsed).toMatchObject({
      sessionId: "synthetic-opencode-session", summary: "completed", errorMessage: null,
      usage: { inputTokens: 0, outputTokens: 10, cachedInputTokens: 2 }, costUsd: 0.0025,
    });
    expect(proc.controlOutput).toBeDefined();
    expect(proc.controlOutput?.stdout).not.toContain("123456");
    expect(proc.stdout).toContain('"input":***REDACTED***');
    expect(parseOpenCodeJsonl(proc.stdout).sessionId).toBeNull();
    expect(logged).toBe(proc.stdout);
    expect(logged).not.toContain("123456");
  });

  it("preserves the adjacent-counter positive control", async () => {
    const { proc, parsed, logged } = await capture(123455);
    expect(proc.exitCode).toBe(0);
    expect(parsed.usage).toEqual({ inputTokens: 123455, outputTokens: 10, cachedInputTokens: 2 });
    expect(parsed.sessionId).toBe("synthetic-opencode-session");
    expect(parsed.costUsd).toBe(0.0025);
    expect(logged).toBe(proc.stdout);
  });

  it("selects control output, supports its absence, and never repairs malformed records", () => {
    const stdout = completedStep(17);
    expect(parseOpenCodeProcessOutput({ stdout })).toEqual(parseOpenCodeJsonl(stdout));
    expect(parseOpenCodeProcessOutput({ stdout, controlOutput: { stdout: completedStep(0), stderr: "" } }).usage.inputTokens).toBe(0);
    expect(parseOpenCodeProcessOutput({ stdout, controlOutput: { stdout: "", stderr: "" } }).sessionId).toBeNull();
    expect(parseOpenCodeProcessOutput({ stdout, controlOutput: { stdout: "***REDACTED***", stderr: "" } }).sessionId).toBeNull();
    const malformed = '{"type":"step_finish","sessionID":"synthetic-opencode-session","part":{"tokens":{"input":***REDACTED***}}}';
    expect(parseOpenCodeProcessOutput({ stdout: malformed }).sessionId).toBeNull();
  });
});
