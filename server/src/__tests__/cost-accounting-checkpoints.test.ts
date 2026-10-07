import { describe, expect, it, vi } from "vitest";
import { createUsageCheckpointLog } from "@paperclipai/adapter-utils/usage-checkpoint";
import { parseClaudeStreamJson } from "../../../packages/adapters/claude-local/src/server/parse.js";
import { parseCodexJsonl } from "../../../packages/adapters/codex-local/src/server/parse.js";
import { parseCursorJsonl } from "../../../packages/adapters/cursor-local/src/server/parse.js";
import { parseGeminiJsonl } from "../../../packages/adapters/gemini-local/src/server/parse.js";
import { parseOpenCodeJsonl } from "../../../packages/adapters/opencode-local/src/server/parse.js";
import { parsePiJsonl } from "../../../packages/adapters/pi-local/src/server/parse.js";
const secret = "TRANSCRIPT_CONTENT_MUST_NOT_ENTER_ACCOUNTING_BUFFER";
const fixtures = [
  { name: "claude", event: { type: "result", total_cost_usd: 0.0123, result: secret, usage: { input_tokens: 7, cache_read_input_tokens: 11, output_tokens: 3 } }, parse: parseClaudeStreamJson, input: 7, cached: 11, output: 3 },
  { name: "codex", event: { type: "turn.completed", text: secret, usage: { input_tokens: 18, cached_input_tokens: 11, output_tokens: 3 } }, parse: parseCodexJsonl, input: 7, cached: 11, output: 3 },
  { name: "cursor", event: { type: "result", result: secret, usage: { inputTokens: 7, cachedInputTokens: 11, outputTokens: 3 } }, parse: parseCursorJsonl, input: 7, cached: 11, output: 3 },
  { name: "gemini", event: { type: "result", message: secret, stats: { input_tokens: 18, cached: 11, output_tokens: 1, total_tokens: 21 } }, parse: parseGeminiJsonl, input: 7, cached: 11, output: 3 },
  { name: "opencode", event: { type: "step_finish", part: { text: secret, cost: 0.0123, tokens: { input: 5, cache: { read: 11, write: 2 }, output: 1, reasoning: 2 } } }, parse: parseOpenCodeJsonl, input: 7, cached: 11, output: 3 },
  { name: "pi", event: { type: "turn_end", message: { role: "assistant", content: secret, usage: { input: 5, cacheWrite: 2, cacheRead: 11, output: 3, cost: { total: 0.0123 } } } }, parse: parsePiJsonl, input: 7, cached: 11, output: 3 },
];
describe("durable accounting stream projection", () => {
  it.each(fixtures)("captures split $name usage without retaining transcript content", async f => {
    const onUsage = vi.fn(async (..._args: any[]) => {}), onLog = vi.fn(async (..._args: any[]) => {});
    const parse = vi.fn((source: string) => {
      expect(source).not.toContain(secret);
      const result = f.parse(source); return { usage: result.usage ?? undefined, complete: true };
    });
    const log = createUsageCheckpointLog(onLog, onUsage, parse);
    const line = JSON.stringify(f.event) + "\n";
    for (let index = 0; index < line.length; index += 7) await log("stdout", line.slice(index,index+7));
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0][0]).toMatchObject({ complete: true, attemptId: expect.any(String), usage: { inputTokens: f.input, cachedInputTokens: f.cached, outputTokens: f.output } });
    expect(onLog.mock.calls.map(call => call[1]).join("")).toBe(line);
  });
  it("awaits durability before publication, suppresses identical snapshots and separates attempts", async () => {
    const order: string[] = [];
    const onUsage = vi.fn(async (..._args: any[]) => { order.push("durable"); });
    const parse = () => ({ usage: { inputTokens: 1, outputTokens: 2 }, complete: false });
    const log = createUsageCheckpointLog(async () => { order.push("published"); }, onUsage, parse);
    const message = '{"type":"result","usage":{"input_tokens":1}}\n';
    await log("stdout", message); await log("stdout", message);
    expect(order).toEqual(["durable", "published", "published"]);
    const other = createUsageCheckpointLog(async () => {}, onUsage, parse); await other("stdout", message);
    expect(onUsage.mock.calls[0][0].attemptId).not.toBe(onUsage.mock.calls[1][0].attemptId);
  });
  it("propagates receipt failures and leaves ordinary logs and stderr alone when disabled", async () => {
    const onLog = vi.fn(async (..._args: any[]) => {});
    const disabled = createUsageCheckpointLog(onLog, undefined, () => null);
    await disabled("stdout", "ordinary output"); await disabled.flush();
    expect(onLog).toHaveBeenCalledWith("stdout", "ordinary output");
    onLog.mockClear();
    const onUsage = vi.fn(async () => { throw new Error("spool full"); });
    const parse = vi.fn(() => ({ usage: { inputTokens: 1, outputTokens: 0 }, complete: false }));
    const log = createUsageCheckpointLog(onLog, onUsage, parse);
    await log("stderr", '{"usage":1}\n'); await log("stdout", 'invalid json\n{"text":"plain"}\n');
    expect(onUsage).not.toHaveBeenCalled(); onLog.mockClear();
    await log("stdout", '{"usage":{"input_tokens":1}}\n');
    expect(onLog).toHaveBeenCalled();
    await expect(log.flush()).rejects.toThrow("spool full");
    const oversized = createUsageCheckpointLog(onLog, onUsage, parse);
    await oversized("stdout", "x".repeat(8*1024*1024+1));
    await expect(oversized.flush()).rejects.toThrow("exceeds");
  });
});
