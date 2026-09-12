import { describe, expect, it } from "vitest";
import { PLUGIN_EVENT_TYPES } from "@paperclipai/shared";
import { eventTypeForActivityAction } from "../services/activity-log.js";

/**
 * The activity-action → plugin-event mapping is a plugin-facing contract that
 * fails silently: an unmapped action produces no event, so a subscriber simply
 * never hears about it and nothing errors. The Decisions Desk was in exactly that
 * state — `decision.created` was logged with the payload a notifier needs
 * (`originIssueId`, `originAgentId`, `originResponsibleUserId`) but mapped to
 * nothing.
 */
describe("decision lifecycle plugin events", () => {
  const decisionActions = [
    "decision.created",
    "decision.expired",
    "decision.dismissed",
    "decision.cancelled",
  ] as const;

  it("declares every decision lifecycle action as a subscribable event type", () => {
    for (const action of decisionActions) {
      expect(PLUGIN_EVENT_TYPES).toContain(action);
    }
  });

  it("maps each decision action onto its own event type", () => {
    for (const action of decisionActions) {
      expect(eventTypeForActivityAction(action)).toBe(action);
    }
  });

  it("keeps desk plumbing out of the plugin event surface", () => {
    // Queue, triage, training and retention actions are internal desk mechanics.
    // Exposing them would invite plugins to depend on queue internals, and each
    // one would become a compatibility obligation.
    for (const action of [
      "decision_queue_item.added",
      "decision_queue.created",
      "decision_queue_item.removed",
      "decision_triage.updated",
      "decision_training.created",
      "decision_retention.archived",
    ]) {
      expect(eventTypeForActivityAction(action)).toBeNull();
    }
  });

  it("does not treat a decision action as a prefix match", () => {
    // The pass-through is an exact set lookup, not a prefix rule: a future
    // action must be declared deliberately rather than inheriting an event.
    expect(eventTypeForActivityAction("decision.created.v2")).toBeNull();
    expect(eventTypeForActivityAction("decision")).toBeNull();
  });

  it("still maps the legacy underscore actions it already covered", () => {
    expect(eventTypeForActivityAction("approval_approved")).toBe("approval.decided");
    expect(eventTypeForActivityAction("approval_rejected")).toBe("approval.decided");
    expect(eventTypeForActivityAction("issue_comment_added")).toBe("issue.comment.created");
    expect(eventTypeForActivityAction("budget_soft_threshold_crossed")).toBe(
      "budget.incident.opened",
    );
  });

  it("passes through the event types that were already exact names", () => {
    expect(eventTypeForActivityAction("issue.created")).toBe("issue.created");
    expect(eventTypeForActivityAction("approval.created")).toBe("approval.created");
  });

  it("leaves unrelated activity unmapped", () => {
    expect(eventTypeForActivityAction("company.created.note")).toBeNull();
    expect(eventTypeForActivityAction("some.unmapped.action")).toBeNull();
  });
});
