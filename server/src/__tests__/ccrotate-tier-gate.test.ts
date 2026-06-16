import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDefaultCcrotateSwitcher,
  createCcrotateTierGate,
  evaluateTierCacheSnapshot,
  mapAdapterToCcrotateTarget,
  readDefaultCcrotateTierCache,
  type CcrotateTierCacheSnapshot,
} from "../services/ccrotate-tier-gate.js";

function snapshot(
  accounts: Array<{
    email: string;
    serviceTier?: string | null;
    reset5h?: number | null;
    reset7d?: number | null;
    utilization5h?: number | null;
    utilization7d?: number | null;
    snapshotCapturedAt?: string | null;
  }>,
): CcrotateTierCacheSnapshot {
  return {
    updatedAt: "2026-04-29T00:00:00.000Z",
    accounts: accounts.map((a) => ({
      email: a.email,
      status: "success",
      serviceTier: a.serviceTier ?? null,
      rateLimits:
        a.reset5h === undefined
          && a.reset7d === undefined
          && a.utilization5h === undefined
          && a.utilization7d === undefined
          && a.snapshotCapturedAt === undefined
          ? null
          : {
            reset5h: a.reset5h ?? null,
            reset7d: a.reset7d ?? null,
            utilization5h: a.utilization5h ?? null,
            utilization7d: a.utilization7d ?? null,
            snapshotCapturedAt: a.snapshotCapturedAt ?? null,
          },
    })),
  };
}

describe("mapAdapterToCcrotateTarget", () => {
  it("maps claude_local to claude", () => {
    expect(mapAdapterToCcrotateTarget("claude_local")).toBe("claude");
  });

  it("maps codex_local to codex", () => {
    expect(mapAdapterToCcrotateTarget("codex_local")).toBe("codex");
  });

  it("maps claude_k8s to claude (shares the org Anthropic billing pool)", () => {
    // claude_k8s runs Claude in a k8s pod with the org API key — that key
    // shares quota/billing with the host's `claude` ccrotate pool, so the
    // tier-cache is authoritative for whether the adapter has any usable
    // credit. Without this mapping the heartbeat scheduler ignores tier
    // exhaustion and burns wakes on guaranteed-401 runs.
    expect(mapAdapterToCcrotateTarget("claude_k8s")).toBe("claude");
  });

  it("maps opencode_k8s to codex for OpenAI-backed OpenCode agents", () => {
    expect(mapAdapterToCcrotateTarget("opencode_k8s")).toBe("codex");
  });

  it("returns null for adapters without a ccrotate provider", () => {
    expect(mapAdapterToCcrotateTarget("cursor")).toBeNull();
    expect(mapAdapterToCcrotateTarget("gemini_local")).toBeNull();
    expect(mapAdapterToCcrotateTarget("process")).toBeNull();
    expect(mapAdapterToCcrotateTarget("http")).toBeNull();
  });
});

