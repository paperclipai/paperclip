import { describe, expect, it } from "vitest";
import {
  adapterReadinessProbeRequestSchema,
  adapterReadinessProbeSchema,
  adapterReadinessReasonCodeSchema,
  adapterReadinessStatusSchema,
  createWeeklyReviewRecommendationActionSchema,
  generateWeeklyReviewSchema,
  localAdapterAssuranceTypeSchema,
  modelAssuranceModelSourceSchema,
  modelAssurancePolicyStatusSchema,
  modelAssuranceReasonCodeSchema,
  modelAssuranceRoleFitSchema,
  weeklyReviewEventStatusSchema,
  weeklyReviewEventTypeSchema,
  weeklyReviewFindingCategorySchema,
  weeklyReviewFindingSeveritySchema,
  weeklyReviewFindingStatusSchema,
  weeklyReviewRecommendationStateSchema,
  weeklyReviewActionKindSchema,
  weeklyReviewActionStatusSchema,
  weeklyReviewStatusSchema,
  weeklyReviewVersionStatusSchema,
} from "../index.js";

describe("weekly review shared validators", () => {
  it("accepts the weekly review lifecycle enum values", () => {
    expect(weeklyReviewStatusSchema.parse("ready")).toBe("ready");
    expect(weeklyReviewVersionStatusSchema.parse("validation_failed")).toBe("validation_failed");
    expect(weeklyReviewFindingCategorySchema.parse("evidence_gap")).toBe("evidence_gap");
    expect(weeklyReviewFindingSeveritySchema.parse("critical")).toBe("critical");
    expect(weeklyReviewFindingStatusSchema.parse("acknowledged")).toBe("acknowledged");
    expect(weeklyReviewRecommendationStateSchema.parse("completed")).toBe("completed");
    expect(weeklyReviewActionKindSchema.parse("create_followup_issue")).toBe("create_followup_issue");
    expect(weeklyReviewActionStatusSchema.parse("failed")).toBe("failed");
    expect(weeklyReviewEventTypeSchema.parse("adapter_readiness_attached")).toBe("adapter_readiness_attached");
    expect(weeklyReviewEventStatusSchema.parse("skipped")).toBe("skipped");
  });

  it("rejects invalid weekly review enum values", () => {
    expect(weeklyReviewStatusSchema.safeParse("active").success).toBe(false);
    expect(weeklyReviewVersionStatusSchema.safeParse("complete").success).toBe(false);
    expect(weeklyReviewFindingCategorySchema.safeParse("accepted_findings").success).toBe(false);
    expect(weeklyReviewFindingSeveritySchema.safeParse("urgent").success).toBe(false);
    expect(weeklyReviewFindingStatusSchema.safeParse("accepted").success).toBe(false);
    expect(weeklyReviewRecommendationStateSchema.safeParse("actioned").success).toBe(false);
    expect(weeklyReviewActionKindSchema.safeParse("delete_adapter_config").success).toBe(false);
    expect(weeklyReviewActionStatusSchema.safeParse("open").success).toBe(false);
    expect(weeklyReviewEventTypeSchema.safeParse("ready").success).toBe(false);
    expect(weeklyReviewEventStatusSchema.safeParse("pending").success).toBe(false);
  });

  it("validates manual review generation inputs", () => {
    const parsed = generateWeeklyReviewSchema.parse({
      periodStart: "2026-05-04T00:00:00.000Z",
      periodEnd: "2026-05-11T00:00:00.000Z",
      previousVersionId: "11111111-1111-4111-8111-111111111111",
    });

    expect(parsed.periodStart).toBe("2026-05-04T00:00:00.000Z");
  });

  it("rejects invalid manual review generation inputs", () => {
    expect(
      generateWeeklyReviewSchema.safeParse({
        periodStart: "2026-05-04",
        periodEnd: "2026-05-11T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      generateWeeklyReviewSchema.safeParse({
        periodStart: "2026-05-04T00:00:00.000Z",
        periodEnd: "2026-05-11T00:00:00.000Z",
        previousVersionId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  it("validates weekly review recommendation governance actions", () => {
    expect(createWeeklyReviewRecommendationActionSchema.parse({
      actionKind: "create_followup_issue",
      title: "Assign support handoff owner",
      priority: "high",
    })).toMatchObject({
      actionKind: "create_followup_issue",
      title: "Assign support handoff owner",
      priority: "high",
    });

    expect(createWeeklyReviewRecommendationActionSchema.safeParse({
      actionKind: "create_followup_issue",
    }).success).toBe(false);
  });

  it("requires explicit target and assignee information for assign issue actions", () => {
    expect(createWeeklyReviewRecommendationActionSchema.safeParse({
      actionKind: "assign_issue",
      targetEntityType: "issue",
      targetEntityId: "issue-1",
      request: {},
    }).success).toBe(false);

    expect(createWeeklyReviewRecommendationActionSchema.safeParse({
      actionKind: "assign_issue",
      targetEntityType: "issue",
      targetEntityId: "issue-1",
      request: { assigneeAgentId: "agent-1" },
    }).success).toBe(true);
  });

  it("requires explicit governed targets for approval actions", () => {
    expect(createWeeklyReviewRecommendationActionSchema.safeParse({
      actionKind: "approve_governed_item",
    }).success).toBe(false);

    expect(createWeeklyReviewRecommendationActionSchema.safeParse({
      actionKind: "reject_governed_item",
      targetEntityType: "approval",
      targetEntityId: "approval-1",
      note: "Reject pending spend increase.",
    }).success).toBe(true);
  });

  it("accepts adapter readiness probe requests for canonical local assurance adapters", () => {
    expect(localAdapterAssuranceTypeSchema.parse("codex_local")).toBe("codex_local");
    expect(localAdapterAssuranceTypeSchema.parse("agy_local")).toBe("agy_local");
    expect(adapterReadinessStatusSchema.parse("blocked")).toBe("blocked");
    expect(adapterReadinessReasonCodeSchema.parse("quota_unknown")).toBe("quota_unknown");
    expect(adapterReadinessProbeRequestSchema.parse({ adapterType: "agy_local", strictMode: true })).toEqual({
      adapterType: "agy_local",
      strictMode: true,
    });
    expect(localAdapterAssuranceTypeSchema.safeParse("gemini_local").success).toBe(false);
    expect(adapterReadinessProbeRequestSchema.safeParse({ adapterType: "gemini_local" }).success).toBe(false);
  });

  it("validates full adapter readiness probe read models", () => {
    const probe = {
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      agentId: "33333333-3333-4333-8333-333333333333",
      adapterType: "agy_local",
      status: "warning",
      basicReady: true,
      operationalReady: false,
      fixtureReady: true,
      reasonCodes: ["quota_unknown"],
      cliVersion: "agy 1.0.0",
      authMode: "oauth",
      model: "gemini-3.5-flash",
      modelProfile: "cheap",
      workspaceStatus: "valid",
      quotaWindows: { day: { remaining: "unknown" } },
      helloRunStatus: "skipped",
      helloRunMetadata: { reason: "fixture" },
      heartbeatRunId: null,
      fallbackRecommendation: {
        adapterType: "claude_local",
        label: "Claude local",
        reason: "Use Claude for synthesis while AGY quota is unknown.",
        requiresApproval: true,
      },
      strictMode: false,
      checkedByUserId: null,
      checkedAt: "2026-05-21T00:00:00.000Z",
      createdAt: "2026-05-21T00:00:00.000Z",
    };

    expect(adapterReadinessProbeSchema.parse(probe).adapterType).toBe("agy_local");
    expect(adapterReadinessProbeSchema.safeParse({ ...probe, id: "not-a-uuid" }).success).toBe(false);
    expect(adapterReadinessProbeSchema.safeParse({ ...probe, checkedAt: "2026-05-21" }).success).toBe(false);
    expect(adapterReadinessProbeSchema.safeParse({ ...probe, adapterType: "gemini_local" }).success).toBe(false);
  });

  it("accepts model assurance enum values", () => {
    expect(modelAssuranceModelSourceSchema.parse("provider_default")).toBe("provider_default");
    expect(modelAssurancePolicyStatusSchema.parse("approved_fallback")).toBe("approved_fallback");
    expect(modelAssuranceRoleFitSchema.parse("weak")).toBe("weak");
    expect(modelAssuranceReasonCodeSchema.parse("manual_model_unverified")).toBe("manual_model_unverified");
  });
});
