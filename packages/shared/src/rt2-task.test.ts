import { describe, expect, it } from "vitest";
import {
  LIVE_EVENT_TYPES,
  assignRt2ParticipantSchema,
  createRt2TaskSchema,
  createRt2TodoSchema,
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

  it("rejects todos without assigneeUserId", () => {
    expect(() =>
      createRt2TodoSchema.parse({
        taskIssueId: "550e8400-e29b-41d4-a716-446655440001",
        title: "Draft checklist",
        deliverables: [
          {
            kind: "doc",
            title: "Checklist",
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
});
