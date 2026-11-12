import { describe, expect, it } from "vitest";
import { ReleaseSwapDriver, type SwapPhaseInfo, type SwapRunReader } from "./release-swap-driver.js";

const info = (phase: SwapPhaseInfo["phase"], overrides: Partial<SwapPhaseInfo> = {}): SwapPhaseInfo => ({ faultId: "f01", phase, at: Date.now(),
  fromUrl: "http://127.0.0.1:9", toUrl: phase === "before_spawn" ? null : "http://127.0.0.1:9", fromPid: 10, toPid: phase === "before_spawn" ? null : 20,
  overlapMs: 60_000, ...overrides });

function driver(input: { rows?: Awaited<ReturnType<SwapRunReader["runsSince"]>>; abandonAfterMs?: number } = {}) {
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const posts: Array<{ url: string; route: string; body: unknown }> = [];
  let issue = 0;
  const swaps = new ReleaseSwapDriver({ options: { swaps: 1, spacingMs: 600_000, overlapMs: 60_000, settleMs: 60_000 }, companyId: "c1",
    adapters: ["opencode"], agents: { opencode: { id: "agent-1" } }, sampleMs: 10, abandonAfterMs: input.abandonAfterMs,
    reader: { runsSince: async () => input.rows ?? [] },
    record: (kind, data) => { events.push({ kind, data }); },
    apiFor: url => ({ post: async <T>(route: string, body?: unknown) => { posts.push({ url, route, body }); issue += 1; return { id: `issue-${issue}`, identifier: `CHA-${issue}` } as T; } }) });
  return { swaps, events, posts };
}

describe("release swap driver", () => {
  it("creates the first probe through the outgoing server's own port and lets a plug-in choose the incoming build", async () => {
    const { swaps, posts } = driver();
    swaps.plugins.push({ name: "mixed", onPhase: async (_swap, phase) => phase.phase === "before_spawn" ? "/checkouts/previous" : undefined });
    expect(await swaps.hook(info("before_spawn"))).toBe("/checkouts/previous");
    await swaps.hook(info("spawned"));
    await swaps.hook(info("stopping"));
    await swaps.hook(info("stopped", { at: Date.now() - 61_000 }));
    await swaps.drain();
    expect(posts[0]).toMatchObject({ url: "http://127.0.0.1:9", route: "/api/companies/c1/issues", body: { assigneeAgentId: "agent-1", status: "todo" } });
    expect(swaps.swaps[0]).toMatchObject({ serverRoot: "/checkouts/previous", abandoned: null, toPid: 20 });
    expect(swaps.swaps[0]!.probes[0]).toMatchObject({ kind: "prep", issueId: "issue-1", identifier: "CHA-1" });
    expect(swaps.swaps[0]!.evidence).not.toBeNull();
  });

  it("ends a swap whose incoming server never came up, so draining cannot hang", async () => {
    const { swaps, events } = driver({ abandonAfterMs: 50 });
    await swaps.hook(info("before_spawn"));
    await swaps.hook(info("spawned"));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(swaps.swaps[0]!.abandoned).toMatch(/not stopped within/);
    await swaps.drain();
    expect(swaps.swaps[0]!.evidence?.findings[0]).toMatch(/^swap abandoned/);
    expect(swaps.launchOpen).toBe(false);
    expect(events.some(event => event.kind === "release_swap_abandoned")).toBe(true);
  });

  it("abandons the open swap when the wave finishes or the harness is interrupted while draining", async () => {
    const finished = driver();
    await finished.swaps.hook(info("before_spawn"));
    await finished.swaps.hook(info("spawned"));
    await finished.swaps.drain();
    expect(finished.swaps.swaps[0]!.abandoned).toMatch(/wave finished/);
    const next = driver();
    await next.swaps.hook(info("before_spawn"));
    await next.swaps.hook(info("spawned"));
    await next.swaps.hook(info("before_spawn", { faultId: "f02" }));
    expect(next.swaps.swaps[0]!.abandoned).toMatch(/new swap \(f02\)/);
    await next.swaps.drain(() => true);
    expect(next.swaps.swaps[1]!.abandoned).not.toBeNull();
  });
});
