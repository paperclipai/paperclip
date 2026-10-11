import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runChildProcess } from "./server-utils.js";
import { runAdapterExecutionTargetProcess } from "./execution-target.js";

const producer = `let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => { const data = JSON.parse(input); require('node:fs').writeSync(data.pipe === 'stderr' ? 2 : 1, data.text); if (data.wait) setTimeout(() => process.exit(0), data.wait); });`;
function options(text: string, pipe: "stdout" | "stderr" = "stdout", wait = 0, env: Record<string, string> = {}) {
  return { cwd: process.cwd(), env, stdin: JSON.stringify({ text, pipe, wait }), timeoutSec: 5, graceSec: 1, onLog: async () => {} };
}

describe("captured-output execution-target callback boundary", () => {
  it("direct child delivers complete and EOF records once", async () => {
    const records: string[] = [];
    const text = '{"type":"assistant","message":"first"}\n{"type":"assistant","message":"last"}';
    const result = await runChildProcess(randomUUID(), process.execPath, ["-e", producer], {
      ...options(text), onControlOutput: async (pipe, value) => { records.push(pipe + ":" + value); },
    });
    expect(result.exitCode).toBe(0);
    expect(records.map(x => x.slice("stdout:".length)).join("")).toBe(text);
    expect(records.every(x => x.startsWith("stdout:"))).toBe(true);
  });
  it("real local wrapper forwards the identical callback", async () => {
    const records: string[] = [];
    const text = '{"type":"assistant","message":"first"}\n{"type":"assistant","message":"last"}';
    const result = await runAdapterExecutionTargetProcess(randomUUID(), null, process.execPath, ["-e", producer], {
      ...options(text), onControlOutput: async (pipe, value) => { records.push(pipe + ":" + value); },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(text);
    expect(records.map(x => x.slice("stdout:".length)).join("")).toBe(text);
  });
});
