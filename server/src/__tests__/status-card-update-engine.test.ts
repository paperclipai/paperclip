import { afterEach, describe, expect, it, vi } from "vitest";
import { statusCardRefreshPolicySchema } from "@paperclipai/shared";
import {
  chooseStatusCardUpdateKind,
  diffStatusCardFingerprint,
  evaluateStatusCardPolicy,
  extractIssueMentions,
  filterStatusCardChanges,
  isWithinStatusCardActiveHours,
  nextStatusCardEvaluationAt,
  nextStatusCardPolicyEligibility,
  statusCardChangesHash,
} from "../services/status-card-update-engine.js";

describe("status card update engine", () => {
  afterEach(() => vi.restoreAllMocks());
  const defaultPolicy = statusCardRefreshPolicySchema.parse({ mode: "interval", intervalMinutes: 15 });

  it("retains non-terminal and terminal status transitions plus membership changes", () => {
    const changes = diffStatusCardFingerprint({
      churn: { status: "todo", updatedAt: "2026-07-23T10:00:00.000Z", identifier: "PAP-1", title: "Churn" },
      done: { status: "in_progress", updatedAt: "2026-07-23T10:00:00.000Z", identifier: "PAP-2", title: "Done" },
      removed: { status: "blocked", updatedAt: "2026-07-23T10:00:00.000Z", identifier: "PAP-3", title: "Removed" },
    }, {
      churn: { status: "in_progress", updatedAt: "2026-07-23T10:01:00.000Z", identifier: "PAP-1", title: "Churn" },
      done: { status: "done", updatedAt: "2026-07-23T10:01:00.000Z", identifier: "PAP-2", title: "Done" },
      added: { status: "todo", updatedAt: "2026-07-23T10:01:00.000Z", identifier: "PAP-4", title: "Added" },
    });

    expect(filterStatusCardChanges(changes, defaultPolicy).map((change) => [change.identifier, change.changeKind])).toEqual([
      ["PAP-1", "status"],
      ["PAP-2", "status"],
      ["PAP-4", "new"],
      ["PAP-3", "removed"],
    ]);
  });

  it("tracks human comments independently from generic issue updates", () => {
    const previous = {
      issue: { status: "in_progress", updatedAt: "2026-07-23T10:00:00.000Z", latestHumanCommentAt: null, identifier: "PAP-5", title: "Commented" },
    };
    const current = {
      issue: { status: "done", updatedAt: "2026-07-23T10:01:00.000Z", latestHumanCommentAt: "2026-07-23T10:01:00.000Z", identifier: "PAP-5", title: "Commented" },
    };
    const changes = diffStatusCardFingerprint(previous, current);
    expect(changes.map((change) => change.changeKind)).toEqual(["status", "human_comment"]);
    const commentOnlyPolicy = statusCardRefreshPolicySchema.parse({
      mode: "interval",
      intervalMinutes: 15,
      triggers: { statusTransitions: false, assigneeChanges: false, humanComments: true, membershipChanges: false, anyUpdate: false },
    });
    expect(filterStatusCardChanges(changes, commentOnlyPolicy)).toMatchObject([{ identifier: "PAP-5", changeKind: "human_comment" }]);
  });

  it("changes the pending signature when equal-sized change sets are replaced", () => {
    const first = [{ issueId: "one", identifier: "PAP-1", title: "One", from: "todo", to: "done", changeKind: "status" as const }];
    const second = [{ issueId: "two", identifier: "PAP-2", title: "Two", from: "todo", to: "done", changeKind: "status" as const }];
    expect(statusCardChangesHash(first)).not.toBe(statusCardChangesHash(second));
  });

  it("does not schedule background evaluation for manual cards", () => {
    const now = new Date("2026-07-23T14:00:00.000Z");
    const manual = statusCardRefreshPolicySchema.parse({ mode: "manual" });
    const interval = statusCardRefreshPolicySchema.parse({ mode: "interval", intervalMinutes: 15 });
    expect(nextStatusCardEvaluationAt(manual, now)).toBeNull();
    expect(nextStatusCardEvaluationAt(interval, now)).toEqual(new Date("2026-07-23T14:15:00.000Z"));
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

  it("disarms unchanged reactive evaluation while retaining exact pending eligibility", () => {
    const policy = statusCardRefreshPolicySchema.parse({ mode: "reactive", debounceSeconds: 90, maxUpdatesPerHour: 2,
      activeHours: { start: "09:00", end: "17:00", timezone: "UTC" } });
    const now = new Date("2026-07-23T16:59:30Z");
    expect(nextStatusCardEvaluationAt(policy, now)).toBeNull();
    expect(nextStatusCardPolicyEligibility({ policy, now, lastChangeAt: now, completedUpdateTimes: [], tokensToday: 0 }))
      .toEqual(new Date("2026-07-24T09:00:00Z"));
    const open = new Date("2026-07-23T14:00:00Z");
    expect(nextStatusCardPolicyEligibility({ policy, now: open, lastChangeAt: new Date("2026-07-23T13:00:00Z"),
      completedUpdateTimes: [new Date("2026-07-23T13:30:00Z"), new Date("2026-07-23T13:45:00Z")], tokensToday: 0 }))
      .toEqual(new Date("2026-07-23T14:30:00.001Z"));
    expect(nextStatusCardPolicyEligibility({ policy, now: open, lastChangeAt: open, completedUpdateTimes: [], tokensToday: 100_000 }))
      .toEqual(new Date("2026-07-24T09:00:00Z"));
  });

  it("retains empty-window pending changes without a recurring eligibility scan", () => {
    const policy = statusCardRefreshPolicySchema.parse({ mode: "reactive", debounceSeconds: 1,
      activeHours: { start: "09:00", end: "09:00", timezone: "UTC" } });
    const now = new Date("2026-07-23T14:00:00Z");
    expect(nextStatusCardPolicyEligibility({ policy, now, lastChangeAt: now, completedUpdateTimes: [], tokensToday: 0 })).toBeNull();
  });

  it("bounds empty-window formatter work before any timezone conversion", () => {
    const policy = statusCardRefreshPolicySchema.parse({ mode: "reactive", debounceSeconds: 1,
      activeHours: { start: "09:00", end: "09:00", timezone: "Pacific/Chatham" } });
    const formatter = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function () {
      throw new Error("Empty active hours must not construct a formatter");
    });
    const now = new Date("2026-07-23T14:00:00Z");
    expect(isWithinStatusCardActiveHours(policy, now)).toBe(false);
    expect(nextStatusCardPolicyEligibility({ policy, now, lastChangeAt: now, completedUpdateTimes: [], tokensToday: 0 })).toBeNull();
    expect(formatter).not.toHaveBeenCalled();
  });

  it("bounds formatter construction and reuses the next opening across cards and source writes", () => {
    const policy = statusCardRefreshPolicySchema.parse({ mode: "reactive", debounceSeconds: 1,
      activeHours: { start: "09:00", end: "17:00", timezone: "America/St_Johns" } });
    const RealFormatter = Intl.DateTimeFormat;
    let constructions = 0;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      if (++constructions > 1) throw new Error("Card evaluation repeatedly constructed timezone formatters");
      return new RealFormatter(...args);
    } as unknown as typeof Intl.DateTimeFormat);
    const conversions = vi.spyOn(RealFormatter.prototype, "formatToParts");
    const now = new Date("2026-07-23T22:00:00Z");
    const input = { policy, now, lastChangeAt: new Date(now.getTime() - 60_000), completedUpdateTimes: [], tokensToday: 0 };
    const started = performance.now();
    expect(nextStatusCardPolicyEligibility(input)).toEqual(new Date("2026-07-24T11:30:00Z"));
    const coldMs = performance.now() - started;
    const coldConversions = conversions.mock.calls.length;
    expect(coldConversions).toBeLessThanOrEqual(2881);
    conversions.mockClear();
    const warmStarted = performance.now();
    for (let write = 0; write < 100; write++) for (let card = 0; card < 20; card++) {
      expect(nextStatusCardPolicyEligibility({ ...input,
        policy: { ...policy, activeHours: { ...policy.activeHours! } },
        now: new Date(now.getTime() + write * 1000),
      })).toEqual(new Date("2026-07-24T11:30:00Z"));
    }
    expect(constructions).toBeLessThanOrEqual(1);
    expect(conversions.mock.calls.length).toBeLessThanOrEqual(2000);
    process.stdout.write(JSON.stringify({ measurement: "status-card active-hours cost", coldMs, coldConversions, constructions,
      warmMs: performance.now() - warmStarted, warmConversions: conversions.mock.calls.length, evaluations: 2000 }) + "\n");
  });

  it.each([
    ["America/New_York", "02:15", "03:30", "2026-03-08T06:50:00Z", "2026-03-08T07:00:00Z"],
    ["America/New_York", "02:15", "02:45", "2026-03-08T06:50:00Z", "2026-03-09T06:15:00Z"],
    ["America/New_York", "02:15", "02:45", "2026-03-07T07:45:00Z", "2026-03-09T06:15:00Z"],
    ["America/New_York", "01:15", "01:45", "2026-11-01T05:50:00Z", "2026-11-01T06:15:00Z"],
    ["America/New_York", "23:30", "01:30", "2026-11-01T05:40:00Z", "2026-11-01T06:00:00Z"],
    ["Australia/Lord_Howe", "02:15", "02:45", "2026-10-03T15:20:00Z", "2026-10-03T15:30:00Z"],
    ["Australia/Lord_Howe", "01:35", "01:45", "2026-04-04T14:50:00Z", "2026-04-04T15:05:00Z"],
    ["Asia/Kathmandu", "09:00", "17:00", "2026-07-23T12:00:00Z", "2026-07-24T03:15:00Z"],
    ["Pacific/Apia", "00:10", "00:20", "2011-12-30T09:50:00Z", "2011-12-30T10:10:00Z"],
  ])("preserves the first real opening in %s %s-%s after %s", (timezone, start, end, time, expected) => {
    const policy = statusCardRefreshPolicySchema.parse({ mode: "reactive", debounceSeconds: 1, activeHours: { start, end, timezone } });
    const now = new Date(time);
    const input = { policy, now, lastChangeAt: new Date(now.getTime() - 60_000), completedUpdateTimes: [], tokensToday: 0 };
    expect(nextStatusCardPolicyEligibility(input)).toEqual(new Date(expected));
    // A later closed instant reuses the opening, while the exact opening itself
    // remains eligible without rounding it into the next minute or day.
    expect(nextStatusCardPolicyEligibility({ ...input, now: new Date(now.getTime() + 1000) })).toEqual(new Date(expected));
    const opening = new Date(expected);
    expect(nextStatusCardPolicyEligibility({ ...input, now: opening })).toEqual(opening);
    expect(nextStatusCardPolicyEligibility({ ...input, now: new Date(opening.getTime() + 1) })).toEqual(new Date(opening.getTime() + 1));
  });

  it("invalidates an upcoming opening for clock rollback and changed policy values", () => {
    const policy = statusCardRefreshPolicySchema.parse({ mode: "reactive", debounceSeconds: 1,
      activeHours: { start: "09:00", end: "17:00", timezone: "UTC" } });
    const calculate = (time: string, activeHours = policy.activeHours!) => {
      const now = new Date(time);
      return nextStatusCardPolicyEligibility({ policy: { ...policy, activeHours }, now,
        lastChangeAt: new Date(now.getTime() - 60_000), completedUpdateTimes: [], tokensToday: 0 });
    };
    expect(calculate("2026-07-23T18:00:00Z")).toEqual(new Date("2026-07-24T09:00:00Z"));
    expect(calculate("2026-07-23T08:00:00Z")).toEqual(new Date("2026-07-23T09:00:00Z"));
    expect(calculate("2026-07-23T17:00:00Z")).toEqual(new Date("2026-07-24T09:00:00Z"));
    expect(calculate("2026-07-23T18:00:00Z", { ...policy.activeHours!, start: "10:00" })).toEqual(new Date("2026-07-24T10:00:00Z"));
    expect(calculate("2026-07-23T18:00:00Z", { ...policy.activeHours!, end: "19:00" })).toEqual(new Date("2026-07-23T18:00:00Z"));
    expect(calculate("2026-07-23T18:00:00Z", { ...policy.activeHours!, timezone: "Asia/Tokyo" })).toEqual(new Date("2026-07-24T00:00:00Z"));
  });

  it("checks the precise instant before a cached minute opening for historical second offsets", () => {
    const policy = statusCardRefreshPolicySchema.parse({ mode: "reactive", debounceSeconds: 1,
      activeHours: { start: "09:00", end: "10:00", timezone: "Africa/Monrovia" } });
    const now = new Date("1970-01-01T08:00:00Z");
    const input = { policy, now, lastChangeAt: new Date(now.getTime() - 60_000), completedUpdateTimes: [], tokensToday: 0 };
    expect(nextStatusCardPolicyEligibility(input)).toEqual(new Date("1970-01-01T09:45:00Z"));
    const inside = new Date("1970-01-01T09:44:45Z");
    expect(isWithinStatusCardActiveHours(policy, inside)).toBe(true);
    expect(nextStatusCardPolicyEligibility({ ...input, now: inside })).toEqual(inside);
  });

  it("bounds formatter and upcoming-opening cache retention", () => {
    const now = new Date("2026-07-25T00:00:00Z");
    const timezonePolicy = (timezone: string) => statusCardRefreshPolicySchema.parse({ mode: "reactive", debounceSeconds: 1,
      activeHours: { start: "09:00", end: "17:00", timezone } });
    const zones = Intl.supportedValuesOf("timeZone").slice(0, 34);
    const first = timezonePolicy(zones[0]!);
    isWithinStatusCardActiveHours(first, now);
    for (const zone of zones.slice(1)) isWithinStatusCardActiveHours(timezonePolicy(zone), now);
    const RealFormatter = Intl.DateTimeFormat;
    const constructor = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      return new RealFormatter(...args);
    } as unknown as typeof Intl.DateTimeFormat);
    isWithinStatusCardActiveHours(first, now);
    expect(constructor).toHaveBeenCalledTimes(1);
    constructor.mockRestore();
    const time = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    const calculate = (minute: number) => {
      const policy = statusCardRefreshPolicySchema.parse({ mode: "reactive", debounceSeconds: 1,
        activeHours: { start: time(minute), end: time(minute + 1), timezone: "UTC" } });
      return nextStatusCardPolicyEligibility({ policy, now, lastChangeAt: new Date(now.getTime() - 60_000), completedUpdateTimes: [], tokensToday: 0 });
    };
    calculate(1);
    for (let minute = 2; minute <= 258; minute++) calculate(minute);
    const conversions = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    expect(calculate(1)).toEqual(new Date("2026-07-25T00:01:00Z"));
    expect(conversions.mock.calls.length).toBeGreaterThan(1);
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

  it("extracts identifier and issue-link mentions from summary markdown", () => {
    const markdown = [
      "**Decide:** [PAP-15357](/issues/PAP-15357) is blocked; PAP-15357 and pap-99 (lowercase) plus SC2-4 moved.",
      "See [the launch issue](/issues/0F5A2C71-9F5C-4B6C-8A9E-1B2C3D4E5F60#comment-1) and /issues/not-a-uuid.",
    ].join("\n");

    expect(extractIssueMentions(markdown)).toEqual({
      identifiers: ["PAP-15357", "SC2-4"],
      issueIds: ["0f5a2c71-9f5c-4b6c-8a9e-1b2c3d4e5f60"],
    });
    expect(extractIssueMentions("No references here.")).toEqual({ identifiers: [], issueIds: [] });
  });
});
