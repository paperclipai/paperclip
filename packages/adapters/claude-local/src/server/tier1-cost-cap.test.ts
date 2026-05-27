import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTier1Gate,
  recordTier1Cost,
  readPerIssueFile,
  type PageOpsArgs,
  type Tier1CostCapDeps,
} from "./tier1-cost-cap.js";

let cacheDir: string;
const ISSUE = "rocaa-23-test-issue";

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "tier1-cost-cap-test-"));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

function deps(overrides: Partial<Tier1CostCapDeps> = {}): Tier1CostCapDeps {
  return {
    cacheDir,
    env: {} as NodeJS.ProcessEnv,
    ...overrides,
  };
}

function writeDisableFile(payload: Record<string, unknown>): void {
  writeFileSync(join(cacheDir, "tier1_disabled_until_midnight"), JSON.stringify(payload), "utf8");
}

describe("buildTier1Gate — daily cap", () => {
  it("allows Tier 1 when no disable file exists", async () => {
    const gate = buildTier1Gate(deps());
    const v = await gate({ issueId: ISSUE });
    expect(v.allowed).toBe(true);
  });

  it("blocks Tier 1 when the disable file's reset_at is in the future", async () => {
    const now = new Date("2026-05-24T12:00:00Z");
    writeDisableFile({
      tripped_at: "2026-05-24T08:00:00+00:00",
      reset_at: "2026-05-25T00:00:00+00:00",
      usd_today: 52.31,
      cap_usd: 50,
    });
    const gate = buildTier1Gate(deps({ now: () => now }));
    const v = await gate({ issueId: ISSUE });
    expect(v.allowed).toBe(false);
    if (v.allowed) return; // type narrow
    expect(v.reason).toBe("daily_cap_tripped");
    expect(v.resetAt).toBe("2026-05-25T00:00:00+00:00");
    expect(v.detail).toContain("$52.31");
    expect(v.detail).toContain("$50.00");
  });

  it("allows Tier 1 again once reset_at has passed", async () => {
    const now = new Date("2026-05-25T00:00:01Z");
    writeDisableFile({
      tripped_at: "2026-05-24T08:00:00+00:00",
      reset_at: "2026-05-25T00:00:00+00:00",
      usd_today: 52.31,
      cap_usd: 50,
    });
    const gate = buildTier1Gate(deps({ now: () => now }));
    const v = await gate({ issueId: ISSUE });
    expect(v.allowed).toBe(true);
  });

  it("treats corrupt disable file as not-tripped (never blocks on bad JSON)", async () => {
    writeFileSync(join(cacheDir, "tier1_disabled_until_midnight"), "{not json", "utf8");
    const gate = buildTier1Gate(deps());
    const v = await gate({ issueId: ISSUE });
    expect(v.allowed).toBe(true);
  });

  it("daily cap is checked even without an issueId", async () => {
    const now = new Date("2026-05-24T12:00:00Z");
    writeDisableFile({
      tripped_at: "2026-05-24T08:00:00+00:00",
      reset_at: "2026-05-25T00:00:00+00:00",
      usd_today: 60,
      cap_usd: 50,
    });
    const gate = buildTier1Gate(deps({ now: () => now }));
    const v = await gate({ issueId: null });
    expect(v.allowed).toBe(false);
  });
});

