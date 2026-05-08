import { describe, expect, it, vi } from "vitest";
import {
  createGoalSubtreeCache,
  isGoalInSyncedSubtree,
} from "../src/goal-subtree-cache.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

// ── Helpers ──────────────────────────────────────────────────────────────────

type GoalRow = {
  id: string;
  title: string;
  parentId: string | null;
  companyId: string;
};

function makeCtx(goals: GoalRow[]): PluginContext {
  const byId = new Map(goals.map((g) => [g.id, g]));
  return {
    goals: {
      get: vi.fn(async (id: string) => byId.get(id) ?? null),
    },
  } as unknown as PluginContext;
}

// ── 3-level tree fixture ──────────────────────────────────────────────────────
//
// root-a ("eee6ff51-…")
//   └─ mid-a
//       └─ leaf-a   ← in scope
//
// root-b
//   └─ mid-b
//       └─ leaf-b   ← out of scope
//
// leaf-orphan (no parent)  ← root-less, out of scope when syncedGoalIds set

const GOALS: GoalRow[] = [
  { id: "eee6ff51-0000-0000-0000-000000000001", title: "Root A", parentId: null, companyId: "co-1" },
  { id: "mid-a", title: "Mid A", parentId: "eee6ff51-0000-0000-0000-000000000001", companyId: "co-1" },
  { id: "leaf-a", title: "Leaf A", parentId: "mid-a", companyId: "co-1" },
  { id: "root-b", title: "Root B", parentId: null, companyId: "co-1" },
  { id: "mid-b", title: "Mid B", parentId: "root-b", companyId: "co-1" },
  { id: "leaf-b", title: "Leaf B", parentId: "mid-b", companyId: "co-1" },
  { id: "leaf-orphan", title: "Orphan Leaf", parentId: null, companyId: "co-1" },
];

const SYNCED_ROOTS = ["eee6ff51"]; // short-prefix match

// ── isGoalInSyncedSubtree ─────────────────────────────────────────────────────

describe("isGoalInSyncedSubtree — 3-level goal tree", () => {
  it("in-scope branch (leaf-a under root-a) → true", async () => {
    const ctx = makeCtx(GOALS);
    const cache = createGoalSubtreeCache();
    const result = await isGoalInSyncedSubtree("leaf-a", "co-1", SYNCED_ROOTS, cache, ctx);
    expect(result).toBe(true);
  });

  it("out-of-scope branch (leaf-b under root-b) → false", async () => {
    const ctx = makeCtx(GOALS);
    const cache = createGoalSubtreeCache();
    const result = await isGoalInSyncedSubtree("leaf-b", "co-1", SYNCED_ROOTS, cache, ctx);
    expect(result).toBe(false);
  });

  it("root-less goal (leaf-orphan, no parent) → false when syncedGoalIds set", async () => {
    const ctx = makeCtx(GOALS);
    const cache = createGoalSubtreeCache();
    const result = await isGoalInSyncedSubtree("leaf-orphan", "co-1", SYNCED_ROOTS, cache, ctx);
    expect(result).toBe(false);
  });

  it("empty syncedGoalIds → all goals in scope", async () => {
    const ctx = makeCtx(GOALS);
    const cache = createGoalSubtreeCache();
    expect(await isGoalInSyncedSubtree("leaf-b", "co-1", [], cache, ctx)).toBe(true);
    expect(await isGoalInSyncedSubtree("leaf-orphan", "co-1", [], cache, ctx)).toBe(true);
  });

  it("short-prefix matches full UUID root", async () => {
    const ctx = makeCtx(GOALS);
    const cache = createGoalSubtreeCache();
    // mid-a is a direct child — still matches via ancestor chain
    const result = await isGoalInSyncedSubtree("mid-a", "co-1", ["eee6ff51"], cache, ctx);
    expect(result).toBe(true);
  });
});

// ── Cache hit / TTL / invalidation ───────────────────────────────────────────

