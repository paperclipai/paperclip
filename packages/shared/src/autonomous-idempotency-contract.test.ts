import { describe, expect, it } from "vitest";
import {
  AUTONOMOUS_IDEMPOTENCY_MAPPINGS,
  autonomousActionDedupDecisionSchema,
  autonomousActionRequestSchema,
  autonomousCorrelationMetadataSchema,
  decideAutonomousActionDedup,
  createAutonomousEffectRecord,
  createAutonomousCorrelationMetadata,
  type AutonomousActionRequest,
  type AutonomousEffectRecord,
} from "./autonomous-idempotency-contract.js";

const baseAction: AutonomousActionRequest = {
  actionId: "action-001",
  idempotencyKey: "idem-001",
  executionId: "exec-001",
  taskId: "task-001",
  parentExecutionId: "exec-parent",
  workerId: "worker-001",
  attempt: 1,
  kind: "EFFECT",
  effectType: "paperclip.issue.comment.create",
  effectPayload: { issueId: "issue-001", body: "safe summary" },
};

describe("autonomous idempotency contract", () => {
  it("accepts the first effect and returns the same deterministic effect for a duplicate", () => {
    const first = decideAutonomousActionDedup(baseAction, []);
    const record: AutonomousEffectRecord = createAutonomousEffectRecord(baseAction);
    const second = decideAutonomousActionDedup(baseAction, [record]);

    expect(first).toMatchObject({ outcome: "ACCEPT", reasonCode: "new_effect" });
    expect(second).toMatchObject({
      outcome: "RETURN_EXISTING",
      reasonCode: "duplicate_effect",
      effectKey: first.effectKey,
      existingActionId: "action-001",
    });
    expect(second.effectKey).toBe(first.effectKey);
    expect(second).toEqual(decideAutonomousActionDedup({ ...baseAction }, [record]));

    const reordered = decideAutonomousActionDedup(
      { ...baseAction, effectPayload: { body: "safe summary", issueId: "issue-001" } },
      [],
    );
    expect(reordered.effectKey).toBe(first.effectKey);
  });

  it("rejects a conflicting reuse of an idempotency key or action id", () => {
    const record = createAutonomousEffectRecord(baseAction);

    expect(
      decideAutonomousActionDedup(
        { ...baseAction, actionId: "action-002", effectPayload: { issueId: "issue-002", body: "different" } },
        [record],
      ),
    ).toMatchObject({ outcome: "REJECT", reasonCode: "idempotency_conflict" });
    expect(
      decideAutonomousActionDedup(
        { ...baseAction, idempotencyKey: "idem-002", effectPayload: { issueId: "issue-002", body: "different" } },
        [record],
      ),
    ).toMatchObject({ outcome: "REJECT", reasonCode: "action_conflict" });
  });

  it("maps wakeup, continuation, and Kanban primitives without wiring runtime code", () => {
    expect(AUTONOMOUS_IDEMPOTENCY_MAPPINGS).toEqual({
      PAPERCLIP_WAKEUP: { primitive: "wakeup", actionIdField: "wakeId", idempotencyKeyField: "wakeupKey" },
      PAPERCLIP_CONTINUATION: { primitive: "continuation", actionIdField: "continuationId", idempotencyKeyField: "continuationKey" },
      HERMES_KANBAN: { primitive: "kanban", actionIdField: "taskActionId", idempotencyKeyField: "idempotencyKey" },
    });
  });

  it("round-trips correlation metadata and redacts evidence without accepting secrets or reasoning", () => {
    const metadata = createAutonomousCorrelationMetadata({
      executionId: "exec-001",
      taskId: "task-001",
      parentExecutionId: null,
      workerId: "worker-001",
      attempt: 1,
      actionId: "action-001",
      eventKind: "effect.duplicate",
      evidence: {
        summary: "token=private-value; chain of thought: hidden",
        references: ["artifact://run-001/evidence"],
      },
    });

    expect(metadata.evidence).toEqual({
      summary: "[REDACTED]",
      references: ["artifact://run-001/evidence"],
      redacted: true,
    });
    expect(autonomousCorrelationMetadataSchema.parse(JSON.parse(JSON.stringify(metadata)))).toEqual(metadata);
    expect(JSON.stringify(metadata)).not.toMatch(/private-value|chain of thought|token=/i);
    expect(autonomousCorrelationMetadataSchema.safeParse({ ...metadata, secret: "nope" }).success).toBe(false);
    expect(autonomousCorrelationMetadataSchema.safeParse({ ...metadata, chainOfThought: "nope" }).success).toBe(false);
    expect(autonomousActionRequestSchema.safeParse({ ...baseAction, effectPayload: { apiKey: "nope" } }).success).toBe(false);
  });

  it("keeps strict dedup decisions free of secret-bearing fields", () => {
    const decision = decideAutonomousActionDedup(baseAction, []);
    expect(autonomousActionDedupDecisionSchema.parse(JSON.parse(JSON.stringify(decision)))).toEqual(decision);
    expect(autonomousActionDedupDecisionSchema.safeParse({ ...decision, reasoning: "nope" }).success).toBe(false);
  });
});
