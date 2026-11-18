import { describe, expect, it } from "vitest";
import { planTriggerUpdate, triggerUpdateActivityAction } from "../services/routine-trigger-update-plan.js";

const real = { status: "received" as const, receivedAt: "2026-11-17T10:00:00Z", test: false };

describe("planTriggerUpdate", () => {
  it("starts testing without touching the delivery", () => {
    const plan = planTriggerUpdate({ setupPending: true }, { kind: "webhook", setupPending: false, lastWebhookDelivery: real });
    expect(plan).toMatchObject({ startsTesting: true, finishesTesting: false, restoredDelivery: null, changeSummary: "Started testing webhook", activityAction: "routine.trigger_test_started" });
  });

  it("restores the last real delivery when a test ends", () => {
    const plan = planTriggerUpdate({ setupPending: false }, {
      kind: "webhook",
      setupPending: true,
      lastWebhookDelivery: { status: "received", receivedAt: "2026-11-18T10:00:00Z", test: true, previous: real },
    });
    expect(plan.restoredDelivery).toEqual({ value: real });
    expect(plan.changeSummary).toBe("Finished testing webhook");
    expect(plan.activityAction).toBe("routine.trigger_setup_finished");
  });

  it("clears a test result that had no real delivery before it", () => {
    const plan = planTriggerUpdate({ setupPending: false }, {
      kind: "webhook",
      setupPending: true,
      lastWebhookDelivery: { status: "received", receivedAt: "2026-11-18T10:00:00Z", test: true, previous: null },
    });
    expect(plan.restoredDelivery).toEqual({ value: null });
    expect(plan.changeSummary).toBe("Finished webhook setup or test");
  });

  it("leaves deliveries recorded before test bookkeeping alone", () => {
    const legacy = { status: "received" as const, receivedAt: "2026-11-18T10:00:00Z", test: true };
    expect(planTriggerUpdate({ setupPending: false }, { kind: "webhook", setupPending: true, lastWebhookDelivery: legacy }).restoredDelivery).toBeNull();
  });

  it("names other updates by trigger kind and maps every activity action", () => {
    expect(planTriggerUpdate({}, { kind: "schedule", setupPending: false, lastWebhookDelivery: null }).changeSummary).toBe("Updated schedule trigger");
    expect(triggerUpdateActivityAction({ archived: true, setupPending: true })).toBe("routine.trigger_removed");
    expect(triggerUpdateActivityAction({ archived: false })).toBe("routine.trigger_restored");
    expect(triggerUpdateActivityAction({})).toBe("routine.trigger_updated");
  });
});
