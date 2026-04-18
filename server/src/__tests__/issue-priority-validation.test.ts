import { describe, expect, it } from "vitest";
import { createIssueSchema, createRoutineSchema, updateIssueSchema, updateRoutineSchema } from "@paperclipai/shared";

describe("issue priority validation", () => {
  it("normalizes legacy urgent create priorities to critical", () => {
    const parsed = createIssueSchema.parse({
      title: "Investigate cart regression",
      status: "todo",
      priority: "urgent",
    });

    expect(parsed.priority).toBe("critical");
  });

  it("normalizes legacy urgent update priorities to critical", () => {
    const parsed = updateIssueSchema.parse({
      priority: "urgent",
    });

    expect(parsed.priority).toBe("critical");
  });

  it("normalizes legacy urgent routine create priorities to critical", () => {
    const parsed = createRoutineSchema.parse({
      projectId: "4d8e31be-bf02-444e-bb4a-15731a531068",
      title: "Weekly review",
      assigneeAgentId: "4367e843-211a-4863-82de-a7bdb047e087",
      priority: "urgent",
    });

    expect(parsed.priority).toBe("critical");
  });

  it("normalizes legacy urgent routine update priorities to critical", () => {
    const parsed = updateRoutineSchema.parse({
      priority: "urgent",
    });

    expect(parsed.priority).toBe("critical");
  });
});
