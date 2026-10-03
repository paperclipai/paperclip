import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { parseCodexProcessOutput } from "./parse.js";

describe("sanitized Codex CLI control output", () => {
  async function completedTurn(inputTokens: number, split = false) {
    const logged: string[] = [];
    const events = [
      { type: "thread.started", thread_id: "synthetic-thread" },
      { type: "item.completed", item: { type: "agent_message", text: "completed" } },
      { type: "turn.completed", usage: { input_tokens: inputTokens, output_tokens: 7, cached_input_tokens: 2 } },
    ];
    const stdout = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    const proc = await runAdapterExecutionTargetProcess(randomUUID(), null, process.execPath, ["-e", `
      const fs = require('node:fs');
      const text = ${JSON.stringify(stdout)};
      const cut = ${split} ? text.indexOf('123456') + 3 : text.length;
      fs.writeSync(1, text.slice(0, cut));
      setTimeout(() => { fs.writeSync(1, text.slice(cut)); process.exit(0); }, 30);
    `], {
      cwd: process.cwd(), env: { CLIENT_SECRET: "123456" }, timeoutSec: 3, graceSec: 1,
      onLog: async (stream, text) => { if (stream === "stdout") logged.push(text); },
      // Codex CLI has no terminalResultCleanup option; accounting must not
      // depend on enabling the Claude-specific liveness path.
    });
    return { proc, parsed: parseCodexProcessOutput(proc), logged: logged.join("") };
  }

  it.each([false, true])("preserves completion and unaffected usage after numeric redaction (split=%s)", async (split) => {
    const result = await completedTurn(123456, split);
    expect(result.proc.exitCode).toBe(0);
    expect(result.proc.timedOut).toBe(false);
    expect(result.proc.terminalResultCleanup).toBeNull();
    expect(result.parsed).toMatchObject({
      sessionId: "synthetic-thread", summary: "completed", sawProtocolTerminalEvent: true,
      usage: { inputTokens: 0, outputTokens: 7, cachedInputTokens: 2 },
    });
    expect(result.proc.controlOutput?.stdout).not.toContain("123456");
    expect(result.proc.stdout).toContain('"input_tokens":***REDACTED***');
    expect(result.logged).toBe(result.proc.stdout);
    expect(result.logged).not.toContain("123456");
  });

  it("preserves the adjacent-counter positive control", async () => {
    const result = await completedTurn(123455);
    expect(result.proc.exitCode).toBe(0);
    expect(result.parsed.sawProtocolTerminalEvent).toBe(true);
    expect(result.parsed.usage).toEqual({ inputTokens: 123455, outputTokens: 7, cachedInputTokens: 2 });
    expect(result.logged).toBe(result.proc.stdout);
  });

  it("supports producers without control output and never repairs malformed display JSON", () => {
    const stdout = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 17, output_tokens: 7 } });
    expect(parseCodexProcessOutput({ stdout }).usage).toMatchObject({ inputTokens: 17, outputTokens: 7 });
    const malformed = '{"type":"turn.completed","usage":{"input_tokens":***REDACTED***}}';
    expect(parseCodexProcessOutput({ stdout: malformed, controlOutput: { stdout: "***REDACTED***", stderr: "" } }).sawProtocolTerminalEvent).toBe(false);
  });

  it("prefers sanitized control fields and uses only a genuine display-terminal fallback", () => {
    const display = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 17, output_tokens: 7 } });
    const control = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 0, output_tokens: 7 } });
    expect(parseCodexProcessOutput({ stdout: display, controlOutput: { stdout: control, stderr: "" } }).usage.inputTokens).toBe(0);
    expect(parseCodexProcessOutput({ stdout: display, controlOutput: { stdout: "***REDACTED***", stderr: "", displayFallbackSafe: true } }).usage.inputTokens).toBe(17);
    expect(parseCodexProcessOutput({ stdout: JSON.stringify({ type: "item.completed" }), controlOutput: { stdout: control, stderr: "" } }).sawProtocolTerminalEvent).toBe(true);
  });
});
