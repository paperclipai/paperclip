import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { workflows, type Db } from "@paperclipai/db";
import { createWorkflowSchema, updateWorkflowSchema, listWorkflowsSchema, readWorkflowQuerySchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { notFound } from "../errors.js";
import { assertCompanyAccess, hasCompanyAccess } from "./authz.js";
import { requireCasesEnabled, workflowService } from "../services/workflows.js";

export function workflowRoutes(db: Db) {
  const router = Router();
  const service = workflowService(db);
  router.get("/companies/:companyId/workflows", async (req, res) => {
    await requireCasesEnabled(db);
    const companyId = z.string().guid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    res.json(await service.list(companyId, listWorkflowsSchema.parse(req.query)));
  });
  router.post("/companies/:companyId/workflows", validate(createWorkflowSchema), async (req, res) => {
    await requireCasesEnabled(db);
    const companyId = z.string().guid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const { prompt: _prompt, ...metadata } = await service.write(companyId, req.actor, req.body);
    res.status(201).json(metadata);
  });
  router.all("/workflows/:id", async (req, res, next) => {
    await requireCasesEnabled(db);
    const id = z.string().guid().parse(req.params.id);
    const [row] = await db.select({ companyId: workflows.companyId }).from(workflows).where(eq(workflows.id, id));
    if (!row || !hasCompanyAccess(req, row.companyId)) throw notFound("Workflow not found");
    assertCompanyAccess(req, row.companyId);
    res.locals.workflowCompanyId = row.companyId;
    next();
  });
  router.get("/workflows/:id", async (req, res) => {
    const query = readWorkflowQuerySchema.parse(req.query);
    const { workflow, snapshot } = await service.read(res.locals.workflowCompanyId, req.params.id as string, query.snapshot);
    res.set("ETag", `"${snapshot}"`).json(workflow);
  });
  router.patch("/workflows/:id", validate(updateWorkflowSchema), async (req, res) => {
    const { prompt: _prompt, ...metadata } = await service.write(res.locals.workflowCompanyId, req.actor, req.body, req.params.id as string);
    res.json(metadata);
  });
  return router;
}
