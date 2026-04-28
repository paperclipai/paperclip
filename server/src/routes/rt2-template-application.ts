import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { applyTemplateToCompany, previewTemplateApplication } from "../services/rt2-template-application.js";
import { assertCompanyAccess } from "./authz.js";

export function rt2TemplateApplicationRoutes(db: Db) {
  const router = Router();

  /**
   * POST /companies/:companyId/rt2/templates/:templateId/apply
   * Apply a template to create organizational structures
   */
  router.post("/companies/:companyId/rt2/templates/:templateId/apply", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      const templateId = req.params.templateId;

      assertCompanyAccess(req, companyId);

      const result = await applyTemplateToCompany(db, templateId, companyId);

      if (!result.success) {
        return res.status(400).json({
          error: "Template application failed",
          details: result.errors,
          result,
        });
      }

      return res.status(201).json(result);
    } catch (error) {
      console.error("Error applying template:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /companies/:companyId/rt2/templates/:templateId/preview
   * Preview what a template will create
   */
  router.get("/companies/:companyId/rt2/templates/:templateId/preview", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      const templateId = req.params.templateId;

      assertCompanyAccess(req, companyId);

      const preview = await previewTemplateApplication(db, templateId, companyId);

      if (!preview) {
        return res.status(404).json({ error: "Template not found" });
      }

      return res.json(preview);
    } catch (error) {
      console.error("Error previewing template:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
