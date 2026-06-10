import type { Db } from "@paperclipai/db";
import type { GateResult, MergeGateResult } from "@paperclipai/shared";
import { issueApprovalService } from "./issue-approvals.js";
import { workProductService } from "./work-products.js";

export function mergerGateService(db: Db) {
  const issueApprovalsSvc = issueApprovalService(db);
  const workProductsSvc = workProductService(db);

  async function evaluateIssueApprovalGate(workProductId: string): Promise<GateResult> {
    const workProduct = await workProductsSvc.getById(workProductId);
    if (!workProduct) {
      return {
        gateId: "issue_approval",
        passed: false,
        reason: "Work product not found",
      };
    }

    if (workProduct.type !== "pull_request") {
      return {
        gateId: "issue_approval",
        passed: false,
        reason: "Work product is not a pull request",
      };
    }

    const issueId = workProduct.issueId;
    if (!issueId) {
      return {
        gateId: "issue_approval",
        passed: false,
        reason: "Work product has no linked issue",
      };
    }

    const approvals = await issueApprovalsSvc.listApprovalsForIssue(issueId);
    if (approvals.length === 0) {
      return {
        gateId: "issue_approval",
        passed: false,
        reason: "No approvals linked to the issue",
      };
    }

    const hasApprovedApproval = approvals.some((approval) => approval.status === "approved");
    if (!hasApprovedApproval) {
      return {
        gateId: "issue_approval",
        passed: false,
        reason: "No approved approval found for the issue",
      };
    }

    return {
      gateId: "issue_approval",
      passed: true,
      reason: "Issue has at least one approved approval",
    };
  }

  return {
    evaluateGates: async (workProductId: string, gateIds?: string[]): Promise<MergeGateResult> => {
      const gatesToEvaluate = gateIds ?? ["issue_approval"];
      const gates: GateResult[] = [];

      for (const gateId of gatesToEvaluate) {
        switch (gateId) {
          case "issue_approval":
            gates.push(await evaluateIssueApprovalGate(workProductId));
            break;
          default:
            gates.push({
              gateId,
              passed: false,
              reason: `Unknown gate: ${gateId}`,
            });
        }
      }

      const canMerge = gates.every((gate) => gate.passed);

      return {
        canMerge,
        gates,
      };
    },
  };
}
