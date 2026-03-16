import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { llmProvidersService } from "../services/llm-providers.js";
import { listProviderModules } from "../services/llm-provider-modules/index.js";

export function llmModelsRoutes(db: Db) {
  const router = Router();
  const llmService = llmProvidersService(db);

  // GET /api/llm-providers
  router.get("/providers", async (req, res) => {
    const providers = listProviderModules().map((m) => ({
      type: m.type,
      label: m.label,
    }));
    res.json(providers);
  });

  // GET /api/llm-providers/:provider/models
  router.get("/:provider/models", async (req, res) => {
    const provider = req.params.provider as string;
    const userApiKey = req.query.apiKey as string | undefined;
    const baseUrl = req.query.baseUrl as string | undefined;

    try {
      // Try to get cached models
      let models;
      const cached = await llmService.getCachedModels(provider as any);

      if (cached.length > 0) {
        models = cached.map((c) => ({
          id: c.modelId,
          ...c.metadata,
        }));
      } else {
        // Fetch fresh models
        models = await llmService.syncModels(provider as any, userApiKey, baseUrl);
        models = models.map((m) => ({
          id: m.id,
          ...m.metadata,
        }));
      }

      // Pagination
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const offset = parseInt(req.query.offset as string) || 0;
      const search = ((req.query.search as string) || "").toLowerCase();

      const filtered = models.filter((m: any) => {
        if (!search) return true;
        const searchText = `${m.name || m.id || ""}`.toLowerCase();
        return searchText.includes(search);
      });

      res.json({
        total: filtered.length,
        limit,
        offset,
        models: filtered.slice(offset, offset + limit),
      });
    } catch (error) {
      res.status(400).json({
        total: 0,
        limit: 0,
        offset: 0,
        models: [],
        error: error instanceof Error ? error.message : "Failed to fetch models",
      });
    }
  });

  return router;
}
