import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  memoryCaptureSchema,
  memoryCorrectSchema,
  memoryForgetSchema,
  memoryListExtractionJobsQuerySchema,
  memoryListOperationsQuerySchema,
  memoryListRecordsQuerySchema,
  memoryQuerySchema,
  memoryRefreshJobSchema,
  memoryRetentionSweepSchema,
  memoryReviewSchema,
  memoryRevokeSchema,
  setAgentMemoryBindingSchema,
  setCompanyMemoryBindingSchema,
  setProjectMemoryBindingSchema,
  updateMemoryBindingSchema,
  createMemoryBindingSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { forbidden, notFound } from "../errors.js";
import { agentService, logActivity, memoryService, projectService } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

function actorInfoFromReq(req: any) {
  if (req.actor.type === "agent") {
    return {
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? "unknown-agent",
      agentId: req.actor.agentId ?? null,
      userId: null,
      runId: req.actor.runId ?? null,
    };
  }

  return {
    actorType: req.actor.type === "board" ? ("user" as const) : ("system" as const),
    actorId: req.actor.type === "board" ? (req.actor.userId ?? "board") : "system",
    agentId: null,
    userId: req.actor.type === "board" ? (req.actor.userId ?? null) : null,
    runId: req.actor.runId ?? null,
  };
}

