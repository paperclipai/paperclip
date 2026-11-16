import { describe, expect, it } from "vitest";
import { whileFrozen, type SendSignal } from "./server-freeze.js";

function signals(exited = false) {
  const sent: Array<[number, string | number]> = [];
  const send: SendSignal = (pid, signal) => {
    if (exited && signal === (0 as unknown as NodeJS.Signals)) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    sent.push([pid, signal]);
  };
  return { sent, send };
}

describe("freezing the incoming server while the outgoing one stops", () => {
  it("resumes the incoming server after the freeze when the stop succeeds", async () => {
    const { sent, send } = signals();
    const waits: number[] = [];
    const frozen = await whileFrozen({ pid: 42, freezeMs: 150_000, send, wait: async ms => { waits.push(ms); } }, async () => "stopped");
    expect(frozen.result).toBe("stopped");
    expect(frozen.thawedAt).not.toBeNull();
    expect(sent.filter(([, signal]) => signal !== 0)).toEqual([[42, "SIGSTOP"], [42, "SIGCONT"]]);
    expect(waits[0]).toBeGreaterThan(149_000);
  });

  it("resumes the incoming server at once when stopping the outgoing one fails", async () => {
    const { sent, send } = signals();
    await expect(whileFrozen({ pid: 42, freezeMs: 150_000, send, wait: async () => undefined }, async () => { throw new Error("stop timed out"); }))
      .rejects.toThrow(/stop timed out/);
    expect(sent.filter(([, signal]) => signal !== 0)).toEqual([[42, "SIGSTOP"], [42, "SIGCONT"]]);
  });

  it("sends nothing after the incoming server exited, and nothing at all without a freeze", async () => {
    const exited = signals(true);
    await expect(whileFrozen({ pid: 42, freezeMs: 1_000, send: exited.send, wait: async () => undefined }, async () => { throw new Error("boom"); })).rejects.toThrow();
    expect(exited.sent).toEqual([[42, "SIGSTOP"]]);
    const none = signals();
    expect(await whileFrozen({ pid: 42, freezeMs: null, send: none.send }, async () => 1)).toEqual({ result: 1, frozenAt: null, thawedAt: null });
    expect(none.sent).toEqual([]);
  });
});
