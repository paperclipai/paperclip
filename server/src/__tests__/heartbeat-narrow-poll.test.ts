import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// This test is a static regression guard for the heartbeat_runs narrow-poll
// invariant introduced by commit 6f069694f (PR #9155). The candidate polls in
// reapOrphanedRuns (server/src/services/heartbeat.ts) and scanSilentActiveRuns
// (server/src/services/recovery/service.ts) MUST NOT project heavy TOAST
// columns (resultJson, contextSnapshot, logStore, usageJson). Drift here is
// the regression that re-triggers the heartbeat_runs TOAST-detox thundering
// herd.
//
// We assert the invariant statically by reading the source and grep'ing for
// `select()` patterns adjacent to `from(heartbeatRuns)`. This catches any
// future widening back to `select().from(heartbeatRuns)` (which detoasts every
// TOAST column) and keeps the test runner hermetic — no DB, no module-mock
// gymnastics, no drift surface from drizzle version upgrades.

const HEARTBEAT_TS = resolve(__dirname, "../services/heartbeat.ts");
const RECOVERY_TS = resolve(__dirname, "../services/recovery/service.ts");
const HEAVY_TOAST_COLUMNS = ["resultJson", "contextSnapshot", "logStore", "usageJson"];

describe("heartbeat narrow poll — static regression guard", () => {
  it("reapOrphanedRuns source does not project heavy TOAST columns", () => {
    const src = readFileSync(HEARTBEAT_TS, "utf8");
    // Find the body of reapOrphanedRuns and assert no TOAST column appears
    // in the SELECT projection that precedes `from(heartbeatRuns)`.
    const reapIdx = src.indexOf("async function reapOrphanedRuns");
    expect(reapIdx, "reapOrphanedRuns should exist").toBeGreaterThan(-1);
    // Slice to the next sibling function definition to bound the search.
    const slice = src.slice(reapIdx, reapIdx + 4000);

    // Locate the SELECT projection preceding .from(heartbeatRuns) inside this
    // function. The narrow-poll marker comment makes this robust to edits.
    // Source uses chained `db\n  .select({...})` — match `.select({` so the
    // assertion is insensitive to chain-styling.
    const selectStart = slice.indexOf(".select({");
    expect(selectStart, "reapOrphanedRuns should call .select({").toBeGreaterThan(-1);
    const fromIdx = slice.indexOf(".from(heartbeatRuns)", selectStart);
    expect(fromIdx, "reapOrphanedRuns select should target heartbeatRuns").toBeGreaterThan(-1);

    const projection = slice.slice(selectStart, fromIdx);
    for (const col of HEAVY_TOAST_COLUMNS) {
      expect(
        projection.includes(`${col}:`),
        `reapOrphanedRuns projection must NOT include ${col} (TOAST-heavy); ` +
          `found in: ${projection.slice(0, 200)}…`,
      ).toBe(false);
    }

    // Sanity: the narrow projection must still carry the columns the reap
    // guards actually inspect.
    expect(projection).toMatch(/id:/);
    expect(projection).toMatch(/processPid:/);
    expect(projection).toMatch(/processGroupId:/);
    expect(projection).toMatch(/processLossRetryCount:/);
  });

  it("scanSilentActiveRuns source does not project heavy TOAST columns", () => {
    const src = readFileSync(RECOVERY_TS, "utf8");
    const scanIdx = src.indexOf("async function scanSilentActiveRuns");
    expect(scanIdx, "scanSilentActiveRuns should exist").toBeGreaterThan(-1);
    const slice = src.slice(scanIdx, scanIdx + 4000);

    const selectStart = slice.indexOf(".select({");
    expect(selectStart, "scanSilentActiveRuns should call .select({").toBeGreaterThan(-1);
    const fromIdx = slice.indexOf(".from(heartbeatRuns)", selectStart);
    expect(fromIdx, "scanSilentActiveRuns select should target heartbeatRuns").toBeGreaterThan(-1);

    const projection = slice.slice(selectStart, fromIdx);
    for (const col of HEAVY_TOAST_COLUMNS) {
      expect(
        projection.includes(`${col}:`),
        `scanSilentActiveRuns projection must NOT include ${col} (TOAST-heavy); ` +
          `found in: ${projection.slice(0, 200)}…`,
      ).toBe(false);
    }

    // The narrow projection must still carry the columns the cheap
    // quiet-decision guard inspects.
    expect(projection).toMatch(/id:/);
    expect(projection).toMatch(/companyId:/);
  });
});