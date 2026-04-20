import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createBackgroundJobRunSchema,
  createBackgroundJobSchema,
  listBackgroundJobRunsQuerySchema,
  listBackgroundJobsQuerySchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { backgroundJobService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function backgroundJobRoutes(db: Db) {
  const router = Router();
  const jobs = backgroundJobService(db);

  router.get("/companies/:companyId/background-jobs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const parsed = listBackgroundJobsQuerySchema.parse(req.query);
    res.json(await jobs.listJobs(companyId, parsed));
  });

  router.post("/companies/:companyId/background-jobs", validate(createBackgroundJobSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const actor = getActorInfo(req);
    const job = await jobs.createOrUpdateJob(companyId, req.body, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      userId: actor.userId,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "background_job.upserted",
      entityType: "background_job",
      entityId: job.id,
      details: {
        key: job.key,
        jobType: job.jobType,
        backendKind: job.backendKind,
      },
    });
    res.status(201).json(job);
  });

  router.get("/companies/:companyId/background-job-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const parsed = listBackgroundJobRunsQuerySchema.parse(req.query);
    res.json(await jobs.listRuns(companyId, parsed));
  });

  router.post("/companies/:companyId/background-job-runs", validate(createBackgroundJobRunSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const actor = getActorInfo(req);
    const run = await jobs.createRun(companyId, req.body, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      userId: actor.userId,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "background_job_run.created",
      entityType: "background_job_run",
      entityId: run.id,
      details: {
        jobKey: run.jobKey,
        jobType: run.jobType,
        trigger: run.trigger,
      },
    });
    res.status(201).json(run);
  });

  router.get("/companies/:companyId/background-job-runs/:runId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    res.json(await jobs.getRun(companyId, req.params.runId as string));
  });

  router.get("/companies/:companyId/background-job-runs/:runId/events", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const limit = Number(req.query.limit ?? 200);
    res.json(await jobs.listRunEvents(companyId, req.params.runId as string, Number.isFinite(limit) ? limit : 200));
  });

  router.post("/companies/:companyId/background-job-runs/:runId/cancel", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const actor = getActorInfo(req);
    const run = await jobs.requestCancelRun(companyId, req.params.runId as string);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "background_job_run.cancel_requested",
      entityType: "background_job_run",
      entityId: run.id,
      details: {
        jobKey: run.jobKey,
        jobType: run.jobType,
      },
    });
    res.json(run);
  });

  return router;
}
