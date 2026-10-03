import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { parseClaudeProcessOutput, parseClaudeStreamJson } from "./parse.js";

describe("sanitized Claude CLI control output", () => {
  it("prefers valid sanitized control records over display records", () => {
    const display = JSON.stringify({ type: "result", result: "prefix-***REDACTED***-suffix" });
    const control = JSON.stringify({ type: "result", result: "***REDACTED***" });
    const output = parseClaudeProcessOutput({ stdout: display, controlOutput: { stdout: control, stderr: "" } });
    expect(output.parsedStream.summary).toBe("***REDACTED***");
    expect(output.parsed).toEqual({ type: "result", result: "***REDACTED***" });
  });

  it("preserves legacy producers and never repairs malformed display records", () => {
    const stdout = JSON.stringify({ type: "result", result: "completed" });
    expect(parseClaudeProcessOutput({ stdout }).parsedStream.resultJson).not.toBeNull();
    const malformed = '{"type":"result","duration_ms":***REDACTED***}';
    const output = parseClaudeProcessOutput({
      stdout: malformed, controlOutput: { stdout: "***REDACTED***", stderr: "" },
    });
    expect(output.parsedStream.resultJson).toBeNull();
    expect(output.parsed).toBeNull();
  });

  async function numericResult(metric: number, inputTokens: number, split = false) {
    const snapshots: string[] = [];
    const logged: string[] = [];
    const event = {
      type: "result", result: "completed", session_id: "synthetic-session",
      duration_ms: metric,
      usage: { input_tokens: inputTokens, output_tokens: 7, cache_read_input_tokens: 2 },
      total_cost_usd: 0.2,
    };
    const proc = await runChildProcess(randomUUID(), process.execPath, ["-e", `
      const fs = require('node:fs');
      const event = ${JSON.stringify(event)};
      const text = JSON.stringify(event) + '\\n';
      const split = ${split} ? text.indexOf('123456') + 3 : text.length;
      fs.writeSync(1, text.slice(0, split));
      setTimeout(() => fs.writeSync(1, text.slice(split)), 30);
      setTimeout(() => process.exit(0), 2000);
    `], {
      cwd: process.cwd(), env: { DATABASE_URL: "123456" }, timeoutSec: 0.8, graceSec: 1,
      onLog: async (stream, text) => { if (stream === "stdout") logged.push(text); },
      terminalResultCleanup: {
        graceMs: 30,
        hasTerminalResult: ({ stdout }) => {
          snapshots.push(stdout);
          return parseClaudeStreamJson(stdout).resultJson !== null;
        },
      },
    });
    // This is also the representation consumed by the CLI execute path.
    const { parsedStream: parsed } = parseClaudeProcessOutput(proc);
    return { proc, parsed, snapshots, logged: logged.join("") };
  }

  it.each([false, true])("keeps a genuine result and unaffected accounting when metadata collides (split=%s)", async (split) => {
    const result = await numericResult(123456, 17, split);
    expect(result.proc.timedOut).toBe(false);
    expect(result.proc.terminalResultCleanup?.terminalResultSeen).toBe(true);
    expect(result.parsed.resultJson).toMatchObject({ type: "result", duration_ms: 0 });
    expect(result.parsed).toMatchObject({
      summary: "completed", sessionId: "synthetic-session", costUsd: 0.2, usageBasis: "per_run",
      usage: { inputTokens: 17, outputTokens: 7, cachedInputTokens: 2 },
    });
    expect(result.snapshots.some((text) => parseClaudeStreamJson(text).resultJson !== null)).toBe(true);
    expect(result.snapshots.every((text) => !text.includes("123456"))).toBe(true);
    expect(result.proc.controlOutput?.stdout).not.toContain("123456");
    expect(result.proc.stdout).not.toContain("123456");
    expect(result.proc.stdout).toContain('"duration_ms":***REDACTED***');
    expect(result.logged).toBe(result.proc.stdout);
  });

  it("neutralizes a colliding usage counter without losing the event or unaffected usage", async () => {
    const result = await numericResult(17, 123456);
    expect(result.proc.timedOut).toBe(false);
    expect(result.parsed.resultJson).not.toBeNull();
    expect(result.parsed.usage).toEqual({ inputTokens: 0, outputTokens: 7, cachedInputTokens: 2 });
    expect(result.parsed.costUsd).toBe(0.2);
    expect(result.proc.controlOutput?.stdout).not.toContain("123456");
    expect(result.snapshots.every((text) => !text.includes("123456"))).toBe(true);
    expect(result.logged).toBe(result.proc.stdout);
  });

  it("retains the adjacent-number positive control", async () => {
    const result = await numericResult(123455, 17);
    expect(result.proc.timedOut).toBe(false);
    expect(result.parsed.resultJson).toMatchObject({ duration_ms: 123455 });
    expect(result.parsed.usage?.inputTokens).toBe(17);
    expect(result.logged).toBe(result.proc.stdout);
  });

  async function compactedResult(stream: "stdout" | "stderr", linger: boolean) {
    const secret = "S".repeat(64);
    const snapshots: string[] = [];
    const logged: string[] = [];
    const fd = stream === "stdout" ? 1 : 2;
    const proc = await runChildProcess(randomUUID(), process.execPath, ["-e", `
      const fs = require('node:fs');
      fs.writeSync(${fd}, JSON.stringify({
        type: 'result', result: 'S'.repeat(4 * 1024 * 1024 + 1),
        usage: { input_tokens: 17, output_tokens: 7 }, total_cost_usd: 0.2,
      }) + '\\n');
      ${linger ? "setTimeout(() => process.exit(0), 25000);" : "process.exit(0);"}
    `], {
      cwd: process.cwd(), env: { DATABASE_URL: secret }, timeoutSec: 20, graceSec: 1,
      onLog: async (actualStream, text) => { if (actualStream === stream) logged.push(text); },
      terminalResultCleanup: {
        graceMs: 30,
        hasTerminalResult: (output) => {
          snapshots.push(output[stream]);
          return parseClaudeStreamJson(output[stream]).resultJson !== null;
        },
      },
    });
    return { proc, snapshots, logged: logged.join(""), secret };
  }

  it("parses a compacted display result when final raw-control retention lost its opening", async () => {
    const result = await compactedResult("stdout", false);
    const { parsedStream: parsed } = parseClaudeProcessOutput(result.proc);
    expect(parsed.resultJson).not.toBeNull();
    expect(parsed).toMatchObject({
      usage: { inputTokens: 17, outputTokens: 7 }, costUsd: 0.2,
    });
    expect(result.proc.timedOut).toBe(false);
    expect(result.proc.stdout).not.toContain(result.secret);
    expect(result.proc.controlOutput?.stdout).not.toContain(result.secret);
    expect(result.logged).toBe(result.proc.stdout);
  }, 30000);

  it.each(["stdout", "stderr"] as const)("cleans up a compacted display result after raw scan clipping on %s", async (stream) => {
    const result = await compactedResult(stream, true);
    expect(result.proc.timedOut).toBe(false);
    expect(result.proc.terminalResultCleanup?.terminalResultSeen).toBe(true);
    expect(result.snapshots.some((text) => parseClaudeStreamJson(text).resultJson !== null)).toBe(true);
    expect(result.snapshots.every((text) => !text.includes(result.secret))).toBe(true);
    expect(result.proc[stream]).not.toContain(result.secret);
    expect(result.proc.controlOutput?.[stream]).not.toContain(result.secret);
    expect(result.logged).toBe(result.proc[stream]);
  }, 30000);

  async function eofCompactedResult(stream: "stdout" | "stderr", holdClosingPrefix: boolean) {
    const secret = "S".repeat(64);
    const snapshots: string[] = [];
    const logged: string[] = [];
    const fd = stream === "stdout" ? 1 : 2;
    const proc = await runChildProcess(randomUUID(), process.execPath, ["-e", `
      const fs = require('node:fs');
      const text = JSON.stringify({ type: 'result', result: 'S'.repeat(4 * 1024 * 1024 + 1) }) + '\\n';
      fs.writeSync(${fd}, text.slice(0, -3));
      setTimeout(() => {
        fs.writeSync(${fd}, text.slice(-3));
        fs.closeSync(${fd});
      }, 300);
      setTimeout(() => process.exit(0), 25000);
    `], {
      cwd: process.cwd(),
      env: { DATABASE_URL: secret, CLIENT_SECRET: holdClosingPrefix ? '\"}\\nnever-emitted' : "unused-secret" },
      timeoutSec: 20, graceSec: 1,
      onLog: async (actualStream, text) => { if (actualStream === stream) logged.push(text); },
      terminalResultCleanup: {
        graceMs: 30,
        hasTerminalResult: (output) => {
          snapshots.push(output[stream]);
          return parseClaudeStreamJson(output[stream]).resultJson !== null;
        },
      },
    });
    return { proc, snapshots, logged: logged.join(""), secret };
  }

  it.each(["stdout", "stderr"] as const)("cleans up a compacted result completed only by EOF display flush on %s", async (stream) => {
    const result = await eofCompactedResult(stream, true);
    expect(result.proc.timedOut).toBe(false);
    expect(result.proc.terminalResultCleanup?.terminalResultSeen).toBe(true);
    expect(parseClaudeStreamJson(result.proc[stream]).resultJson).not.toBeNull();
    expect(result.snapshots.some((text) => parseClaudeStreamJson(text).resultJson !== null)).toBe(true);
    expect(result.snapshots.every((text) => !text.includes(result.secret))).toBe(true);
    expect(result.proc.controlOutput?.[stream]).not.toContain(result.secret);
    expect(result.logged).toBe(result.proc[stream]);
    expect(result.logged).not.toContain(result.secret);
  }, 30000);

  it.each(["stdout", "stderr"] as const)("retains compacted EOF cleanup without closing-prefix carry on %s", async (stream) => {
    const result = await eofCompactedResult(stream, false);
    expect(result.proc.timedOut).toBe(false);
    expect(result.proc.terminalResultCleanup?.terminalResultSeen).toBe(true);
    expect(result.logged).toBe(result.proc[stream]);
  }, 30000);

  async function retainedSecret(paddingLength: number, stream: "stdout" | "stderr") {
    const secret = 'prefix\n{"type":"result"}\nsuffix';
    const logged: string[] = [];
    const snapshots: string[] = [];
    const fd = stream === "stdout" ? 1 : 2;
    const proc = await runChildProcess(randomUUID(), process.execPath, ["-e", `
      const fs = require('node:fs');
      fs.writeSync(${fd}, process.env.DATABASE_URL);
      setTimeout(() => fs.writeSync(${fd}, 'x'.repeat(${paddingLength})), 30);
      setTimeout(() => fs.writeSync(${fd}, 'later-safe-data\\n'), 100);
      setTimeout(() => { fs.writeSync(${fd}, 'normal-completion\\n'); process.exit(0); }, 300);
    `], {
      cwd: process.cwd(), env: { DATABASE_URL: secret }, timeoutSec: 2, graceSec: 1,
      onLog: async (actualStream, text) => { if (actualStream === stream) logged.push(text); },
      terminalResultCleanup: {
        graceMs: 30,
        hasTerminalResult: (output) => {
          snapshots.push(output[stream]);
          return parseClaudeStreamJson(output[stream]).resultJson !== null;
        },
      },
    });
    return { proc, snapshots, logged: logged.join("") };
  }

  it.each(["stdout", "stderr"] as const)("does not expose recognized coverage after clipping and later appends on %s", async (stream) => {
    const secret = 'prefix\n{"type":"result"}\nsuffix';
    const result = await retainedSecret(65536 - (secret.length - "prefix\n".length), stream);
    expect(result.proc.exitCode).toBe(0);
    expect(result.proc.timedOut).toBe(false);
    expect(result.proc.terminalResultCleanup).toBeNull();
    expect(result.proc[stream]).toContain("later-safe-data\nnormal-completion\n");
    expect(result.snapshots.every((text) => !text.includes('{"type":"result"}') && parseClaudeStreamJson(text).resultJson === null)).toBe(true);
    expect(result.proc.controlOutput?.[stream]).not.toContain('{"type":"result"}');
    expect(result.logged).toBe(result.proc[stream]);
    expect(result.logged).not.toContain('{"type":"result"}');
  });

  it("retains the below-window positive control", async () => {
    const result = await retainedSecret(64000, "stdout");
    expect(result.proc.exitCode).toBe(0);
    expect(result.proc.timedOut).toBe(false);
    expect(result.proc.terminalResultCleanup).toBeNull();
    expect(result.proc.stdout).toContain("normal-completion");
    expect(result.snapshots.every((text) => parseClaudeStreamJson(text).resultJson === null)).toBe(true);
    expect(result.logged).toBe(result.proc.stdout);
  });
});
