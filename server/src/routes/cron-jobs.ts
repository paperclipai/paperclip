import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createCronJobSchema,
  updateCronJobSchema,
  listCronJobsQuerySchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { cronSchedulerService } from "../services/cron-scheduler.js";
import { heartbeatService } from "../services/heartbeat.js";
import { logActivity } from "../services/activity-log.js";
import { notFound, unprocessable } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function cronJobRoutes(db: Db) {
  const router = Router();
  const heartbeat = heartbeatService(db);
  const cronScheduler = cronSchedulerService(db, heartbeat);

  // List cron jobs
  router.get("/companies/:companyId/cron-jobs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const query = listCronJobsQuerySchema.parse(req.query);
    const filters: { agentId?: string; enabled?: boolean } = {};
    if (query.agentId) filters.agentId = query.agentId;
    if (query.enabled !== undefined) filters.enabled = query.enabled === "true";

    const jobs = await cronScheduler.listJobs(companyId, filters);
    res.json(jobs);
  });

  // Create cron job
  router.post("/companies/:companyId/cron-jobs", validate(createCronJobSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const actor = getActorInfo(req);

    try {
      const job = await cronScheduler.createJob(companyId, {
        ...req.body,
        createdBy: actor.actorId,
      });

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "cron_job.created",
        entityType: "cron_job",
        entityId: job.id,
        details: { name: job.name, cronExpr: job.cronExpr, agentId: job.agentId },
      });

      res.status(201).json(job);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Invalid cron expression")) {
        throw unprocessable(err.message);
      }
      throw err;
    }
  });

  // Get single cron job
  router.get("/companies/:companyId/cron-jobs/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const job = await cronScheduler.getJob(req.params.id as string);
    if (!job || job.companyId !== companyId) throw notFound("Cron job not found");
    res.json(job);
  });

  // Update cron job
  router.patch("/companies/:companyId/cron-jobs/:id", validate(updateCronJobSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const existing = await cronScheduler.getJob(req.params.id as string);
    if (!existing || existing.companyId !== companyId) throw notFound("Cron job not found");

    const actor = getActorInfo(req);

    try {
      const updated = await cronScheduler.updateJob(existing.id, req.body);
      if (!updated) throw notFound("Cron job not found");

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "cron_job.updated",
        entityType: "cron_job",
        entityId: updated.id,
        details: { changes: Object.keys(req.body) },
      });

      res.json(updated);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Invalid cron expression")) {
        throw unprocessable(err.message);
      }
      throw err;
    }
  });

  // Delete cron job
  router.delete("/companies/:companyId/cron-jobs/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const existing = await cronScheduler.getJob(req.params.id as string);
    if (!existing || existing.companyId !== companyId) throw notFound("Cron job not found");

    const actor = getActorInfo(req);

    await cronScheduler.deleteJob(existing.id);

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "cron_job.deleted",
      entityType: "cron_job",
      entityId: existing.id,
      details: { name: existing.name },
    });

    res.status(204).end();
  });

  // Trigger cron job immediately
  router.post("/companies/:companyId/cron-jobs/:id/run", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const existing = await cronScheduler.getJob(req.params.id as string);
    if (!existing || existing.companyId !== companyId) throw notFound("Cron job not found");

    const actor = getActorInfo(req);

    const result = await cronScheduler.triggerJobNow(existing.id);

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "cron_job.triggered",
      entityType: "cron_job",
      entityId: existing.id,
      details: { name: existing.name },
    });

    res.status(202).json({ triggered: true, runId: result?.run?.id ?? null });
  });

  return router;
}
