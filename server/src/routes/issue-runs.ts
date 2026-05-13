import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueRuns } from "@paperclipai/db";
import {
  acquireIssueRunSchema,
  heartbeatIssueRunSchema,
  releaseIssueRunSchema,
  recoverStaleIssueRunsSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { issueRunsService } from "../services/issue-runs.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import { notFound } from "../errors.js";

/**
 * Internal issue-runs HTTP API — Jarvis-OS Phase-4 (Marco-Decision 4D-8).
 *
 * Hermes and other executors call these endpoints instead of touching the DB
 * directly. All endpoints require board-level auth. Per-issue-run mutations are
 * scoped to the run's companyId via assertCompanyAccess. The cross-company
 * recover-stale endpoint requires instance-admin.
 */
export function issueRunRoutes(db: Db) {
  const router = Router();
  const svc = issueRunsService(db);

  async function getRunOrThrow(runId: string) {
    const rows = await db.select().from(issueRuns).where(eq(issueRuns.runId, runId)).limit(1);
    if (!rows[0]) {
      throw notFound("issue_run not found");
    }
    return rows[0];
  }

  router.post(
    "/api/internal/issue-runs/acquire",
    validate(acquireIssueRunSchema),
    async (req, res) => {
      assertBoard(req);
      assertCompanyAccess(req, req.body.companyId as string);
      const result = await svc.acquire(req.body);
      res.status(result.acquired ? 201 : 409).json(result);
    },
  );

  router.post(
    "/api/internal/issue-runs/:runId/heartbeat",
    validate(heartbeatIssueRunSchema.omit({ runId: true })),
    async (req, res) => {
      assertBoard(req);
      const runId = req.params.runId as string;
      const run = await getRunOrThrow(runId);
      assertCompanyAccess(req, run.companyId);
      const result = await svc.heartbeat({ ...req.body, runId });
      res.status(result.ok ? 200 : 409).json(result);
    },
  );

  router.post(
    "/api/internal/issue-runs/:runId/release",
    validate(releaseIssueRunSchema.omit({ runId: true })),
    async (req, res) => {
      assertBoard(req);
      const runId = req.params.runId as string;
      const run = await getRunOrThrow(runId);
      assertCompanyAccess(req, run.companyId);
      const result = await svc.release({ ...req.body, runId });
      res.status(result.ok ? 200 : 409).json(result);
    },
  );

  router.post(
    "/api/internal/issue-runs/recover-stale",
    validate(recoverStaleIssueRunsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const result = await svc.recoverStale(req.body);
      res.json(result);
    },
  );

  return router;
}
