import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  createRuntimeServiceSchema, registerRuntimeServiceSchema, runtimeServiceActivitySchema, runtimeServiceControlSchema,
  updateRuntimeServicePolicySchema, updateRuntimeServiceEnvironmentSchema, updateRuntimeServiceCompanyPolicySchema,
  attachRuntimeServiceTaskSchema, detachRuntimeServiceTaskSchema, deleteRuntimeServiceDataSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { createRuntimeServiceOperations, type RuntimeServiceDependencies } from "../services/runtime-services/operations.js";
import { badRequest } from "../errors.js";

export function runtimeServiceRoutes(db: Db, options: RuntimeServiceDependencies) {
  const router = Router();
  const operations = createRuntimeServiceOperations(db, options);
  // A company-qualified lookup always returns the same missing result for a
  // nonexistent service and an ID belonging to a different company.
  router.param("companyId", (req, _res, next, value) => {
    if (!z.string().guid().safeParse(value).success) return next(badRequest("Invalid company ID"));
    next();
  });
  router.param("serviceId", (req, _res, next, value) => {
    if (!z.string().guid().safeParse(value).success) return next(badRequest("Invalid service ID"));
    next();
  });
  router.get("/companies/:companyId/runtime-service-policy", async (req, res) => {
    res.set("Cache-Control", "no-store").json(await operations.companyPolicy(req, req.params.companyId as string));
  });
  router.patch("/companies/:companyId/runtime-service-policy", validate(updateRuntimeServiceCompanyPolicySchema), async (req, res) => {
    res.set("Cache-Control", "no-store").json(await operations.updateCompanyPolicy(req, req.params.companyId as string, req.body));
  });
  router.get("/companies/:companyId/runtime-services", async (req, res) => {
    const companyId = req.params.companyId as string;
    const parsed = z.object({ issueId: z.string().guid().optional() }).strict().safeParse(req.query);
    if (!parsed.success) throw badRequest("Invalid service filters");
    res.json(await operations.list(req, companyId, parsed.data.issueId));
  });
  router.post("/companies/:companyId/runtime-services", validate(createRuntimeServiceSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    res.status(202).json(await operations.create(req, companyId, req.body));
  });
  router.post("/companies/:companyId/runtime-services/register", validate(registerRuntimeServiceSchema), async (req, res) => {
    res.status(202).json(await operations.register(req, req.params.companyId as string, req.body));
  });
  router.get("/companies/:companyId/runtime-services/:serviceId", async (req, res) => {
    res.json(await operations.inspect(req, req.params.companyId as string, req.params.serviceId as string));
  });
  router.get("/companies/:companyId/runtime-services/:serviceId/data-deletion", async (req, res) => {
    res.set("Cache-Control", "no-store").json(await operations.dataDeletionReview(req, req.params.companyId as string, req.params.serviceId as string));
  });
  router.post("/companies/:companyId/runtime-services/:serviceId/data-deletion", validate(deleteRuntimeServiceDataSchema), async (req, res) => {
    res.status(202).set("Cache-Control", "no-store").json(await operations.deleteData(req, req.params.companyId as string, req.params.serviceId as string, req.body));
  });
  router.post("/companies/:companyId/runtime-services/:serviceId/control", validate(runtimeServiceControlSchema), async (req, res) => {
    res.status(202).json(await operations.control(req, req.params.companyId as string, req.params.serviceId as string, req.body));
  });
  router.post("/companies/:companyId/runtime-services/:serviceId/attach-task", validate(attachRuntimeServiceTaskSchema), async (req, res) => {
    res.json(await operations.attachTask(req, req.params.companyId as string, req.params.serviceId as string, req.body));
  });
  router.post("/companies/:companyId/runtime-services/:serviceId/detach-task", validate(detachRuntimeServiceTaskSchema), async (req, res) => {
    res.json(await operations.detachTask(req, req.params.companyId as string, req.params.serviceId as string, req.body));
  });
  router.patch("/companies/:companyId/runtime-services/:serviceId/policy", validate(updateRuntimeServicePolicySchema), async (req, res) => {
    res.json(await operations.updatePolicy(req, req.params.companyId as string, req.params.serviceId as string, req.body));
  });
  router.get("/companies/:companyId/runtime-services/:serviceId/logs", async (req, res) => {
    res.set("Cache-Control", "no-store").json(await operations.logs(req, req.params.companyId as string, req.params.serviceId as string));
  });
  router.get("/companies/:companyId/runtime-services/:serviceId/storage", async (req, res) => {
    res.set("Cache-Control", "no-store").json(await operations.storage(req, req.params.companyId as string, req.params.serviceId as string));
  });
  router.post("/companies/:companyId/runtime-services/:serviceId/storage/refresh", validate(z.object({}).strict()), async (req, res) => {
    res.set("Cache-Control", "no-store").json(await operations.storage(req, req.params.companyId as string, req.params.serviceId as string, true));
  });
  router.get("/companies/:companyId/runtime-services/:serviceId/environment", async (req, res) => {
    res.set("Cache-Control", "no-store").json(await operations.environment(req, req.params.companyId as string, req.params.serviceId as string));
  });
  router.patch("/companies/:companyId/runtime-services/:serviceId/environment", validate(updateRuntimeServiceEnvironmentSchema), async (req, res) => {
    res.set("Cache-Control", "no-store").json(await operations.updateEnvironment(req, req.params.companyId as string, req.params.serviceId as string, req.body));
  });
  router.post("/companies/:companyId/runtime-services/:serviceId/activity", validate(runtimeServiceActivitySchema), async (req, res) => {
    await operations.activity(req, req.params.companyId as string, req.params.serviceId as string, req.body.visible);
    res.status(204).end();
  });
  return router;
}