describe("evaluateTierCacheSnapshot", () => {
  const now = new Date("2026-04-29T00:00:00.000Z");

  it("allows dispatch when at least one Claude account is base", () => {
    const result = evaluateTierCacheSnapshot(
      "claude",
      snapshot([
        { email: "a@x.com", serviceTier: "exhausted", reset7d: 1777651200 },
        { email: "b@x.com", serviceTier: "base" },
      ]),
      now,
    );
    expect(result.allow).toBe(true);
    expect(result.usableAccount).toBe("b@x.com");
  });

  it("allows dispatch when at least one Codex account is available", () => {
    const result = evaluateTierCacheSnapshot(
      "codex",
      snapshot([
        { email: "a@x.com", serviceTier: "exhausted", reset7d: 1777651200 },
        { email: "b@x.com", serviceTier: "available" },
      ]),
      now,
    );
    expect(result.allow).toBe(true);
    expect(result.usableAccount).toBe("b@x.com");
  });

  it("treats Codex near_limit accounts as usable (≤10% left is still quota)", () => {
    // BLO-4474: codex producer labels accounts with ≤10% remaining as
    // "near_limit". Those accounts still have hours of quota and must rotate.
    const result = evaluateTierCacheSnapshot(
      "codex",
      snapshot([
        { email: "a@x.com", serviceTier: "exhausted", reset7d: 1777651200 },
        { email: "b@x.com", serviceTier: "near_limit" },
      ]),
      now,
    );
    expect(result.allow).toBe(true);
    expect(result.usableAccount).toBe("b@x.com");
  });

  it("treats Claude extra tier as usable (paid overage with capacity)", () => {
    // BLO-4975: ccrotate marks paid-overage accounts as `serviceTier: "extra"`
    // and reports them as `usableNow` — they have real capacity until
    // reset5h/reset7d hits 0%. The gate must mirror that or it will defer
    // dispatch even when usable accounts exist (the 2026-05-12 4h45m
    // UXDesigner outage).
    const result = evaluateTierCacheSnapshot(
      "claude",
      snapshot([
        { email: "a@x.com", serviceTier: "exhausted", reset7d: 1777651200 },
        { email: "b@x.com", serviceTier: "extra" },
      ]),
      now,
    );
    expect(result.allow).toBe(true);
    expect(result.usableAccount).toBe("b@x.com");
  });

  it("does NOT treat Claude near_limit as usable (Claude has hard 7d cap)", () => {
    // Asymmetry vs codex: claude's 7d window is hard-enforced. A "near_limit"
    // claude account (if ever produced) would be one heartbeat from 401s. Keep
    // it out of the usable set even though codex now allows it.
    const result = evaluateTierCacheSnapshot(
      "claude",
      snapshot([
        { email: "a@x.com", serviceTier: "near_limit", reset5h: 1777680600 },
      ]),
      now,
    );
    expect(result.allow).toBe(false);
  });

  it("denies and reports earliest reset across 5h and 7d for Claude when no usable account", () => {
    // now = 2026-04-29T00:00:00Z, epoch ~ 1777680000
    const earliest5h = 1777680000 + 600; // 10 minutes from now
    const otherReset = 1777680000 + 7200; // 2 hours from now
    const result = evaluateTierCacheSnapshot(
      "claude",
      snapshot([
        { email: "a@x.com", serviceTier: "exhausted", reset5h: earliest5h, reset7d: otherReset },
        { email: "b@x.com", serviceTier: "exhausted", reset7d: otherReset + 3600 },
      ]),
      now,
    );
    expect(result.allow).toBe(false);
    expect(result.resumeAt).not.toBeNull();
    expect(result.resumeAt!.getTime()).toBe(earliest5h * 1000);
  });

  it("allows optimistically when every account is exhausted AND every snapshot is >5min stale", () => {
    // BLO-freshness-loop (2026-05-17): `ccrotate refresh`'s burst-probe-all
    // routinely false-flags accounts as `exhausted` due to Anthropic per-org
    // Usage API throttling. The cluster's freshness-loop (ccrotate-serve
    // sidecar) re-probes one account at a time to correct the labels — but
    // until it sweeps the pool, the gate must not deadlock heartbeats on
    // stale labels. Mirror the inconclusive-snapshot fallback for the
    // stale-snapshot case.
    const sixMinAgo = new Date(now.getTime() - 6 * 60_000).toISOString();
    const result = evaluateTierCacheSnapshot(
      "claude",
      snapshot([
        { email: "a@x.com", serviceTier: "exhausted", snapshotCapturedAt: sixMinAgo },
        { email: "b@x.com", serviceTier: "exhausted", snapshotCapturedAt: sixMinAgo },
      ]),
      now,
    );
    expect(result.allow).toBe(true);
    expect(result.usableAccount).toBeNull();
  });

  it("does NOT trigger stale-snapshot fallback when even one account snapshot is fresh", () => {
    // If the freshness-loop has just re-probed any account and confirmed
    // it's still exhausted, the cache is trustworthy. Don't bypass.
    const sixMinAgo = new Date(now.getTime() - 6 * 60_000).toISOString();
    const tenSecAgo = new Date(now.getTime() - 10_000).toISOString();
    const result = evaluateTierCacheSnapshot(
      "claude",
      snapshot([
        { email: "a@x.com", serviceTier: "exhausted", snapshotCapturedAt: sixMinAgo, reset5h: 1777680600 },
        { email: "b@x.com", serviceTier: "exhausted", snapshotCapturedAt: tenSecAgo, reset5h: 1777680600 },
      ]),
      now,
    );
    expect(result.allow).toBe(false);
    expect(result.resumeAt).not.toBeNull();
  });

  it("denies with null resumeAt when no resets are present", () => {
    const result = evaluateTierCacheSnapshot(
      "claude",
      snapshot([{ email: "a@x.com", serviceTier: "exhausted" }]),
      now,
    );
    expect(result.allow).toBe(false);
    expect(result.resumeAt).toBeNull();
  });

  it("ignores past reset epochs when picking the earliest future one", () => {
    const nowEpoch = Math.floor(now.getTime() / 1000);
    const past = nowEpoch - 3600;
    const future = nowEpoch + 1800;
    const result = evaluateTierCacheSnapshot(
      "claude",
      snapshot([
        { email: "a@x.com", serviceTier: "exhausted", reset5h: past, reset7d: future },
      ]),
      now,
    );
    expect(result.allow).toBe(false);
    expect(result.resumeAt!.getTime()).toBe(future * 1000);
  });

  it("denies dispatch when snapshot has no accounts", () => {
    const result = evaluateTierCacheSnapshot("claude", snapshot([]), now);
    expect(result.allow).toBe(false);
    expect(result.resumeAt).toBeNull();
  });

  it("treats accounts with status != success as not usable", () => {
    const result = evaluateTierCacheSnapshot(
      "codex",
      {
        updatedAt: "2026-04-29T00:00:00.000Z",
        accounts: [
          {
            email: "stale@x.com",
            status: "error",
            serviceTier: null,
            rateLimits: null,
          },
        ],
      },
      now,
    );
    expect(result.allow).toBe(false);
  });

  it("allows optimistically when every account is inconclusive (Usage API on cooldown)", () => {
    // 2026-05-04 deadlock repro: Anthropic per-account Usage API throttled the
    // cluster, so every account ended up status="unknown" with no tier and no
    // rateLimits. Old behavior denied → no run dispatch → no quotaExhaustedHook
    // → no bot trigger → tokens stayed expired → cache never recovered. Fix
    // is to allow optimistically and let the post-run quota hook handle the
    // case where the optimism was wrong.
    const result = evaluateTierCacheSnapshot(
      "claude",
      {
        updatedAt: "2026-05-04T18:07:42.707Z",
        accounts: [
          {
            email: "a@x.com",
            status: "unknown",
            serviceTier: null,
            response: "Usage API on cooldown — org-level fallback skipped",
            rateLimits: null,
          },
          {
            email: "b@x.com",
            status: "unknown",
            serviceTier: null,
            rateLimits: null,
          },
        ],
      },
      now,
    );
    expect(result.allow).toBe(true);
    expect(result.usableAccount).toBeNull();
    expect(result.resumeAt).toBeNull();
  });

  it("still denies when at least one account has a known-bad rateLimit despite others being unknown", () => {
    // Mixed snapshot: one account has rate-limit data showing it's exhausted
    // until a future epoch; another is inconclusive. The known-bad account
    // means we have SOME signal — fall through to the deny + earliest-reset
    // path rather than the inconclusive-allow shortcut.
    const result = evaluateTierCacheSnapshot(
      "claude",
      {
        updatedAt: "2026-05-04T18:07:42.707Z",
        accounts: [
          {
            email: "exhausted@x.com",
            status: "success",
            serviceTier: "exhausted",
            rateLimits: { reset5h: now.getTime() / 1000 + 600 },
          },
          {
            email: "unknown@x.com",
            status: "unknown",
            serviceTier: null,
            rateLimits: null,
          },
        ],
      },
      now,
    );
    expect(result.allow).toBe(false);
    expect(result.resumeAt).not.toBeNull();
  });

  it("picks the Claude base account with lowest utilization, not first-in-cache", () => {
    // Regression: tier-gate used to return the FIRST base-tier account in
    // cache order, ignoring rate-limit utilization. Result: it switched to
    // a "base" account whose 5h window was already at 100%, so the agent
    // pod immediately hit `out_of_credits overage rejected`. Observed
    // 2026-05-14 with ramadan@blockcast.net (5h:100%) being picked over
    // berkeley.edu (5h:27%). Fix: rank by max(util5h,util7d) ascending,
    // skip any account >=99% practical-exhaustion.
    const result = evaluateTierCacheSnapshot(
      "claude",
      snapshot([
        { email: "first-but-full@x.com", serviceTier: "base", utilization5h: 100, utilization7d: 18 },
        { email: "second-also-full@x.com", serviceTier: "base", utilization5h: 95, utilization7d: 17 },
        { email: "fresh@x.com", serviceTier: "base", utilization5h: 27, utilization7d: 70 },
      ]),
      now,
    );
    expect(result.allow).toBe(true);
    expect(result.usableAccount).toBe("fresh@x.com");
  });

  it("defers when every Claude base account is at >=99% in either window", () => {
    // Edge case: tier-cache says all base accounts but they're all
    // practically empty. Fall through to deferral (same as no base
    // candidates) rather than spawning a doomed agent.
    const reset = Math.floor(now.getTime() / 1000) + 3600;
    const result = evaluateTierCacheSnapshot(
      "claude",
      snapshot([
        { email: "a@x.com", serviceTier: "base", utilization5h: 100, utilization7d: 50, reset5h: reset },
        { email: "b@x.com", serviceTier: "base", utilization5h: 99, utilization7d: 60, reset5h: reset },
      ]),
      now,
    );
    expect(result.allow).toBe(false);
    expect(result.usableAccount).toBeNull();
  });

  it("treats Claude base account with no utilization data as eligible (mid-rank)", () => {
    // Older ccrotate cache versions / accounts on Usage API cooldown omit
    // utilization fields. Don't punish them — accept them at neutral rank
    // (score 50) so they win over known-100% accounts but lose to
    // known-low-util accounts.
    const result = evaluateTierCacheSnapshot(
      "claude",
      snapshot([
        { email: "full@x.com", serviceTier: "base", utilization5h: 100, utilization7d: 18 },
        { email: "unknown-util@x.com", serviceTier: "base" },
      ]),
      now,
    );
    expect(result.allow).toBe(true);
    expect(result.usableAccount).toBe("unknown-util@x.com");
  });
});

