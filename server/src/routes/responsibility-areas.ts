import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  createResponsibilityAreaSchema,
  listResponsibilityAreasQuerySchema,
  updateResponsibilityAreaSchema,
} from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { accessService, instanceSettingsService, logActivity } from "../services/index.js";
import { responsibilityAreaService } from "../services/responsibility-areas.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

const NOT_FOUND = "Area not found";

/**
 * Responsibility areas (experimental, `enableResponsibilities`). Areas have no
 * owner: any board user with write access to the company manages them, and
 * agents can only propose one.
 */
export function responsibilityAreaRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const settings = instanceSettingsService(db);
  const svc = responsibilityAreaService(db);

  async function assertResponsibilitiesEnabled() {
    const experimental = await settings.getExperimental();
    if (experimental.enableResponsibilities !== true) throw notFound("Responsibilities are not enabled");
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
    return row;
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
      details,
    });
  }

  router.get("/companies/:companyId/responsibility-areas", async (req, res) => {
    await assertResponsibilitiesEnabled();
    const companyId = req.params.companyId as string;
    await assertCompanyRead(req, companyId);
    const query = listResponsibilityAreasQuerySchema.parse(req.query);
    res.json(await svc.list(companyId, { includeArchived: query.includeArchived }));
  });

  router.post("/companies/:companyId/responsibility-areas", validate(createResponsibilityAreaSchema), async (req, res) => {
    await assertResponsibilitiesEnabled();
    const companyId = req.params.companyId as string;
    await assertCompanyRead(req, companyId);
    const actor = getActorInfo(req);
    const { area, created } = await svc.create(
      companyId,
      req.body,
      req.actor.type === "agent" ? { type: "agent", agentId: actor.actorId } : { type: "board" },
    );
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
    assertBoard(req);
    const row = await loadForBoardWrite(req, res);
    if (!row) return;
    const updated = await svc.update(row, req.body);
    await logAreaMutation(req, row.companyId, "responsibility_area.updated", row.id, {
      fields: Object.keys(req.body),
      ...(req.body.status !== undefined ? { fromStatus: row.status, toStatus: updated.status } : {}),
      ...(req.body.title !== undefined ? { fromTitle: row.title, toTitle: updated.title } : {}),
    });
    res.json(updated);
  });

  router.delete("/responsibility-areas/:id", async (req, res) => {
    await assertResponsibilitiesEnabled();
    assertBoard(req);
    const row = await loadForBoardWrite(req, res);
    if (!row) return;
    const removed = await svc.remove(row);
    if (!removed) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    await logAreaMutation(req, row.companyId, "responsibility_area.deleted", row.id, { title: row.title });
    res.json(removed);
  });

  return router;
}
