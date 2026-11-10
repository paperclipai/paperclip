import { describe, expect, it } from "vitest";
import { deriveDashboardSignals } from "./signals";

const quiet = { agents: { running: 0, error: 0 }, pendingApprovals: 0, budgets: { pendingApprovals: 0 } };

describe("deriveDashboardSignals", () => {
  it("is quiet before data loads and when nothing is happening", () => {
    expect(deriveDashboardSignals({})).toEqual({ "live-runs": false, "agent-errors": false, "pending-approvals": false });
    expect(deriveDashboardSignals({ summary: quiet, liveRuns: [{ status: "succeeded" }], agents: [{ status: "idle" }] }))
      .toEqual({ "live-runs": false, "agent-errors": false, "pending-approvals": false });
  });

  it("raises live runs from the summary, the live run list or an agent status event", () => {
    expect(deriveDashboardSignals({ summary: { ...quiet, agents: { running: 1, error: 0 } } })["live-runs"]).toBe(true);
    expect(deriveDashboardSignals({ summary: quiet, liveRuns: [{ status: "queued" }] })["live-runs"]).toBe(true);
    expect(deriveDashboardSignals({ summary: quiet, agents: [{ status: "running" }] })["live-runs"]).toBe(true);
  });

  it("raises agent errors and pending approvals", () => {
    expect(deriveDashboardSignals({ summary: quiet, agents: [{ status: "error" }] })["agent-errors"]).toBe(true);
    expect(deriveDashboardSignals({ summary: { ...quiet, agents: { running: 0, error: 2 } } })["agent-errors"]).toBe(true);
    expect(deriveDashboardSignals({ summary: { ...quiet, budgets: { pendingApprovals: 1 } } })["pending-approvals"]).toBe(true);
  });
});
