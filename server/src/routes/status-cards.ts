import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createStatusCardSchema,
  listStatusCardsQuerySchema,
  patchStatusCardSchema,
} from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { accessService, instanceSettingsService, logActivity, statusCardService } from "../services/index.js";
import { assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

export function statusCardRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const settings = instanceSettingsService(db);
  const service = statusCardService(db);

  async function assertStatusCardsEnabled() {
    const experimental = await settings.getExperimental();
    if (experimental.enableStatusCards !== true) throw notFound("Status cards are not enabled");
  }

  async function assertCanMutate(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "tasks:assign",
      resource: {
        type: "issue",
        companyId,
        issueId: null,
        projectId: null,
        parentIssueId: null,
        assigneeAgentId: null,
        assigneeUserId: null,
      },
    });
    if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }

  async function logMutation(req: Request, companyId: string, action: string, cardId: string, details?: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action,
      entityType: "status_card",
      entityId: cardId,
      agentId: actor.agentId,
      runId: actor.runId,
      details,
    });
  }

  router.get("/companies/:companyId/status-cards", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertStatusCardsEnabled();
    const query = listStatusCardsQuerySchema.parse(req.query);
    res.json(await service.list(companyId, query.archived));
  });

  router.post("/companies/:companyId/status-cards", validate(createStatusCardSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertStatusCardsEnabled();
    await assertCanMutate(req, companyId);
    const actor = getActorInfo(req);
    const card = await service.create(companyId, req.body, {
      agentId: actor.actorType === "agent" ? actor.actorId : null,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    await service.requestCompile(card.id);
    await logMutation(req, companyId, "status_card.created", card.id, { state: card.state });
    res.status(201).json(card);
  });

  router.get("/status-cards/:id", async (req, res) => {
    await assertStatusCardsEnabled();
    const card = await getAccessibleResource(req, res, service.getById(req.params.id as string), "Status card not found");
    if (!card) return;
    res.json(card);
  });

  router.patch("/status-cards/:id", validate(patchStatusCardSchema), async (req, res) => {
    await assertStatusCardsEnabled();
    const card = await getAccessibleResource(req, res, service.getById(req.params.id as string), "Status card not found");
    if (!card) return;
    await assertCanMutate(req, card.companyId);
    const actor = getActorInfo(req);
    const updated = await service.update(card, req.body, {
      agentId: actor.actorType === "agent" ? actor.actorId : null,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    if (req.body.interestPrompt !== undefined) await service.requestCompile(card.id);
    await logMutation(req, card.companyId, "status_card.updated", card.id, {
      fields: Object.keys(req.body),
      archived: Boolean(updated.archivedAt),
    });
    res.json(updated);
  });

  router.delete("/status-cards/:id", async (req, res) => {
    await assertStatusCardsEnabled();
    const card = await getAccessibleResource(req, res, service.getById(req.params.id as string), "Status card not found");
    if (!card) return;
    await assertCanMutate(req, card.companyId);
    await service.remove(card.id);
    await logMutation(req, card.companyId, "status_card.deleted", card.id);
    res.status(204).send();
  });

  router.get("/status-cards/:id/updates", async (req, res) => {
    await assertStatusCardsEnabled();
    const card = await getAccessibleResource(req, res, service.getById(req.params.id as string), "Status card not found");
    if (!card) return;
    res.json(await service.listUpdates(card.id));
  });

  return router;
}
