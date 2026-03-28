import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { activityService } from "../services/activity.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { issueService } from "../services/index.js";
import { sanitizeRecord } from "../redaction.js";

const createActivitySchema = z.object({
  actorType: z.enum(["agent", "user", "system"]).optional().default("system"),
  actorId: z.string().min(1),
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  agentId: z.string().uuid().optional().nullable(),
  details: z.record(z.unknown()).optional().nullable(),
});

export function activityRoutes(db: Db) {
  const router = Router();
  const svc = activityService(db);
  const issueSvc = issueService(db);

  function readQueryString(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const first = value.find((entry): entry is string => typeof entry === "string");
      return first;
    }
    return undefined;
  }

  async function resolveIssueByRef(rawId: string) {
    if (/^[A-Z]+-\d+$/i.test(rawId)) {
      return { issue: await issueSvc.getByIdentifier(rawId), invalidRef: false };
    }
    if (isUuidLike(rawId)) {
      return { issue: await issueSvc.getById(rawId), invalidRef: false };
    }
    return { issue: null, invalidRef: true };
  }

  router.get("/companies/:companyId/activity", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const agentId = readQueryString(req.query.agentId);
    if (agentId && !isUuidLike(agentId)) {
      res.status(400).json({ error: "Invalid agentId filter" });
      return;
    }

    const filters = {
      companyId,
      agentId,
      entityType: readQueryString(req.query.entityType),
      entityId: readQueryString(req.query.entityId),
    };
    const result = await svc.list(filters);
    res.json(result);
  });

  router.post("/companies/:companyId/activity", validate(createActivitySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    const event = await svc.create({
      companyId,
      ...req.body,
      details: req.body.details ? sanitizeRecord(req.body.details) : null,
    });
    res.status(201).json(event);
  });

  router.get("/issues/:id/activity", async (req, res) => {
    const rawId = req.params.id as string;
    const { issue, invalidRef } = await resolveIssueByRef(rawId);
    if (invalidRef) {
      res.status(400).json({ error: "Invalid issue id. Use UUID or identifier like PAP-123." });
      return;
    }
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const result = await svc.forIssue(issue.id);
    res.json(result);
  });

  router.get("/issues/:id/runs", async (req, res) => {
    const rawId = req.params.id as string;
    const { issue, invalidRef } = await resolveIssueByRef(rawId);
    if (invalidRef) {
      res.status(400).json({ error: "Invalid issue id. Use UUID or identifier like PAP-123." });
      return;
    }
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const result = await svc.runsForIssue(issue.companyId, issue.id);
    res.json(result);
  });

  router.get("/heartbeat-runs/:runId/issues", async (req, res) => {
    const runId = req.params.runId as string;
    const result = await svc.issuesForRun(runId);
    res.json(result);
  });

  return router;
}
