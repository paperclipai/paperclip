export type ApprovalFlowStage = "primary" | "final";

export interface ApprovalFlowContext {
  approvalName?: string | null;
  approvalStage?: ApprovalFlowStage | null;
  requiresSecondReview?: boolean | null;
}

export interface ApprovalFlowConfig {
  primaryReviewerUserId?: string | null;
  secondaryReviewerUserId?: string | null;
}

export interface ResolvedApprovalFlowRoute {
  approvalName: string | null;
  approvalStage: ApprovalFlowStage;
  requiresSecondReview: boolean;
  currentReviewerUserId: string | null;
  nextReviewerUserId: string | null;
}

function trimNullable(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function resolveApprovalFlowRoute(
  context: ApprovalFlowContext,
  config: ApprovalFlowConfig,
): ResolvedApprovalFlowRoute {
  const requiresSecondReview = Boolean(context.requiresSecondReview);
  const approvalStage: ApprovalFlowStage = context.approvalStage
    ?? (requiresSecondReview ? "primary" : "final");
  const currentReviewerUserId = approvalStage === "primary"
    ? trimNullable(config.primaryReviewerUserId)
    : trimNullable(config.secondaryReviewerUserId) ?? trimNullable(config.primaryReviewerUserId);
  const nextReviewerUserId = approvalStage === "primary" && requiresSecondReview
    ? trimNullable(config.secondaryReviewerUserId)
    : null;

  return {
    approvalName: trimNullable(context.approvalName),
    approvalStage,
    requiresSecondReview,
    currentReviewerUserId,
    nextReviewerUserId,
  };
}
