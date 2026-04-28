import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  applyRt2KnowledgeVaultImportSchema,
  getRt2DailyWikiPageSchema,
  getRt2WikiPageSchema,
  listRt2DailyWikiPagesSchema,
  listRt2WikiPagesSchema,
  previewRt2KnowledgeVaultImportSchema,
  projectRt2KnowledgeSchema,
  rebuildRt2DailyWikiSchema,
  resolveRt2KnowledgeVaultConflictSchema,
  saveRt2KnowledgeVaultWriterSettingsSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { rt2KnowledgeProjectorService } from "../services/rt2-knowledge-projector.js";
import { assertCompanyAccess } from "./authz.js";

export function rt2KnowledgeRoutes(db: Db) {
  const router = Router();
  const svc = rt2KnowledgeProjectorService(db);

  router.get("/companies/:companyId/rt2/wiki-pages", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = listRt2WikiPagesSchema.parse(req.query);
    res.json(await svc.listWikiPages(companyId, query));
  });

  router.get("/companies/:companyId/rt2/wiki-page", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { pageKey } = getRt2WikiPageSchema.parse({ pageKey: req.query.pageKey });
    res.json(await svc.getWikiPage(companyId, pageKey));
  });

  router.get("/companies/:companyId/rt2/knowledge/vault-export", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = listRt2WikiPagesSchema.parse(req.query);
    res.json(await svc.exportObsidianVault(companyId, query));
  });

  router.get("/companies/:companyId/rt2/knowledge/vault-writer", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getVaultWriterSettings(companyId));
  });

  router.post(
    "/companies/:companyId/rt2/knowledge/vault-writer",
    validate(saveRt2KnowledgeVaultWriterSettingsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const body = saveRt2KnowledgeVaultWriterSettingsSchema.parse(req.body ?? {});
      const result = await svc.saveVaultWriterSettings(companyId, body);
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "rt2-knowledge-bridge",
        action: "rt2.knowledge.vault_writer_saved",
        entityType: "knowledge_vault",
        entityId: result.vaultName,
        details: { exportPath: result.exportPath, writerMode: result.writerMode },
      });
      res.json(result);
    },
  );

  router.post("/companies/:companyId/rt2/knowledge/vault-writer/dry-run", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.dryRunVaultWriter(companyId));
  });

  router.post(
    "/companies/:companyId/rt2/knowledge/vault-import-preview",
    validate(previewRt2KnowledgeVaultImportSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const body = previewRt2KnowledgeVaultImportSchema.parse(req.body ?? {});
      res.json(await svc.previewObsidianVaultImport(companyId, body));
    },
  );

  router.post(
    "/companies/:companyId/rt2/knowledge/vault-import-apply",
    validate(applyRt2KnowledgeVaultImportSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const body = applyRt2KnowledgeVaultImportSchema.parse(req.body ?? {});
      const result = await svc.applyObsidianVaultImport(companyId, body);
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "rt2-knowledge-bridge",
        action: "rt2.knowledge.vault_import_applied",
        entityType: "knowledge_vault",
        entityId: body.vaultName ?? "vault-import",
        details: {
          approvedCandidateIds: result.appliedCandidateIds,
          updatedWikiPages: result.updatedWikiPages,
          updatedGraphNodes: result.updatedGraphNodes,
          updatedGraphEdges: result.updatedGraphEdges,
          auditId: result.auditId,
        },
      });
      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/rt2/knowledge/vault-conflict-resolve",
    validate(resolveRt2KnowledgeVaultConflictSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const body = resolveRt2KnowledgeVaultConflictSchema.parse(req.body ?? {});
      const result = await svc.resolveObsidianVaultConflict(companyId, body, "rt2-operator");
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "rt2-knowledge-bridge",
        action: "rt2.knowledge.vault_conflict_resolved",
        entityType: "wiki_page",
        entityId: result.pageKey,
        details: { decision: result.decision, applied: result.applied, auditId: result.auditId },
      });
      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/rt2/knowledge/project",
    validate(projectRt2KnowledgeSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const body = projectRt2KnowledgeSchema.parse(req.body ?? {});
      res.json(await svc.projectAll(companyId, body.limit));
    },
  );

  router.get("/companies/:companyId/rt2/knowledge/daily/wiki-pages", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = listRt2DailyWikiPagesSchema.parse(req.query);
    res.json(await svc.listDailyWikiPages(companyId, query));
  });

  router.get("/companies/:companyId/rt2/knowledge/daily/index", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = listRt2DailyWikiPagesSchema.parse(req.query);
    res.json(await svc.listDailyWikiPages(companyId, query));
  });

  router.get("/companies/:companyId/rt2/knowledge/daily/wiki-page", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { date, userId } = getRt2DailyWikiPageSchema.parse(req.query);
    res.json(await svc.getDailyWikiPage(companyId, date, userId));
  });

  router.get("/companies/:companyId/rt2/knowledge/daily", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { date, userId } = getRt2DailyWikiPageSchema.parse(req.query);
    res.json(await svc.getDailyWikiPage(companyId, date, userId));
  });

  router.post(
    "/companies/:companyId/rt2/knowledge/daily/rebuild",
    validate(rebuildRt2DailyWikiSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.projectAllDaily(companyId);
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "rt2-daily-wiki-projector",
        action: "rt2.knowledge.daily_wiki_rebuilt",
        entityType: "daily_wiki_page",
        entityId: companyId,
        details: { projectedDates: result.projectedDates, totalPages: result.totalPages },
      });
      res.json(result);
    },
  );

  return router;
}