describe("buildTier1Gate — per-issue cap", () => {
  it("allows Tier 1 with no per-issue history", async () => {
    const gate = buildTier1Gate(deps({ env: { PAPERCLIP_TIER1_PER_ISSUE_USD_CAP: "5" } as NodeJS.ProcessEnv }));
    const v = await gate({ issueId: ISSUE });
    expect(v.allowed).toBe(true);
  });

  it("blocks Tier 1 once the per-issue file marks cumulative spend at-or-over cap", async () => {
    // Simulate prior recordTier1Cost calls totaling $5.10 with $5 cap.
    const env = { PAPERCLIP_TIER1_PER_ISSUE_USD_CAP: "5" } as NodeJS.ProcessEnv;
    await recordTier1Cost(deps({ env }), { issueId: ISSUE, costUsd: 5.1 });
    const gate = buildTier1Gate(deps({ env }));
    const v = await gate({ issueId: ISSUE });
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.reason).toBe("per_issue_cap_tripped");
    expect(v.detail).toContain(ISSUE);
    expect(v.detail).toContain("$5.10");
    // Per-issue trip has no resetAt — needs human review.
    expect(v.resetAt).toBeUndefined();
  });

  it("respects env-overridden per-issue cap", async () => {
    const env = { PAPERCLIP_TIER1_PER_ISSUE_USD_CAP: "1" } as NodeJS.ProcessEnv;
    await recordTier1Cost(deps({ env }), { issueId: ISSUE, costUsd: 1.5 });
    const gate = buildTier1Gate(deps({ env }));
    const v = await gate({ issueId: ISSUE });
    expect(v.allowed).toBe(false);
  });

  it("does NOT apply the per-issue cap when issueId is null (still allowed if daily ok)", async () => {
    const env = { PAPERCLIP_TIER1_PER_ISSUE_USD_CAP: "5" } as NodeJS.ProcessEnv;
    // Populate someone else's bucket; should not affect the null-issue call.
    await recordTier1Cost(deps({ env }), { issueId: "other-issue", costUsd: 99 });
    const gate = buildTier1Gate(deps({ env }));
    const v = await gate({ issueId: null });
    expect(v.allowed).toBe(true);
  });

  it("daily cap wins over per-issue cap when both are tripped", async () => {
    const env = { PAPERCLIP_TIER1_PER_ISSUE_USD_CAP: "5" } as NodeJS.ProcessEnv;
    await recordTier1Cost(deps({ env }), { issueId: ISSUE, costUsd: 100 });
    const now = new Date("2026-05-24T12:00:00Z");
    writeDisableFile({
      tripped_at: "2026-05-24T08:00:00+00:00",
      reset_at: "2026-05-25T00:00:00+00:00",
      usd_today: 60,
      cap_usd: 50,
    });
    const gate = buildTier1Gate(deps({ env, now: () => now }));
    const v = await gate({ issueId: ISSUE });
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.reason).toBe("daily_cap_tripped");
  });
});