describe("createCcrotateTierGate", () => {
  it("allows dispatch for adapters that don't map to a ccrotate target", async () => {
    const readCache = vi.fn();
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
      cacheTtlMs: 30_000,
    });
    const result = await gate.checkAdapter({
      adapterType: "process",
      agentId: "agent-1",
      now: new Date(),
    });
    expect(result.allow).toBe(true);
    expect(readCache).not.toHaveBeenCalled();
  });

  it("dispatches when cache returns null (ccrotate not installed) and warns once", async () => {
    const readCache = vi.fn().mockResolvedValue(null);
    const warn = vi.fn();
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn },
      cacheTtlMs: 30_000,
    });
    const r1 = await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "agent-1",
      now: new Date(),
    });
    const r2 = await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "agent-2",
      now: new Date(),
    });
    expect(r1.allow).toBe(true);
    expect(r2.allow).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("dispatches when readCache throws and warns once", async () => {
    const readCache = vi.fn().mockRejectedValue(new Error("ENOENT"));
    const warn = vi.fn();
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn },
      cacheTtlMs: 30_000,
    });
    const r1 = await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "agent-1",
      now: new Date(),
    });
    const r2 = await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "agent-1",
      now: new Date(),
    });
    expect(r1.allow).toBe(true);
    expect(r2.allow).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("denies dispatch when no Claude account is base and reschedules at earliest reset + 120s", async () => {
    const now = new Date("2026-04-29T00:00:00.000Z");
    const reset = Math.floor(now.getTime() / 1000) + 600;
    const readCache = vi.fn().mockResolvedValue(
      snapshot([
        { email: "a@x.com", serviceTier: "exhausted", reset5h: reset },
      ]),
    );
    const info = vi.fn();
    const gate = createCcrotateTierGate({
      readCache,
      log: { info, warn: vi.fn() },
      cacheTtlMs: 30_000,
    });
    const r = await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "agent-1",
      now,
    });
    expect(r.allow).toBe(false);
    if (!r.allow) {
      expect(r.target).toBe("claude");
      expect(r.resumeAt).not.toBeNull();
      // Should be earliest reset + 120s grace window
      expect(r.resumeAt!.getTime()).toBe(reset * 1000 + 120_000);
      expect(r.reason).toBe("ccrotate.no_usable_account");
    }
    expect(info).toHaveBeenCalled();
  });

  it("memoizes the cache read for the configured TTL", async () => {
    const now0 = new Date("2026-04-29T00:00:00.000Z");
    const reset = Math.floor(now0.getTime() / 1000) + 600;
    const readCache = vi.fn().mockResolvedValue(
      snapshot([{ email: "a@x.com", serviceTier: "exhausted", reset5h: reset }]),
    );
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
      cacheTtlMs: 30_000,
    });

    // Two checks within the TTL window for two different agents
    await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "agent-1",
      now: now0,
    });
    await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "agent-2",
      now: new Date(now0.getTime() + 5_000),
    });
    expect(readCache).toHaveBeenCalledTimes(1);

    // After the TTL expires it should re-read
    await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "agent-3",
      now: new Date(now0.getTime() + 31_000),
    });
    expect(readCache).toHaveBeenCalledTimes(2);
  });

  it("evaluates Claude and Codex independently within the same gate", async () => {
    const now = new Date("2026-04-29T00:00:00.000Z");
    const reset = Math.floor(now.getTime() / 1000) + 600;
    const readCache = vi
      .fn()
      .mockImplementation((target: "claude" | "codex") =>
        Promise.resolve(
          target === "claude"
            ? snapshot([{ email: "c@x.com", serviceTier: "exhausted", reset5h: reset }])
            : snapshot([{ email: "x@x.com", serviceTier: "available" }]),
        ),
      );
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
      cacheTtlMs: 30_000,
    });

    const claudeResult = await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "agent-c",
      now,
    });
    const codexResult = await gate.checkAdapter({
      adapterType: "codex_local",
      agentId: "agent-x",
      now,
    });
    expect(claudeResult.allow).toBe(false);
    expect(codexResult.allow).toBe(true);
  });

  it("clears the deferral memo once a usable account reappears", async () => {
    const now0 = new Date("2026-04-29T00:00:00.000Z");
    const reset = Math.floor(now0.getTime() / 1000) + 600;
    const denySnapshot = snapshot([{ email: "a@x.com", serviceTier: "exhausted", reset5h: reset }]);
    const allowSnapshot = snapshot([{ email: "a@x.com", serviceTier: "base" }]);
    const readCache = vi
      .fn()
      .mockResolvedValueOnce(denySnapshot)
      .mockResolvedValueOnce(allowSnapshot);
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
      cacheTtlMs: 30_000,
    });

    const denied = await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "a1",
      now: now0,
    });
    expect(denied.allow).toBe(false);

    // Past the resume window — gate should re-read the cache and now allow.
    const after = new Date(reset * 1000 + 200_000);
    const allowed = await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "a1",
      now: after,
    });
    expect(allowed.allow).toBe(true);
  });

  it("logs the deferral once per (target, agentId) until the resume time passes", async () => {
    const now0 = new Date("2026-04-29T00:00:00.000Z");
    const reset = Math.floor(now0.getTime() / 1000) + 600;
    const readCache = vi.fn().mockResolvedValue(
      snapshot([{ email: "a@x.com", serviceTier: "exhausted", reset5h: reset }]),
    );
    const info = vi.fn();
    const gate = createCcrotateTierGate({
      readCache,
      log: { info, warn: vi.fn() },
      cacheTtlMs: 30_000,
    });

    await gate.checkAdapter({ adapterType: "claude_local", agentId: "a1", now: now0 });
    await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "a1",
      now: new Date(now0.getTime() + 10_000),
    });
    expect(info).toHaveBeenCalledTimes(1);

    // Different agent should log its own deferral
    await gate.checkAdapter({ adapterType: "claude_local", agentId: "a2", now: now0 });
    expect(info).toHaveBeenCalledTimes(2);
  });

  it("caps the deferral memo at maxDeferralMs even when resumeAt is far in the future", async () => {
    // BLO-4975: in the 2026-05-12 incident the scheduler memoized a 28h
    // deferral and stopped re-reading the cache. The pool recovered hours
    // before the memo expired, but the gate kept returning deny. With the
    // cap, the memo expires after maxDeferralMs (default 15 min, override
    // here for fast test) so a recovered pool gets picked up within that
    // window.
    const now0 = new Date("2026-04-29T00:00:00.000Z");
    const farFutureReset = Math.floor(now0.getTime() / 1000) + 28 * 60 * 60; // 28h out
    const denySnapshot = snapshot([
      { email: "stuck@x.com", serviceTier: "exhausted", reset7d: farFutureReset },
    ]);
    const allowSnapshot = snapshot([{ email: "recovered@x.com", serviceTier: "base" }]);
    const readCache = vi
      .fn()
      .mockResolvedValueOnce(denySnapshot)
      .mockResolvedValueOnce(allowSnapshot);
    const info = vi.fn();
    const gate = createCcrotateTierGate({
      readCache,
      log: { info, warn: vi.fn() },
      cacheTtlMs: 30_000,
      maxDeferralMs: 60_000, // 1 minute cap for the test
    });

    const denied = await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "a1",
      now: now0,
    });
    expect(denied.allow).toBe(false);
    // The returned resumeAt still reflects the cache's far-future claim (for
    // diagnostic logging) — only the in-memory expiry is capped.
    if (!denied.allow) {
      expect(denied.resumeAt!.getTime()).toBe(farFutureReset * 1000 + 120_000);
    }

    // Just past the cap — gate must re-read the cache and pick up recovery.
    const afterCap = new Date(now0.getTime() + 61_000);
    const allowed = await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "a1",
      now: afterCap,
    });
    expect(allowed.allow).toBe(true);
    expect(readCache).toHaveBeenCalledTimes(2);
  });
});

