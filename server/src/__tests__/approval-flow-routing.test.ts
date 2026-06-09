import { describe, expect, it } from "vitest";
import { resolveApprovalFlowRoute } from "../services/approval-flow-routing.js";

describe("resolveApprovalFlowRoute", () => {
  it("routes configured two-step approvals through the primary reviewer first", () => {
    const route = resolveApprovalFlowRoute(
      {
        approvalName: "Policy approval",
        requiresSecondReview: true,
      },
      {
        primaryReviewerUserId: "primary-user-id",
        secondaryReviewerUserId: "secondary-user-id",
      },
    );

    expect(route).toEqual({
      approvalName: "Policy approval",
      approvalStage: "primary",
      requiresSecondReview: true,
      currentReviewerUserId: "primary-user-id",
      nextReviewerUserId: "secondary-user-id",
    });
  });

  it("routes single-step approvals directly to the secondary reviewer", () => {
    const route = resolveApprovalFlowRoute(
      {
        approvalName: "General approval",
        requiresSecondReview: false,
      },
      {
        primaryReviewerUserId: "primary-user-id",
        secondaryReviewerUserId: "secondary-user-id",
      },
    );

    expect(route).toEqual({
      approvalName: "General approval",
      approvalStage: "final",
      requiresSecondReview: false,
      currentReviewerUserId: "secondary-user-id",
      nextReviewerUserId: null,
    });
  });

  it("falls back to the primary reviewer when a single-step approval has no secondary reviewer", () => {
    const route = resolveApprovalFlowRoute(
      {
        approvalName: "General approval",
        requiresSecondReview: false,
      },
      {
        primaryReviewerUserId: "primary-user-id",
        secondaryReviewerUserId: null,
      },
    );

    expect(route).toEqual({
      approvalName: "General approval",
      approvalStage: "final",
      requiresSecondReview: false,
      currentReviewerUserId: "primary-user-id",
      nextReviewerUserId: null,
    });
  });
});
