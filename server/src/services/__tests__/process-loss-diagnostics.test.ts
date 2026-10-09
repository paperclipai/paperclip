import { describe, expect, it } from "vitest";
import { buildProcessLossDiagnostic, readProcessLossDiagnostic } from "../process-loss-diagnostics.js";

const nowMs = Date.UTC(2026, 0, 1, 12);
const run = {
  startedAt: new Date(nowMs - 10 * 60_000), lastOutputAt: new Date(nowMs - 2 * 60_000),
  processPid: 123, processGroupId: null,
};
const input = { run, nowMs, observerStartedAtMs: nowMs - 30_000,
  checksPersistedChildLiveness: true, retryEligible: true };

describe("orphan process-loss evidence", () => {
  it("distinguishes a run from the previous observer without inventing a restart cause", () => {
    expect(buildProcessLossDiagnostic(input)).toEqual({
      pidRecorded: true, groupRecorded: false, localCheck: "not_observed_alive", retryEligible: true,
      runPredatesObserver: true, lastOutputAgeMs: 120_000, observerUptimeMs: 30_000,
    });
    const currentObserverRun = buildProcessLossDiagnostic({ ...input, observerStartedAtMs: nowMs - 20 * 60_000 });
    expect(currentObserverRun.runPredatesObserver).toBe(false);
    expect(currentObserverRun).not.toHaveProperty("restartCause");
  });

  it("does not describe missing or unchecked identifiers as confirmed child death", () => {
    expect(buildProcessLossDiagnostic({ ...input, checksPersistedChildLiveness: false }).localCheck).toBe("not_checked");
    expect(buildProcessLossDiagnostic({ ...input, run: { ...run, processPid: null }, retryEligible: false }))
      .toMatchObject({ pidRecorded: false, groupRecorded: false, localCheck: "no_identifiers", retryEligible: false });
    expect(buildProcessLossDiagnostic({ ...input, run: { ...run, processPid: null, processGroupId: 456 } }))
      .toMatchObject({ pidRecorded: false, groupRecorded: true, localCheck: "not_observed_alive" });
  });

  it("omits unavailable, future and unbounded ages", () => {
    for (const lastOutputAt of [null, new Date(NaN), new Date(nowMs + 1), new Date(nowMs - 604_800_001)]) {
      expect(buildProcessLossDiagnostic({ ...input, run: { ...run, lastOutputAt } })).not.toHaveProperty("lastOutputAgeMs");
    }
    for (const observerStartedAtMs of [NaN, Infinity, nowMs + 1]) {
      const diagnostic = buildProcessLossDiagnostic({ ...input, observerStartedAtMs });
      expect(diagnostic).not.toHaveProperty("observerUptimeMs");
      expect(diagnostic).not.toHaveProperty("runPredatesObserver");
    }
    expect(buildProcessLossDiagnostic({ ...input, run: { ...run, startedAt: new Date(nowMs + 1) } }))
      .not.toHaveProperty("runPredatesObserver");
    expect(buildProcessLossDiagnostic({ ...input, observerStartedAtMs: nowMs - 1.5 }).observerUptimeMs).toBe(2);
  });

  it("reads only bounded scalar evidence, including hostile persisted input", () => {
    const diagnostic = buildProcessLossDiagnostic(input);
    expect(readProcessLossDiagnostic({ ...diagnostic, pid: 123, prompt: "private-prompt", path: "/private/path" }))
      .toEqual(diagnostic);
    for (const value of [null, [], "private", { localCheck: "private", pidRecorded: 1,
      groupRecorded: "false", retryEligible: "private", runPredatesObserver: null,
      observerUptimeMs: 604_800_001, lastOutputAgeMs: -1 },
      Object.defineProperty({}, "localCheck", { get() { throw new Error("private"); } })]) {
      expect(readProcessLossDiagnostic(value)).toEqual({});
    }
  });
});
