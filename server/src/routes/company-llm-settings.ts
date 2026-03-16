import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { llmProvidersService } from "../services/llm-providers.js";
import { z } from "zod";

const setCompanySettingsSchema = z.object({
  preferredProviderType: z.string().min(1),
  preferredModelId: z.string().min(1),
});

export function companyLlmSettingsRoutes(db: Db) {
  const router = Router({ mergeParams: true });
  const llmService = llmProvidersService(db);

  // GET /api/companies/:companyId/llm-settings
  router.get("/", async (req, res) => {
    const companyId = (req.params as any).companyId as string;
    const actor = req.actor as any;

    // Check company access (allow if local_implicit or admin)
    const isAllowed =
      actor.source === "local_implicit" ||
      actor.isInstanceAdmin ||
      actor.companyIds?.includes(companyId);
    if (!isAllowed) {
      return res.status(403).json({ error: "Access denied" });
    }

    try {
      const settings = await llmService.getCompanySettings(companyId);
      res.json(settings || { companyId, preferredProviderType: null, preferredModelId: null });
    } catch (error) {
      res.status(500).json({ error: "Failed to get settings" });
    }
  });

  // POST /api/companies/:companyId/llm-settings
  router.post("/", validate(setCompanySettingsSchema), async (req, res) => {
    const companyId = (req.params as any).companyId as string;
    const actor = req.actor as any;

    // Check company access (allow if local_implicit or admin)
    const isAllowed =
      actor.source === "local_implicit" ||
      actor.isInstanceAdmin ||
      actor.companyIds?.includes(companyId);
    if (!isAllowed) {
      return res.status(403).json({ error: "Access denied" });
    }

    try {
      const settings = await llmService.setCompanySettings(
        companyId,
        req.body.preferredProviderType as any,
        req.body.preferredModelId,
      );

      res.json(settings);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Failed to set settings" });
    }
  });

  return router;
}
