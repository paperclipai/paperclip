import { describe, expect, it } from "vitest";
import { terminalWorkspaceSweepWasInert } from "../services/execution-workspaces.ts";

/**
 * The full result shape `sweepTerminalWorkspaces` returns. Every counter is
 * listed so the "one non-zero outcome at a time" case below covers all of them
 * rather than the subset someone happened to think of.
 */
const EMPTY_SWEEP = {
  checked: 0,
  eligible: 0,
  archived: 0,
  cleanupFailed: 0,
  skippedActiveRun: 0,
  skippedNonTerminalTree: 0,
  skippedUndelivered: 0,
  skippedRace: 0,
  skippedReopened: 0,
  skippedCooldown: 0,
  clearedStaleReopenPending: 0,
};

const NON_ARCHIVING_OUTCOMES = [
  "skippedActiveRun",
  "skippedNonTerminalTree",
  "skippedUndelivered",
  "skippedRace",
  "skippedReopened",
  "skippedCooldown",
  "clearedStaleReopenPending",
] as const;

describe("terminalWorkspaceSweepWasInert", () => {
  it("reports a sweep that found no candidates as not inert", () => {
    // Nothing to archive is not the same as failing to archive. An idle
    // instance must not log every ten minutes.
    expect(terminalWorkspaceSweepWasInert(EMPTY_SWEEP)).toBe(false);
  });

  it("reports a sweep that archived or cleanup-failed as not inert", () => {
    expect(terminalWorkspaceSweepWasInert({ ...EMPTY_SWEEP, checked: 5, archived: 1 })).toBe(false);
    expect(terminalWorkspaceSweepWasInert({ ...EMPTY_SWEEP, checked: 5, cleanupFailed: 1 })).toBe(false);
  });

  // The regression this predicate exists for. The caller used to sum five named
  // skip counters and omitted `skippedReopened` and `clearedStaleReopenPending`,
  // so a reaper skipping every candidate for either reason logged nothing --
  // permanently silent, which is how an instance reached 2,598 workspaces and
  // zero archived rows without a single warning.
  it.each(NON_ARCHIVING_OUTCOMES)("reports a sweep whose only outcome is %s as inert", (outcome) => {
    expect(terminalWorkspaceSweepWasInert({ ...EMPTY_SWEEP, checked: 3, [outcome]: 3 })).toBe(true);
  });

  // Guards the shape itself: a new non-archiving outcome added to the sweep
  // must not need this predicate updated to stay visible.
  it("reports a sweep with candidates and no recognised outcome at all as inert", () => {
    expect(terminalWorkspaceSweepWasInert({ ...EMPTY_SWEEP, checked: 3 })).toBe(true);
  });
});
