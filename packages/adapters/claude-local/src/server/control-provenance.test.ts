import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { parseClaudeProcessOutput, parseClaudeStreamJson } from "./parse.js";

describe("original structured-record provenance", () => {
  it.each(["stdout", "stderr"] as const)("does not promote a rejected original on %s", async (stream) => {
    const secret = 'BAD"DATA';
    const malformed = '{"type":"result","result":"before ' + secret + ' after"}\n';
    expect(() => JSON.parse(malformed)).toThrow();
    const logged: string[] = [];
    const result = await runChildProcess(randomUUID(), process.execPath, ["-e", `
      require('node:fs').writeSync(${stream === "stdout" ? 1 : 2}, ${JSON.stringify(malformed)});
      setTimeout(() => process.exit(0), 300);
    `], {
      cwd: process.cwd(), env: { DATABASE_URL: secret }, timeoutSec: 3, graceSec: 1,
      onLog: async (pipe, text) => { if (pipe === stream) logged.push(text); },
      terminalResultCleanup: {
        graceMs: 20,
        hasTerminalResult: (output) => parseClaudeStreamJson(output[stream]).resultJson !== null,
      },
    });
    // Literal display becomes valid JSON, but the original was rejected.
    expect(parseClaudeStreamJson(result[stream]).resultJson).not.toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.terminalResultCleanup).toBeNull();
    expect(result.controlOutput?.[stream]).toContain("***REDACTED***");
    expect(logged.join("")).toBe(result[stream]);
    expect(logged.join("")).not.toContain(secret);
    if (stream === "stdout") {
      expect(parseClaudeProcessOutput(result).parsedStream.resultJson).toBeNull();
    }
  });

  it.each(['BAD"DATA', "BAD\\DATA", "BAD\tDATA"])("rejects display-only completion after syntax-changing redaction %j", async (secret) => {
    const malformed = '{"type":"result","result":"before ' + secret + ' after"}\n';
    expect(() => JSON.parse(malformed)).toThrow();
    const result = await runChildProcess(randomUUID(), process.execPath, ["-e", `
      require('node:fs').writeSync(1, ${JSON.stringify(malformed)});
    `], {
      cwd: process.cwd(), env: { CLIENT_SECRET: secret }, timeoutSec: 3, graceSec: 1,
      onLog: async () => {},
    });
    expect(parseClaudeStreamJson(result.stdout).resultJson).not.toBeNull();
    expect(parseClaudeProcessOutput(result).parsedStream.resultJson).toBeNull();
    expect(result.stdout).not.toContain(secret);
  });

  it("retains a genuine structured control despite an unsafe unused value", async () => {
    const event = { type: "result", result: "completed", usage: { input_tokens: 17, output_tokens: 7 } };
    const result = await runChildProcess(randomUUID(), process.execPath, ["-e", `
      console.log(JSON.stringify(${JSON.stringify(event)}));
    `], {
      cwd: process.cwd(), env: { CLIENT_SECRET: 'BAD"DATA' }, timeoutSec: 3, graceSec: 1,
      onLog: async () => {},
    });
    expect(parseClaudeProcessOutput(result).parsedStream).toMatchObject({
      summary: "completed", usage: { inputTokens: 17, outputTokens: 7 },
    });
  });
});
