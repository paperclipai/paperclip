import { describe, expect, it } from "vitest";
import { PLUGIN_EVENT_TYPES } from "@paperclipai/shared";
import { eventTypeForActivityAction } from "../services/activity-log.js";
import { passesFilter } from "../services/plugin-event-bus.js";

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
    "decision.decided",
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

  it("publishes a decision request raised through the queue as decision.created", () => {
    // The desk raises its requests through the decision queue: a seed rule
    // inserts a queue item when an issue needs an answer, and that insertion is
    // what an operator sees appear. Those actions are not declared event types of
    // their own, so without a bridge entry they were dropped and no subscriber
    // ever saw a decision request arrive.
    expect(eventTypeForActivityAction("decision_queue_item.seeded")).toBe("decision.created");
    expect(eventTypeForActivityAction("decision_queue_item.added")).toBe("decision.created");
  });

  it("keeps desk plumbing out of the plugin event surface", () => {
    // Queue, triage, training and retention actions are internal desk mechanics.
    // Exposing them would invite plugins to depend on queue internals, and each
    // one would become a compatibility obligation. The two request actions above
    // are the exception: they are what an operator is asked to answer.
    for (const action of [
      "decision_queue.created",
      "decision_queue_item.removed",
      "decision_triage.updated",
      "decision_training.created",
      "decision_retention.archived",
    ]) {
      expect(eventTypeForActivityAction(action)).toBeNull();
    }
  });

  it("reaches an agent-scoped subscriber when a decision is cancelled", () => {
    // The bus matches an `{ agentId }` filter against `payload.agentId` for anything
    // that is not an agent entity. The cancellation producer used to log the action
    // without that field, so a plugin subscribed to a specific agent's decisions
    // silently never saw a cancellation. `agentId` is the origin agent, not the actor
    // who cancelled: the subscriber asked about the decision, not about the actor.
    const originAgentId = "agent-1";
    // The payload `logActivity` builds: the activity's `agentId` is spread onto the
    // payload root next to the redacted details, so the producer's
    // `agentId: updated.originAgentId` is what the filter reads as `payload.agentId`.
    const cancellation = {
      eventId: "evt-1",
      eventType: "decision.cancelled",
      occurredAt: new Date(0).toISOString(),
      companyId: "company-1",
      actorType: "user",
      actorId: "user-1",
      entityType: "decision",
      entityId: "decision-1",
      payload: { agentId: originAgentId, originAgentId },
    } as unknown as Parameters<typeof passesFilter>[0];

    expect(passesFilter(cancellation, { agentId: originAgentId })).toBe(true);
    expect(passesFilter(cancellation, { agentId: "someone-else" })).toBe(false);
    expect(passesFilter(cancellation, {})).toBe(true);

    // The shape this test guards against: the producer as it was before this PR —
    // no origin agent on the activity, so `payload.agentId` is null.
    const withoutAgent = { ...cancellation, payload: { agentId: null } } as typeof cancellation;
    expect(passesFilter(withoutAgent, { agentId: originAgentId })).toBe(false);
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
