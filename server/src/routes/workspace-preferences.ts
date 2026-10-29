import { Router } from "express";
import { companies, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { updateWorkspacePreferenceSchema } from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { workspacePreferenceService } from "../services/workspace-preferences.js";
import { assertBoard, hasCompanyAccess } from "./authz.js";

export function workspacePreferenceRoutes(db: Db) {
  const router = Router();
  const svc = workspacePreferenceService(db);
  const paths = ["/workspace-preferences/me", "/companies/:companyId/workspace-preferences/me"];
  router.use(paths, (req, res, next) => {
    assertBoard(req);
    if (!req.actor.userId) throw forbidden("Board user access required");
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });
  router.get("/workspace-preferences/me", async (req, res) => {
    res.json(await svc.get(req.actor.userId!));
  });
  router.put("/companies/:companyId/workspace-preferences/me", validate(updateWorkspacePreferenceSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    // The company supplies authorized audit context, not ownership of this
    // personal setting. Viewers may change their own interface too.
    if (!hasCompanyAccess(req, companyId)) throw forbidden("User does not have access to this company");
    if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin
      && !req.actor.memberships?.some(member => member.companyId === companyId && member.status === "active")) {
      throw forbidden("User does not have active company access");
    }
    if (!await db.query.companies.findFirst({ where: eq(companies.id, companyId) })) throw notFound("Company not found");
    res.json(await svc.set(companyId, req.actor.userId!, req.body.coordinatorWorkspaceEnabled));
  });
  return router;
}
