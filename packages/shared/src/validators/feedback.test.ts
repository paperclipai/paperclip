import { describe, expect, it } from "vitest";
import { upsertIssueFeedbackVoteSchema } from "./feedback.js";

describe("upsertIssueFeedbackVoteSchema", () => {
  const valid = {
    targetType: "issue_comment" as const,
    targetId: "00000000-0000-0000-0000-000000000001",
    vote: "up" as const,
  };

  it("accepts a minimal vote", () => {
    expect(upsertIssueFeedbackVoteSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts all valid targetType values", () => {
    for (const targetType of ["issue_comment", "issue_document_revision"]) {
      expect(upsertIssueFeedbackVoteSchema.safeParse({ ...valid, targetType }).success).toBe(true);
    }
  });

  it("rejects an invalid targetType", () => {
    expect(
      upsertIssueFeedbackVoteSchema.safeParse({ ...valid, targetType: "issue" }).success,
    ).toBe(false);
  });

  it("accepts vote up and vote down", () => {
    expect(upsertIssueFeedbackVoteSchema.safeParse({ ...valid, vote: "up" }).success).toBe(true);
    expect(upsertIssueFeedbackVoteSchema.safeParse({ ...valid, vote: "down" }).success).toBe(true);
  });

  it("rejects an invalid vote value", () => {
    expect(upsertIssueFeedbackVoteSchema.safeParse({ ...valid, vote: "neutral" }).success).toBe(false);
  });

  it("rejects a non-uuid targetId", () => {
    expect(
      upsertIssueFeedbackVoteSchema.safeParse({ ...valid, targetId: "not-uuid" }).success,
    ).toBe(false);
  });

  it("accepts optional reason", () => {
    const result = upsertIssueFeedbackVoteSchema.safeParse({
      ...valid,
      reason: "Great explanation",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a reason over 1000 characters", () => {
    expect(
      upsertIssueFeedbackVoteSchema.safeParse({ ...valid, reason: "a".repeat(1001) }).success,
    ).toBe(false);
  });

  it("accepts optional allowSharing", () => {
    expect(upsertIssueFeedbackVoteSchema.safeParse({ ...valid, allowSharing: true }).success).toBe(true);
    expect(upsertIssueFeedbackVoteSchema.safeParse({ ...valid, allowSharing: false }).success).toBe(true);
  });
});
