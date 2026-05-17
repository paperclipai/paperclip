import { describe, expect, it } from "vitest";
import {
  createStandupActionSchema,
  disableStandupPolicySchema,
  evaluateStandupSlaSchema,
  inspectStandupSchema,
  manualStandupFireSchema,
  processStandupOutboxSchema,
  replayStandupOutboxJobSchema,
  submitStandupResponseSchema,
  upsertStandupPolicySchema,
} from "./standup.js";

const uuidA = "11111111-1111-4111-8111-111111111111";
const uuidB = "22222222-2222-4222-8222-222222222222";
const uuidC = "33333333-3333-4333-8333-333333333333";

const validResponse = {
  whatHappened: "Generator failed to produce a useful CAR candidate.",
  why: "The current prompt loop is returning generic analysis instead of an actionable experiment.",
  nextAction: "Patch the generator probe and rerun one bounded experiment.",
  owner: "CRO",
  dueTime: "2026-05-16T17:00:00.000Z",
  proofTarget: "Paperclip action issue with probe output attached.",
  blockerOrAuthorityGap: "No live-capital permission is needed for the probe.",
  immediateActionTaken: "Created the action issue and assigned the CRO.",
};

describe("standup validators", () => {
  it("requires service-run provenance for policy writes", () => {
    const parsed = upsertStandupPolicySchema.safeParse({
      policyKey: "car-daily",
      title: "CAR daily standup",
      timezone: "America/Chicago",
      scheduleCron: "30 8 * * *",
      recoveryByLocalTime: "09:00",
      responseDueLocalTime: "10:00",
      escalationDueLocalTime: "10:15",
      participantAgentIds: [uuidA],
      responseSchema: { required: Object.keys(validResponse) },
      nonGreenTriggerRule: { source: "car-loop-recovery" },
      actionRouting: { generator_nonproductive: { ownerAgentId: uuidB } },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => issue.path.join(".") === "serviceRunId")).toBe(true);
  });

  it("accepts the strict participant response contract", () => {
    const parsed = submitStandupResponseSchema.safeParse({
      sessionId: uuidA,
      participantId: uuidB,
      actorRunId: uuidC,
      response: validResponse,
    });

    expect(parsed.success).toBe(true);
  });

  it("preserves policy-defined accountability fields on participant responses", () => {
    const parsed = submitStandupResponseSchema.safeParse({
      sessionId: uuidA,
      participantId: uuidB,
      actorRunId: uuidC,
      response: {
        ...validResponse,
        historicalContext: "Prior heartbeats treated halt compliance as success.",
        decisionPosition: "Disagree with any halt that blocks paper research.",
        dissentOrChallenge: "Real-money movement is the only board boundary.",
        existentialRiskAssessment: "A full-company paper halt puts the company and leadership roles at risk.",
      },
    });

    expect(parsed.success).toBe(true);
    const response = parsed.data?.response as Record<string, unknown>;
    expect(response.historicalContext).toBe("Prior heartbeats treated halt compliance as success.");
    expect(response.decisionPosition).toBe("Disagree with any halt that blocks paper research.");
    expect(response.dissentOrChallenge).toBe("Real-money movement is the only board boundary.");
    expect(response.existentialRiskAssessment).toBe("A full-company paper halt puts the company and leadership roles at risk.");
  });

  it("rejects generic response bodies missing accountability fields", () => {
    const parsed = submitStandupResponseSchema.safeParse({
      sessionId: uuidA,
      participantId: uuidB,
      actorRunId: uuidC,
      response: {
        whatHappened: "Monitoring.",
        why: "None.",
      },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toContain("response.nextAction");
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toContain("response.proofTarget");
  });

  it("keeps inspect read-only lookup grounded in a session or policy date", () => {
    expect(inspectStandupSchema.safeParse({ sessionId: uuidA }).success).toBe(true);
    expect(inspectStandupSchema.safeParse({ companyId: uuidA, policyKey: "car-daily", localDate: "2026-05-16" }).success).toBe(true);
    expect(inspectStandupSchema.safeParse({ policyKey: "car-daily", localDate: "2026-05-16" }).success).toBe(false);
    expect(inspectStandupSchema.safeParse({ policyKey: "car-daily" }).success).toBe(false);
  });

  it("validates manual fire provenance and standup snapshots", () => {
    const parsed = manualStandupFireSchema.safeParse({
      policyKey: "car-daily",
      localDate: "2026-05-16",
      triggerConditionSnapshot: { source: "manual-proof" },
      assessmentSnapshot: { carStatus: "non_green" },
      serviceRunId: uuidA,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.standupType).toBe("daily");
    expect(parsed.data?.triggerConditionSnapshot).toEqual({ source: "manual-proof" });

    expect(manualStandupFireSchema.safeParse({
      policyKey: "car-daily",
      triggerConditionSnapshot: {},
      assessmentSnapshot: {},
    }).success).toBe(false);
  });

  it("requires service-run provenance for SLA evaluation", () => {
    expect(evaluateStandupSlaSchema.safeParse({
      sessionId: uuidA,
      now: "2026-05-16T15:15:00.000Z",
      serviceRunId: uuidB,
    }).success).toBe(true);

    expect(evaluateStandupSlaSchema.safeParse({
      sessionId: uuidA,
      now: "not-a-date",
      serviceRunId: uuidB,
    }).success).toBe(false);
  });

  it("validates action creation contract with owner, timing, and proof target", () => {
    const parsed = createStandupActionSchema.safeParse({
      sessionId: uuidA,
      ownerAgentId: uuidB,
      sourceBlockerKey: "generator_nonproductive",
      canonicalKey: "car-daily:2026-05-16:generator_nonproductive:CRO",
      dueAt: "2026-05-16T17:00:00.000Z",
      proofTarget: "CAR issue shows a completed generator probe.",
      timingState: "due_before_next_standup",
      serviceRunId: uuidC,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.status).toBe("open");
    expect(parsed.data?.actionJson).toEqual({});

    expect(createStandupActionSchema.safeParse({
      sessionId: uuidA,
      ownerAgentId: uuidB,
      sourceBlockerKey: "generator_nonproductive",
      canonicalKey: "car-daily:2026-05-16:generator_nonproductive:CRO",
      dueAt: "2026-05-16T17:00:00.000Z",
      proofTarget: "",
      timingState: "due_before_next_standup",
      serviceRunId: uuidC,
    }).success).toBe(false);
  });

  it("validates outbox replay by job, idempotency key, and service run", () => {
    expect(replayStandupOutboxJobSchema.safeParse({
      jobId: uuidA,
      idempotencyKey: "replay:standup:directive:1",
      jobType: "directive_issue",
      serviceRunId: uuidB,
    }).success).toBe(true);

    expect(replayStandupOutboxJobSchema.safeParse({
      jobId: uuidA,
      idempotencyKey: "",
      serviceRunId: uuidB,
    }).success).toBe(false);
  });

  it("validates outbox processing scope and service run proof", () => {
    const parsed = processStandupOutboxSchema.safeParse({
      companyId: uuidA,
      sessionId: uuidB,
      serviceRunId: uuidC,
      limit: 10,
      now: "2026-05-16T15:30:00.000Z",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.limit).toBe(10);

    expect(processStandupOutboxSchema.safeParse({
      companyId: uuidA,
      serviceRunId: uuidC,
      limit: 0,
    }).success).toBe(false);
  });

  it("validates policy disable requests with explicit drain behavior", () => {
    const parsed = disableStandupPolicySchema.safeParse({
      policyKey: "car-daily",
      reason: "Standup proof run complete; disabling test policy.",
      serviceRunId: uuidA,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.standupType).toBe("daily");
    expect(parsed.data?.drainMode).toBe("drain");

    expect(disableStandupPolicySchema.safeParse({
      policyKey: "car-daily",
      reason: "x",
      drainMode: "delete_everything",
      serviceRunId: uuidA,
    }).success).toBe(false);
  });
});
