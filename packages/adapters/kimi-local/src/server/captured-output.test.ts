import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { parseKimiJsonl, parseKimiProcessOutput } from "./parse.js";

// Kimi 0.27 CLI tool_calls and trailing resume hint from parse.test.ts and
// docs/adapters/kimi-local.md. This verified lane has no accounting envelope.
function completedTurn(offset: number) {
  return [
    { role: "assistant", tool_calls: [{ type: "function", id: "synthetic-tool", function: {
      name: "Read", arguments: JSON.stringify({ path: "probe.txt", offset, limit: 7 }),
    } }] },
    { role: "assistant", tool_calls: [{ type: "function", id: "synthetic-safe-tool", function: {
      name: "Read", arguments: JSON.stringify({ path: "probe.txt", offset: 17, limit: 2 }),
    } }] },
    { role: "tool", tool_call_id: "synthetic-tool", content: "synthetic file content" },
    { role: "assistant", content: "completed" },
    { role: "meta", type: "session.resume_hint", session_id: "synthetic-kimi-session",
      command: "kimi -r synthetic-kimi-session", content: "To resume this session: kimi -r synthetic-kimi-session" },
  ].map((event) => JSON.stringify(event)).join("\n");
}

async function capture(offset: number, split = false) {
  const logged: string[] = [];
  const stdout = completedTurn(offset) + "\n";
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
  return { proc, parsed: parseKimiProcessOutput(proc), logged: logged.join("") };
}

describe("sanitized Kimi CLI control output", () => {
  it.each([false, true])("preserves resume metadata without repairing tainted tool arguments (split=%s)", async (split) => {
    const { proc, parsed, logged } = await capture(123456, split);
    expect(proc.exitCode).toBe(0);
    expect(proc.timedOut).toBe(false);
    expect(proc.terminalResultCleanup).toBeNull();
    expect(parsed).toMatchObject({
      sessionId: "synthetic-kimi-session", summary: "completed", errorMessage: null,
      toolCalls: [
        // A secret inside JSON-encoded arguments redacts the entire string;
        // preserving sibling counters within that string would invent a repair.
        { id: "synthetic-tool", name: "Read", arguments: "***REDACTED***" },
        { id: "synthetic-safe-tool", name: "Read", arguments: { path: "probe.txt", offset: 17, limit: 2 } },
      ],
      toolResults: [{ toolCallId: "synthetic-tool", content: "synthetic file content" }],
    });
    expect(proc.controlOutput).toBeDefined();
    expect(proc.controlOutput?.stdout).not.toContain("123456");
    expect(proc.stdout).toContain('\\"offset\\":***REDACTED***');
    expect(parseKimiJsonl(proc.stdout).toolCalls[0]?.arguments).toBe('{"path":"probe.txt","offset":***REDACTED***,"limit":7}');
    expect(logged).toBe(proc.stdout);
    expect(logged).not.toContain("123456");
  });

  it("preserves adjacent numeric tool arguments as the positive control", async () => {
    const { proc, parsed, logged } = await capture(123455);
    expect(proc.exitCode).toBe(0);
    expect(parsed.toolCalls[0]?.arguments).toEqual({ path: "probe.txt", offset: 123455, limit: 7 });
    expect(parsed.toolCalls[1]?.arguments).toEqual({ path: "probe.txt", offset: 17, limit: 2 });
    expect(parsed.sessionId).toBe("synthetic-kimi-session");
    expect(logged).toBe(proc.stdout);
  });

  it("selects control output, supports its absence, and never repairs malformed records", () => {
    const stdout = completedTurn(17);
    expect(parseKimiProcessOutput({ stdout })).toEqual(parseKimiJsonl(stdout));
    const control = completedTurn(0);
    expect(parseKimiProcessOutput({ stdout, controlOutput: { stdout: control, stderr: "" } }).toolCalls[0]?.arguments).toEqual({ path: "probe.txt", offset: 0, limit: 7 });
    expect(parseKimiProcessOutput({ stdout, controlOutput: { stdout: "", stderr: "" } }).sessionId).toBeNull();
    expect(parseKimiProcessOutput({ stdout, controlOutput: { stdout: "***REDACTED***", stderr: "" } }).sessionId).toBeNull();
    const malformed = '{"role":"meta","type":"session.resume_hint","session_id":***REDACTED***}';
    expect(parseKimiProcessOutput({ stdout: malformed }).sessionId).toBeNull();
  });
});
