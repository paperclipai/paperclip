import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createAgentPermissionGrantSchema,
  patchAgentPermissionDefaultsSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { agentAclService, agentService, accessService } from "../services/index.js";
import { forbidden, notFound } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";

export function agentAclRoutes(db: Db) {
  const router = Router();
  const svc = agentAclService(db);
  const agents = agentService(db);
  const access = accessService(db);

  async function assertCanManageAcl(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);

    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(companyId, req.actor.userId, "agents:create");
      if (!allowed) {
        throw forbidden("Missing permission: agents:create");
      }
      return;
    }

    if (!req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.role !== "ceo") {
      throw forbidden("Only CEO agents can manage agent permissions");
    }
  }

  // --- Grants ---

  router.get("/companies/:companyId/agent-permission-grants", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const granteeId = req.query.granteeId as string | undefined;
    const agentId = req.query.agentId as string | undefined;
    const permission = req.query.permission as string | undefined;
    const result = await svc.listGrants(companyId, { granteeId, agentId, permission });
    res.json(result);
  });

  router.post(
    "/companies/:companyId/agent-permission-grants",
    validate(createAgentPermissionGrantSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanManageAcl(req, companyId);
      const { granteeId, agentId, permission } = req.body as {
        granteeId: string;
        agentId: string;
        permission: string;
      };
      const result = await svc.createGrant(companyId, granteeId, agentId, permission);
      res.status(201).json(result);
    },
  );

  router.delete("/companies/:companyId/agent-permission-grants/:grantId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const grantId = req.params.grantId as string;
    await assertCanManageAcl(req, companyId);
    const result = await svc.deleteGrant(companyId, grantId);
    if (!result) {
      throw notFound("Grant not found");
    }
    res.json(result);
  });

  // --- Defaults ---

  router.get("/companies/:companyId/agent-permission-defaults", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.getDefaults(companyId);
    if (!result) {
      res.json({ companyId, assignDefault: false, commentDefault: false, updatedAt: new Date() });
      return;
    }
    res.json(result);
  });

  router.patch(
    "/companies/:companyId/agent-permission-defaults",
    validate(patchAgentPermissionDefaultsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanManageAcl(req, companyId);
      const patch = req.body as { assignDefault?: boolean; commentDefault?: boolean };
      const result = await svc.upsertDefaults(companyId, patch);
      res.json(result);
    },
  );

  return router;
}
