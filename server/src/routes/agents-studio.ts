import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  CONNECTOR_CATALOG,
  INTEGRATOR_REGISTRY,
  INTEGRATOR_CATEGORIES,
  WORKFLOW_TEMPLATES,
  factoryAgentCreateSchema,
  integratorConnectInputSchema,
  integratorRunActionSchema,
  workflowCreateSchema,
  workflowUpdateSchema,
  workflowDeployTemplateSchema,
  workflowRunCreateSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { agentsStudioService, integratorsService } from "../services/index.js";
import { notFound } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function agentsStudioRoutes(db: Db, options: { pluginWorkerManager?: unknown } = {}) {
  const router = Router();
  const svc = agentsStudioService(db);
  const integrators = integratorsService(db);

  function actorOf(req: Parameters<typeof getActorInfo>[0]) {
    const info = getActorInfo(req);
    return { agentId: info.agentId, userId: info.actorType === "user" ? info.actorId : null };
  }

  // Static catalogs — connector palette + deployable templates (no company scope).
  router.get("/agents-studio/connectors", (_req, res) => {
    res.json({ connectors: CONNECTOR_CATALOG });
  });

  router.get("/agents-studio/templates", (_req, res) => {
    res.json({ templates: WORKFLOW_TEMPLATES });
  });

  router.get("/agents-studio/integrators", (_req, res) => {
    res.json({ integrators: INTEGRATOR_REGISTRY, categories: INTEGRATOR_CATEGORIES });
  });

  // Per-company integrator connections.
  router.get("/companies/:companyId/integrators", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ integrators: await integrators.list(companyId) });
  });

  router.post(
    "/companies/:companyId/integrators/:integratorKey/connect",
    validate(integratorConnectInputSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const integratorKey = req.params.integratorKey as string;
      assertCompanyAccess(req, companyId);
      const integrator = await integrators.connect(companyId, integratorKey, req.body.config);
      if (!integrator) throw notFound("Unknown integrator");
      res.json({ integrator });
    },
  );

  router.post("/companies/:companyId/integrators/:integratorKey/disconnect", async (req, res) => {
    const companyId = req.params.companyId as string;
    const integratorKey = req.params.integratorKey as string;
    assertCompanyAccess(req, companyId);
    const integrator = await integrators.disconnect(companyId, integratorKey);
    if (!integrator) throw notFound("Unknown integrator");
    res.json({ integrator });
  });

  // Execute a real, live action against the connected system.
  router.post(
    "/companies/:companyId/integrators/:integratorKey/run-action",
    validate(integratorRunActionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const integratorKey = req.params.integratorKey as string;
      assertCompanyAccess(req, companyId);
      const result = await integrators.runAction(companyId, integratorKey, req.body.action, req.body.inputs);
      res.json({ result });
    },
  );

  router.post("/companies/:companyId/agents-studio/provision-org", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.provisionOrg(companyId);
    res.status(201).json(result);
  });

  router.get("/companies/:companyId/workflows", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ workflows: await svc.list(companyId) });
  });

  // Factory agents — list for step assignment + create new specialized agents.
  router.get("/companies/:companyId/agents-studio/agents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ agents: await svc.listFactoryAgents(companyId) });
  });

  router.post(
    "/companies/:companyId/agents-studio/agents",
    validate(factoryAgentCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const agent = await svc.createFactoryAgent(companyId, req.body);
      res.status(201).json({ agent });
    },
  );

  router.post("/companies/:companyId/workflows", validate(workflowCreateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const workflow = await svc.create(companyId, req.body, actorOf(req));
    res.status(201).json({ workflow });
  });

  router.post(
    "/companies/:companyId/workflows/deploy",
    validate(workflowDeployTemplateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const workflow = await svc.deployTemplate(companyId, req.body.templateKey, req.body.name, actorOf(req));
      if (!workflow) throw notFound("Unknown template");
      res.status(201).json({ workflow });
    },
  );

  router.get("/companies/:companyId/workflows/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, companyId);
    const workflow = await svc.getById(companyId, id);
    if (!workflow) throw notFound("Workflow not found");
    res.json({ workflow });
  });

  router.patch(
    "/companies/:companyId/workflows/:id",
    validate(workflowUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
    const id = req.params.id as string;
      assertCompanyAccess(req, companyId);
      const workflow = await svc.update(companyId, id, req.body);
      if (!workflow) throw notFound("Workflow not found");
      res.json({ workflow });
    },
  );

  router.delete("/companies/:companyId/workflows/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, companyId);
    const removed = await svc.remove(companyId, id);
    if (!removed) throw notFound("Workflow not found");
    res.json({ ok: true });
  });

  router.get("/companies/:companyId/workflows/:id/runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, companyId);
    res.json({ runs: await svc.listRuns(companyId, id) });
  });

  router.post(
    "/companies/:companyId/workflows/:id/run",
    validate(workflowRunCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
    const id = req.params.id as string;
      assertCompanyAccess(req, companyId);
      const run = await svc.run(companyId, id, req.body.trigger, {
        pluginWorkerManager: options.pluginWorkerManager,
      });
      if (!run) throw notFound("Workflow not found");
      res.status(201).json({ run });
    },
  );

  return router;
}
