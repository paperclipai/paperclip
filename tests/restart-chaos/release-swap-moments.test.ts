import { describe, expect, it } from "vitest";
import { ReleaseSwapDriver, mergeRunSample, type SwapPhaseInfo, type SwapRecord } from "./release-swap-driver.js";
import { runsStartedDuringSwap, swapMoments, swapMomentsMarkdown } from "./release-swap-moments.js";

const base = Date.parse("2026-11-12T20:00:00.000Z");

function swap(): SwapRecord {
  return { index: 1, faultId: "f01", fromPid: 10, toPid: 20, fromUrl: "a", toUrl: "b", serverRoot: null, requestedAt: base, spawnedAt: base + 1_000,
    switchedAt: base + 30_000, overlapEndsAt: base + 540_000, stopRequestedAt: base + 540_000, stoppedAt: base + 545_000,
    incomingPhases: [{ phase: "starting", at: base + 2_000 }, { phase: "ready", at: base + 29_500 }], probes: [], runs: {}, sampleErrors: 0, plugins: [],
    abandoned: null, evidence: null };
}

const row = (runId: string, startedAt: number, ownerPid: number) => ({ runId, issueId: `i-${runId}`, createdAt: startedAt, startedAt, finishedAt: null, errorCode: null,
  at: startedAt + 500, status: "running", ownerPid, executionStage: "executing", nativePhase: null, lastOutputSeq: 1 });

describe("release swap moments", () => {
  it("gives the five moments and places each run started during the swap between two of them, with the server that started it", () => {
    const record = swap();
    for (const sample of [row("before-ready", base + 10_000, 10), row("overlap-old", base + 200_000, 10), row("overlap-new", base + 300_000, 20),
      row("draining", base + 542_000, 20), row("earlier", base - 60_000, 10)]) mergeRunSample(record.runs, sample);
    expect(swapMoments(record)).toEqual({ incoming_spawned: base + 1_000, incoming_ready: base + 29_500, traffic_switched: base + 30_000,
      outgoing_sigterm: base + 540_000, outgoing_exited: base + 545_000 });
    expect(runsStartedDuringSwap(record).map(run => [run.runId, run.after, run.before, run.startedBy])).toEqual([
      ["before-ready", "incoming_spawned", "incoming_ready", "old"],
      ["overlap-old", "traffic_switched", "outgoing_sigterm", "old"],
      ["overlap-new", "traffic_switched", "outgoing_sigterm", "new"],
      ["draining", "outgoing_sigterm", "outgoing_exited", "new"],
    ]);
    const lines = swapMomentsMarkdown([record]);
    expect(lines[0]).toBe("| Swap | incoming_spawned | incoming_ready | traffic_switched | outgoing_sigterm | outgoing_exited |");
    expect(lines[2]).toBe("| 1 | 20:00:01.000 | 20:00:29.500 | 20:00:30.000 | 20:09:00.000 | 20:09:05.000 |");
    expect(lines).toContain("- Swap 1: run overlap-old started 20:03:20.000, between traffic_switched and outgoing_sigterm, by the outgoing server");
  });

  it("records each moment in the timeline under its own name, with SIGTERM only at the outgoing server's stop", async () => {
    const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
    const driver = new ReleaseSwapDriver({ options: { swaps: 1, spacingMs: 600_000, overlapMs: 60_000, settleMs: 60_000 }, companyId: "c1", adapters: ["opencode"],
      agents: { opencode: { id: "agent-1" } }, sampleMs: 10, reader: { runsSince: async () => [] }, record: (kind, data) => { events.push({ kind, data }); },
      apiFor: () => ({ post: async <T>() => ({ id: "issue-1" }) as T }) });
    const info = (phase: SwapPhaseInfo["phase"], at: number): SwapPhaseInfo => ({ faultId: "f01", phase, at, fromUrl: "http://127.0.0.1:9",
      toUrl: phase === "before_spawn" ? null : "http://127.0.0.1:9", fromPid: 10, toPid: phase === "before_spawn" ? null : 20, overlapMs: 60_000 });
    const now = Date.now();
    for (const [phase, at] of [["before_spawn", now], ["spawned", now + 1], ["switched", now + 2], ["stopping", now + 3], ["stopped", now - 61_000]] as const) {
      await driver.hook(info(phase, at));
    }
    await driver.drain();
    expect(events.filter(event => event.kind.startsWith("swap_")).map(event => event.kind))
      .toEqual(["swap_incoming_spawned", "swap_incoming_ready", "swap_traffic_switched", "swap_outgoing_sigterm", "swap_outgoing_exited"]);
    expect(events.find(event => event.kind === "swap_incoming_ready")!.data).toMatchObject({ confirmedBy: "supervisor", at: new Date(now + 2).toISOString() });
    expect(events.find(event => event.kind === "swap_outgoing_sigterm")!.data).toMatchObject({ swap: 1, fromPid: 10, at: new Date(now + 3).toISOString() });
  });

  it("never places readiness after the traffic switch when the readiness watcher answers late", () => {
    const record = { ...swap(), incomingPhases: [{ phase: "starting", at: base + 2_000 }, { phase: "ready", at: base + 35_000 }] };
    mergeRunSample(record.runs, row("just-after-switch", base + 32_000, 20));
    expect(swapMoments(record)).toMatchObject({ incoming_ready: base + 30_000, traffic_switched: base + 30_000 });
    expect(runsStartedDuringSwap(record).map(run => [run.runId, run.after, run.before])).toEqual([["just-after-switch", "traffic_switched", "outgoing_sigterm"]]);
  });
});
