import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { issueApprovalService, issueService } from "../services/index.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { parseClassificationBlock, detectInconsistencies } from "../lib/authority-classification.js";

export function authorityClassificationRoutes(db: Db) {
  const router = Router();
  const svc = issueService(db);
  const issueApprovalsSvc = issueApprovalService(db);

  /** GET /api/issues/:id/authority-classification
   * Parses and returns the Authority Classification block from the issue description.
   * Surfaces inconsistencies (e.g. T3 triggers active but tier < T3, missing Approval ID).
   */
  router.get("/issues/:id/authority-classification", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const parseResult = parseClassificationBlock(issue.description ?? "");

    if (!parseResult.found) {
      res.json({
        issueId: issue.id,
        identifier: issue.identifier,
        found: false,
        block: null,
        inconsistencies: [],
      });
      return;
    }

    // Fetch linked approvals so caller can see gate status
    const linkedApprovals = await issueApprovalsSvc.listApprovalsForIssue(issue.id);
    const hasApprovedBoardApproval = linkedApprovals.some(
      (a) => a.type === "request_board_approval" && a.status === "approved",
    );

    res.json({
      issueId: issue.id,
      identifier: issue.identifier,
      found: true,
      block: parseResult.block,
      inconsistencies: parseResult.inconsistencies,
      gateStatus: {
        isT3: parseResult.block?.tier === "T3",
        approvalRequired: parseResult.block?.approvalRequired ?? false,
        hasApprovedBoardApproval,
        gateWouldBlock:
          parseResult.block?.tier === "T3" &&
          parseResult.block.approvalRequired === true &&
          !hasApprovedBoardApproval,
      },
    });
  });

  /** GET /api/companies/:companyId/authority-classification-report
   * Auditor-facing read-only endpoint.
   * Lists issues with missing or inconsistent Authority Classification blocks.
   * Requires board authentication.
   */
  router.get("/companies/:companyId/authority-classification-report", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const limitParam = parseInt(req.query.limit as string ?? "200", 10);
    const limit = isNaN(limitParam) || limitParam < 1 || limitParam > 500 ? 200 : limitParam;
    const offsetParam = parseInt(req.query.offset as string ?? "0", 10);
    const offset = isNaN(offsetParam) || offsetParam < 0 ? 0 : offsetParam;

    // Fetch active (non-cancelled) issues for this company
    const allIssues = await svc.list(companyId, {
      status: "todo,in_progress,in_review,blocked,backlog",
      limit,
      offset,
    });

    const report = await Promise.all(
      allIssues.map(async (issue) => {
        const parseResult = parseClassificationBlock(issue.description ?? "");
        const linkedApprovals = parseResult.found && parseResult.block?.tier === "T3"
          ? await issueApprovalsSvc.listApprovalsForIssue(issue.id)
          : [];
        const hasApprovedBoardApproval = linkedApprovals.some(
          (a) => a.type === "request_board_approval" && a.status === "approved",
        );
        return {
          issueId: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          status: issue.status,
          classificationFound: parseResult.found,
          tier: parseResult.block?.tier ?? null,
          inconsistencies: parseResult.inconsistencies,
          gateWouldBlock:
            parseResult.found &&
            parseResult.block?.tier === "T3" &&
            parseResult.block.approvalRequired === true &&
            !hasApprovedBoardApproval,
        };
      }),
    );

    // Filter to only issues with problems
    const flagged = report.filter(
      (r) => !r.classificationFound || r.inconsistencies.length > 0 || r.gateWouldBlock,
    );

    res.json({
      total: flagged.length,
      limit,
      offset,
      issues: flagged,
    });
  });

  return router;
}
