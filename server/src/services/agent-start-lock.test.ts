import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_DISPATCH_PASS_DEADLINE_MS,
  dispatchForAgent,
  isAgentDispatchActive,
  type AgentDispatchPass,
} from "./agent-start-lock.js";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

function meter() {
  const stats = { passes: 0, active: 0, peak: 0, requests: [] as boolean[] };
  const spec = (attach: boolean, body: (signal: AbortSignal) => Promise<void>): AgentDispatchPass<boolean, number> => ({
    request: attach,
    idle: -1,
    merge: (current, next) => current || next,
    async run(request, signal) {
      stats.passes += 1;
      stats.active += 1;
      stats.peak = Math.max(stats.peak, stats.active);
      stats.requests.push(request);
      const pass = stats.passes;
      try {
        await body(signal);
      } finally {
        stats.active -= 1;
      }
      return { value: pass };
    },
  });
  return { stats, spec };
}

describe("agent dispatch passes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs one pass per agent and folds every trigger that arrives during it into one follow-up pass", async () => {
    const agentId = randomUUID();
    const { stats, spec } = meter();
    const first = gate();
    const firstPass = dispatchForAgent(agentId, spec(false, () => first.opened));
    const burst = Array.from({ length: 50 }, (_, index) =>
      dispatchForAgent(agentId, spec(index === 7, async () => undefined)));
    expect(stats).toMatchObject({ passes: 1, peak: 1 });
    first.open();
    expect(await firstPass).toBe(1);
    expect(new Set(await Promise.all(burst))).toEqual(new Set([2]));
    expect(stats).toMatchObject({ passes: 2, peak: 1, requests: [false, true] });
    expect(isAgentDispatchActive(agentId)).toBe(false);
  });

  it("keeps a second pass out while a slow pass runs past the old 30 second stale limit", async () => {
    vi.useFakeTimers();
    const agentId = randomUUID();
    const { stats, spec } = meter();
    const slow = gate();
    const firstPass = dispatchForAgent(agentId, spec(false, () => slow.opened));
    const triggers: Array<Promise<number>> = [];
    for (let second = 0; second < 45; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      triggers.push(dispatchForAgent(agentId, spec(false, async () => undefined)));
    }
    expect(stats).toMatchObject({ passes: 1, peak: 1 });
    slow.open();
    await firstPass;
    await Promise.all(triggers);
    expect(stats).toMatchObject({ passes: 2, peak: 1 });
  });

  it("stops a hung pass at its deadline and lets the waiting trigger run without overlapping it", async () => {
    vi.useFakeTimers();
    const agentId = randomUUID();
    const { stats, spec } = meter();
    let hungSignal: AbortSignal | null = null;
    void dispatchForAgent(agentId, spec(false, (signal) => {
      hungSignal = signal;
      return new Promise<void>(() => undefined);
    }));
    const waiting = dispatchForAgent(agentId, spec(false, async () => undefined));
    await vi.advanceTimersByTimeAsync(AGENT_DISPATCH_PASS_DEADLINE_MS - 1);
    expect(stats.passes).toBe(1);
    expect(hungSignal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(hungSignal!.aborted).toBe(true);
    expect(await waiting).toBe(2);
    expect(stats.passes).toBe(2);
    expect(isAgentDispatchActive(agentId)).toBe(false);
    expect(await dispatchForAgent(agentId, spec(false, async () => undefined))).toBe(3);
  });

  it("lets a trigger stop a hung pass by the pass's start time when its deadline timer has not run", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const agentId = randomUUID();
    const { stats, spec } = meter();
    let hungSignal: AbortSignal | null = null;
    void dispatchForAgent(agentId, spec(false, (signal) => {
      hungSignal = signal;
      return new Promise<void>(() => undefined);
    }));
    vi.advanceTimersByTime(AGENT_DISPATCH_PASS_DEADLINE_MS);
    expect(await dispatchForAgent(agentId, spec(false, async () => undefined))).toBe(2);
    expect(hungSignal!.aborted).toBe(true);
    expect(stats.passes).toBe(2);
  });

  it("does not wait on itself when a pass triggers its own agent", async () => {
    const agentId = randomUUID();
    const { stats, spec } = meter();
    let nested: Promise<number> | null = null;
    const pass = dispatchForAgent(agentId, spec(false, async () => {
      nested = dispatchForAgent(agentId, spec(false, async () => undefined));
      expect(await nested).toBe(-1);
    }));
    expect(await pass).toBe(1);
    await vi.waitFor(() => expect(stats.passes).toBe(2));
    expect(stats.peak).toBe(1);
  });

  it("settles a pass's effects after the next pass may start", async () => {
    const agentId = randomUUID();
    const order: string[] = [];
    const release = gate();
    const pass = dispatchForAgent(agentId, {
      request: null, idle: null, merge: () => null,
      async run() {
        await release.opened;
        return {
          value: null,
          settle: async () => {
            order.push(`settle:${isAgentDispatchActive(agentId)}`);
            await dispatchForAgent(agentId, { request: null, idle: null, merge: () => null,
              async run() { order.push("nested"); return { value: null }; } });
          },
        };
      },
    });
    release.open();
    await pass;
    expect(order).toEqual(["settle:false", "nested"]);
  });

  it("passes a failed pass's error to its caller and frees the agent", async () => {
    const agentId = randomUUID();
    const { spec } = meter();
    await expect(dispatchForAgent(agentId, spec(false, async () => { throw new Error("boom"); }))).rejects.toThrow("boom");
    expect(isAgentDispatchActive(agentId)).toBe(false);
  });
});
