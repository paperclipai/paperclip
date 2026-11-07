import { expect, it } from "vitest";
import { projectIdleExternalObjectSchedule, type IdleExternalObjectRow } from "../services/external-object-idle-schedule.js";

const now = Date.UTC(2099, 0, 1);
function object(patch: Partial<IdleExternalObjectRow> = {}): IdleExternalObjectRow {
  return { id: "object", companyId: "company", companyStatus: "active", revision: "row:1", eligible: true,
    nextRefreshAt: new Date(now + 60_000), refreshStartedAt: null, refreshToken: null, ...patch };
}

it("retains the exact owner-eligible future deadline and leaves passive history alone", () => {
  const row = object();
  expect(projectIdleExternalObjectSchedule([row, object({ eligible: false, nextRefreshAt: new Date(now - 1) })], now, true))
    .toMatchObject({ blocked: false, deadlines: [now + 60_000] });
  expect(row.nextRefreshAt!.getTime()).toBe(now + 60_000);
  expect(projectIdleExternalObjectSchedule([row], now, false)).toMatchObject({ blocked: false, deadlines: [] });
});

it.each([{ nextRefreshAt: null }, { nextRefreshAt: new Date(now) }, { nextRefreshAt: new Date(Number.NaN) }])(
  "blocks due or invalid eligible obligations %j", patch => {
    expect(projectIdleExternalObjectSchedule([object(patch)], now, true).blocked).toBe(true);
  });

it.each([{ refreshToken: "token" }, { refreshStartedAt: new Date(now - 600_000) }])(
  "never exempts active or ambiguous claims after eligibility removal %j", patch => {
    expect(projectIdleExternalObjectSchedule([object({ ...patch, eligible: false })], now, false).blocked).toBe(true);
  });

it("blocks an uninitialized owner and a bounded inspection overflow", () => {
  expect(projectIdleExternalObjectSchedule([], now, null).blocked).toBe(true);
  expect(projectIdleExternalObjectSchedule(Array.from({ length: 10_001 }, () => object({ eligible: false })), now, true).blocked).toBe(true);
});
