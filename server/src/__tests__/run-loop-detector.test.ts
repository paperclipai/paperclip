import { describe, expect, it } from "vitest";

import {
  detectRunLoop,
  detectRunLoops,
  LOOP_DETECTOR_MAX_WINDOW_RUNS,
  LOOP_DETECTOR_THRESHOLD,
  type DetectRunLoopRecentRun,
} from "../services/run-loop-detector.js";

// By default a run's SAVED read boundary mirrors its snapshot issueId, matching
// how the enqueue path sets scopeKind/issueId from the snapshot at creation.
// `saved` overrides that to model coalescing drift, where the snapshot issueId
// is rewritten after creation but the persisted columns stay on the original
// binding.
function run(
  id: string,
  minutesAgo: number,
  ctx: Record<string, unknown> | null,
  now: Date,
  saved?: { scopeKind?: "company" | "issue"; issueId?: string | null },
): DetectRunLoopRecentRun {
  const snapshotIssueId = typeof ctx?.issueId === "string" ? ctx.issueId : null;
  const issueId = saved?.issueId !== undefined ? saved.issueId : snapshotIssueId;
  const scopeKind = saved?.scopeKind ?? (issueId !== null ? "issue" : "company");
  return {
    id,
    scopeKind,
    issueId,
    contextSnapshot: ctx,
    createdAt: new Date(now.getTime() - minutesAgo * 60 * 1000),
  };
}

describe("detectRunLoop", () => {
  const NOW = new Date("2026-05-11T13:00:00.000Z");

  it("returns null when no runs are present", () => {
    expect(
      detectRunLoop({ agentId: "a", recentRuns: [], now: NOW }),
    ).toBeNull();
  });

  it("returns null when the same group has fewer runs than the threshold", () => {
    const ctx = { issueId: "issue-1", wakeReason: "issue_commented" };
    const runs = [0, 5, 10, 15].map((m, i) =>
      run(`r${i}`, m, ctx, NOW),
    );
    expect(
      detectRunLoop({
        agentId: "a",
        recentRuns: runs,
        now: NOW,
        threshold: 5,
        windowSec: 1800,
      }),
    ).toBeNull();
  });

  it("returns a signal when threshold is reached for one (issueId, wakeReason)", () => {
    const ctx = { issueId: "issue-1", wakeReason: "issue_commented" };
    const runs = [0, 5, 10, 15, 20].map((m, i) =>
      run(`r${i}`, m, ctx, NOW),
    );
    const signal = detectRunLoop({
      agentId: "agent-1",
      recentRuns: runs,
      now: NOW,
      threshold: 5,
      windowSec: 1800,
    });
    expect(signal).not.toBeNull();
    expect(signal?.agentId).toBe("agent-1");
    expect(signal?.scopeKind).toBe("issue");
    expect(signal?.issueId).toBe("issue-1");
    expect(signal?.wakeReason).toBe("issue_commented");
    expect(signal?.count).toBe(5);
    expect(signal?.threshold).toBe(5);
    expect(signal?.windowSec).toBe(1800);
    expect(signal?.recentRunIds).toHaveLength(5);
    expect(new Date(signal!.firstAt).getTime()).toBeLessThan(
      new Date(signal!.lastAt).getTime(),
    );
  });

  it("ignores runs outside the window", () => {
    const ctx = { issueId: "issue-1", wakeReason: "issue_commented" };
    const runs = [
      run("r0", 0, ctx, NOW),
      run("r1", 5, ctx, NOW),
      run("r2", 10, ctx, NOW),
      run("r3", 15, ctx, NOW),
      run("r4", 60, ctx, NOW),
    ];
    expect(
      detectRunLoop({
        agentId: "a",
        recentRuns: runs,
        now: NOW,
        threshold: 5,
        windowSec: 1800,
      }),
    ).toBeNull();
  });

  it("does not group across different issueIds", () => {
    const wake = "issue_commented";
    const runs = [
      run("r0", 0, { issueId: "issue-1", wakeReason: wake }, NOW),
      run("r1", 2, { issueId: "issue-2", wakeReason: wake }, NOW),
      run("r2", 4, { issueId: "issue-3", wakeReason: wake }, NOW),
      run("r3", 6, { issueId: "issue-4", wakeReason: wake }, NOW),
      run("r4", 8, { issueId: "issue-5", wakeReason: wake }, NOW),
    ];
    expect(
      detectRunLoop({
        agentId: "a",
        recentRuns: runs,
        now: NOW,
        threshold: 5,
        windowSec: 1800,
      }),
    ).toBeNull();
  });

  it("does not group across different wakeReasons", () => {
    const issueId = "issue-1";
    const runs = [
      run("r0", 0, { issueId, wakeReason: "issue_commented" }, NOW),
      run("r1", 2, { issueId, wakeReason: "timer" }, NOW),
      run("r2", 4, { issueId, wakeReason: "assignment" }, NOW),
      run("r3", 6, { issueId, wakeReason: "manual" }, NOW),
      run("r4", 8, { issueId, wakeReason: "callback" }, NOW),
    ];
    expect(
      detectRunLoop({
        agentId: "a",
        recentRuns: runs,
        now: NOW,
        threshold: 5,
        windowSec: 1800,
      }),
    ).toBeNull();
  });

  it("ignores runs missing both issueId and wakeReason", () => {
    const runs = [0, 1, 2, 3, 4].map((m, i) =>
      run(`r${i}`, m, null, NOW),
    );
    expect(
      detectRunLoop({
        agentId: "a",
        recentRuns: runs,
        now: NOW,
        threshold: 5,
        windowSec: 1800,
      }),
    ).toBeNull();
  });

  it("groups by wakeReason alone when issueId is missing", () => {
    const runs = [0, 2, 4, 6, 8].map((m, i) =>
      run(`r${i}`, m, { wakeReason: "timer" }, NOW),
    );
    const signal = detectRunLoop({
      agentId: "a",
      recentRuns: runs,
      now: NOW,
      threshold: 5,
      windowSec: 1800,
    });
    expect(signal?.scopeKind).toBe("company");
    expect(signal?.issueId).toBeNull();
    expect(signal?.wakeReason).toBe("timer");
    expect(signal?.count).toBe(5);
  });

  it("returns the worst offender when multiple groups exceed the threshold", () => {
    const wake = "issue_commented";
    const small = [0, 1, 2, 3, 4].map((m, i) =>
      run(`small-${i}`, m, { issueId: "issue-small", wakeReason: wake }, NOW),
    );
    const big = [0, 1, 2, 3, 4, 5, 6].map((m, i) =>
      run(`big-${i}`, m, { issueId: "issue-big", wakeReason: wake }, NOW),
    );
    const signal = detectRunLoop({
      agentId: "a",
      recentRuns: [...small, ...big],
      now: NOW,
      threshold: 5,
      windowSec: 1800,
    });
    expect(signal?.issueId).toBe("issue-big");
    expect(signal?.count).toBe(7);
  });

  it("respects explicit threshold and windowSec overrides", () => {
    const ctx = { issueId: "issue-1", wakeReason: "timer" };
    const runs = [0, 1, 2].map((m, i) => run(`r${i}`, m, ctx, NOW));
    const signal = detectRunLoop({
      agentId: "a",
      recentRuns: runs,
      now: NOW,
      threshold: 3,
      windowSec: 600,
    });
    expect(signal?.count).toBe(3);
    expect(signal?.threshold).toBe(3);
    expect(signal?.windowSec).toBe(600);
  });
});

