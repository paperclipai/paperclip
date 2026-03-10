import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  boardSummaryQuerySchema,
  createBriefingRecordSchema,
  createPlanRecordSchema,
  createRecordAttachmentSchema,
  createRecordLinkSchema,
  createResultRecordSchema,
  generateRecordSchema,
  promoteToResultSchema,
  publishRecordSchema,
  upsertBriefingScheduleSchema,
  updateRecordSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { badRequest } from "../errors.js";
import { knowledgeService, logActivity, recordService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

function readBoardViewUserId(req: Parameters<typeof getActorInfo>[0]) {
  if (req.actor.type !== "board") return null;
  return req.actor.userId ?? "local-board";
}

function parseRecordFilters(query: Record<string, unknown>) {
  return {
    status: typeof query.status === "string" ? query.status : undefined,
    kind: typeof query.kind === "string" ? query.kind : undefined,
    scopeType: typeof query.scopeType === "string" ? query.scopeType as "company" | "project" | "agent" : undefined,
    scopeRefId: typeof query.scopeRefId === "string" ? query.scopeRefId : undefined,
    ownerAgentId: typeof query.ownerAgentId === "string" ? query.ownerAgentId : undefined,
    projectId: typeof query.projectId === "string" ? query.projectId : undefined,
    q: typeof query.q === "string" ? query.q : undefined,
  };
}

export function recordRoutes(db: Db) {
  const router = Router();
  const svc = recordService(db);
  const knowledgeSvc = knowledgeService(db);

  router.get("/companies/:companyId/plans", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await svc.listPlans(companyId, parseRecordFilters(req.query));
    res.json(rows);
  });

  router.post("/companies/:companyId/plans", validate(createPlanRecordSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const record = await svc.createPlan(companyId, req.body, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "record.created",
      entityType: "record",
      entityId: record.id,
      details: { category: record.category, kind: record.kind, scopeType: record.scopeType, scopeRefId: record.scopeRefId },
    });
    res.status(201).json(record);
  });

  router.get("/companies/:companyId/results", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await svc.listResults(companyId, parseRecordFilters(req.query));
    res.json(rows);
  });

  router.post("/companies/:companyId/results", validate(createResultRecordSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const record = await svc.createResult(companyId, req.body, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "record.created",
      entityType: "record",
      entityId: record.id,
      details: { category: record.category, kind: record.kind, scopeType: record.scopeType, scopeRefId: record.scopeRefId },
    });
    res.status(201).json(record);
  });

  router.post("/companies/:companyId/results/promote", validate(promoteToResultSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const record = await svc.promoteToResult(companyId, req.body, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "record.promoted_to_result",
      entityType: "record",
      entityId: record.id,
      details: { sourceType: req.body.sourceType, sourceId: req.body.sourceId, kind: record.kind },
    });
    res.status(201).json(record);
  });

  router.get("/companies/:companyId/briefings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await svc.listBriefings(companyId, parseRecordFilters(req.query));
    res.json(rows);
  });

  router.post("/companies/:companyId/briefings", validate(createBriefingRecordSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const record = await svc.createBriefing(companyId, req.body, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "record.created",
      entityType: "record",
      entityId: record.id,
      details: { category: record.category, kind: record.kind, scopeType: record.scopeType, scopeRefId: record.scopeRefId },
    });
    res.status(201).json(record);
  });

  router.get("/companies/:companyId/briefings/board", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = boardSummaryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest("Invalid board query", parsed.error.issues);
    }
    const scopeType = parsed.data.scopeType;
    const scopeRefId = parsed.data.scopeId ?? companyId;
    if (scopeType !== "company" && !parsed.data.scopeId) {
      throw badRequest("scopeId is required for project and agent boards");
    }
    const summary = await svc.boardSummary(companyId, scopeType, scopeRefId, {
      since: parsed.data.since,
      userId: readBoardViewUserId(req),
      markViewed: parsed.data.since === undefined || parsed.data.since === "last_visit",
    });
    res.json(summary);
  });

  router.get("/companies/:companyId/briefings/portfolio", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = boardSummaryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest("Invalid portfolio query", parsed.error.issues);
    }
    const scopeType = parsed.data.scopeType;
    const scopeRefId = parsed.data.scopeId ?? companyId;
    if (scopeType !== "company" && !parsed.data.scopeId) {
      throw badRequest("scopeId is required for project and agent portfolio views");
    }
    const summary = await svc.portfolioSummary(companyId, scopeType, scopeRefId);
    res.json(summary);
  });

  router.get("/records/:recordId", async (req, res) => {
    const recordId = req.params.recordId as string;
    const record = await svc.getById(recordId);
    if (!record) {
      res.status(404).json({ error: "Record not found" });
      return;
    }
    assertCompanyAccess(req, record.companyId);
    res.json(record);
  });

  router.patch("/records/:recordId", validate(updateRecordSchema), async (req, res) => {
    const recordId = req.params.recordId as string;
    const existing = await svc.getById(recordId);
    if (!existing) {
      res.status(404).json({ error: "Record not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);
    const record = await svc.update(recordId, req.body, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    if (!record) {
      res.status(404).json({ error: "Record not found" });
      return;
    }
    await logActivity(db, {
      companyId: record.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "record.updated",
      entityType: "record",
      entityId: record.id,
      details: { changedKeys: Object.keys(req.body).sort() },
    });
    res.json(record);
  });

  router.post("/records/:recordId/links", validate(createRecordLinkSchema), async (req, res) => {
    const recordId = req.params.recordId as string;
    const existing = await svc.getById(recordId);
    if (!existing) {
      res.status(404).json({ error: "Record not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);
    const link = await svc.addLink(recordId, req.body);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "record.link_added",
      entityType: "record",
      entityId: recordId,
      details: { targetType: link.targetType, targetId: link.targetId, relation: link.relation },
    });
    res.status(201).json(link);
  });

  router.post("/records/:recordId/attachments", validate(createRecordAttachmentSchema), async (req, res) => {
    const recordId = req.params.recordId as string;
    const existing = await svc.getById(recordId);
    if (!existing) {
      res.status(404).json({ error: "Record not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);
    const attachment = await svc.addAttachment(recordId, req.body);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "record.attachment_added",
      entityType: "record",
      entityId: recordId,
      details: { assetId: attachment.assetId, contentType: attachment.asset.contentType, byteSize: attachment.asset.byteSize },
    });
    res.status(201).json(attachment);
  });

  router.post("/records/:recordId/generate", validate(generateRecordSchema), async (req, res) => {
    const recordId = req.params.recordId as string;
    const existing = await svc.getById(recordId);
    if (!existing) {
      res.status(404).json({ error: "Record not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);
    const record = await svc.generate(recordId, req.body, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId: record.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "record.generated",
      entityType: "record",
      entityId: record.id,
      details: { category: record.category, kind: record.kind, since: req.body.since ?? null },
    });
    res.json(record);
  });

  router.get("/records/:recordId/schedule", async (req, res) => {
    const recordId = req.params.recordId as string;
    const existing = await svc.getById(recordId);
    if (!existing) {
      res.status(404).json({ error: "Record not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const schedule = await svc.getSchedule(recordId);
    if (!schedule) {
      res.status(404).json({ error: "Briefing schedule not found" });
      return;
    }
    res.json(schedule);
  });

  router.put("/records/:recordId/schedule", validate(upsertBriefingScheduleSchema), async (req, res) => {
    const recordId = req.params.recordId as string;
    const existing = await svc.getById(recordId);
    if (!existing) {
      res.status(404).json({ error: "Record not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);
    const schedule = await svc.upsertSchedule(recordId, req.body);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "record.schedule_upserted",
      entityType: "record",
      entityId: recordId,
      details: {
        cadence: schedule.cadence,
        timezone: schedule.timezone,
        localHour: schedule.localHour,
        localMinute: schedule.localMinute,
        dayOfWeek: schedule.dayOfWeek,
        autoPublish: schedule.autoPublish,
      },
    });
    res.json(schedule);
  });

  router.delete("/records/:recordId/schedule", async (req, res) => {
    const recordId = req.params.recordId as string;
    const existing = await svc.getById(recordId);
    if (!existing) {
      res.status(404).json({ error: "Record not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);
    const schedule = await svc.deleteSchedule(recordId);
    if (!schedule) {
      res.status(404).json({ error: "Briefing schedule not found" });
      return;
    }
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "record.schedule_deleted",
      entityType: "record",
      entityId: recordId,
      details: { scheduleId: schedule.id },
    });
    res.json(schedule);
  });

  router.post("/records/:recordId/publish", validate(publishRecordSchema), async (req, res) => {
    const recordId = req.params.recordId as string;
    const existing = await svc.getById(recordId);
    if (!existing) {
      res.status(404).json({ error: "Record not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);
    const record = await svc.publish(recordId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId: record.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "record.published",
      entityType: "record",
      entityId: record.id,
      details: { category: record.category, kind: record.kind, status: record.status },
    });
    const knowledgeEntry = await knowledgeSvc.autoPublishEligibleRecord(record.id);
    if (knowledgeEntry) {
      await logActivity(db, {
        companyId: knowledgeEntry.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "knowledge.published",
        entityType: "knowledge_entry",
        entityId: knowledgeEntry.id,
        details: { sourceRecordId: knowledgeEntry.sourceRecordId, kind: knowledgeEntry.kind, autoPublished: true },
      });
    }
    res.json(record);
  });

  return router;
}
