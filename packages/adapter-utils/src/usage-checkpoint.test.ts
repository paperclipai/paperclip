import { describe, expect, it, vi } from "vitest";
import { createUsageCheckpointLog } from "./usage-checkpoint.js";
import { runChildProcess } from "./server-utils.js";
import type { AdapterUsageCheckpoint } from "./types.js";

const createParser = () => {
  let costUsd = 0;
  return (stdout: string): AdapterUsageCheckpoint => {
    const events = stdout.trim().split("\n").map(line => JSON.parse(line));
    costUsd += events.reduce((sum, event) => sum + event.usage.costUsd, 0);
    return { costUsd, complete: events.some(event => event.type === "result") };
  };
};
const event = JSON.stringify({ type: "usage", usage: { inputTokens: 2, costUsd: 0.25 }, text: "private content" });

describe("usage checkpoint stream", () => {
  it("redacts malformed counter text without making the counter absent", async () => {
    const consume = vi.fn((_records: string) => null);
    const log = createUsageCheckpointLog(vi.fn(), vi.fn(), consume);
    await log("stdout", JSON.stringify({ type: "result", usage: {
      input_tokens: 2, output_tokens: 1, cached_input_tokens: "private malformed counter",
    } }) + "\n");
    const retained = consume.mock.calls[0][0];
    expect(retained).not.toContain("private malformed counter");
    const usage = JSON.parse(retained).usage;
    expect(Object.hasOwn(usage, "cached_input_tokens")).toBe(true);
    expect(typeof usage.cached_input_tokens).not.toBe("number");
    expect(usage.cached_input_tokens).not.toBeNull();
  });

  it.each([false, true])("persists reported zero usage on confirmed completion (newline=%s)", async newline => {
    const saved = vi.fn();
    const receipt = { usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, costUsd: null, complete: false };
    const log = createUsageCheckpointLog(vi.fn(), saved, () => receipt);
    await log("stdout", JSON.stringify({ type: "step_finish", part: { tokens: { input: 0, output: 0 } } }) + (newline ? "\n" : ""));
    expect(saved).not.toHaveBeenCalled();
    await log.flush({ complete: true });
    expect(saved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ...receipt, complete: true }));
    await log.flush({ complete: true });
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it("propagates a zero-receipt persistence failure before cleanup and never invents absent usage", async () => {
    const failure = new Error("Cannot persist zero receipt");
    const saved = vi.fn().mockRejectedValue(failure);
    const log = createUsageCheckpointLog(vi.fn(), saved, () => ({ usage: { inputTokens: 0, outputTokens: 0 }, costUsd: null, complete: false }));
    await log.flush({ complete: true });
    expect(saved).not.toHaveBeenCalled();
    await log("stdout", '{"type":"step_finish","part":{"tokens":{"input":0,"output":0}}}');
    await expect(log.flush({ complete: true })).rejects.toBe(failure);
  });

  it("flushes an unterminated Pi price and closes each attempt independently", async () => {
    const saved = vi.fn(); const parser = vi.fn(createParser());
    const first = createUsageCheckpointLog(vi.fn(), saved, parser);
    await first("stdout", event);
    expect(saved).not.toHaveBeenCalled();
    await first.flush({ complete: true });
    const second = createUsageCheckpointLog(vi.fn(), saved, createParser());
    await second("stdout", event + "\n");
    await second.flush({ complete: true });
    expect(saved.mock.calls[0][0]).toMatchObject({ costUsd: 0.25, complete: true });
    expect(saved.mock.calls.at(-1)![0]).toMatchObject({ costUsd: 0.25, complete: true });
    expect(saved.mock.calls.at(-1)![0].attemptId).not.toBe(saved.mock.calls[0][0].attemptId);
    expect(parser.mock.calls[0][0]).not.toContain("private content");
  });

  it("bounds large content strings before buffering and preserves usage on either side", async () => {
    const saved = vi.fn(); const parser = vi.fn(createParser()); const output = vi.fn();
    const log = createUsageCheckpointLog(output, saved, parser);
    const line = JSON.stringify({ type: "result", usage: { inputTokens: 2, costUsd: 0.25 }, messages: [{ content: '"\\\n'.repeat(2 * 1024 * 1024) }], model: "after-large-content" });
    for (let offset = 0; offset < line.length; offset += 4093) await log("stdout", line.slice(offset, offset + 4093));
    await log.flush();
    expect(saved).toHaveBeenLastCalledWith(expect.objectContaining({ costUsd: 0.25, complete: true }));
    expect(parser.mock.calls[0][0]).toContain("after-large-content");
    expect(parser.mock.calls[0][0].length).toBeLessThan(1000);
    expect(output.mock.calls.map(call => call[1]).join("")).toBe(line);
  });

  it("preserves Unicode and escaped quotes across the string limit and chunk boundaries", async () => {
    for (const suffix of ['\\u1234', '\\"', '\\\\']) {
      const saved = vi.fn(); const parser = vi.fn(createParser());
      const log = createUsageCheckpointLog(vi.fn(), saved, parser);
      const line = '{"type":"result","text":"' + 'a'.repeat(249) + suffix + 'discarded","usage":{"costUsd":0.25}}\n';
      for (const character of line) await log("stdout", character);
      await log.flush();
      expect(saved).toHaveBeenCalledWith(expect.objectContaining({ costUsd: 0.25 }));
    }
  });

  it("surfaces a persistence failure outside the local process's best-effort log path", async () => {
    const failure = new Error("Receipt storage unavailable");
    const output = vi.fn(); const saved = vi.fn().mockRejectedValue(failure);
    const log = createUsageCheckpointLog(output, saved, createParser());
    const result = await runChildProcess("checkpoint-test", process.execPath, ["-e", `process.stdout.write(${JSON.stringify(event + "\n")})`], {
      cwd: process.cwd(), env: {}, timeoutSec: 5, graceSec: 1, onLog: log,
    });
    expect(result.exitCode).toBe(0);
    expect(output).toHaveBeenCalledWith("stdout", event + "\n");
    await expect(log.flush()).rejects.toBe(failure);
  });

  it("clears every price representation when the display lost a cost record", async () => {
    const saved = vi.fn();
    const log = createUsageCheckpointLog(vi.fn(), saved, () => ({
      usage: { inputTokens: 2, outputTokens: 1 }, costUsd: 0.25, costUsdExact: "0.25",
      cacheAdjustedCostUsd: 0.25, usageByModel: [{ model: "example", usage: { inputTokens: 2, outputTokens: 1 }, costUsd: 0.25 }], complete: false,
    }));
    await log("stdout", '{"type":"step_finish","part":{"cost":***REDACTED***}}\n');
    await log("stdout", event + "\n");
    await log.flush({ complete: true });
    expect(saved).toHaveBeenLastCalledWith(expect.objectContaining({ costUsd: null, costUsdExact: null, cacheAdjustedCostUsd: null, costStatus: "unpriced", complete: true }));
    expect(saved.mock.calls.at(-1)![0].usageByModel).toBeUndefined();
  });

  it("does not promote partial usage to complete merely because the stream was flushed", async () => {
    const saved = vi.fn(); const log = createUsageCheckpointLog(vi.fn(), saved, createParser());
    await log("stdout", event); await log.flush();
    expect(saved.mock.calls.at(-1)![0]).toMatchObject({ costUsd: 0.25, complete: false });
  });

  it("persists each changed total and the final receipt before publishing its chunk", async () => {
    const order: string[] = [];
    const saved = vi.fn(async (receipt: AdapterUsageCheckpoint) => { order.push(`saved:${receipt.costUsd}:${receipt.complete}`); });
    const log = createUsageCheckpointLog(async () => { order.push("log"); }, saved, createParser());
    await log("stdout", event + "\n");
    await log("stdout", event + "\n");
    await log("stdout", JSON.stringify({ type: "result", usage: { costUsd: 0 } }) + "\n");
    expect(order).toEqual(["saved:0.25:false", "log", "saved:0.5:false", "log", "saved:0.5:true", "log"]);
  });

  it("saves every new receipt before logging with linear parsing work", async () => {
    const parser = vi.fn(createParser()); const saved = vi.fn();
    const log = createUsageCheckpointLog(vi.fn(), saved, parser);
    for (let i = 0; i < 1024; i++) {
      await log("stdout", event + "\n");
      expect(saved.mock.calls.at(-1)![0].costUsd).toBe((i + 1) * 0.25);
    }
    await log.flush({ complete: true });
    expect(saved.mock.calls.at(-1)![0]).toMatchObject({ costUsd: 256, complete: true });
    expect(saved).toHaveBeenCalledTimes(1025); // all updates plus completion
    expect(parser).toHaveBeenCalledTimes(1024);
    expect(parser.mock.calls.reduce((sum, [input]) => sum + input.length, 0)).toBeLessThanOrEqual(1024 * (event.length + 1));
  });

  describe("records the display stream lost to redaction", () => {
    const marker = "***REDACTED***";
    const damagedStep = `{"type":"step_finish","part":{"cost":0.0025,"tokens":{"input":${marker},"output":7}}}`;
    const run = async (...lines: string[]) => {
      const log = createUsageCheckpointLog(vi.fn(), vi.fn(), () => null);
      for (const line of lines) await log("stdout", line + "\n");
      await log.flush();
      return log.unreadRecords();
    };

    it("counts an accounting line whose numeric counter was replaced by the marker", async () => {
      expect(await run(damagedStep, damagedStep)).toBe(2);
    });

    it("recognizes partial and repeated secret matches within one numeric token", async () => {
      expect(await run(
        damagedStep.replace(`:${marker},`, `:91${marker}78,`),
        damagedStep.replace(`:${marker},`, `:91${marker}${marker}78,`),
        damagedStep.replace(`:${marker},`, `:91${marker}7${marker}78,`),
      )).toBe(3);
    });

    it("does not count accounting words, nested envelopes, or Pi message duplicates as costs", async () => {
      expect(await run(
        `{"type":"text","part":{"text":"cost usage tokens step_finish turn_end","cost":${marker}}}`,
        `{"type":"text","part":{"type":"step_finish","tokens":{"input":${marker}}}}`,
        `{"type":"message_end","message":{"role":"assistant","usage":{"input":${marker},"cost":{"total":0.0025}}}}`,
      )).toBe(0);
    });

    it("counts Pi turns and standalone usage, not words in their content", async () => {
      expect(await run(
        `{"type":"turn_end","message":{"usage":{"input":${marker},"cost":{"total":0.0025}}}}`,
        `{"type":"usage","usage":{"costUsd":${marker}}}`,
      )).toBe(2);
    });

    it("counts a marker-damaged line that is still unterminated at flush", async () => {
      const log = createUsageCheckpointLog(vi.fn(), vi.fn(), () => null);
      await log("stdout", damagedStep);
      await log.flush();
      expect(log.unreadRecords()).toBe(1);
    });

    it("does not count a line that parses, a non-record line, or an unrelated damaged line", async () => {
      expect(await run(
        '{"type":"step_finish","part":{"cost":0.0025,"tokens":{"input":' + JSON.stringify(marker) + ',"output":7}}}',
        `not json ${marker} tokens cost`,
        `{"type":"text","part":{"text":"hello ${marker.slice(0, 4)}","n":${marker}}}`,
        '{"type":"step_finish","part":{"cost":0.0025,"tokens":{"input":',
      )).toBe(0);
    });
  });
});
