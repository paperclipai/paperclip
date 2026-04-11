import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createProjectEnvironmentSchema,
  updateProjectEnvironmentSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { projectEnvironmentService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

export function projectEnvironmentRoutes(db: Db) {
  const router = Router({ mergeParams: true });

  router.get("/", async (req, res) => {
    const { companyId, projectId } = req.params as { companyId: string; projectId: string };
    assertCompanyAccess(req, companyId);
    const svc = projectEnvironmentService(db);
    const envs = await svc.list(companyId, projectId);
    res.json(envs);
  });

  router.post("/", validate(createProjectEnvironmentSchema), async (req, res) => {
    const { companyId, projectId } = req.params as { companyId: string; projectId: string };
    assertCompanyAccess(req, companyId);
    const svc = projectEnvironmentService(db);
    const env = await svc.create(companyId, projectId, req.body);
    res.status(201).json(env);
  });

  router.put("/:envId", validate(updateProjectEnvironmentSchema), async (req, res) => {
    const { companyId, envId } = req.params as { companyId: string; projectId: string; envId: string };
    assertCompanyAccess(req, companyId);
    const svc = projectEnvironmentService(db);
    const env = await svc.update(companyId, envId, req.body);
    res.json(env);
  });

  router.delete("/:envId", async (req, res) => {
    const { companyId, envId } = req.params as { companyId: string; projectId: string; envId: string };
    assertCompanyAccess(req, companyId);
    const svc = projectEnvironmentService(db);
    const env = await svc.remove(companyId, envId);
    res.json(env);
  });

  return router;
}