export function memoryRoutes(
  db: Db,
  opts?: {
    pluginMemoryProviders?: import("../services/plugin-memory-provider-dispatcher.js").PluginMemoryProviderDispatcher;
  },
) {
  const router = Router();
  const memory = memoryService(db, {
    pluginMemoryProviders: opts?.pluginMemoryProviders,
  });
  const agentsSvc = agentService(db);
  const projectsSvc = projectService(db);

  router.get("/companies/:companyId/memory/providers", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await memory.providers());
  });

  router.get("/companies/:companyId/memory/bindings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await memory.listBindings(companyId));
  });

  router.get("/companies/:companyId/memory/targets", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await memory.listTargets(companyId));
  });

  router.post("/companies/:companyId/memory/bindings", validate(createMemoryBindingSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const binding = await memory.createBinding(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.binding_created",
      entityType: "memory_binding",
      entityId: binding.id,
      details: {
        key: binding.key,
        providerKey: binding.providerKey,
        enabled: binding.enabled,
        configKeys: Object.keys(binding.config ?? {}).sort(),
      },
    });
    res.status(201).json(binding);
  });

  router.patch("/memory/bindings/:bindingId", validate(updateMemoryBindingSchema), async (req, res) => {
    assertBoard(req);
    const bindingId = req.params.bindingId as string;
    const existing = await memory.getBindingById(bindingId);
    if (!existing) throw notFound("Memory binding not found");
    assertCompanyAccess(req, existing.companyId);
    const binding = await memory.updateBinding(bindingId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: binding.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.binding_updated",
      entityType: "memory_binding",
      entityId: binding.id,
      details: {
        changedKeys: Object.keys(req.body as Record<string, unknown>).sort(),
        enabled: binding.enabled,
        configKeys: Object.keys(binding.config ?? {}).sort(),
      },
    });
    res.json(binding);
  });

  router.put("/companies/:companyId/memory/default-binding", validate(setCompanyMemoryBindingSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const target = await memory.setCompanyDefault(companyId, req.body.bindingId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.default_set",
      entityType: "memory_binding",
      entityId: target.bindingId,
      details: {
        targetType: target.targetType,
        targetId: target.targetId,
      },
    });
    res.json(target);
  });

  router.get("/agents/:agentId/memory-binding", async (req, res) => {
    const agentId = req.params.agentId as string;
    const agent = await agentsSvc.getById(agentId);
    if (!agent) throw notFound("Agent not found");
    assertCompanyAccess(req, agent.companyId);
    res.json(await memory.resolveBinding(agent.companyId, { agentId: agent.id }));
  });

  router.put("/agents/:agentId/memory-binding", validate(setAgentMemoryBindingSchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const agent = await agentsSvc.getById(agentId);
    if (!agent) throw notFound("Agent not found");
    assertCompanyAccess(req, agent.companyId);
    assertBoard(req);
    const target = await memory.setAgentOverride(agent.id, req.body.bindingId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: target ? "memory.agent_override_set" : "memory.agent_override_cleared",
      entityType: "agent",
      entityId: agent.id,
      details: {
        bindingId: target?.bindingId ?? null,
      },
    });
    res.json(target);
  });

  router.get("/projects/:projectId/memory-binding", async (req, res) => {
    const projectId = req.params.projectId as string;
    const project = await projectsSvc.getById(projectId);
    if (!project) throw notFound("Project not found");
    assertCompanyAccess(req, project.companyId);
    res.json(await memory.resolveBinding(project.companyId, { projectId: project.id }));
  });

  router.put("/projects/:projectId/memory-binding", validate(setProjectMemoryBindingSchema), async (req, res) => {
    const projectId = req.params.projectId as string;
    const project = await projectsSvc.getById(projectId);
    if (!project) throw notFound("Project not found");
    assertCompanyAccess(req, project.companyId);
    assertBoard(req);
    const target = await memory.setProjectOverride(project.id, req.body.bindingId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: target ? "memory.project_override_set" : "memory.project_override_cleared",
      entityType: "project",
      entityId: project.id,
      details: {
        bindingId: target?.bindingId ?? null,
      },
    });
    res.json(target);
  });

  router.post("/companies/:companyId/memory/query", validate(memoryQuerySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const payload = req.body;
    if (req.actor.type === "agent" && payload.scope?.agentId && payload.scope.agentId !== req.actor.agentId) {
      throw forbidden("Agent cannot query memory for another agent scope");
    }
    res.json(await memory.query(companyId, payload, actorInfoFromReq(req)));
  });

  router.post("/companies/:companyId/memory/capture", validate(memoryCaptureSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const payload = req.body;
    if (req.actor.type === "agent" && payload.scope?.agentId && payload.scope.agentId !== req.actor.agentId) {
      throw forbidden("Agent cannot capture memory for another agent scope");
    }
    const result = await memory.capture(companyId, payload, actorInfoFromReq(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.captured",
      entityType: "memory_operation",
      entityId: result.operation.id,
      details: {
        bindingId: result.operation.bindingId,
        recordIds: result.records.map((record) => record.id),
        sourceKind: result.operation.source?.kind ?? null,
      },
    });
    res.status(201).json(result);
  });

  router.post("/companies/:companyId/memory/forget", validate(memoryForgetSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await memory.forget(companyId, req.body, actorInfoFromReq(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.forgotten",
      entityType: "memory_operation",
      entityId: result.operation.id,
      details: {
        forgottenRecordIds: result.forgottenRecordIds,
      },
    });
    res.json(result);
  });

  router.get("/companies/:companyId/memory/records", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = memoryListRecordsQuerySchema.parse(req.query);
    res.json(await memory.listRecords(companyId, parsed, actorInfoFromReq(req)));
  });

  router.get("/companies/:companyId/memory/records/:recordId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const record = await memory.getRecord(companyId, req.params.recordId as string, actorInfoFromReq(req));
    if (!record) throw notFound("Memory record not found");
    res.json(record);
  });

  router.post("/companies/:companyId/memory/revoke", validate(memoryRevokeSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await memory.revoke(companyId, req.body, actorInfoFromReq(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.revoked",
      entityType: "memory_record",
      entityId: result.revokedRecordIds[0] ?? "none",
      details: {
        revokedRecordIds: result.revokedRecordIds,
        selector: req.body.selector,
        reason: req.body.reason,
      },
    });
    res.json(result);
  });

  router.post("/companies/:companyId/memory/records/:recordId/correct", validate(memoryCorrectSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await memory.correct(companyId, req.params.recordId as string, req.body, actorInfoFromReq(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.corrected",
      entityType: "memory_record",
      entityId: result.correctedRecord.id,
      details: {
        originalRecordId: result.originalRecord.id,
        correctedRecordId: result.correctedRecord.id,
        reason: req.body.reason,
      },
    });
    res.status(201).json(result);
  });

  router.patch("/companies/:companyId/memory/records/:recordId/review", validate(memoryReviewSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await memory.review(companyId, req.params.recordId as string, req.body, actorInfoFromReq(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.reviewed",
      entityType: "memory_record",
      entityId: result.record.id,
      details: {
        recordId: result.record.id,
        reviewState: result.record.reviewState,
      },
    });
    res.json(result);
  });

  router.post("/companies/:companyId/memory/retention/sweep", validate(memoryRetentionSweepSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await memory.sweepRetention(companyId, req.body, actorInfoFromReq(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.retention_swept",
      entityType: "memory_record",
      entityId: result.expiredRecordIds[0] ?? "none",
      details: {
        expiredRecordIds: result.expiredRecordIds,
      },
    });
    res.json(result);
  });

  router.get("/companies/:companyId/memory/operations", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const parsed = memoryListOperationsQuerySchema.parse(req.query);
    res.json(await memory.listOperations(companyId, parsed));
  });

  router.get("/companies/:companyId/memory/extraction-jobs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const parsed = memoryListExtractionJobsQuerySchema.parse(req.query);
    res.json(await memory.listExtractionJobs(companyId, parsed));
  });

  router.post("/companies/:companyId/memory/refresh-jobs", validate(memoryRefreshJobSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await memory.startRefreshJob(companyId, req.body, actorInfoFromReq(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "memory.refresh_job_started",
      entityType: "background_job_run",
      entityId: result.run.id,
      details: {
        jobId: result.job.id,
        dryRun: result.dryRun,
        sourceCounts: result.sourceCounts,
      },
    });
    res.status(202).json(result);
  });

  return router;
}