describe("createCcrotateTierGate switcher integration", () => {
  const now = new Date("2026-04-29T00:00:00.000Z");

  it("calls switcher with the first base-tier account on allow", async () => {
    const readCache = vi.fn().mockResolvedValue(
      snapshot([
        { email: "exhausted@x.com", serviceTier: "exhausted", reset7d: 1777651200 },
        { email: "good@x.com", serviceTier: "base" },
        { email: "alsogood@x.com", serviceTier: "base" },
      ]),
    );
    const switchTo = vi.fn().mockResolvedValue({ ok: true });
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
      switcher: { switchTo },
    });

    const r = await gate.checkAdapter({ adapterType: "claude_local", agentId: "a1", now });
    expect(r.allow).toBe(true);
    if (r.allow) expect(r.switchedTo).toEqual({ target: "claude", email: "good@x.com" });
    expect(switchTo).toHaveBeenCalledExactlyOnceWith("claude", "good@x.com");
  });

  it("does not re-spawn switch when the chosen email hasn't changed", async () => {
    const readCache = vi.fn().mockResolvedValue(
      snapshot([{ email: "good@x.com", serviceTier: "base" }]),
    );
    const switchTo = vi.fn().mockResolvedValue({ ok: true });
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
      switcher: { switchTo },
      cacheTtlMs: 0, // force re-read each call to prove the gate, not the cache, dedupes
    });

    await gate.checkAdapter({ adapterType: "claude_local", agentId: "a1", now });
    await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "a2",
      now: new Date(now.getTime() + 60_000),
    });
    await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "a1",
      now: new Date(now.getTime() + 120_000),
    });
    expect(switchTo).toHaveBeenCalledTimes(1);
  });

  it("logs the rotate_on_exhausted_active marker when snapshot has exhausted accounts and the gate rotates (BLO-4975)", async () => {
    // Staff Engineer's review of PR #142 asked for an explicit, grep-able
    // signal whenever the scheduler proactively rotates off an exhausted
    // active account. We use "snapshot contains exhausted" as a proxy for
    // "active was likely exhausted" because the tier-cache does not track
    // which account is active.
    const readCache = vi.fn().mockResolvedValue(
      snapshot([
        { email: "stuck@x.com", serviceTier: "exhausted", reset7d: 1777651200 },
        { email: "fresh@x.com", serviceTier: "base" },
      ]),
    );
    const switchTo = vi.fn().mockResolvedValue({ ok: true });
    const info = vi.fn();
    const gate = createCcrotateTierGate({
      readCache,
      log: { info, warn: vi.fn() },
      switcher: { switchTo },
    });

    const r = await gate.checkAdapter({ adapterType: "claude_local", agentId: "a1", now });
    expect(r.allow).toBe(true);
    expect(switchTo).toHaveBeenCalledExactlyOnceWith("claude", "fresh@x.com");

    const markerCalls = info.mock.calls.filter(
      ([, msg]) => msg === "ccrotate.rotate_on_exhausted_active",
    );
    expect(markerCalls).toHaveLength(1);
    expect(markerCalls[0]![0]).toMatchObject({
      target: "claude",
      email: "fresh@x.com",
      previouslySwitchedTo: null,
    });
  });

  it("does NOT log rotate_on_exhausted_active when the snapshot has no exhausted accounts", async () => {
    // The marker is specifically for "rotated off exhausted" — not "any
    // rotation". When the snapshot is all-healthy, the marker stays silent.
    const readCache = vi.fn().mockResolvedValue(
      snapshot([
        { email: "a@x.com", serviceTier: "base" },
        { email: "b@x.com", serviceTier: "base" },
      ]),
    );
    const switchTo = vi.fn().mockResolvedValue({ ok: true });
    const info = vi.fn();
    const gate = createCcrotateTierGate({
      readCache,
      log: { info, warn: vi.fn() },
      switcher: { switchTo },
    });

    await gate.checkAdapter({ adapterType: "claude_local", agentId: "a1", now });
    expect(switchTo).toHaveBeenCalledExactlyOnceWith("claude", "a@x.com");
    const markerCalls = info.mock.calls.filter(
      ([, msg]) => msg === "ccrotate.rotate_on_exhausted_active",
    );
    expect(markerCalls).toHaveLength(0);
  });

  it("end-to-end invariant: active exhausted + pool usable → resumeAt null + rotation fires (BLO-4975)", async () => {
    // The full Staff-Engineer-requested integration test. Simulates the
    // 2026-05-12 incident's RECOVERED state: the cache shows the formerly-
    // active account exhausted with a far-future 7d reset, but at least one
    // other account is on a usable tier. The invariant the gate must uphold:
    //   1. allow=true (do not defer dispatch)
    //   2. switcher fires synchronously with the usable account email
    //   3. resumeAt is null (no deferral whatsoever — re-evaluation is
    //      immediate, not bounded by maxDeferralMs)
    //   4. the rotate_on_exhausted_active marker is logged
    const farFutureReset = Math.floor(now.getTime() / 1000) + 28 * 60 * 60;
    const readCache = vi.fn().mockResolvedValue(
      snapshot([
        { email: "active-exhausted@x.com", serviceTier: "exhausted", reset7d: farFutureReset },
        { email: "exhausted-too@x.com", serviceTier: "exhausted", reset7d: farFutureReset + 3600 },
        { email: "extra-tier-usable@x.com", serviceTier: "extra" },
        { email: "base-tier-usable@x.com", serviceTier: "base" },
      ]),
    );
    const switchTo = vi.fn().mockResolvedValue({ ok: true });
    const info = vi.fn();
    const gate = createCcrotateTierGate({
      readCache,
      log: { info, warn: vi.fn() },
      switcher: { switchTo },
    });

    const r = await gate.checkAdapter({
      adapterType: "claude_k8s", // the adapter type from the original incident
      agentId: "uxdesigner",
      now,
    });

    // Invariant 1: allow
    expect(r.allow).toBe(true);
    // Invariant 2: switcher fired with the first usable account in iteration
    //              order (extra-tier-usable is reached before base-tier-usable
    //              after the two exhausted ones are skipped)
    expect(switchTo).toHaveBeenCalledExactlyOnceWith("claude", "extra-tier-usable@x.com");
    if (r.allow) {
      expect(r.switchedTo).toEqual({ target: "claude", email: "extra-tier-usable@x.com" });
    }
    // Invariant 3: no deferral was set (gate would carry it in subsequent
    //              calls if it were); verify by checking a follow-up tick
    //              returns allow without re-reading the cache.
    const r2 = await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "uxdesigner",
      now: new Date(now.getTime() + 1_000),
    });
    expect(r2.allow).toBe(true);
    // Invariant 4: marker logged exactly once for the rotation
    const markerCalls = info.mock.calls.filter(
      ([, msg]) => msg === "ccrotate.rotate_on_exhausted_active",
    );
    expect(markerCalls).toHaveLength(1);
  });

  it("re-spawns switch when the best base account changes", async () => {
    const readCache = vi
      .fn()
      .mockResolvedValueOnce(snapshot([{ email: "first@x.com", serviceTier: "base" }]))
      .mockResolvedValueOnce(snapshot([{ email: "second@x.com", serviceTier: "base" }]));
    const switchTo = vi.fn().mockResolvedValue({ ok: true });
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
      switcher: { switchTo },
      cacheTtlMs: 0,
    });

    await gate.checkAdapter({ adapterType: "claude_local", agentId: "a1", now });
    await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "a1",
      now: new Date(now.getTime() + 60_000),
    });
    expect(switchTo).toHaveBeenNthCalledWith(1, "claude", "first@x.com");
    expect(switchTo).toHaveBeenNthCalledWith(2, "claude", "second@x.com");
  });

  it("does not call switcher for adapters without a ccrotate target", async () => {
    const readCache = vi.fn();
    const switchTo = vi.fn();
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
      switcher: { switchTo },
    });

    const r = await gate.checkAdapter({ adapterType: "process", agentId: "a1", now });
    expect(r.allow).toBe(true);
    expect(switchTo).not.toHaveBeenCalled();
  });

  it("does not call switcher on the deny path", async () => {
    const reset = Math.floor(now.getTime() / 1000) + 600;
    const readCache = vi.fn().mockResolvedValue(
      snapshot([{ email: "a@x.com", serviceTier: "exhausted", reset5h: reset }]),
    );
    const switchTo = vi.fn();
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
      switcher: { switchTo },
    });

    const r = await gate.checkAdapter({ adapterType: "claude_local", agentId: "a1", now });
    expect(r.allow).toBe(false);
    expect(switchTo).not.toHaveBeenCalled();
  });

  it("does not call switcher when readCache returns null (ccrotate not installed)", async () => {
    const readCache = vi.fn().mockResolvedValue(null);
    const switchTo = vi.fn();
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
      switcher: { switchTo },
    });

    const r = await gate.checkAdapter({ adapterType: "claude_local", agentId: "a1", now });
    expect(r.allow).toBe(true);
    expect(switchTo).not.toHaveBeenCalled();
  });

  it("warns and proceeds when switcher fails — does not deny dispatch", async () => {
    const readCache = vi.fn().mockResolvedValue(
      snapshot([{ email: "good@x.com", serviceTier: "base" }]),
    );
    const switchTo = vi.fn().mockResolvedValue({ ok: false, error: "ccrotate not found" });
    const warn = vi.fn();
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn },
      switcher: { switchTo },
    });

    const r = await gate.checkAdapter({ adapterType: "claude_local", agentId: "a1", now });
    expect(r.allow).toBe(true);
    expect(switchTo).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ target: "claude", email: "good@x.com" }),
      expect.stringMatching(/switch failed/i),
    );
  });

  it("retries the switch on the next call after a failure (lastSwitched not advanced)", async () => {
    const readCache = vi.fn().mockResolvedValue(
      snapshot([{ email: "good@x.com", serviceTier: "base" }]),
    );
    const switchTo = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "transient" })
      .mockResolvedValueOnce({ ok: true });
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
      switcher: { switchTo },
      cacheTtlMs: 0,
    });

    await gate.checkAdapter({ adapterType: "claude_local", agentId: "a1", now });
    await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "a1",
      now: new Date(now.getTime() + 60_000),
    });
    expect(switchTo).toHaveBeenCalledTimes(2);
  });

  it("works without a switcher (preserves original behavior)", async () => {
    const readCache = vi.fn().mockResolvedValue(
      snapshot([{ email: "good@x.com", serviceTier: "base" }]),
    );
    const gate = createCcrotateTierGate({
      readCache,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    const r = await gate.checkAdapter({ adapterType: "claude_local", agentId: "a1", now });
    expect(r.allow).toBe(true);
  });
});

