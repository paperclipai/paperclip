import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  IMPROVEMENT_SUGGESTION_ORIGIN_KINDS,
  IMPROVEMENT_SUGGESTION_STATUSES,
  IMPROVEMENT_TARGET_LAYERS,
  createImprovementSuggestionSchema,
  reviewImprovementSuggestionSchema,
  type ImprovementSuggestionOriginKind,
  type ImprovementSuggestionStatus,
  type ImprovementTargetLayer,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { improvementSuggestionService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

function enumQueryValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined;
}

export function improvementSuggestionRoutes(db: Db) {
  const router = Router();
  const svc = improvementSuggestionService(db);

  router.get("/companies/:companyId/improvement-suggestions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId, {
      status: enumQueryValue(req.query.status, IMPROVEMENT_SUGGESTION_STATUSES) as ImprovementSuggestionStatus | undefined,
      originKind: enumQueryValue(req.query.originKind, IMPROVEMENT_SUGGESTION_ORIGIN_KINDS) as ImprovementSuggestionOriginKind | undefined,
      targetLayer: enumQueryValue(req.query.targetLayer, IMPROVEMENT_TARGET_LAYERS) as ImprovementTargetLayer | undefined,
    }));
  });

  router.get("/companies/:companyId/improvement-suggestions/:suggestionId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.get(companyId, req.params.suggestionId as string));
  });

  router.post(
    "/companies/:companyId/improvement-suggestions",
    validate(createImprovementSuggestionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actorInfo = getActorInfo(req);
      const actor = req.actor.type === "agent"
        ? {
            type: "agent" as const,
            agentId: req.actor.agentId ?? "",
            runId: req.actor.runId ?? null,
          }
        : req.actor.type === "board"
          ? {
              type: "board" as const,
              userId: req.actor.userId ?? "board",
              runId: req.actor.runId ?? null,
            }
          : null;
      if (!actor) throw forbidden("Board or agent authentication required");

      const suggestion = await svc.create(companyId, req.body, actor);
      await logActivity(db, {
        companyId,
        actorType: actorInfo.actorType,
        actorId: actorInfo.actorId,
        agentId: actorInfo.agentId,
        runId: actorInfo.runId,
        action: suggestion.originKind === "board_directed"
          ? "improvement.board_directive.recorded"
          : "improvement.suggestion.created",
        entityType: "improvement_suggestion",
        entityId: suggestion.id,
        details: {
          originKind: suggestion.originKind,
          status: suggestion.status,
          targetLayer: suggestion.targetLayer,
          sourceIssueId: suggestion.sourceIssueId,
          sourceRunId: suggestion.sourceRunId,
          evidenceCount: suggestion.evidence.length,
        },
      });
      res.status(201).json(suggestion);
    },
  );

  router.post(
    "/companies/:companyId/improvement-suggestions/:suggestionId/review",
    validate(reviewImprovementSuggestionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const actor = getActorInfo(req);
      const suggestion = await svc.review(
        companyId,
        req.params.suggestionId as string,
        req.body,
        req.actor.userId ?? "board",
      );
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: suggestion.status === "accepted"
          ? "improvement.suggestion.accepted"
          : "improvement.suggestion.rejected",
        entityType: "improvement_suggestion",
        entityId: suggestion.id,
        details: {
          originKind: suggestion.originKind,
          status: suggestion.status,
          targetLayer: suggestion.targetLayer,
        },
      });
      res.json(suggestion);
    },
  );

  return router;
}