describe("recordTier1Cost", () => {
  it("creates the per-issue file on first sample with correct shape", async () => {
    const env = { PAPERCLIP_TIER1_PER_ISSUE_USD_CAP: "5" } as NodeJS.ProcessEnv;
    const state = await recordTier1Cost(deps({ env }), { issueId: ISSUE, costUsd: 1.23 });
    expect(state).not.toBeNull();
    expect(state!.cumulativeUsd).toBeCloseTo(1.23, 6);
    expect(state!.capUsd).toBe(5);
    expect(state!.tripped).toBe(false);
    expect(state!.recentSamples).toHaveLength(1);
    expect(state!.firstSeenAt).toBe(state!.lastUpdatedAt);
    // Reload to ensure round-trip.
    const reloaded = readPerIssueFile(cacheDir, ISSUE);
    expect(reloaded?.cumulativeUsd).toBeCloseTo(1.23, 6);
  });

  it("accumulates across calls and retains a bounded sample tail", async () => {
    const env = { PAPERCLIP_TIER1_PER_ISSUE_USD_CAP: "5" } as NodeJS.ProcessEnv;
    for (let i = 0; i < 12; i++) {
      await recordTier1Cost(deps({ env }), { issueId: ISSUE, costUsd: 0.1 });
    }
    const state = readPerIssueFile(cacheDir, ISSUE)!;
    expect(state.cumulativeUsd).toBeCloseTo(1.2, 4);
    // Capped at 8 retained samples.
    expect(state.recentSamples.length).toBeLessThanOrEqual(8);
  });

  it("ignores null issueId and non-positive cost", async () => {
    expect(await recordTier1Cost(deps(), { issueId: null, costUsd: 1 })).toBeNull();
    expect(await recordTier1Cost(deps(), { issueId: ISSUE, costUsd: 0 })).toBeNull();
    expect(await recordTier1Cost(deps(), { issueId: ISSUE, costUsd: -1 })).toBeNull();
    expect(existsSync(join(cacheDir, "issue_rocaa-23-test-issue.json"))).toBe(false);
  });

  it("fires pageOps and markIssueNeedsHumanReview exactly once on cap-cross", async () => {
    const env = { PAPERCLIP_TIER1_PER_ISSUE_USD_CAP: "1" } as NodeJS.ProcessEnv;
    const pageOps = vi.fn(async (_args: PageOpsArgs) => {});
    const mark = vi.fn(async (_id: string, _args: { reason: string; detail: string }) => {});
    // Three calls; first two are under cap, third crosses, fourth is already-tripped.
    await recordTier1Cost(deps({ env, pageOps, markIssueNeedsHumanReview: mark }), { issueId: ISSUE, costUsd: 0.4 });
    await recordTier1Cost(deps({ env, pageOps, markIssueNeedsHumanReview: mark }), { issueId: ISSUE, costUsd: 0.4 });
    await recordTier1Cost(deps({ env, pageOps, markIssueNeedsHumanReview: mark }), { issueId: ISSUE, costUsd: 0.3 });
    await recordTier1Cost(deps({ env, pageOps, markIssueNeedsHumanReview: mark }), { issueId: ISSUE, costUsd: 0.5 });
    expect(pageOps).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledTimes(1);
    const pageArgs = pageOps.mock.calls[0][0];
    expect(pageArgs.severity).toBe("critical");
    expect(pageArgs.reason).toBe("per_issue_cap_tripped");
    expect(pageArgs.message).toContain(ISSUE);
    expect(mark.mock.calls[0][0]).toBe(ISSUE);
    expect(mark.mock.calls[0][1].reason).toBe("per_issue_cap_tripped");
  });

  it("does not crash the dispatch path when pageOps throws", async () => {
    const env = { PAPERCLIP_TIER1_PER_ISSUE_USD_CAP: "1" } as NodeJS.ProcessEnv;
    const pageOps = vi.fn(async (_args: PageOpsArgs) => {
      throw new Error("slack down");
    });
    const mark = vi.fn(async () => {});
    const state = await recordTier1Cost(
      deps({ env, pageOps, markIssueNeedsHumanReview: mark }),
      { issueId: ISSUE, costUsd: 2 },
    );
    expect(state?.tripped).toBe(true);
    expect(mark).toHaveBeenCalledTimes(1);
  });

  it("does not crash when markIssueNeedsHumanReview throws", async () => {
    const env = { PAPERCLIP_TIER1_PER_ISSUE_USD_CAP: "1" } as NodeJS.ProcessEnv;
    const pageOps = vi.fn(async () => {});
    const mark = vi.fn(async () => {
      throw new Error("paperclip api 500");
    });
    const state = await recordTier1Cost(
      deps({ env, pageOps, markIssueNeedsHumanReview: mark }),
      { issueId: ISSUE, costUsd: 2 },
    );
    expect(state?.tripped).toBe(true);
    expect(pageOps).toHaveBeenCalledTimes(1);
  });

  it("sanitizes issueId for filename to prevent path traversal", async () => {
    const malicious = "../../etc/passwd";
    const env = { PAPERCLIP_TIER1_PER_ISSUE_USD_CAP: "5" } as NodeJS.ProcessEnv;
    await recordTier1Cost(deps({ env }), { issueId: malicious, costUsd: 1 });
    // Verify the file lives inside cacheDir, not in /etc.
    const expected = join(cacheDir, "issue_.._.._etc_passwd.json");
    expect(existsSync(expected)).toBe(true);
    const written = JSON.parse(readFileSync(expected, "utf8"));
    expect(written.issueId).toBe(malicious);
  });
});
