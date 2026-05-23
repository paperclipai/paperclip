import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { sessionResumeService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity } from "../services/index.js";

export function sessionResumeRoutes(db: Db) {
  const router = Router();
  const svc = sessionResumeService(db);

  // Start a new session
  router.post("/companies/:companyId/sessions/start", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const { agentId, branch } = req.body;
      const session = await svc.startSession(companyId, agentId, branch);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "session.started",
        entityType: "session",
        entityId: session.id,
      });

      res.status(201).json(session);
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Capture a snapshot
  router.post("/sessions/:sessionId/snapshot", async (req, res) => {
    try {
      const { sessionId } = req.params;
      const snapshotData = req.body;

      const snapshot = await svc.captureSnapshot(sessionId, snapshotData);
      res.status(201).json(snapshot);
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // End a session
  router.post("/sessions/:sessionId/end", async (req, res) => {
    try {
      const { sessionId } = req.params;
      const session = await svc.endSession(sessionId);
      res.json(session);
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Get last session resume
  router.get("/companies/:companyId/sessions/resume", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const agentId = req.query.agentId as string | undefined;
      const resume = await svc.getLastSessionResume(companyId, agentId);

      if (!resume) {
        res.status(404).json({ error: "No session resume found" });
        return;
      }

      res.json(resume);
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Get activity summary
  router.get("/companies/:companyId/sessions/activity", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const days = parseInt(req.query.days as string) || 7;
      const summary = await svc.getActivitySummary(companyId, days);

      res.json(summary);
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  return router;
}
