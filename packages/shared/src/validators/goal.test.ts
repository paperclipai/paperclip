import { describe, expect, it } from "vitest";
import { createGoalSchema, updateGoalSchema } from "./goal.js";

describe("createGoalSchema", () => {
  it("accepts a minimal goal", () => {
    expect(createGoalSchema.safeParse({ title: "My Goal" }).success).toBe(true);
  });

  it("rejects an empty title", () => {
    expect(createGoalSchema.safeParse({ title: "" }).success).toBe(false);
  });

  it("defaults level to task", () => {
    const result = createGoalSchema.safeParse({ title: "Goal" });
    expect(result.success && result.data.level).toBe("task");
  });

  it("defaults status to planned", () => {
    const result = createGoalSchema.safeParse({ title: "Goal" });
    expect(result.success && result.data.status).toBe("planned");
  });

  it("accepts valid level values", () => {
    for (const level of ["company", "team", "agent", "task"]) {
      expect(createGoalSchema.safeParse({ title: "G", level }).success).toBe(true);
    }
  });

  it("rejects an invalid level", () => {
    expect(createGoalSchema.safeParse({ title: "G", level: "department" }).success).toBe(false);
  });

  it("accepts valid status values", () => {
    for (const status of ["planned", "active", "achieved", "cancelled"]) {
      expect(createGoalSchema.safeParse({ title: "G", status }).success).toBe(true);
    }
  });

  it("accepts optional parentId and ownerAgentId as UUIDs", () => {
    const result = createGoalSchema.safeParse({
      title: "G",
      parentId: "00000000-0000-0000-0000-000000000001",
      ownerAgentId: "00000000-0000-0000-0000-000000000002",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid UUID for parentId", () => {
    expect(createGoalSchema.safeParse({ title: "G", parentId: "not-uuid" }).success).toBe(false);
  });
});

describe("updateGoalSchema", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(updateGoalSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a partial update", () => {
    expect(updateGoalSchema.safeParse({ title: "New Title", status: "active" }).success).toBe(true);
  });

  it("rejects an invalid status in a partial update", () => {
    expect(updateGoalSchema.safeParse({ status: "done" }).success).toBe(false);
  });
});