describe("detectRunLoops", () => {
  const NOW = new Date("2026-05-11T13:00:00.000Z");
  const wake = "issue_commented";

  it("returns an empty array when nothing qualifies", () => {
    expect(detectRunLoops({ agentId: "a", recentRuns: [], now: NOW })).toEqual([]);
  });

  it("returns every qualifying group, not only the worst, sorted worst-first", () => {
    // Regression: the queue previously received only the single worst group, so
    // if that group was on cooldown a distinct loop on another issue was hidden.
    const big = [0, 1, 2, 3, 4, 5, 6].map((m, i) =>
      run(`big-${i}`, m, { issueId: "issue-big", wakeReason: wake }, NOW),
    );
    const small = [0, 1, 2, 3, 4].map((m, i) =>
      run(`small-${i}`, m, { issueId: "issue-small", wakeReason: wake }, NOW),
    );
    const belowThreshold = [0, 1, 2].map((m, i) =>
      run(`tiny-${i}`, m, { issueId: "issue-tiny", wakeReason: wake }, NOW),
    );
    const signals = detectRunLoops({
      agentId: "a",
      recentRuns: [...small, ...big, ...belowThreshold],
      now: NOW,
      threshold: 5,
      windowSec: 1800,
    });
    expect(signals.map((s) => s.issueId)).toEqual(["issue-big", "issue-small"]);
    expect(signals.map((s) => s.count)).toEqual([7, 5]);
  });

  it("breaks count ties by earliest firstAt (longest-running loop first)", () => {
    const older = [20, 15, 10, 5, 0].map((m, i) =>
      run(`older-${i}`, m, { issueId: "issue-older", wakeReason: wake }, NOW),
    );
    const newer = [8, 6, 4, 2, 0].map((m, i) =>
      run(`newer-${i}`, m, { issueId: "issue-newer", wakeReason: wake }, NOW),
    );
    const signals = detectRunLoops({
      agentId: "a",
      recentRuns: [...newer, ...older],
      now: NOW,
      threshold: 5,
      windowSec: 1800,
    });
    expect(signals.map((s) => s.issueId)).toEqual(["issue-older", "issue-newer"]);
  });

  it("detectRunLoop returns the first element of detectRunLoops", () => {
    const runs = [
      ...[0, 1, 2, 3, 4, 5].map((m, i) =>
        run(`a-${i}`, m, { issueId: "issue-a", wakeReason: wake }, NOW),
      ),
      ...[0, 1, 2, 3, 4].map((m, i) =>
        run(`b-${i}`, m, { issueId: "issue-b", wakeReason: wake }, NOW),
      ),
    ];
    const input = { agentId: "a", recentRuns: runs, now: NOW, threshold: 5, windowSec: 1800 };
    expect(detectRunLoop(input)).toEqual(detectRunLoops(input)[0]);
  });
});

