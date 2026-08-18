import { describe, expect, it } from "vitest";
import { expandCronOccurrences } from "./cron-occurrences.js";
import { nextCronTickInTimeZone } from "./routines.js";

/**
 * Repeatedly ask the *scheduler's* own next-tick function for occurrences, so
 * the fast expander can be checked against the slow thing it replaces rather
 * than against a hand-written expectation that could share its bugs.
 */
function oracleOccurrences(
  expression: string,
  timeZone: string,
  from: Date,
  to: Date,
  cap = 500,
): string[] {
  const out: string[] = [];
  // `nextCronTickInTimeZone` is strictly-after, so step back a minute to keep
  // an occurrence landing exactly on `from` in scope.
  let cursor = new Date(from.getTime() - 60_000);
  for (let i = 0; i < cap; i += 1) {
    const next = nextCronTickInTimeZone(expression, timeZone, cursor);
    if (!next || next.getTime() > to.getTime()) break;
    out.push(next.toISOString());
    cursor = next;
  }
  return out;
}

function iso(result: { occurrences: Date[] }): string[] {
  return result.occurrences.map((date) => date.toISOString());
}

describe("expandCronOccurrences", () => {
  it("expands a daily schedule across a window", () => {
    const result = expandCronOccurrences("30 9 * * *", "UTC", {
      from: new Date("2026-03-01T00:00:00Z"),
      to: new Date("2026-03-04T23:59:00Z"),
      limit: 100,
    });
    expect(iso(result)).toEqual([
      "2026-03-01T09:30:00.000Z",
      "2026-03-02T09:30:00.000Z",
      "2026-03-03T09:30:00.000Z",
      "2026-03-04T09:30:00.000Z",
    ]);
    expect(result.truncated).toBe(false);
  });

  it("treats the window bounds as inclusive", () => {
    const result = expandCronOccurrences("0 * * * *", "UTC", {
      from: new Date("2026-03-01T01:00:00Z"),
      to: new Date("2026-03-01T03:00:00Z"),
      limit: 100,
    });
    expect(iso(result)).toEqual([
      "2026-03-01T01:00:00.000Z",
      "2026-03-01T02:00:00.000Z",
      "2026-03-01T03:00:00.000Z",
    ]);
  });

  it("projects midnight schedules that the h24 formatter would drop (#7529)", () => {
    const result = expandCronOccurrences("0 0 * * *", "UTC", {
      from: new Date("2026-03-01T00:00:00Z"),
      to: new Date("2026-03-03T00:00:00Z"),
      limit: 100,
    });
    expect(iso(result)).toEqual([
      "2026-03-01T00:00:00.000Z",
      "2026-03-02T00:00:00.000Z",
      "2026-03-03T00:00:00.000Z",
    ]);
  });

  it("resolves occurrences in the schedule's timezone, not the server's", () => {
    // 09:00 in New York is 14:00 UTC in winter and 13:00 UTC in summer.
    const winter = expandCronOccurrences("0 9 * * *", "America/New_York", {
      from: new Date("2026-01-15T00:00:00Z"),
      to: new Date("2026-01-15T23:59:00Z"),
      limit: 10,
    });
    expect(iso(winter)).toEqual(["2026-01-15T14:00:00.000Z"]);

    const summer = expandCronOccurrences("0 9 * * *", "America/New_York", {
      from: new Date("2026-07-15T00:00:00Z"),
      to: new Date("2026-07-15T23:59:00Z"),
      limit: 10,
    });
    expect(iso(summer)).toEqual(["2026-07-15T13:00:00.000Z"]);
  });

  it("ANDs day-of-month and day-of-week the way Paperclip's scheduler does", () => {
    // Vixie cron ORs these fields; `nextCronTick` (cron.ts:280) ANDs them. The
    // calendar has to agree with the scheduler, not with Vixie: November 2026
    // has a Friday the 13th, October does not.
    const result = expandCronOccurrences("0 9 13 * 5", "UTC", {
      from: new Date("2026-10-01T00:00:00Z"),
      to: new Date("2026-12-31T23:59:00Z"),
      limit: 100,
    });
    expect(iso(result)).toEqual(["2026-11-13T09:00:00.000Z"]);
  });

  it("never emits a wall clock that DST skipped", () => {
    // America/New_York jumps 02:00 -> 03:00 on 2026-03-08, so 02:30 never
    // happens that day.
    const result = expandCronOccurrences("30 2 * * *", "America/New_York", {
      from: new Date("2026-03-07T00:00:00Z"),
      to: new Date("2026-03-10T23:59:00Z"),
      limit: 100,
    });
    expect(iso(result)).toEqual([
      "2026-03-07T07:30:00.000Z",
      // 2026-03-08 02:30 does not exist — no entry.
      "2026-03-09T06:30:00.000Z",
      "2026-03-10T06:30:00.000Z",
    ]);
  });

  it("emits both instants of a wall clock that DST repeated", () => {
    // America/New_York falls back 02:00 -> 01:00 on 2026-11-01, so 01:30
    // happens twice — and the scheduler's minute-stepper fires on both.
    const result = expandCronOccurrences("30 1 * * *", "America/New_York", {
      from: new Date("2026-11-01T00:00:00Z"),
      to: new Date("2026-11-01T23:59:00Z"),
      limit: 100,
    });
    expect(iso(result)).toEqual([
      "2026-11-01T05:30:00.000Z", // EDT (UTC-4)
      "2026-11-01T06:30:00.000Z", // EST (UTC-5)
    ]);
  });

  it("caps a dense series and reports the truncation", () => {
    const result = expandCronOccurrences("*/5 * * * *", "UTC", {
      from: new Date("2026-03-01T00:00:00Z"),
      to: new Date("2026-03-31T23:59:00Z"),
      limit: 10,
    });
    expect(result.occurrences).toHaveLength(10);
    expect(result.truncated).toBe(true);
    // The cap keeps the *earliest* occurrences, which is what makes "your next
    // ten runs" a true statement.
    expect(iso(result)[0]).toBe("2026-03-01T00:00:00.000Z");
    expect(iso(result)[9]).toBe("2026-03-01T00:45:00.000Z");
  });

  it("returns nothing for an empty or inverted window", () => {
    expect(
      expandCronOccurrences("0 9 * * *", "UTC", {
        from: new Date("2026-03-04T00:00:00Z"),
        to: new Date("2026-03-01T00:00:00Z"),
        limit: 10,
      }).occurrences,
    ).toEqual([]);
    expect(
      expandCronOccurrences("0 9 * * *", "UTC", {
        from: new Date("2026-03-01T00:00:00Z"),
        to: new Date("2026-03-04T00:00:00Z"),
        limit: 0,
      }).occurrences,
    ).toEqual([]);
  });

  it("rejects an invalid cron expression", () => {
    expect(() =>
      expandCronOccurrences("not a cron", "UTC", {
        from: new Date("2026-03-01T00:00:00Z"),
        to: new Date("2026-03-02T00:00:00Z"),
        limit: 10,
      }),
    ).toThrow();
  });

  it("rejects an unknown timezone", () => {
    expect(() =>
      expandCronOccurrences("0 9 * * *", "Mars/Olympus_Mons", {
        from: new Date("2026-03-01T00:00:00Z"),
        to: new Date("2026-03-02T00:00:00Z"),
        limit: 10,
      }),
    ).toThrow();
  });

  describe("agrees with the scheduler's own next-tick function", () => {
    // Each case is checked against `nextCronTickInTimeZone` — the function the
    // routine scheduler actually dispatches from — so the calendar can never
    // quietly drift from what will really run. Midnight schedules are excluded:
    // the scheduler drops those today (#7529, fix in flight as #7922) and this
    // module deliberately gets them right, which is the one documented
    // divergence.
    // Windows are kept short on purpose. The oracle walks one minute at a time,
    // so its cost is the length of the window rather than the number of
    // occurrences; each case is sized to cover the behaviour it is there for
    // (a DST transition, a month rollover, a non-hour offset) and no more.
    const cases: { expression: string; timeZone: string; from: string; to: string }[] = [
      { expression: "30 9 * * *", timeZone: "UTC", from: "2026-03-01", to: "2026-03-15" },
      { expression: "*/15 * * * *", timeZone: "UTC", from: "2026-03-01", to: "2026-03-02" },
      // Straddles the UK spring-forward (29 March).
      { expression: "0 9 * * 1", timeZone: "Europe/London", from: "2026-03-25", to: "2026-04-05" },
      // Straddles the US spring-forward (8 March).
      { expression: "45 17 * * 1-5", timeZone: "America/New_York", from: "2026-03-04", to: "2026-03-13" },
      // Monthly, across a month boundary.
      { expression: "30 6 1 * *", timeZone: "America/New_York", from: "2026-01-28", to: "2026-02-05" },
      // Half-hour offset zone.
      { expression: "0 12 * * 0", timeZone: "Asia/Kolkata", from: "2026-05-01", to: "2026-05-12" },
      // Straddles the Australian autumn transition (5 April).
      { expression: "15 3 * * *", timeZone: "Australia/Sydney", from: "2026-04-01", to: "2026-04-08" },
      // The New York spring-forward gap and fall-back fold at 01:30.
      { expression: "30 1 * * *", timeZone: "America/New_York", from: "2026-03-05", to: "2026-03-12" },
      { expression: "30 1 * * *", timeZone: "America/New_York", from: "2026-10-28", to: "2026-11-05" },
    ];

    for (const testCase of cases) {
      // The oracle is the deliberately slow minute-stepper, so these get more
      // than the default per-test budget on a loaded CI box.
      it(`${testCase.expression} @ ${testCase.timeZone} (${testCase.from} → ${testCase.to})`, { timeout: 60_000 }, () => {
        const from = new Date(`${testCase.from}T00:00:00Z`);
        const to = new Date(`${testCase.to}T00:00:00Z`);
        const expanded = iso(
          expandCronOccurrences(testCase.expression, testCase.timeZone, { from, to, limit: 500 }),
        );
        expect(expanded).toEqual(oracleOccurrences(testCase.expression, testCase.timeZone, from, to));
      });
    }
  });
});
