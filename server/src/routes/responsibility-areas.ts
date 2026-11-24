import { dashboardOwner } from "./responsibility-owner.js";
import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  createResponsibilityAreaSchema,
  deleteResponsibilityAreaQuerySchema,
  listResponsibilityAreasQuerySchema,
  updateResponsibilityAreaSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { responsibilitiesDisabledError } from "../services/responsibilities-disabled.js";
import { validate } from "../middleware/validate.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { accessService, instanceSettingsService, logActivity } from "../services/index.js";
import { reportVersionOf, responsibilityAgentChangeService, responsibilityDeletionKey } from "../services/responsibility-agent-changes.js";
import { responsibilityAreaService } from "../services/responsibility-areas.js";
import { AGENT_PERSON_RULE, agentPersonInCompany } from "./agent-person-authz.js";
import { assertBoardOrAgent, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

const NOT_FOUND = "Area not found";

/**
 * An owner or a run they directed can manage their areas. Agent changes are versioned.
 */
export function responsibilityAreaRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const settings = instanceSettingsService(db);
  const svc = responsibilityAreaService(db);
  const agentChanges = responsibilityAgentChangeService(db);

  async function assertResponsibilitiesEnabled() {
    const experimental = await settings.getExperimental();
    if (experimental.enableResponsibilities !== true) throw responsibilitiesDisabledError();
  }

  async function assertCompanyRead(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board" && req.actor.type !== "agent") throw forbidden("Board or agent access required");
    if (req.actor.type === "agent") {
      const decision = await access.decide({
        actor: req.actor,
        action: "company_scope:read",
        resource: { type: "company", companyId },
      });
      if (!decision.allowed) {
        throw forbidden("Responsibility areas are outside this agent's authorization boundary", authorizationDeniedDetails(decision));
      }
    }
  }

  async function loadForBoardWrite(req: Request, res: Response) {
    const row = await getAccessibleResource(req, res, svc.getById(req.params.id as string), NOT_FOUND);
    if (!row) return null;
    await assertCompanyRead(req, row.companyId);
    await dashboardOwner(db, req, row.companyId, row.ownerUserId);
    return row;
  }

  /** A board user, or an agent acting for a member of the company: who the agent acts for, or null for a board user. */
  async function assertAreaWriter(req: Request, companyId: string) {
    if (req.actor.type === "board") return null;
    await assertCompanyRead(req, companyId);
    const person = await agentPersonInCompany(db, req, companyId);
    if (!person) throw forbidden(`Only a member of the company can change an area, and this agent's run does not act for one. ${AGENT_PERSON_RULE}.`);
    return { personUserId: person.userId, agentId: getActorInfo(req).actorId };
  }

  async function logAreaMutation(req: Request, companyId: string, action: string, entityId: string, details?: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action,
      entityType: "responsibility_area",
      entityId,
      details: req.actor.type === "agent" && req.actor.onBehalfOfUserId
        ? { ...details, onBehalfOfUserId: req.actor.onBehalfOfUserId }
        : details,
    });
  }

  router.get("/companies/:companyId/responsibility-areas", async (req, res) => {
    await assertResponsibilitiesEnabled();
    const companyId = req.params.companyId as string;
    await assertCompanyRead(req, companyId);
    const query = listResponsibilityAreasQuerySchema.parse(req.query);
    res.json(await svc.list(companyId, await dashboardOwner(db, req, companyId), { includeArchived: query.includeArchived }));
  });

  router.post("/companies/:companyId/responsibility-areas", validate(createResponsibilityAreaSchema), async (req, res) => {
    await assertResponsibilitiesEnabled();
    const companyId = req.params.companyId as string;
    await assertCompanyRead(req, companyId);
    const actor = getActorInfo(req);
    const person = await agentPersonInCompany(db, req, companyId);
    const ownerUserId = await dashboardOwner(db, req, companyId);
    const create = (tx: Db) => responsibilityAreaService(tx).create(
      companyId, ownerUserId,
      req.body,
      req.actor.type !== "agent" ? { type: "board" }
        : person ? { type: "board", viaAgentId: actor.actorId }
          : { type: "agent", agentId: actor.actorId },
    );
    const { area, created } = person
      ? await agentChanges.record({
        companyId, ownerUserIds: [person.userId], agentId: actor.actorId,
        onVersion: reportVersionOf(res, person.userId),
        createdAreaIds: (result) => (result.created ? [result.area.id] : []),
      }, create)
      : await create(db);
    if (!created) {
      res.json(area);
      return;
    }
    await logAreaMutation(req, companyId, "responsibility_area.created", area.id, {
      title: area.title,
      status: area.status,
      source: area.source,
    });
    res.status(201).json(area);
  });

  router.patch("/responsibility-areas/:id", validate(updateResponsibilityAreaSchema), async (req, res) => {
    await assertResponsibilitiesEnabled();
    assertBoardOrAgent(req);
    const row = await loadForBoardWrite(req, res);
    if (!row) return;
    const writer = await assertAreaWriter(req, row.companyId);
    const updated = writer
      ? await agentChanges.record({
        companyId: row.companyId, ownerUserIds: [writer.personUserId],
        agentId: writer.agentId, touchedAreaIds: [row.id],
        onVersion: reportVersionOf(res, writer.personUserId),
      }, (tx) => responsibilityAreaService(tx).update(row, req.body))
      : await svc.update(row, req.body);
    await logAreaMutation(req, row.companyId, "responsibility_area.updated", row.id, {
      fields: Object.keys(req.body),
      ...(req.body.status !== undefined ? { fromStatus: row.status, toStatus: updated.status } : {}),
      ...(req.body.title !== undefined ? { fromTitle: row.title, toTitle: updated.title } : {}),
    });
    res.json(updated);
  });

  router.delete("/responsibility-areas/:id", async (req, res) => {
    await assertResponsibilitiesEnabled();
    assertBoardOrAgent(req);
    const row = await loadForBoardWrite(req, res);
    if (!row) return;
    const query = deleteResponsibilityAreaQuerySchema.parse(req.query);
    const writer = await assertAreaWriter(req, row.companyId);
    let confirmationId: string | null = null;
    if (writer) {
      // Permanent: an agent deletes only after the person accepts its confirmation card.
      const card = await agentChanges.assertConfirmedDeletion({
        companyId: row.companyId,
        agentId: writer.agentId,
        interactionId: query.confirmationId,
        key: responsibilityDeletionKey("area", row.id),
        ownerUserId: writer.personUserId,
      });
      confirmationId = card.id;
    }
    const remove = (tx: Db) => responsibilityAreaService(tx).remove(row, { moveTo: query.moveResponsibilitiesTo ?? null });
    // Moving its responsibilities changes their owners' Dashboards too.
    const removed = writer
      ? await agentChanges.record({
        companyId: row.companyId, ownerUserIds: [writer.personUserId],
        agentId: writer.agentId,
        touchedAreaIds: [row.id, ...(query.moveResponsibilitiesTo ? [query.moveResponsibilitiesTo] : [])],
        onVersion: reportVersionOf(res, writer.personUserId),
      }, remove)
      : await remove(db);
    if (!removed) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    await logAreaMutation(req, row.companyId, "responsibility_area.deleted", row.id, {
      title: row.title,
      ...(query.moveResponsibilitiesTo ? { movedResponsibilitiesTo: query.moveResponsibilitiesTo, moved: removed.moved } : {}),
      ...(confirmationId ? { confirmationInteractionId: confirmationId } : {}),
    });
    res.json({ ...removed.area, movedResponsibilities: removed.moved });
  });

  return router;
}
