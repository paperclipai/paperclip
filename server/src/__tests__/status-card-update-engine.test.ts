import { describe, expect, it } from "vitest";
import { statusCardRefreshPolicySchema } from "@paperclipai/shared";
import {
  chooseStatusCardUpdateKind,
  diffStatusCardFingerprint,
  evaluateStatusCardPolicy,
  filterStatusCardChanges,
  isWithinStatusCardActiveHours,
} from "../services/status-card-update-engine.js";

describe("status card update engine", () => {
  const defaultPolicy = statusCardRefreshPolicySchema.parse({ mode: "interval", intervalMinutes: 15 });

  it("filters in-progress churn while retaining terminal transitions and membership changes", () => {
    const changes = diffStatusCardFingerprint({
      churn: { status: "in_progress", updatedAt: "2026-07-23T10:00:00.000Z", identifier: "PAP-1", title: "Churn" },
      done: { status: "in_progress", updatedAt: "2026-07-23T10:00:00.000Z", identifier: "PAP-2", title: "Done" },
      removed: { status: "blocked", updatedAt: "2026-07-23T10:00:00.000Z", identifier: "PAP-3", title: "Removed" },
    }, {
      churn: { status: "in_progress", updatedAt: "2026-07-23T10:01:00.000Z", identifier: "PAP-1", title: "Churn" },
      done: { status: "done", updatedAt: "2026-07-23T10:01:00.000Z", identifier: "PAP-2", title: "Done" },
      added: { status: "todo", updatedAt: "2026-07-23T10:01:00.000Z", identifier: "PAP-4", title: "Added" },
    });

    expect(filterStatusCardChanges(changes, defaultPolicy).map((change) => [change.identifier, change.changeKind])).toEqual([
      ["PAP-2", "status"],
      ["PAP-4", "new"],
      ["PAP-3", "removed"],
    ]);
  });

  it("enforces debounce, hourly rate cap, active hours, and daily token cap", () => {
    const now = new Date("2026-07-23T14:00:30.000Z");
    const reactive = statusCardRefreshPolicySchema.parse({ mode: "reactive", debounceSeconds: 60, maxUpdatesPerHour: 6 });
    expect(evaluateStatusCardPolicy({ policy: reactive, now, lastChangeAt: new Date("2026-07-23T14:00:00.000Z"), updatesLastHour: 0, tokensToday: 0, manual: false }).action).toBe("wait");
    expect(evaluateStatusCardPolicy({ policy: reactive, now, lastChangeAt: new Date("2026-07-23T13:59:00.000Z"), updatesLastHour: 6, tokensToday: 0, manual: false }).action).toBe("wait");
    expect(evaluateStatusCardPolicy({ policy: reactive, now, lastChangeAt: new Date("2026-07-23T13:59:00.000Z"), updatesLastHour: 0, tokensToday: 100_000, manual: false }).action).toBe("pause_budget");
    expect(evaluateStatusCardPolicy({ policy: reactive, now, lastChangeAt: null, updatesLastHour: 99, tokensToday: 999_999, manual: true }).action).toBe("run");

    const hours = statusCardRefreshPolicySchema.parse({ mode: "interval", intervalMinutes: 15, activeHours: { start: "09:00", end: "17:00", timezone: "UTC" } });
    expect(isWithinStatusCardActiveHours(hours, new Date("2026-07-23T16:59:00.000Z"))).toBe(true);
    expect(isWithinStatusCardActiveHours(hours, new Date("2026-07-23T17:00:00.000Z"))).toBe(false);
    expect(evaluateStatusCardPolicy({ policy: hours, now: new Date("2026-07-23T18:00:00.000Z"), lastChangeAt: null, updatesLastHour: 0, tokensToday: 0, manual: false }).action).toBe("pause_hours");
  });

  it("selects full rebuilds for bounded drift rules and incremental otherwise", () => {
    const base = { hasDocument: true, changeCount: 2, queryVersion: 3, lastUpdateQueryVersion: 3, incrementalCount: 2, configurationChanged: false };
    expect(chooseStatusCardUpdateKind(base)).toBe("incremental");
    expect(chooseStatusCardUpdateKind({ ...base, changeCount: 11 })).toBe("full");
    expect(chooseStatusCardUpdateKind({ ...base, queryVersion: 4 })).toBe("full");
    expect(chooseStatusCardUpdateKind({ ...base, incrementalCount: 9 })).toBe("full");
    expect(chooseStatusCardUpdateKind({ ...base, configurationChanged: true })).toBe("full");
    expect(chooseStatusCardUpdateKind({ ...base, explicitFull: true })).toBe("full");
    expect(chooseStatusCardUpdateKind({ ...base, restoreRefresh: true })).toBe("full");
  });
});
