import { describe, expect, it } from "vitest";

import {
  detectRunLoop,
  detectRunLoops,
  LOOP_DETECTOR_RUN_FETCH_LIMIT,
  LOOP_DETECTOR_THRESHOLD,
  type DetectRunLoopRecentRun,
} from "../services/run-loop-detector.js";

function run(
  id: string,
  minutesAgo: number,
  ctx: Record<string, unknown> | null,
  now: Date,
): DetectRunLoopRecentRun {
  return {
    id,
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

describe("LOOP_DETECTOR_RUN_FETCH_LIMIT", () => {
  it("never drops below the threshold, so a high threshold cannot silently disable detection", () => {
    // Regression: a flat fetch limit of 50 silently disabled detection whenever
    // the threshold exceeded 50, because the query could never return enough rows.
    expect(LOOP_DETECTOR_RUN_FETCH_LIMIT).toBeGreaterThanOrEqual(LOOP_DETECTOR_THRESHOLD);
    expect(LOOP_DETECTOR_RUN_FETCH_LIMIT).toBe(Math.max(50, LOOP_DETECTOR_THRESHOLD));
  });
});
