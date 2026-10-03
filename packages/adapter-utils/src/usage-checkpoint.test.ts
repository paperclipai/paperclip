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
});
