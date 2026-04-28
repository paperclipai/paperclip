import { describe, expect, it } from "vitest";
import { appendRt2DomainEventSchema, rt2DomainEventTypeSchema } from "./index.js";

describe("RT2 domain event contracts", () => {
  it("validates known RT2 domain event types", () => {
    expect(rt2DomainEventTypeSchema.parse("rt2.task.created")).toBe("rt2.task.created");
    expect(rt2DomainEventTypeSchema.parse("rt2.execution.completed")).toBe("rt2.execution.completed");
    expect(() => rt2DomainEventTypeSchema.parse("issue.created")).toThrow();
  });

  it("requires company, actor, entity, and non-empty idempotency keys", () => {
    expect(() =>
      appendRt2DomainEventSchema.parse({
        companyId: "550e8400-e29b-41d4-a716-446655440000",
        eventType: "rt2.task.created",
        actorType: "user",
        actorId: "user-1",
        entityType: "task",
        entityId: "550e8400-e29b-41d4-a716-446655440001",
        idempotencyKey: "",
      }),
    ).toThrow();

    expect(
      appendRt2DomainEventSchema.parse({
        companyId: "550e8400-e29b-41d4-a716-446655440000",
        eventType: "rt2.task.created",
        actorType: "user",
        actorId: "user-1",
        entityType: "task",
        entityId: "550e8400-e29b-41d4-a716-446655440001",
        payload: { projectId: "550e8400-e29b-41d4-a716-446655440002" },
      }),
    ).toEqual(expect.objectContaining({
      eventVersion: 1,
      payload: { projectId: "550e8400-e29b-41d4-a716-446655440002" },
      metadata: {},
    }));
  });
});

