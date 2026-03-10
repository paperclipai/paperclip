import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { recordService } from "../services/records.js";
import { knowledgeService } from "../services/knowledge.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity } from "../services/index.js";

export function knowledgeRoutes(db: Db) {
  const router = Router();
  const svc = knowledgeService(db);
  const recordsSvc = recordService(db);

  router.get("/companies/:companyId/knowledge", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await svc.list(companyId);
    res.json(rows);
  });

  router.get("/knowledge/:entryId", async (req, res) => {
    const entryId = req.params.entryId as string;
    const entry = await svc.getById(entryId);
    if (!entry) {
      res.status(404).json({ error: "Knowledge entry not found" });
      return;
    }
    assertCompanyAccess(req, entry.companyId);
    res.json(entry);
  });

  router.post("/records/:recordId/publish-to-knowledge", async (req, res) => {
    const recordId = req.params.recordId as string;
    const record = await recordsSvc.getById(recordId);
    if (!record) {
      res.status(404).json({ error: "Record not found" });
      return;
    }
    assertCompanyAccess(req, record.companyId);
    const entry = await svc.publishRecord(recordId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: entry.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "knowledge.published",
      entityType: "knowledge_entry",
      entityId: entry.id,
      details: { sourceRecordId: entry.sourceRecordId, kind: entry.kind },
    });
    res.status(201).json(entry);
  });

  return router;
}
