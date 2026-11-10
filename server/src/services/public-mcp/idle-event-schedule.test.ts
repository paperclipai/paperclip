import { describe, expect, it } from "vitest";
import { projectIdleMcpEventSchedule, type IdleMcpEventDeadlineRow } from "./idle-event-schedule.js";
const input = { now: 1000, coveredGrantIds: ["grant"], personal: { revision: "personal:1", reconciled: true }, dot: { revision: "dot:1", reconciled: true } };
const row: IdleMcpEventDeadlineRow = { id: "delivery", subscriptionId: "subscription", companyId: "company", grantId: "grant", taskId: "task", bindingId: null,
  subscriptionExpiresAt: new Date(10_000), subscriptionStoppedAt: null, nextAttemptAt: new Date(2000), attempts: 1, outcome: "http_503", sourceMatches: true };
describe("MCP durable retry deadline proof", () => {
  it("represents future retries after successful reconciliation without advancing their deadline", () => {
    const result = projectIdleMcpEventSchedule([row], input);
    expect(result.blocked).toBe(false);
    expect(result.deadlines).toEqual([2000]);
    expect(projectIdleMcpEventSchedule([row], { ...input, now: 1500 }).deadlines).toEqual([2000]);
    expect(projectIdleMcpEventSchedule([], input).deadlines).toEqual([]);
  });
  it("retains due, in-flight, orphaned, exhausted, stopped, foreign and unfamiliar delivery work", () => {
    for (const change of [{ nextAttemptAt: new Date(1000) }, { nextAttemptAt: new Date(NaN) }, { attempts: 0 }, { attempts: 6 }, { attempts: 1.5 },
      { outcome: null }, { outcome: "delivered" }, { outcome: "http_404" }, { subscriptionStoppedAt: new Date() }, { subscriptionExpiresAt: new Date(1000) },
      { sourceMatches: false }, { grantId: "foreign" }, { taskId: null, bindingId: null }, { bindingId: "binding" }]) {
      expect(projectIdleMcpEventSchedule([{ ...row, ...change }], input).blocked).toBe(true);
    }
    expect(projectIdleMcpEventSchedule([row], { ...input, personal: { revision: "changed", reconciled: false } }).blocked).toBe(true);
    expect(projectIdleMcpEventSchedule([row], { ...input, coveredGrantIds: [] }).blocked).toBe(true);
    expect(projectIdleMcpEventSchedule(Array.from({ length: 10_001 }, () => row), input).blocked).toBe(true);
  });
  it("checks the Dot owner independently and changes proof state on a new reconciliation", () => {
    const dot = { ...row, taskId: null, bindingId: "binding", outcome: "network_error" };
    expect(projectIdleMcpEventSchedule([dot], input).blocked).toBe(false);
    expect(projectIdleMcpEventSchedule([dot], { ...input, dot: { revision: "dot:2", reconciled: false } }).blocked).toBe(true);
    expect(projectIdleMcpEventSchedule([row], { ...input, personal: { revision: "personal:2", reconciled: true } }).state)
      .not.toEqual(projectIdleMcpEventSchedule([row], input).state);
  });
});
