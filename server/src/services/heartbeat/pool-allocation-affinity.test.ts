import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { getNativeReviewAssignment } from "../native-runtime/native-review-participant.js";
import { hasReviewPoolAllocation } from "./pool-allocation-affinity.js";
vi.mock("../native-runtime/native-review-participant.js", async importOriginal => ({
  ...await importOriginal<typeof import("../native-runtime/native-review-participant.js")>(), getNativeReviewAssignment: vi.fn(),
}));
const interactionId = "11111111-1111-4111-8111-111111111111", decisionId = "22222222-2222-4222-8222-222222222222";
const run = { id: "failed-review", companyId: "company", agentId: "reviewer", status: "failed", runtimeMode: "native",
  scopeKind: "issue", issueId: "issue", nativeIssueId: "issue", contextSnapshot: {
    nativeReviewInteractionId: interactionId, nativeReviewDecisionId: decisionId,
  } } as const;
const db = {} as Db, key = `native-review:${interactionId}`;
describe("review pool attribution affinity", () => {
  beforeEach(() => vi.mocked(getNativeReviewAssignment).mockReset());
  it("uses authoritative review assignment for a failed review's own allocation", async () => {
    vi.mocked(getNativeReviewAssignment).mockResolvedValue({} as never);
    expect(await hasReviewPoolAllocation(db, run, key)).toBe(true);
    expect(getNativeReviewAssignment).toHaveBeenCalledWith(db, { companyId: run.companyId, issueId: run.issueId,
      agentId: run.agentId, contextSnapshot: run.contextSnapshot, allowResolvedByRunId: run.id });
  });
  it("rejects an absent, foreign or stale assignment", async () => {
    vi.mocked(getNativeReviewAssignment).mockResolvedValue(null);
    expect(await hasReviewPoolAllocation(db, run, key)).toBe(false);
  });
  it.each([{ runtimeMode: "legacy" }, { nativeIssueId: "foreign" }, { scopeKind: "company" }, { contextSnapshot: {} }])(
    "rejects mismatched source bindings %j", async override => {
      vi.mocked(getNativeReviewAssignment).mockResolvedValue({} as never);
      expect(await hasReviewPoolAllocation(db, { ...run, ...override } as typeof run, key)).toBe(false);
      expect(getNativeReviewAssignment).not.toHaveBeenCalled();
    });
  it("does not accept another review's allocation key", async () => {
    vi.mocked(getNativeReviewAssignment).mockResolvedValue({} as never);
    expect(await hasReviewPoolAllocation(db, run, `native-review:${decisionId}`)).toBe(false);
    expect(getNativeReviewAssignment).not.toHaveBeenCalled();
  });
});
