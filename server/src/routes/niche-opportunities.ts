import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { nicheOpportunityService } from "../services/niche-opportunities.js";
import { issueService } from "../services/issues.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { notFound, badRequest } from "../errors.js";

export function nicheOpportunityRoutes(db: Db) {
  const router = Router();
  const svc = nicheOpportunityService(db);

  // List niche opportunities — board or company agent can read
  router.get("/companies/:companyId/niche-opportunities", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const status = req.query.status as string | undefined;
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const offset = Number(req.query.offset ?? 0);

    const result = await svc.list(companyId, status as any, limit, offset);
    res.json(result);
  });

  // Get single opportunity — board or company access
  router.get("/companies/:companyId/niche-opportunities/:id", async (req, res) => {
    const { companyId, id } = req.params;
    assertCompanyAccess(req, companyId);

    const opp = await svc.get(companyId, id);
    if (!opp) throw notFound("Niche opportunity not found");
    res.json(opp);
  });

  // Create opportunity (for NDA agent)
  router.post("/companies/:companyId/niche-opportunities", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const { headKeyword, categoryPath, tier, compositeScore, metadata, discoveredAt } = req.body as {
      headKeyword?: string;
      categoryPath?: string;
      tier?: string;
      compositeScore?: number;
      metadata?: string;
      discoveredAt?: string;
    };

    if (!headKeyword || !categoryPath) {
      throw badRequest("headKeyword and categoryPath are required");
    }

    const opp = await svc.create(companyId, {
      headKeyword,
      categoryPath,
      tier,
      compositeScore,
      metadata,
      discoveredAt: discoveredAt ? new Date(discoveredAt) : undefined,
    });

    if (!opp) {
      return res.status(409).json({ error: "Niche opportunity with this category and keyword already exists" });
    }

    res.status(201).json(opp);
  });

  // Board-only: review (approve / defer / reject)
  router.post(
    "/companies/:companyId/niche-opportunities/:id/review",
    async (req, res) => {
      const { companyId, id } = req.params;
      // Status transitions are board-only
      assertBoard(req);
      assertCompanyAccess(req, companyId);

      const { action, reviewNote } = req.body as {
        action?: "approve" | "defer" | "reject";
        reviewNote?: string;
      };

      if (!action || !["approve", "defer", "reject"].includes(action)) {
        throw badRequest("action must be approve, defer, or reject");
      }

      const opp = await svc.get(companyId, id);
      if (!opp) throw notFound("Niche opportunity not found");

      const actor = getActorInfo(req);
      const reviewedByUserId = actor.actorType === "user" ? actor.actorId : null;

      let miaIssueId: string | undefined;
      let miaIssueIdentifier: string | null | undefined;

      if (action === "approve") {
        // Auto-create an MIA assignment issue
        const issueSvc = issueService(db);
        const miaIssue = await issueSvc.create(companyId, {
          title: `Analyze niche: ${opp.headKeyword}`,
          description: [
            `**Niche opportunity approved for analysis.**`,
            ``,
            `- **Head keyword:** ${opp.headKeyword}`,
            `- **Category path:** ${opp.categoryPath}`,
            `- **Tier:** ${opp.tier}`,
            `- **Composite score:** ${opp.compositeScore}`,
            `- **Niche opportunity ID:** ${opp.id}`,
            ``,
            `Produce a full niche analysis brief for this opportunity.`,
          ].join("\n"),
          status: "todo",
          priority: opp.tier === "S" ? "critical" : opp.tier === "A" ? "high" : "medium",
          createdByUserId: reviewedByUserId,
          createdByAgentId: null,
        } as any);
        miaIssueId = miaIssue.id;
        miaIssueIdentifier = miaIssue.identifier;
      }

      const updated = await svc.review(
        companyId,
        id,
        action,
        reviewedByUserId ?? "board",
        reviewNote,
        miaIssueId,
      );

      if (!updated) throw notFound("Niche opportunity not found");

      res.json({ opportunity: updated, miaIssueId, miaIssueIdentifier });
    },
  );

  return router;
}
