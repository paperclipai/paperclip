import type {
  ExecutionWorkspaceCloseGitReadiness,
  ExecutionWorkspaceDeliveryState,
} from "@paperclipai/shared";

export const CODE_WORK_PRODUCT_TYPES = new Set(["pull_request", "branch", "commit"]);

export type IssueDoneDeliveryReasonCode =
  | "missing_primary_code_work_product"
  | "primary_work_product_not_merged"
  | "primary_work_product_review_not_approved"
  | "independent_review_not_configured"
  | "independent_review_not_pending"
  | "primary_work_product_unhealthy"
  | "combined_regression_checks_missing"
  | "combined_regression_checks_failed"
  | "delivery_not_reconciled"
  | "delivery_evidence_stale"
  | "delivered_commit_not_on_target"
  | "workspace_git_state_unverified"
  | "workspace_dirty";

export interface IssueDoneDeliveryReadiness {
  required: boolean;
  ready: boolean;
  disposition: "code" | "no_merge" | "not_applicable";
  reasonCodes: IssueDoneDeliveryReasonCode[];
}

type DeliveryEvidence = {
  reconciledAt?: unknown;
  commitOnTarget?: unknown;
  combinedRegressionChecks?: unknown;
};

type DeliveryWorkProduct = {
  type: string;
  status: string;
  reviewState: string;
  healthStatus: string;
  metadata: Record<string, unknown> | null;
  updatedAt?: Date | string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function deliveryEvidence(product: Pick<DeliveryWorkProduct, "metadata"> | null): DeliveryEvidence {
  const metadata = record(product?.metadata);
  return record(metadata?.deliveryEvidence) ?? {};
}

export function hasExplicitNoMergeDisposition(
  product: Pick<DeliveryWorkProduct, "metadata"> | null,
): boolean {
  const disposition = record(record(product?.metadata)?.deliveryDisposition);
  return disposition?.kind === "no_merge"
    && typeof disposition.reason === "string"
    && disposition.reason.trim().length > 0;
}

function combinedRegressionState(evidence: DeliveryEvidence): "missing" | "failed" | "passed" {
  if (!Array.isArray(evidence.combinedRegressionChecks) || evidence.combinedRegressionChecks.length === 0) {
    return "missing";
  }
  return evidence.combinedRegressionChecks.every((entry) => {
    const status = record(entry)?.status;
    return status === "passed" || status === "success";
  }) ? "passed" : "failed";
}

export function evaluateIssueDoneDeliveryReadiness(input: {
  primaryWorkProduct: DeliveryWorkProduct | null;
  hasIsolatedGitWorkspace: boolean;
  workspaceDeliveryState?: ExecutionWorkspaceDeliveryState | null;
  workspaceGit?: ExecutionWorkspaceCloseGitReadiness | null;
  workspaceGitInspectionSucceeded?: boolean;
  issueStatus?: string;
  reviewPolicy?: string | null;
  enforceTransitionStatus?: boolean;
}): IssueDoneDeliveryReadiness {
  const primaryIsCode = Boolean(
    input.primaryWorkProduct && CODE_WORK_PRODUCT_TYPES.has(input.primaryWorkProduct.type),
  );
  if (!primaryIsCode && hasExplicitNoMergeDisposition(input.primaryWorkProduct)) {
    return {
      required: false,
      ready: true,
      disposition: "no_merge",
      reasonCodes: [],
    };
  }
  const required = primaryIsCode || input.hasIsolatedGitWorkspace;

  if (!required) {
    return {
      required: false,
      ready: true,
      disposition: hasExplicitNoMergeDisposition(input.primaryWorkProduct)
        ? "no_merge"
        : "not_applicable",
      reasonCodes: [],
    };
  }

  const reasons: IssueDoneDeliveryReasonCode[] = [];
  if (input.reviewPolicy !== "not_creator" && input.reviewPolicy !== "human_only") {
    reasons.push("independent_review_not_configured");
  }
  if (input.enforceTransitionStatus !== false && input.issueStatus !== "in_review") {
    reasons.push("independent_review_not_pending");
  }
  const product = primaryIsCode ? input.primaryWorkProduct : null;
  if (!product) {
    reasons.push("missing_primary_code_work_product");
  } else {
    if (product.status !== "merged") reasons.push("primary_work_product_not_merged");
    if (product.reviewState !== "approved") reasons.push("primary_work_product_review_not_approved");
    if (product.healthStatus !== "healthy") reasons.push("primary_work_product_unhealthy");

    const evidence = deliveryEvidence(product);
    const regressionState = combinedRegressionState(evidence);
    if (regressionState === "missing") reasons.push("combined_regression_checks_missing");
    if (regressionState === "failed") reasons.push("combined_regression_checks_failed");
    const reconciledAt = typeof evidence.reconciledAt === "string" ? Date.parse(evidence.reconciledAt) : Number.NaN;
    if (!Number.isFinite(reconciledAt)) {
      reasons.push("delivery_not_reconciled");
    } else if (product.updatedAt && reconciledAt < new Date(product.updatedAt).getTime()) {
      reasons.push("delivery_evidence_stale");
    }
    if (!input.hasIsolatedGitWorkspace && evidence.commitOnTarget !== true) {
      reasons.push("delivered_commit_not_on_target");
    }
  }

  if (input.hasIsolatedGitWorkspace) {
    if (input.workspaceGitInspectionSucceeded !== true || !input.workspaceGit) {
      reasons.push("workspace_git_state_unverified");
    } else if (input.workspaceGit.hasDirtyTrackedFiles || input.workspaceGit.hasUntrackedFiles) {
      reasons.push("workspace_dirty");
    }
    if (
      input.workspaceDeliveryState !== "merged_via_pr"
      && input.workspaceDeliveryState !== "merged_by_ancestry"
      && input.workspaceDeliveryState !== "merged_by_patch_equivalence"
    ) {
      reasons.push("delivered_commit_not_on_target");
    }
  }

  return {
    required: true,
    ready: reasons.length === 0,
    disposition: "code",
    reasonCodes: [...new Set(reasons)],
  };
}
