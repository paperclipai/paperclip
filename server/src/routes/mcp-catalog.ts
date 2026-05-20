// LET-515 — canonical MCP catalog read + safe-install preview route.
//
// Endpoints (all require company access; nothing here mutates state):
//   GET  /companies/:companyId/mcp-catalog
//     → { entries: McpCatalogListEntry[] } from the canonical, allowlisted set.
//   POST /companies/:companyId/mcp-catalog/preview
//     body: { catalogId, namedSecretRefs?: string[] }
//     → McpCatalogPreviewResult — preview-only. Refuses non-allowlisted
//       catalog ids, refuses raw-secret-shaped values, and surfaces blockers
//       (verifiedPublisher, sourceAvailable, required-secret-refs missing).
//
// The route NEVER calls capability-apply, NEVER mutates agent config, and
// NEVER returns secret values. Tests live in `__tests__/mcp-catalog-routes.test.ts`.

import { Router } from "express";
import { z } from "zod";
import { CAPABILITY_APPLY_ERROR_CODES } from "@paperclipai/shared";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  McpCatalogError,
  mcpCatalogService,
  type McpCatalogService,
} from "../services/mcp-catalog.js";
import { assertCompanyAccess } from "./authz.js";

const previewSchema = z.object({
  catalogId: z.string().min(1).max(240),
  namedSecretRefs: z.array(z.string().min(1).max(120)).max(16).optional(),
});

export interface McpCatalogRouteOptions {
  catalog?: McpCatalogService;
}

export function mcpCatalogRoutes(opts: McpCatalogRouteOptions = {}) {
  const router = Router();
  const svc = opts.catalog ?? mcpCatalogService();

  router.get("/companies/:companyId/mcp-catalog", async (req, res) => {
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(req, companyId);
    res.json({ entries: svc.listCatalog() });
  });

  router.post(
    "/companies/:companyId/mcp-catalog/preview",
    validate(previewSchema),
    async (req, res) => {
      const { companyId } = req.params as { companyId: string };
      assertCompanyAccess(req, companyId);
      try {
        const result = svc.previewInstall(req.body as z.infer<typeof previewSchema>);
        res.json(result);
      } catch (err) {
        if (err instanceof McpCatalogError) {
          const code = err.code;
          if (code === "MCP_CATALOG_NOT_FOUND") {
            throw notFound(err.message, { code, ...err.details });
          }
          if (
            code === CAPABILITY_APPLY_ERROR_CODES.CATALOG_NOT_ALLOWLISTED ||
            code === CAPABILITY_APPLY_ERROR_CODES.EGRESS_BLOCKED
          ) {
            throw unprocessable(err.message, { code, ...err.details });
          }
          if (
            code === "MCP_CATALOG_RAW_SECRET_REJECTED" ||
            code === "MCP_CATALOG_INVALID_SECRET_REF"
          ) {
            // Do NOT echo the caller's value back. The service has already
            // scrubbed it; we only surface the code + catalogId in details.
            throw badRequest(err.message, { code, ...err.details });
          }
          throw badRequest(err.message, { code, ...err.details });
        }
        throw err;
      }
    },
  );

  return router;
}
