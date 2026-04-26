import { describe, expect, it } from "vitest";
import {
  createRoutineSchema,
  createRoutineTriggerSchema,
  routineVariableSchema,
  runRoutineSchema,
  updateRoutineSchema,
  updateRoutineTriggerSchema,
} from "./routine.js";

describe("routineVariableSchema", () => {
  const validTextVar = { name: "myVar", type: "text" as const };
  const validSelectVar = { name: "env", type: "select" as const, options: ["dev", "prod"] };

  it("accepts a minimal text variable", () => {
    expect(routineVariableSchema.safeParse(validTextVar).success).toBe(true);
  });

  it("accepts a full text variable with defaults", () => {
    const result = routineVariableSchema.safeParse({
      name: "count",
      label: "Count",
      type: "text",
      defaultValue: "42",
      required: false,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid select variable with options", () => {
    expect(routineVariableSchema.safeParse(validSelectVar).success).toBe(true);
  });

  it("rejects a select variable with no options", () => {
    const result = routineVariableSchema.safeParse({ name: "env", type: "select", options: [] });
    expect(result.success).toBe(false);
  });

  it("rejects a non-select variable that defines options", () => {
    const result = routineVariableSchema.safeParse({
      name: "count",
      type: "text",
      options: ["a", "b"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a select variable with a default that is not in options", () => {
    const result = routineVariableSchema.safeParse({
      name: "env",
      type: "select",
      options: ["dev", "prod"],
      defaultValue: "staging",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a select variable with a valid default", () => {
    const result = routineVariableSchema.safeParse({
      name: "env",
      type: "select",
      options: ["dev", "prod"],
      defaultValue: "dev",
    });
    expect(result.success).toBe(true);
  });

  it("rejects names that do not start with a letter", () => {
    expect(routineVariableSchema.safeParse({ name: "123bad", type: "text" }).success).toBe(false);
    expect(routineVariableSchema.safeParse({ name: "_bad", type: "text" }).success).toBe(false);
  });

  it("accepts names with alphanumeric characters and underscores", () => {
    expect(routineVariableSchema.safeParse({ name: "myVar_2", type: "text" }).success).toBe(true);
  });
});

describe("createRoutineSchema", () => {
  const minimal = { title: "My Routine" };

  it("accepts a minimal routine (title only)", () => {
    expect(createRoutineSchema.safeParse(minimal).success).toBe(true);
  });

  it("rejects an empty title", () => {
    expect(createRoutineSchema.safeParse({ title: "" }).success).toBe(false);
  });

  it("rejects a title over 200 chars", () => {
    expect(
      createRoutineSchema.safeParse({ title: "a".repeat(201) }).success,
    ).toBe(false);
  });

  it("accepts valid priority values", () => {
    for (const priority of ["low", "medium", "high", "critical"]) {
      expect(
        createRoutineSchema.safeParse({ title: "T", priority }).success,
      ).toBe(true);
    }
  });

  it("rejects an invalid priority", () => {
    expect(createRoutineSchema.safeParse({ title: "T", priority: "urgent" }).success).toBe(false);
  });

  it("defaults priority to medium", () => {
    const result = createRoutineSchema.safeParse(minimal);
    expect(result.success && result.data.priority).toBe("medium");
  });

  it("defaults concurrencyPolicy to coalesce_if_active", () => {
    const result = createRoutineSchema.safeParse(minimal);
    expect(result.success && result.data.concurrencyPolicy).toBe("coalesce_if_active");
  });

  it("accepts valid concurrencyPolicy values", () => {
    for (const policy of ["coalesce_if_active", "always_enqueue", "skip_if_active"]) {
      expect(
        createRoutineSchema.safeParse({ title: "T", concurrencyPolicy: policy }).success,
      ).toBe(true);
    }
  });
});

describe("updateRoutineSchema", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(updateRoutineSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a partial update", () => {
    expect(updateRoutineSchema.safeParse({ title: "New Title", priority: "high" }).success).toBe(true);
  });
});

describe("createRoutineTriggerSchema", () => {
  it("accepts a valid schedule trigger", () => {
    const result = createRoutineTriggerSchema.safeParse({
      kind: "schedule",
      cronExpression: "0 * * * *",
      timezone: "UTC",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a schedule trigger with missing cronExpression", () => {
    const result = createRoutineTriggerSchema.safeParse({
      kind: "schedule",
      timezone: "UTC",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid webhook trigger", () => {
    const result = createRoutineTriggerSchema.safeParse({
      kind: "webhook",
      signingMode: "bearer",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a webhook trigger with invalid signingMode", () => {
    const result = createRoutineTriggerSchema.safeParse({
      kind: "webhook",
      signingMode: "invalid",
    });
    expect(result.success).toBe(false);
  });

  it("defaults webhook replayWindowSec to 300", () => {
    const result = createRoutineTriggerSchema.safeParse({ kind: "webhook" });
    expect(result.success && (result.data as any).replayWindowSec).toBe(300);
  });

  it("accepts an api trigger with no extra fields", () => {
    expect(createRoutineTriggerSchema.safeParse({ kind: "api" }).success).toBe(true);
  });

  it("rejects an unknown trigger kind", () => {
    expect(createRoutineTriggerSchema.safeParse({ kind: "cron" }).success).toBe(false);
  });
});

describe("updateRoutineTriggerSchema", () => {
  it("accepts an empty object", () => {
    expect(updateRoutineTriggerSchema.safeParse({}).success).toBe(true);
  });

  it("rejects an out-of-range replayWindowSec", () => {
    expect(updateRoutineTriggerSchema.safeParse({ replayWindowSec: 10 }).success).toBe(false);
    expect(updateRoutineTriggerSchema.safeParse({ replayWindowSec: 100_000 }).success).toBe(false);
  });
});

describe("runRoutineSchema", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(runRoutineSchema.safeParse({}).success).toBe(true);
  });

  it("defaults source to manual", () => {
    const result = runRoutineSchema.safeParse({});
    expect(result.success && result.data.source).toBe("manual");
  });

  it("accepts source api", () => {
    expect(runRoutineSchema.safeParse({ source: "api" }).success).toBe(true);
  });

  it("rejects an invalid source", () => {
    expect(runRoutineSchema.safeParse({ source: "webhook" }).success).toBe(false);
  });

  it("accepts triggerId as uuid", () => {
    const result = runRoutineSchema.safeParse({
      triggerId: "00000000-0000-0000-0000-000000000001",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-uuid triggerId", () => {
    expect(runRoutineSchema.safeParse({ triggerId: "not-a-uuid" }).success).toBe(false);
  });
});
