import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  addDecisionQueueItemSchema,
  createDecisionQueueSchema,
  decisionAttentionSourceKindSchema,
  removeDecisionQueueItemSchema,
  updateDecisionQueueSchema,
  updateDecisionRetentionSchema,
  updateDecisionTriageSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  authorizationDeniedDetails,
  authorizationService,
  type AuthorizationAction,
} from "../services/authorization.js";
import {
  DECISION_QUEUE_SEEDS,
  decisionQueueService,
  type DecisionMutationActor,
} from "../services/decision-queues.js";
import { assertBoardOrAgent, assertCompanyAccess, getActorInfo } from "./authz.js";
import { decisionRetentionService } from "../services/decision-retention.js";

function mutationActor(req: Parameters<typeof getActorInfo>[0]): DecisionMutationActor {
  const actor = getActorInfo(req);
  return {
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    userId: actor.actorType === "user" ? actor.actorId : null,
    runId: actor.runId,
    agentApiKeyId: actor.agentApiKeyId,
    responsibleUserId: req.actor.onBehalfOfUserId ?? (actor.actorType === "user" ? actor.actorId : null),
  };
}

async function assertDecisionAccess(
  db: Db,
  req: Parameters<typeof getActorInfo>[0],
  companyId: string,
  action: Extract<AuthorizationAction, "decision_queue:read" | "decision_queue:manage" | "decision_triage:manage">,
) {
  assertBoardOrAgent(req);
  assertCompanyAccess(req, companyId);
  const decision = await authorizationService(db).decide({
    actor: req.actor,
    action,
    resource: { type: "company", companyId },
  });
  if (!decision.allowed) {
    throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }
}

function sourceParams(req: Parameters<typeof getActorInfo>[0]) {
  const parsed = decisionAttentionSourceKindSchema.safeParse(req.params.sourceKind);
  if (!parsed.success) return null;
  const sourceId = (req.params.sourceId as string | undefined)?.trim();
  if (!sourceId || sourceId.length > 500) return null;
  return { sourceKind: parsed.data, sourceId };
}

export function decisionQueueRoutes(db: Db) {
  const router = Router();
  const svc = decisionQueueService(db);
  const retention = decisionRetentionService(db);

  router.get("/companies/:companyId/decision-queue-seed-rules", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertDecisionAccess(db, req, companyId, "decision_queue:read");
    res.json(DECISION_QUEUE_SEEDS);
  });

  router.get("/companies/:companyId/decision-queues", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertDecisionAccess(db, req, companyId, "decision_queue:read");
    res.json(await svc.list(companyId, req.actor));
  });

  router.post("/companies/:companyId/decision-queues", validate(createDecisionQueueSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertDecisionAccess(db, req, companyId, "decision_queue:manage");
    const result = await svc.create({
      companyId,
      authActor: req.actor,
      actor: mutationActor(req),
      ...req.body,
    });
    res.status(result.created ? 201 : 200).json(result.queue);
  });

  router.patch("/companies/:companyId/decision-queues/:key", validate(updateDecisionQueueSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertDecisionAccess(db, req, companyId, "decision_queue:manage");
    res.json(await svc.update({
      companyId,
      key: req.params.key as string,
      patch: req.body,
      authActor: req.actor,
      actor: mutationActor(req),
    }));
  });

  router.get("/companies/:companyId/decision-queues/:key/items", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertDecisionAccess(db, req, companyId, "decision_queue:read");
    res.json(await svc.listItems(companyId, req.params.key as string, req.actor));
  });

  router.post(
    "/companies/:companyId/decision-queues/:key/items",
    validate(addDecisionQueueItemSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertDecisionAccess(db, req, companyId, "decision_queue:manage");
      const result = await svc.addItem({
        companyId,
        key: req.params.key as string,
        sourceKind: req.body.sourceKind,
        sourceId: req.body.sourceId,
        authActor: req.actor,
        actor: mutationActor(req),
      });
      res.status(result.created ? 201 : 200).json(result.item);
    },
  );

  router.delete(
    "/companies/:companyId/decision-queues/:key/items/:sourceKind/:sourceId",
    validate(removeDecisionQueueItemSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertDecisionAccess(db, req, companyId, "decision_queue:manage");
      const source = sourceParams(req);
      if (!source) {
        res.status(400).json({ error: "Invalid attention source identity" });
        return;
      }
      res.json(await svc.removeItem({
        companyId,
        key: req.params.key as string,
        ...source,
        reason: req.body.reason,
        authActor: req.actor,
        actor: mutationActor(req),
      }));
    },
  );

  router.get("/companies/:companyId/decision-triage/:sourceKind/:sourceId", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertDecisionAccess(db, req, companyId, "decision_queue:read");
    const source = sourceParams(req);
    if (!source) {
      res.status(400).json({ error: "Invalid attention source identity" });
      return;
    }
    res.json(await svc.getTriage(companyId, source.sourceKind, source.sourceId, req.actor));
  });

  router.put(
    "/companies/:companyId/decision-triage/:sourceKind/:sourceId",
    validate(updateDecisionTriageSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertDecisionAccess(db, req, companyId, "decision_triage:manage");
      const source = sourceParams(req);
      if (!source) {
        res.status(400).json({ error: "Invalid attention source identity" });
        return;
      }
      res.json(await svc.updateTriage({
        companyId,
        ...source,
        ...req.body,
        authActor: req.actor,
        actor: mutationActor(req),
      }));
    },
  );

  router.patch(
    "/companies/:companyId/decision-retention/:sourceKind/:sourceId",
    validate(updateDecisionRetentionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertDecisionAccess(db, req, companyId, "decision_triage:manage");
      const source = sourceParams(req);
      if (!source) {
        res.status(400).json({ error: "Invalid attention source identity" });
        return;
      }
      res.json(await retention.setKeep({
        companyId,
        ...source,
        keep: req.body.keep,
        authActor: req.actor,
        actor: mutationActor(req),
      }));
    },
  );

  router.post("/companies/:companyId/decision-retention/:sourceKind/:sourceId/archive", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertDecisionAccess(db, req, companyId, "decision_triage:manage");
    const source = sourceParams(req);
    if (!source) {
      res.status(400).json({ error: "Invalid attention source identity" });
      return;
    }
    res.json(await retention.archive({ companyId, ...source, authActor: req.actor, actor: mutationActor(req) }));
  });

  router.post("/companies/:companyId/decision-retention/:sourceKind/:sourceId/revive", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertDecisionAccess(db, req, companyId, "decision_triage:manage");
    const source = sourceParams(req);
    if (!source) {
      res.status(400).json({ error: "Invalid attention source identity" });
      return;
    }
    res.json(await retention.revive({ companyId, ...source, authActor: req.actor, actor: mutationActor(req) }));
  });

  return router;
}