describe("readDefaultCcrotateTierCache", () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalStateUrl: string | undefined;
  let originalStateToken: string | undefined;
  let originalServeToken: string | undefined;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalStateUrl = process.env.CCROTATE_STATE_URL;
    originalStateToken = process.env.CCROTATE_STATE_TOKEN;
    originalServeToken = process.env.CCROTATE_SERVE_TOKEN;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "ccrotate-tier-gate-test-"));
    process.env.HOME = tempHome;
    delete process.env.CCROTATE_STATE_URL;
    delete process.env.CCROTATE_STATE_TOKEN;
    delete process.env.CCROTATE_SERVE_TOKEN;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalStateUrl === undefined) delete process.env.CCROTATE_STATE_URL;
    else process.env.CCROTATE_STATE_URL = originalStateUrl;
    if (originalStateToken === undefined) delete process.env.CCROTATE_STATE_TOKEN;
    else process.env.CCROTATE_STATE_TOKEN = originalStateToken;
    if (originalServeToken === undefined) delete process.env.CCROTATE_SERVE_TOKEN;
    else process.env.CCROTATE_SERVE_TOKEN = originalServeToken;
    vi.unstubAllGlobals();
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("returns null when the cache file does not exist", async () => {
    const result = await readDefaultCcrotateTierCache("claude");
    expect(result).toBeNull();
  });

  it("parses the Claude tier-cache file from disk", async () => {
    const dir = path.join(tempHome, ".ccrotate");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "tier-cache.json"),
      JSON.stringify({
        updatedAt: "2026-04-29T00:00:00.000Z",
        accounts: [
          {
            email: "a@x.com",
            status: "success",
            serviceTier: "base",
            rateLimits: { reset5h: null, reset7d: 1777651200 },
          },
        ],
      }),
    );
    const snap = await readDefaultCcrotateTierCache("claude");
    expect(snap).not.toBeNull();
    expect(snap!.accounts).toHaveLength(1);
    expect(snap!.accounts[0]?.email).toBe("a@x.com");
    expect(snap!.accounts[0]?.serviceTier).toBe("base");
  });

  it("uses tier-cache.codex.json for the codex target", async () => {
    const dir = path.join(tempHome, ".ccrotate");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "tier-cache.codex.json"),
      JSON.stringify({
        updatedAt: "2026-04-29T00:00:00.000Z",
        accounts: [
          {
            email: "x@x.com",
            status: "success",
            serviceTier: "available",
            rateLimits: { reset5h: 123, reset7d: 456 },
          },
        ],
      }),
    );
    const snap = await readDefaultCcrotateTierCache("codex");
    expect(snap?.accounts[0]?.email).toBe("x@x.com");
    expect(snap?.accounts[0]?.serviceTier).toBe("available");
  });

  it("prefers the ccrotate state server when CCROTATE_STATE_URL is set", async () => {
    process.env.CCROTATE_STATE_URL = "http://ccrotate-state.local/";
    process.env.CCROTATE_STATE_TOKEN = "state-token";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      updatedAt: "2026-06-16T00:00:00.000Z",
      accounts: [{ email: "live@x.com", status: "success", serviceTier: "available" }],
    })));
    vi.stubGlobal("fetch", fetchMock);

    const snap = await readDefaultCcrotateTierCache("codex");

    expect(snap?.accounts[0]?.email).toBe("live@x.com");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://ccrotate-state.local/state/tier-cache?target=codex");
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer state-token");
  });
});