describe("saved read boundary (scopeKind, issueId)", () => {
  const NOW = new Date("2026-05-11T13:00:00.000Z");
  const wake = "issue_commented";

  it("attributes a coalesced run to its saved issue, not the mutated snapshot issue", () => {
    // Regression for the privacy finding: cross-task coalescing can rewrite a
    // run's snapshot issueId to a different issue. Grouping on the snapshot would
    // publish these runs' ids/timestamps to viewers of issue-B even though the
    // runs are bound to the private issue-A. The saved issueId keeps them on A.
    const runs = [0, 1, 2, 3, 4].map((m, i) =>
      run(`r${i}`, m, { issueId: "issue-B", wakeReason: wake }, NOW, {
        scopeKind: "issue",
        issueId: "issue-A",
      }),
    );
    const signals = detectRunLoops({
      agentId: "a",
      recentRuns: runs,
      now: NOW,
      threshold: 5,
      windowSec: 1800,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0].scopeKind).toBe("issue");
    expect(signals[0].issueId).toBe("issue-A");
    // The mutated snapshot issue never becomes a reported boundary.
    expect(signals.map((s) => s.issueId)).not.toContain("issue-B");
  });

  it("does not let runs bound to different saved issues cross into one group", () => {
    // Five runs all carry snapshot issueId "issue-shared" (as if coalesced), but
    // each is saved-bound to a distinct private issue. They must stay in five
    // single-run groups, so none reaches the threshold.
    const runs = [0, 1, 2, 3, 4].map((m, i) =>
      run(`r${i}`, m, { issueId: "issue-shared", wakeReason: wake }, NOW, {
        scopeKind: "issue",
        issueId: `issue-${i}`,
      }),
    );
    expect(
      detectRunLoop({
        agentId: "a",
        recentRuns: runs,
        now: NOW,
        threshold: 5,
        windowSec: 1800,
      }),
    ).toBeNull();
  });

  it("never widens a company-scoped run's boundary via a stale snapshot issueId", () => {
    // A company-scoped run whose snapshot still names an issue stays company
    // scoped (issueId null), so its signal is only company-gated downstream.
    const runs = [0, 2, 4, 6, 8].map((m, i) =>
      run(`r${i}`, m, { issueId: "issue-ghost", wakeReason: "timer" }, NOW, {
        scopeKind: "company",
        issueId: null,
      }),
    );
    const signal = detectRunLoop({
      agentId: "a",
      recentRuns: runs,
      now: NOW,
      threshold: 5,
      windowSec: 1800,
    });
    expect(signal?.scopeKind).toBe("company");
    expect(signal?.issueId).toBeNull();
    expect(signal?.count).toBe(5);
  });

  it("keeps a company-scoped group and an issue-scoped group with null issue separate", () => {
    const companyRuns = [0, 1, 2, 3, 4].map((m, i) =>
      run(`co-${i}`, m, { wakeReason: "timer" }, NOW, { scopeKind: "company", issueId: null }),
    );
    const issueNullRuns = [0, 1, 2, 3, 4].map((m, i) =>
      run(`iss-${i}`, m, { wakeReason: "timer" }, NOW, { scopeKind: "issue", issueId: null }),
    );
    const signals = detectRunLoops({
      agentId: "a",
      recentRuns: [...companyRuns, ...issueNullRuns],
      now: NOW,
      threshold: 5,
      windowSec: 1800,
    });
    expect(signals.map((s) => s.scopeKind).sort()).toEqual(["company", "issue"]);
    expect(signals.every((s) => s.issueId === null)).toBe(true);
  });
});

describe("LOOP_DETECTOR_MAX_WINDOW_RUNS", () => {
  it("stays at or above the threshold so a high threshold cannot shrink the ceiling below one loop", () => {
    // Regression: an earlier max(50, threshold) fetch cap was applied globally
    // before grouping, so interleaved newer runs could push a qualifying loop
    // out of the fetched prefix. The window predicate now bounds the fetch; this
    // constant is only a pathological-volume ceiling and must never fall below
    // the rows one loop needs.
    expect(LOOP_DETECTOR_MAX_WINDOW_RUNS).toBeGreaterThanOrEqual(LOOP_DETECTOR_THRESHOLD);
    expect(LOOP_DETECTOR_MAX_WINDOW_RUNS).toBe(Math.max(5000, LOOP_DETECTOR_THRESHOLD));
  });
});