describe("GoalSubtreeCache — TTL and invalidation", () => {
  it("caches result: goals.get called fewer times on second resolve", async () => {
    const ctx = makeCtx(GOALS);
    const cache = createGoalSubtreeCache(60_000);

    await cache.getAncestorChain("leaf-a", "co-1", ctx);
    const callsAfterFirst = (ctx.goals.get as ReturnType<typeof vi.fn>).mock.calls.length;

    await cache.getAncestorChain("leaf-a", "co-1", ctx);
    const callsAfterSecond = (ctx.goals.get as ReturnType<typeof vi.fn>).mock.calls.length;

    // Second call should not trigger any additional goals.get calls
    expect(callsAfterSecond).toBe(callsAfterFirst);
  });

  it("cache invalidation: after invalidate(), next resolve re-fetches goal", async () => {
    // Simulate rename: before=original title, after=new title (id stays same)
    const goalsV1: GoalRow[] = [
      { id: "eee6ff51-0000-0000-0000-000000000001", title: "Old Root Name", parentId: null, companyId: "co-1" },
      { id: "leaf-a", title: "Leaf A", parentId: "eee6ff51-0000-0000-0000-000000000001", companyId: "co-1" },
    ];
    const goalsV2: GoalRow[] = [
      { id: "eee6ff51-0000-0000-0000-000000000001", title: "New Root Name", parentId: null, companyId: "co-1" },
      { id: "leaf-a", title: "Leaf A", parentId: "eee6ff51-0000-0000-0000-000000000001", companyId: "co-1" },
    ];

    const cache = createGoalSubtreeCache(60_000);

    // First resolve populates cache with v1
    const ctxV1 = makeCtx(goalsV1);
    const chainBefore = await cache.getAncestorChain("leaf-a", "co-1", ctxV1);
    expect(chainBefore).toContain("eee6ff51-0000-0000-0000-000000000001");

    // Simulate goal.updated event — invalidate
    cache.invalidate("co-1");

    // Next resolve uses v2 context (renamed goal)
    const ctxV2 = makeCtx(goalsV2);
    // isGoalInSyncedSubtree re-fetches because cache was invalidated
    const result = await isGoalInSyncedSubtree(
      "leaf-a",
      "co-1",
      ["eee6ff51"],
      cache,
      ctxV2,
    );
    // Still in scope — id unchanged, rename doesn't break membership
    expect(result).toBe(true);
    // ctxV2.goals.get was called (not served from stale cache)
    expect((ctxV2.goals.get as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

  it("TTL expiry causes re-fetch", async () => {
    const ctx = makeCtx(GOALS);
    // 0ms TTL means immediately stale
    const cache = createGoalSubtreeCache(0);

    await cache.getAncestorChain("leaf-a", "co-1", ctx);
    const callsAfterFirst = (ctx.goals.get as ReturnType<typeof vi.fn>).mock.calls.length;

    await cache.getAncestorChain("leaf-a", "co-1", ctx);
    const callsAfterSecond = (ctx.goals.get as ReturnType<typeof vi.fn>).mock.calls.length;

    // Must re-fetch after expiry
    expect(callsAfterSecond).toBeGreaterThan(callsAfterFirst);
  });

  it("invalidate() scoped to companyId — other company unaffected", async () => {
    const goalsCoA: GoalRow[] = [{ id: "goal-a", title: "G", parentId: null, companyId: "co-a" }];
    const goalsCoB: GoalRow[] = [{ id: "goal-b", title: "G", parentId: null, companyId: "co-b" }];
    const ctxA = makeCtx(goalsCoA);
    const ctxB = makeCtx(goalsCoB);
    const cache = createGoalSubtreeCache(60_000);

    await cache.getAncestorChain("goal-a", "co-a", ctxA);
    await cache.getAncestorChain("goal-b", "co-b", ctxB);

    cache.invalidate("co-a");

    // co-b entry still cached — no extra calls
    const callsBefore = (ctxB.goals.get as ReturnType<typeof vi.fn>).mock.calls.length;
    await cache.getAncestorChain("goal-b", "co-b", ctxB);
    expect((ctxB.goals.get as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });
});

// ── Depth measurement ─────────────────────────────────────────────────────────
//
// Worst-case depth in fixture: 3 levels (root → mid → leaf).
// See README for expected real-world depth notes.

describe("GoalSubtreeCache — depth constraint", () => {
  it("resolves a 3-level chain correctly (fixture max depth)", async () => {
    const ctx = makeCtx(GOALS);
    const cache = createGoalSubtreeCache();
    const chain = await cache.getAncestorChain("leaf-a", "co-1", ctx);
    // leaf-a → mid-a → root-a
    expect(chain).toHaveLength(3);
    expect(chain[0]).toBe("leaf-a");
    expect(chain[1]).toBe("mid-a");
    expect(chain[2]).toBe("eee6ff51-0000-0000-0000-000000000001");
  });

  it("handles a 5-level chain without error (documented max depth)", async () => {
    const deepGoals: GoalRow[] = [
      { id: "d-1", title: "L1", parentId: null, companyId: "co-1" },
      { id: "d-2", title: "L2", parentId: "d-1", companyId: "co-1" },
      { id: "d-3", title: "L3", parentId: "d-2", companyId: "co-1" },
      { id: "d-4", title: "L4", parentId: "d-3", companyId: "co-1" },
      { id: "d-5", title: "L5", parentId: "d-4", companyId: "co-1" },
    ];
    const ctx = makeCtx(deepGoals);
    const cache = createGoalSubtreeCache();
    const chain = await cache.getAncestorChain("d-5", "co-1", ctx);
    expect(chain).toHaveLength(5);
  });

  it("cycle guard: does not loop infinitely on circular parentId references", async () => {
    const cycleGoals: GoalRow[] = [
      { id: "c-1", title: "C1", parentId: "c-2", companyId: "co-1" },
      { id: "c-2", title: "C2", parentId: "c-1", companyId: "co-1" },
    ];
    const ctx = makeCtx(cycleGoals);
    const cache = createGoalSubtreeCache();
    // Should terminate (visited set breaks the loop)
    const chain = await cache.getAncestorChain("c-1", "co-1", ctx);
    expect(chain.length).toBeLessThanOrEqual(2);
  });
});