describe("createDefaultCcrotateSwitcher", () => {
  const originalStateUrl = process.env.CCROTATE_STATE_URL;
  const originalStateToken = process.env.CCROTATE_STATE_TOKEN;
  const originalServeToken = process.env.CCROTATE_SERVE_TOKEN;

  afterEach(() => {
    if (originalStateUrl === undefined) delete process.env.CCROTATE_STATE_URL;
    else process.env.CCROTATE_STATE_URL = originalStateUrl;
    if (originalStateToken === undefined) delete process.env.CCROTATE_STATE_TOKEN;
    else process.env.CCROTATE_STATE_TOKEN = originalStateToken;
    if (originalServeToken === undefined) delete process.env.CCROTATE_SERVE_TOKEN;
    else process.env.CCROTATE_SERVE_TOKEN = originalServeToken;
    vi.unstubAllGlobals();
  });

  it("switches through the ccrotate state server when configured", async () => {
    process.env.CCROTATE_STATE_URL = "http://ccrotate-state.local";
    process.env.CCROTATE_SERVE_TOKEN = "serve-token";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ email: "bot5@x.com" })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createDefaultCcrotateSwitcher().switchTo("codex", "bot5@x.com");

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://ccrotate-state.local/state/current");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ target: "codex", email: "bot5@x.com" }));
    expect((init.headers as Headers).get("authorization")).toBe("Bearer serve-token");
  });
});

