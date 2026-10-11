import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { parseCodexProcessOutput, parseCodexJsonl } from "./parse.js";

describe("original Codex control provenance", () => {
  it("preserves a genuine terminal control and unaffected accounting", async () => {
    const text = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 17, output_tokens: 7 } });
    const result = await runChildProcess(randomUUID(), process.execPath, ["-e", `
      require('node:fs').writeSync(1, ${JSON.stringify(text)});
    `], {
      cwd: process.cwd(), env: { CLIENT_SECRET: 'unused"value' }, timeoutSec: 3, graceSec: 1,
      onLog: async () => {},
    });
    expect(parseCodexProcessOutput(result)).toMatchObject({
      sawProtocolTerminalEvent: true, usage: { inputTokens: 17, outputTokens: 7 },
    });
  });

  it("does not promote malformed original JSON into terminal accounting", async () => {
    const secret = 'BAD"DATA';
    const text = '{"type":"turn.completed","usage":{"input_tokens":17,"output_tokens":7},"note":"before ' + secret + ' after"}\n';
    expect(() => JSON.parse(text)).toThrow();
    const result = await runChildProcess(randomUUID(), process.execPath, ["-e", `
      require('node:fs').writeSync(1, ${JSON.stringify(text)});
    `], {
      cwd: process.cwd(), env: { CLIENT_SECRET: secret }, timeoutSec: 3, graceSec: 1,
      onLog: async () => {},
    });
    expect(parseCodexJsonl(result.stdout).sawProtocolTerminalEvent).toBe(true);
    expect(parseCodexProcessOutput(result).sawProtocolTerminalEvent).toBe(false);
    expect(result.stdout).not.toContain(secret);
  });

  it("does not trust unannotated display fallback from a structured producer", () => {
    const stdout = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 17 } });
    expect(parseCodexProcessOutput({ stdout, controlOutput: { stdout: "***REDACTED***", stderr: "" } }).sawProtocolTerminalEvent).toBe(false);
    expect(parseCodexProcessOutput({ stdout }).sawProtocolTerminalEvent).toBe(true);
  });
});
