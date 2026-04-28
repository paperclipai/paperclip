import { describe, expect, it } from "vitest";
import {
  LIVE_EVENT_TYPES,
  assignRt2ParticipantSchema,
  claimRt2ExecutionSchema,
  completeRt2ExecutionSchema,
  createOneLinerInboundDraftSchema,
  createRt2TaskSchema,
  createRt2TodoSchema,
  enqueueRt2ExecutionSchema,
} from "./index.js";

describe("RT2 task shared contracts", () => {
  it("rejects tasks with empty deliverables", () => {
    expect(() =>
      createRt2TaskSchema.parse({
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        title: "Plan task engine",
        taskMode: "solo",
        capacity: 1,
        deliverables: [],
      }),
    ).toThrow();
  });

  it("rejects deliverables without base price", () => {
    expect(() =>
      createRt2TaskSchema.parse({
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        title: "Plan task engine",
        taskMode: "solo",
        capacity: 1,
        deliverables: [
          {
            title: "Task brief",
            type: "document",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects todos without assigneeUserId", () => {
    expect(() =>
      createRt2TodoSchema.parse({
        taskIssueId: "550e8400-e29b-41d4-a716-446655440001",
        title: "Draft checklist",
        deliverables: [
          {
            title: "Checklist",
            type: "document",
            basePrice: 120000,
          },
        ],
      }),
    ).toThrow();
  });

  it("includes RT2 live event types", () => {
    expect(LIVE_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        "rt2.task.updated",
        "rt2.participant.updated",
        "rt2.todo.updated",
        "rt2.deliverable.updated",
      ]),
    );
  });

  it("requires a participant userId for manager assignment", () => {
    expect(() => assignRt2ParticipantSchema.parse({})).toThrow();
    expect(assignRt2ParticipantSchema.parse({ userId: "user-1" })).toEqual({ userId: "user-1" });
  });

  it("validates RT2 execution lifecycle payloads", () => {
    expect(enqueueRt2ExecutionSchema.parse({})).toEqual({});
    expect(claimRt2ExecutionSchema.parse({ executorType: "jarvis", executorId: "jarvis-1" })).toEqual({
      executorType: "jarvis",
      executorId: "jarvis-1",
    });
    expect(() => completeRt2ExecutionSchema.parse({})).toThrow();
    expect(completeRt2ExecutionSchema.parse({ missingDeliverableReason: "manual result" })).toEqual({
      missingDeliverableReason: "manual result",
    });
  });

  it("accepts messenger, mobile, and native One-Liner inbound sources", () => {
    for (const source of ["slack", "teams", "webhook", "mobile", "native"] as const) {
      expect(createOneLinerInboundDraftSchema.parse({
        source,
        text: "task: Capture field note; deliverable: note; price: 1000",
      })).toEqual({
        source,
        text: "task: Capture field note; deliverable: note; price: 1000",
      });
    }
  });
});
