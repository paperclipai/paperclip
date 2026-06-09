import { describe, expect, it } from "vitest";
import {
  routineRevisionSnapshotV1Schema,
  updateRoutineSchema,
} from "./routine.js";

const routineId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const triggerId = "33333333-3333-4333-8333-333333333333";
const baseRevisionId = "44444444-4444-4444-8444-444444444444";

describe("routine validators", () => {
  it("accepts versioned routine revision snapshots with safe trigger metadata", () => {
    const parsed = routineRevisionSnapshotV1Schema.parse({
      version: 1,
      routine: {
        id: routineId,
        companyId,
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "Daily triage",
        description: null,
        assigneeAgentId: null,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
      },
      triggers: [{
        id: triggerId,
        kind: "webhook",
        label: "Inbound",
        enabled: true,
        cronExpression: null,
        timezone: null,
        publicId: "routine_webhook_123",
        signingMode: "bearer",
        replayWindowSec: 300,
      }],
    });

    expect(parsed.triggers[0]?.publicId).toBe("routine_webhook_123");
  });

  it("rejects secret-bearing trigger fields in routine revision snapshots", () => {
    expect(() => routineRevisionSnapshotV1Schema.parse({
      version: 1,
      routine: {
        id: routineId,
        companyId,
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "Daily triage",
        description: null,
        assigneeAgentId: null,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
      },
      triggers: [{
        id: triggerId,
        kind: "webhook",
        label: "Inbound",
        enabled: true,
        cronExpression: null,
        timezone: null,
        publicId: "routine_webhook_123",
        signingMode: "bearer",
        replayWindowSec: 300,
        secretId: "55555555-5555-4555-8555-555555555555",
      }],
    })).toThrow();
  });

  it("accepts optional base revision ids on routine updates", () => {
    expect(updateRoutineSchema.parse({
      title: "Daily triage",
      baseRevisionId,
    }).baseRevisionId).toBe(baseRevisionId);
  });
});
