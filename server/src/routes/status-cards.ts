import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createStatusCardSchema,
  listStatusCardsQuerySchema,
  patchStatusCardSchema,
  refreshStatusCardSchema,
  STATUS_CARD_AGENT_MAX_INTEREST_PROMPT_LENGTH,
  writeStatusCardQuerySchema,
  writeStatusCardSummarySchema,
} from "@paperclipai/shared";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { accessService, heartbeatService, instanceSettingsService, issueService, logActivity, statusCardService } from "../services/index.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import { assertCompanyAccess, getAccessibleResource, getActorInfo, hasCompanyAccess } from "./authz.js";

export function statusCardRoutes(db: Db, opts: { heartbeat?: IssueAssignmentWakeupDeps } = {}) {
  const router = Router();
  const access = accessService(db);
  const settings = instanceSettingsService(db);
  const service = statusCardService(db);
  const issueSvc = issueService(db);
  const heartbeat = opts.heartbeat ?? heartbeatService(db);

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

  async function assertCanManageCard(req: Request, card: { companyId: string; createdByAgentId: string | null }) {
    await assertCanMutate(req, card.companyId);
    if (req.actor.type === "agent" && card.createdByAgentId !== req.actor.agentId) {
      throw forbidden("Agents can only manage status cards they authored");
    }
  }

  function assertAgentPromptLimit(req: Request, interestPrompt: string | undefined) {
    if (
      req.actor.type === "agent" &&
      interestPrompt !== undefined &&
      interestPrompt.length > STATUS_CARD_AGENT_MAX_INTEREST_PROMPT_LENGTH
    ) {
      throw unprocessable(
        `Agent-authored status card prompts cannot exceed ${STATUS_CARD_AGENT_MAX_INTEREST_PROMPT_LENGTH} characters`,
      );
    }
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

  async function enqueueCompile(req: Request, cardId: string) {
    const actor = getActorInfo(req);
    const result = await service.requestCompile(cardId, {
      agentId: actor.actorType === "agent" ? actor.actorId : null,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    if (!result.alreadyGenerating) {
      try {
        await queueIssueAssignmentWakeup({
          heartbeat,
          issue: result.generatingIssue,
          reason: "status_card_compile_assigned",
          mutation: "status_card.compile_requested",
          contextSource: "status_card_compile",
          requestedByActorType: actor.actorType === "agent" ? "agent" : "user",
          requestedByActorId: actor.actorId,
          taskKey: `status-card:${cardId}`,
          rethrowOnError: true,
        });
      } catch (error) {
        await issueSvc.update(result.generatingIssue.id, { status: "cancelled" });
        throw error;
      }
    }
    return result;
  }

  async function enqueueRefresh(req: Request, cardId: string, full: boolean, trigger: "manual" | "restore" = "manual") {
    const actor = getActorInfo(req);
    const result = await service.requestRefresh(cardId, {
      full,
      trigger,
      actor: {
        agentId: actor.actorType === "agent" ? actor.actorId : null,
        userId: actor.actorType === "user" ? actor.actorId : null,
      },
    });
    if (result.enqueued && result.generatingIssue && !result.alreadyGenerating) {
      try {
        await queueIssueAssignmentWakeup({
          heartbeat,
          issue: result.generatingIssue,
          reason: "status_card_update_assigned",
          mutation: "status_card.refresh_requested",
          contextSource: "status_card_update",
          requestedByActorType: actor.actorType === "agent" ? "agent" : "user",
          requestedByActorId: actor.actorId,
          taskKey: `status-card:${cardId}`,
          rethrowOnError: true,
        });
      } catch (error) {
        await issueSvc.update(result.generatingIssue.id, { status: "cancelled" });
        throw error;
      }
    }
    return result;
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
    assertAgentPromptLimit(req, req.body.interestPrompt);
    const actor = getActorInfo(req);
    const card = await service.create(companyId, req.body, {
      agentId: actor.actorType === "agent" ? actor.actorId : null,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    try {
      const compile = await enqueueCompile(req, card.id);
      await logMutation(req, companyId, "status_card.created", card.id, { state: card.state });
      res.status(201).json(compile.card);
    } catch (error) {
      await service.remove(card.id);
      throw error;
    }
  });

  router.get("/status-cards/:id", async (req, res) => {
    await assertStatusCardsEnabled();
    const card = await getAccessibleResource(req, res, service.getById(req.params.id as string), "Status card not found");
    if (!card) return;
    res.json(await service.hydrate(card));
  });

  router.patch("/status-cards/:id", validate(patchStatusCardSchema), async (req, res) => {
    await assertStatusCardsEnabled();
    const card = await getAccessibleResource(req, res, service.getById(req.params.id as string), "Status card not found");
    if (!card) return;
    await assertCanManageCard(req, card);
    assertAgentPromptLimit(req, req.body.interestPrompt);
    const actor = getActorInfo(req);
    const updated = await service.update(card, req.body, {
      agentId: actor.actorType === "agent" ? actor.actorId : null,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    const compile = req.body.interestPrompt !== undefined ? await enqueueCompile(req, card.id) : null;
    const restore = req.body.archived === false && card.archivedAt && updated.queries.length > 0 && !updated.generatingIssueId
      ? await enqueueRefresh(req, card.id, true, "restore")
      : null;
    await logMutation(req, card.companyId, "status_card.updated", card.id, {
      fields: Object.keys(req.body),
      archived: Boolean(updated.archivedAt),
    });
    res.json(compile?.card ?? restore?.card ?? updated);
  });

  router.delete("/status-cards/:id", async (req, res) => {
    await assertStatusCardsEnabled();
    const card = await getAccessibleResource(req, res, service.getById(req.params.id as string), "Status card not found");
    if (!card) return;
    await assertCanManageCard(req, card);
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

  router.post("/status-cards/:id/recompile", async (req, res) => {
    await assertStatusCardsEnabled();
    const card = await getAccessibleResource(req, res, service.getById(req.params.id as string), "Status card not found");
    if (!card) return;
    await assertCanManageCard(req, card);
    const result = await enqueueCompile(req, card.id);
    await logMutation(req, card.companyId, "status_card.recompile_requested", card.id, {
      generatingIssueId: result.generatingIssue.id,
      alreadyGenerating: result.alreadyGenerating,
    });
    res.status(result.alreadyGenerating ? 200 : 202).json(result);
  });

  router.post("/status-cards/:id/refresh", validate(refreshStatusCardSchema), async (req, res) => {
    await assertStatusCardsEnabled();
    const card = await getAccessibleResource(req, res, service.getById(req.params.id as string), "Status card not found");
    if (!card) return;
    await assertCanManageCard(req, card);
    const result = await enqueueRefresh(req, card.id, req.body.full);
    await logMutation(req, card.companyId, "status_card.refresh_requested", card.id, {
      full: req.body.full,
      generatingIssueId: result.generatingIssue?.id ?? null,
      alreadyGenerating: result.alreadyGenerating,
      enqueued: result.enqueued,
    });
    res.status(result.enqueued && !result.alreadyGenerating ? 202 : 200).json(result);
  });

  router.get("/status-cards/:id/dry-run", async (req, res) => {
    await assertStatusCardsEnabled();
    const card = await getAccessibleResource(req, res, service.getById(req.params.id as string), "Status card not found");
    if (!card) return;
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId: card.companyId },
    });
    if (!decision.allowed) {
      throw forbidden("Status-card dry-run is outside this actor's low-trust authorization boundary", authorizationDeniedDetails(decision));
    }
    res.json({ cardId: card.id, queryVersion: card.queryVersion, queries: await service.dryRun(card) });
  });

  router.put("/status-cards/:id/query", validate(writeStatusCardQuerySchema), async (req, res) => {
    await assertStatusCardsEnabled();
    const card = await getAccessibleResource(req, res, service.getById(req.params.id as string), "Status card not found");
    if (!card) return;
    if (!hasCompanyAccess(req, card.companyId)) throw notFound("Status card not found");
    assertCompanyAccess(req, card.companyId);
    const actor = getActorInfo(req);
    const updated = await service.writeQuery(card.id, req.body, {
      agentId: actor.actorType === "agent" ? actor.actorId : null,
      runId: actor.runId ?? null,
    });
    await logMutation(req, card.companyId, "status_card.query_written", card.id, {
      queryVersion: updated.queryVersion,
      generationIssueId: req.body.generationIssueId,
      changeSummary: req.body.changeSummary,
    });
    res.json(updated);
  });

  router.put("/status-cards/:id/summary", validate(writeStatusCardSummarySchema), async (req, res) => {
    await assertStatusCardsEnabled();
    const card = await getAccessibleResource(req, res, service.getById(req.params.id as string), "Status card not found");
    if (!card) return;
    if (!hasCompanyAccess(req, card.companyId)) throw notFound("Status card not found");
    assertCompanyAccess(req, card.companyId);
    const actor = getActorInfo(req);
    const result = await service.writeSummary(card.id, req.body, {
      agentId: actor.actorType === "agent" ? actor.actorId : null,
      runId: actor.runId ?? null,
    });
    await logMutation(req, card.companyId, "status_card.summary_written", card.id, {
      queryVersion: result.card.queryVersion,
      generationIssueId: req.body.generationIssueId,
      documentId: result.document.id,
      changeSummary: req.body.changeSummary,
    });
    res.json(result);
  });

  return router;
}
