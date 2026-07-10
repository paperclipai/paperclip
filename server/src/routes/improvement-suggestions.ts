import { Router, type Request } from "express";
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
  isRootLevelImprovementTarget,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { improvementSuggestionService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

function enumQueryValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined;
}

function assertImprovementGovernanceBoard(
  req: Request,
  companyId: string,
  targetLayer?: ImprovementTargetLayer,
) {
  assertBoard(req);
  const instanceAuthority = req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true;
  if (instanceAuthority) return;
  const membership = req.actor.memberships?.find((entry) => entry.companyId === companyId);
  const companyAuthority = membership?.status === "active"
    && (membership.membershipRole === "owner" || membership.membershipRole === "admin");
  if (!companyAuthority) {
    throw forbidden("Company owner or admin authority required for improvement governance");
  }
  if (targetLayer && isRootLevelImprovementTarget(targetLayer)) {
    throw forbidden(`Instance admin authority required for ${targetLayer} improvements`);
  }
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
              localImplicit: req.actor.source === "local_implicit",
            }
          : null;
      if (!actor) throw forbidden("Board or agent authentication required");
      if (actor.type === "board") {
        assertImprovementGovernanceBoard(req, companyId, req.body.targetLayer);
      }

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
      assertImprovementGovernanceBoard(req, companyId);
      const actor = getActorInfo(req);
      const suggestion = await svc.review(
        companyId,
        req.params.suggestionId as string,
        req.body,
        {
          userId: req.actor.userId ?? "board",
          localImplicit: req.actor.source === "local_implicit",
        },
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
