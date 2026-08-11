import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  evaluateRecoverySuppression,
  isAllExecutableLanesIntentionallyPaused,
} from "./pause-hold-guard.js";

function createDbStub(results: unknown[][]) {
  const pending = [...results];
  const where = vi.fn(async () => pending.shift() ?? []);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } as unknown as Db, select };
}

const noPauseHold = { getActivePauseHoldGate: vi.fn(async () => null) };

describe("TSMC-20760 intentional company-pause recovery guard", () => {
  it("suppresses recovery while the company run-pause is active", async () => {
    const { db } = createDbStub([[{ runPauseState: { active: true, reason: "operator pause" } }]]);

    await expect(evaluateRecoverySuppression(db, "company-1", "issue-1", noPauseHold as never)).resolves.toEqual({
      suppressed: true,
      reason: "company_run_pause",
    });
  });

  it("suppresses recovery when every executable lane is intentionally paused", async () => {
    const { db } = createDbStub([
      [{ runPauseState: {} }],
      [{ status: "paused" }, { status: "pending_approval" }, { status: "terminated" }],
    ]);

    await expect(evaluateRecoverySuppression(db, "company-1", "issue-1", noPauseHold as never)).resolves.toEqual({
      suppressed: true,
      reason: "all_lanes_paused",
    });
    expect(isAllExecutableLanesIntentionallyPaused(["paused", "pending_approval", "terminated"])).toBe(true);
  });

  it("does not suppress one paused agent while another lane remains active", async () => {
    const { db } = createDbStub([
      [{ runPauseState: {} }],
      [{ status: "paused" }, { status: "idle" }],
    ]);

    await expect(evaluateRecoverySuppression(db, "company-1", "issue-1", noPauseHold as never)).resolves.toEqual({
      suppressed: false,
      reason: null,
    });
  });

  it("restores automatic recovery immediately after an explicit company resume", async () => {
    const { db } = createDbStub([
      [{ runPauseState: { active: true, reason: "maintenance" } }],
      [{ runPauseState: {} }],
      [{ status: "idle" }],
    ]);

    await expect(evaluateRecoverySuppression(db, "company-1", "issue-1", noPauseHold as never)).resolves.toMatchObject({
      suppressed: true,
      reason: "company_run_pause",
    });
    await expect(evaluateRecoverySuppression(db, "company-1", "issue-1", noPauseHold as never)).resolves.toEqual({
      suppressed: false,
      reason: null,
    });
  });
});