// T6 — verifier branch on the deny path.
import type { CcrotateVerifier } from "../services/ccrotate-serve-verifier.js";
import { VerifierError } from "../services/ccrotate-serve-verifier.js";

function makeVerifier(impl: CcrotateVerifier["probeOne"]): CcrotateVerifier {
  return { probeOne: impl };
}

describe("tier-gate — verifier branch", () => {
  const allExhausted = {
    updatedAt: new Date().toISOString(),
    accounts: [
      {
        email: "a@x.com",
        status: "success",
        serviceTier: "exhausted",
        rateLimits: { snapshotCapturedAt: new Date().toISOString() },
      },
      {
        email: "b@x.com",
        status: "success",
        serviceTier: "exhausted",
        rateLimits: { snapshotCapturedAt: new Date().toISOString() },
      },
      {
        email: "c@x.com",
        status: "success",
        serviceTier: "exhausted",
        rateLimits: { snapshotCapturedAt: new Date().toISOString() },
      },
    ],
  };

  it("allows when verifier returns usable", async () => {
    const verifier = makeVerifier(async (_t, email) => ({
      email,
      status: "success",
      serviceTier: "base",
      rateLimits: {},
    }) as any);
    const gate = createCcrotateTierGate({
      readCache: async () => allExhausted as any,
      log: { info: vi.fn(), warn: vi.fn() } as any,
      verifier,
    });
    const result = await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "a1",
      now: new Date(),
    });
    expect(result.allow).toBe(true);
  });

  it("denies when verifier confirms exhausted", async () => {
    const verifier = makeVerifier(async (_t, email) => ({
      email,
      status: "success",
      serviceTier: "exhausted",
      rateLimits: {},
    }) as any);
    const gate = createCcrotateTierGate({
      readCache: async () => allExhausted as any,
      log: { info: vi.fn(), warn: vi.fn() } as any,
      verifier,
    });
    const result = await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "a1",
      now: new Date(),
    });
    expect(result.allow).toBe(false);
  });

  it("optimistic-allow on transport error", async () => {
    const verifier = makeVerifier(async () => {
      throw new VerifierError("transport", "boom");
    });
    const gate = createCcrotateTierGate({
      readCache: async () => allExhausted as any,
      log: { info: vi.fn(), warn: vi.fn() } as any,
      verifier,
    });
    const result = await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "a1",
      now: new Date(),
    });
    expect(result.allow).toBe(true);
  });

  it("fail-closed deny on auth error", async () => {
    const verifier = makeVerifier(async () => {
      throw new VerifierError("auth", "401");
    });
    const gate = createCcrotateTierGate({
      readCache: async () => allExhausted as any,
      log: { info: vi.fn(), warn: vi.fn() } as any,
      verifier,
    });
    const result = await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "a1",
      now: new Date(),
    });
    expect(result.allow).toBe(false);
  });

  it("optimistic-allow on circuit_open error", async () => {
    const verifier = makeVerifier(async () => {
      throw new VerifierError("circuit_open", "ccrotate-serve unreachable");
    });
    const gate = createCcrotateTierGate({
      readCache: async () => allExhausted as any,
      log: { info: vi.fn(), warn: vi.fn() } as any,
      verifier,
    });
    const result = await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "a1",
      now: new Date(),
    });
    expect(result.allow).toBe(true);
  });

  it("verifier NOT called when cache shows usable account", async () => {
    const probe = vi.fn(async () =>
      ({
        email: "x",
        status: "success",
        serviceTier: "base",
        rateLimits: {},
      }) as any,
    );
    const verifier = makeVerifier(probe);
    const usable = {
      updatedAt: new Date().toISOString(),
      accounts: [
        {
          email: "a@x.com",
          status: "success",
          serviceTier: "base",
          rateLimits: { utilization5h: 4, utilization7d: 5 },
        },
      ],
    };
    const gate = createCcrotateTierGate({
      readCache: async () => usable as any,
      log: { info: vi.fn(), warn: vi.fn() } as any,
      verifier,
    });
    await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "a1",
      now: new Date(),
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("regression: no verifier → existing deny on all-exhausted cache", async () => {
    const gate = createCcrotateTierGate({
      readCache: async () => allExhausted as any,
      log: { info: vi.fn(), warn: vi.fn() } as any,
    });
    const result = await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "a1",
      now: new Date(),
    });
    expect(result.allow).toBe(false);
  });

  it("invalidates in-process cache after verifier call so next checkAdapter re-reads", async () => {
    let readCount = 0;
    const probe = vi.fn(
      async (_t, email) =>
        ({
          email,
          status: "success",
          serviceTier: "base",
          rateLimits: {},
        }) as any,
    );
    const verifier = makeVerifier(probe);
    const gate = createCcrotateTierGate({
      readCache: async () => {
        readCount++;
        return allExhausted as any;
      },
      log: { info: vi.fn(), warn: vi.fn() } as any,
      verifier,
      cacheTtlMs: 60_000,
    });
    await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "a1",
      now: new Date(),
    });
    await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "a2",
      now: new Date(),
    });
    expect(readCount).toBe(2);
  });
});
