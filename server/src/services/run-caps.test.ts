import { describe, expect, it } from "vitest";
import { AGENT_DEFAULT_RUN_CAPS, CODER_AGENT_RUN_CAPS } from "@paperclipai/shared";
import {
  type RunCapRunRecord,
  evaluateRunCaps,
  resolveRunCaps,
} from "./run-caps.js";

const ISSUE = "issue-1";

/** Build N no-progress runs on the same issue (no useful action ever recorded). */
function noProgressRuns(n: number, issueId: string | null = ISSUE): RunCapRunRecord[] {
  return Array.from({ length: n }, () => ({ issueId, lastUsefulActionAt: null }));
}

describe("evaluateRunCaps — run-rate", () => {
  const caps = { perHour: 40, perDay: 250, maxConsecutiveRuns: 8 };

  it("does not pause at or below the hourly cap", () => {
    const decision = evaluateRunCaps({
      caps,
      currentIssueId: ISSUE,
      runsLastHour: 40,
      runsLastDay: 40,
      recentRuns: [],
    });
    expect(decision.shouldPause).toBe(false);
  });

  it("auto-pauses on the run that exceeds the hourly cap (WEI-57 ~87/h is caught at 41)", () => {
    const decision = evaluateRunCaps({
      caps,
      currentIssueId: ISSUE,
      runsLastHour: 41,
      runsLastDay: 41,
      recentRuns: [],
    });
    expect(decision.shouldPause).toBe(true);
    expect(decision.kind).toBe("run_rate_hour");
    expect(decision.reason).toBe("auto:run_rate_hour (41)");
  });

  it("auto-pauses on the run that exceeds the daily cap", () => {
    const decision = evaluateRunCaps({
      caps,
      currentIssueId: ISSUE,
      runsLastHour: 5,
      runsLastDay: 251,
      recentRuns: [],
    });
    expect(decision.shouldPause).toBe(true);
    expect(decision.kind).toBe("run_rate_day");
    expect(decision.reason).toBe("auto:run_rate_day (251)");
  });
});

describe("evaluateRunCaps — no-progress streak", () => {
  const caps = { perHour: 999, perDay: 9999, maxConsecutiveRuns: 8 };

  it("DoD: maxConsecutiveRuns+1 runs on the same issue with no progress auto-pauses", () => {
    // The (N+1)-th start sees N prior terminal runs with no progress.
    const decision = evaluateRunCaps({
      caps,
      currentIssueId: ISSUE,
      runsLastHour: 9,
      runsLastDay: 9,
      recentRuns: noProgressRuns(caps.maxConsecutiveRuns),
    });
    expect(decision.shouldPause).toBe(true);
    expect(decision.kind).toBe("no_progress");
    expect(decision.reason).toBe("auto:no_progress (8)");
  });

  it("does not pause before enough history accrues", () => {
    const decision = evaluateRunCaps({
      caps,
      currentIssueId: ISSUE,
      runsLastHour: 8,
      runsLastDay: 8,
      recentRuns: noProgressRuns(caps.maxConsecutiveRuns - 1),
    });
    expect(decision.shouldPause).toBe(false);
  });

  it("does not pause when the agent is working different issues (variety = progress)", () => {
    const runs = noProgressRuns(caps.maxConsecutiveRuns);
    runs[3] = { issueId: "other-issue", lastUsefulActionAt: null };
    const decision = evaluateRunCaps({
      caps,
      currentIssueId: ISSUE,
      runsLastHour: 9,
      runsLastDay: 9,
      recentRuns: runs,
    });
    expect(decision.shouldPause).toBe(false);
  });

  it("does not pause when last_useful_action_at advanced during the streak (no false positive)", () => {
    const runs = noProgressRuns(caps.maxConsecutiveRuns);
    // Newest run made a useful action; oldest did not -> progress.
    runs[0] = { issueId: ISSUE, lastUsefulActionAt: new Date("2026-06-03T10:00:00Z") };
    const decision = evaluateRunCaps({
      caps,
      currentIssueId: ISSUE,
      runsLastHour: 9,
      runsLastDay: 9,
      recentRuns: runs,
    });
    expect(decision.shouldPause).toBe(false);
  });

  it("pauses when useful action is stale (no advancement beyond the streak baseline)", () => {
    const stale = new Date("2026-06-03T09:00:00Z");
    const runs: RunCapRunRecord[] = Array.from({ length: caps.maxConsecutiveRuns }, () => ({
      issueId: ISSUE,
      lastUsefulActionAt: stale,
    }));
    const decision = evaluateRunCaps({
      caps,
      currentIssueId: ISSUE,
      runsLastHour: 9,
      runsLastDay: 9,
      recentRuns: runs,
    });
    expect(decision.shouldPause).toBe(true);
    expect(decision.kind).toBe("no_progress");
  });

  it("does not evaluate no-progress when the current run has no issue", () => {
    const decision = evaluateRunCaps({
      caps,
      currentIssueId: null,
      runsLastHour: 9,
      runsLastDay: 9,
      recentRuns: noProgressRuns(caps.maxConsecutiveRuns, null),
    });
    expect(decision.shouldPause).toBe(false);
  });
});

describe("resolveRunCaps", () => {
  it("uses standard defaults for non-coder roles", () => {
    expect(resolveRunCaps("pm", null)).toEqual(AGENT_DEFAULT_RUN_CAPS);
    expect(resolveRunCaps("general", {})).toEqual(AGENT_DEFAULT_RUN_CAPS);
  });

  it("uses coder caps for coder roles", () => {
    expect(resolveRunCaps("engineer", null)).toEqual(CODER_AGENT_RUN_CAPS);
    expect(resolveRunCaps("cto", null)).toEqual(CODER_AGENT_RUN_CAPS);
  });

  it("merges per-agent adapter_config.runCaps over the role base", () => {
    const resolved = resolveRunCaps("engineer", { runCaps: { perHour: 120 } });
    expect(resolved).toEqual({ perHour: 120, perDay: 400, maxConsecutiveRuns: 8 });
  });

  it("ignores invalid override values", () => {
    const resolved = resolveRunCaps("pm", { runCaps: { perHour: 0, perDay: "lots", maxConsecutiveRuns: -3 } });
    expect(resolved).toEqual(AGENT_DEFAULT_RUN_CAPS);
  });
});
