import { describe, expect, it } from "vitest";
import type { PipelineCompanyCaseEvent } from "../api/pipelines";
import { formatLearningEvent, groupLearningEventsByDay, learningDayKey } from "./pipeline-learnings";

function event(overrides: Partial<PipelineCompanyCaseEvent>): PipelineCompanyCaseEvent {
  return {
    id: "event-1",
    companyId: "company-1",
    caseId: "item-1",
    type: "review_decided",
    actorType: "user",
    createdAt: "2026-06-10T12:00:00.000Z",
    updatedAt: "2026-06-10T12:00:00.000Z",
    payload: {},
    case: { id: "item-1", caseKey: "CASE-1", title: "Launch tweet" },
    pipeline: { id: "pipeline-1", key: "content", name: "Content production" },
    fromStage: null,
    toStage: null,
    actorAgent: null,
    ...overrides,
  };
}

describe("formatLearningEvent", () => {
  it("translates review decisions with a target stage", () => {
    const result = formatLearningEvent(event({
      type: "review_decided",
      toStage: { id: "stage-2", key: "publish", name: "Publish", kind: "done" },
      payload: { actorName: "Dotta", decision: "approve" },
    }));

    expect(result.kind).toBe("review");
    expect(result.sentence).toBe("Dotta approved 'Launch tweet' moving to Publish.");
    expect(result.sentence).not.toContain("review_decided");
  });

  it("translates review decisions without optional context", () => {
    const result = formatLearningEvent(event({
      type: "review_decided",
      payload: { decision: "request_changes" },
    }));

    expect(result.sentence).toBe("Someone sent back 'Launch tweet'.");
    expect(result.sentence).not.toContain("review_decided");
  });

  it("prefers the acting agent's name and renders reject decisions", () => {
    const result = formatLearningEvent(event({
      type: "review_decided",
      actorType: "agent",
      actorAgent: { id: "agent-1", name: "Drafting agent" },
      payload: { decision: "reject", reason: "Off brand" },
    }));

    expect(result.sentence).toBe("Drafting agent declined 'Launch tweet' - note: Off brand.");
  });

  it("translates forced moves with a reason", () => {
    const result = formatLearningEvent(event({
      type: "transition_forced",
      fromStage: { id: "stage-1", key: "drafting", name: "Drafting", kind: "working" },
      toStage: { id: "stage-3", key: "done", name: "Done", kind: "done" },
      payload: { reason: "Ready for the campaign" },
    }));

    expect(result.kind).toBe("forced_move");
    expect(result.sentence).toBe("'Launch tweet' was moved by hand from Drafting to Done - reason: Ready for the campaign.");
    expect(result.sentence).not.toContain("transition_forced");
  });

  it("translates forced moves without a reason", () => {
    const result = formatLearningEvent(event({
      type: "transition_forced",
      toStage: { id: "stage-3", key: "done", name: "Done", kind: "done" },
      payload: {},
    }));

    expect(result.sentence).toBe("'Launch tweet' was moved by hand to Done.");
    expect(result.sentence).not.toContain("transition_forced");
  });

  it("falls back to neutral copy for unknown event types", () => {
    const result = formatLearningEvent(event({ type: "blockers_set" }));

    expect(result.kind).toBe("unknown");
    expect(result.sentence).toBe("'Launch tweet' changed.");
    expect(result.sentence).not.toContain("blockers_set");
  });
});

describe("groupLearningEventsByDay", () => {
  it("groups consecutive events by calendar day", () => {
    const groups = groupLearningEventsByDay([
      event({ id: "a", createdAt: "2026-06-10T12:00:00.000Z" }),
      event({ id: "b", createdAt: "2026-06-10T08:00:00.000Z" }),
      event({ id: "c", createdAt: "2026-06-09T22:00:00.000Z" }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].events.map((item) => item.id)).toEqual(["a", "b"]);
    expect(groups[1].events.map((item) => item.id)).toEqual(["c"]);
  });

  it("buckets invalid timestamps under Unknown", () => {
    expect(learningDayKey("not-a-date")).toBe("Unknown");
  });
});
