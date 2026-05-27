import { Router, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { brabrixAgentSyncSettingsUpdateSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { brabrixSettingsService, createBrabrixAgentSyncService, logActivity } from "../services/index.js";
import { BrabrixHttpError } from "../integrations/brabrix/brabrix-client.js";
import {
  BrabrixProjectImporterHttpError,
  createBrabrixProjectImporter,
  type BrabrixProjectImportResult,
} from "../integrations/brabrix/brabrix-project-importer.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

function extractRequestIdFromBody(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { requestId?: unknown };
    return typeof parsed.requestId === "string" && parsed.requestId.trim().length > 0
      ? parsed.requestId.trim()
      : null;
  } catch {
    return null;
  }
}

function extractErrorMessageFromBody(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    return typeof parsed.message === "string" && parsed.message.trim().length > 0
      ? parsed.message.trim()
      : null;
  } catch {
    return null;
  }
}

export function brabrixRoutes(db: Db) {
  const router = Router();
  const brabrixSettings = brabrixSettingsService(db);

  function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  function hasBrabrixToken(value: string | null | undefined): boolean {
    return typeof value === "string" && value.trim().length > 0;
  }

  function handleBrabrixImporterError(res: Response, error: unknown): boolean {
    if (!(error instanceof BrabrixProjectImporterHttpError)) return false;
    const status = error.details.status ?? null;
    const upstreamMessage = extractErrorMessageFromBody(error.details.responseBody);
    if (status === 401 || status === 403) {
      res.status(422).json({
        error: "Brabrix authentication failed. Check Company Settings > Brabrix token/API key.",
      });
      return true;
    }
    if (status === 404) {
      res.status(422).json({
        error: "Brabrix project or endpoint not found. Verify configured endpoints and selected project ID.",
      });
      return true;
    }
    if (typeof status === "number" && status >= 500) {
      const requestId = extractRequestIdFromBody(error.details.responseBody);
      res.status(502).json({
        error: requestId
          ? `Brabrix API returned an internal error. Try again and share requestId ${requestId} with Brabrix support.`
          : "Brabrix API returned an internal error. Try again in a few seconds.",
      });
      return true;
    }
    if (status === 400 || status === 422) {
      const normalized = upstreamMessage?.toLowerCase() ?? "";
      if (normalized.includes("x-tenant-id")) {
        res.status(422).json({
          error: "Brabrix Tenant ID is invalid. Use a UUID from Brabrix membership, or clear the Tenant ID setting.",
        });
        return true;
      }
      if (normalized.includes("active tenant")) {
        res.status(422).json({
          error: "Brabrix requires an active tenant for this account. Configure a valid Brabrix Tenant ID in Company Settings > Brabrix.",
        });
        return true;
      }
      res.status(422).json({
        error: upstreamMessage
          ? `Brabrix request rejected: ${upstreamMessage}`
          : error.message,
      });
      return true;
    }
    res.status(422).json({
      error: error.message,
    });
    return true;
  }

  async function createProjectImporterForCompany(companyId: string) {
    const config = await brabrixSettings.resolveConfig(companyId);
    if (!hasBrabrixToken(config.agentToken)) {
      return { config, importer: null };
    }
    return {
      config,
      importer: createBrabrixProjectImporter({
        db,
        companyId,
        config,
      }),
    };
  }

  router.post("/companies/:companyId/brabrix/sync-next-task", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const config = await brabrixSettings.resolveConfig(companyId);
    const syncService = createBrabrixAgentSyncService({ config });
    if (!syncService.isEnabled()) {
      res.status(409).json({
        error: "Brabrix integration is not configured. Set token and project ID in Company Settings > Brabrix, or configure BRABRIX_* env vars.",
      });
      return;
    }

    try {
      const bundle = await syncService.fetchNextTask();
      res.json(bundle);
    } catch (error) {
      if (error instanceof BrabrixHttpError) {
        const status = error.details.status ?? null;
        if (status === 401 || status === 403) {
          res.status(422).json({
            error: "Brabrix authentication failed. Check Company Settings > Brabrix token/API key and project ID.",
          });
          return;
        }
        if (status === 404) {
          res.status(422).json({
            error: "Brabrix project not found. Verify the configured project ID for this company.",
          });
          return;
        }
        if (typeof status === "number" && status >= 500) {
          const requestId = extractRequestIdFromBody(error.details.responseBody);
          res.status(502).json({
            error: requestId
              ? `Brabrix API returned an internal error. Try again and, if it persists, share requestId ${requestId} with Brabrix support.`
              : "Brabrix API returned an internal error. Try again in a few seconds.",
          });
          return;
        }
      }
      throw error;
    }
  });

  router.get("/companies/:companyId/brabrix/connection/test", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { importer } = await createProjectImporterForCompany(companyId);
    if (!importer) {
      res.status(409).json({
        ok: false,
        message: "Brabrix integration is not configured. Set token/API key in Company Settings > Brabrix.",
        projectCount: null,
      });
      return;
    }
    try {
      const projects = await importer.listProjects();
      res.json({
        ok: true,
        message: "Brabrix connection is healthy.",
        projectCount: projects.length,
      });
    } catch (error) {
      if (handleBrabrixImporterError(res, error)) return;
      throw error;
    }
  });

  router.get("/companies/:companyId/brabrix/projects", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { importer } = await createProjectImporterForCompany(companyId);
    if (!importer) {
      res.status(409).json({
        error: "Brabrix integration is not configured. Set token/API key in Company Settings > Brabrix.",
      });
      return;
    }
    try {
      const projects = await importer.listProjects();
      res.json({ projects });
    } catch (error) {
      if (handleBrabrixImporterError(res, error)) return;
      throw error;
    }
  });

  router.get("/companies/:companyId/brabrix/projects/imported", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { config } = await createProjectImporterForCompany(companyId);
    const importer = createBrabrixProjectImporter({
      db,
      companyId,
      config,
    });
    const projects = await importer.listImportedProjects();
    res.json({ projects });
  });

  router.post("/companies/:companyId/brabrix/projects/:projectId/import", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = asNonEmptyString(req.params.projectId);
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!projectId) {
      res.status(400).json({ error: "projectId is required." });
      return;
    }
    const { importer } = await createProjectImporterForCompany(companyId);
    if (!importer) {
      res.status(409).json({
        error: "Brabrix integration is not configured. Set token/API key in Company Settings > Brabrix.",
      });
      return;
    }
    let result: BrabrixProjectImportResult;
    try {
      result = await importer.importProject(projectId);
    } catch (error) {
      if (handleBrabrixImporterError(res, error)) return;
      throw error;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.brabrix_project_imported",
      entityType: "project",
      entityId: result.localProjectId,
      details: {
        brabrixProjectId: result.brabrixProjectId,
        localWorkspaceId: result.localWorkspaceId,
        counts: result.counts,
        warnings: result.warnings,
      },
    });

    res.json(result);
  });

  router.post("/companies/:companyId/brabrix/projects/:projectId/sync", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = asNonEmptyString(req.params.projectId);
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!projectId) {
      res.status(400).json({ error: "projectId is required." });
      return;
    }
    const { importer } = await createProjectImporterForCompany(companyId);
    if (!importer) {
      res.status(409).json({
        error: "Brabrix integration is not configured. Set token/API key in Company Settings > Brabrix.",
      });
      return;
    }
    let result: BrabrixProjectImportResult;
    try {
      result = await importer.syncProject(projectId);
    } catch (error) {
      if (handleBrabrixImporterError(res, error)) return;
      throw error;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.brabrix_project_synced",
      entityType: "project",
      entityId: result.localProjectId,
      details: {
        brabrixProjectId: result.brabrixProjectId,
        localWorkspaceId: result.localWorkspaceId,
        counts: result.counts,
        warnings: result.warnings,
      },
    });

    res.json(result);
  });

  router.post("/companies/:companyId/brabrix/projects/:projectId/disconnect", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = asNonEmptyString(req.params.projectId);
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!projectId) {
      res.status(400).json({ error: "projectId is required." });
      return;
    }
    const { config } = await createProjectImporterForCompany(companyId);
    const importer = createBrabrixProjectImporter({
      db,
      companyId,
      config,
    });
    const result = await importer.disconnectProject(projectId);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.brabrix_project_disconnected",
      entityType: "company",
      entityId: companyId,
      details: {
        brabrixProjectId: projectId,
        disconnected: result.disconnected,
        localProjectId: result.localProjectId,
      },
    });

    res.json(result);
  });

  router.get("/companies/:companyId/brabrix/settings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await brabrixSettings.getSettings(companyId);
    res.json(result);
  });

  router.patch(
    "/companies/:companyId/brabrix/settings",
    validate(brabrixAgentSyncSettingsUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const result = await brabrixSettings.updateSettings(companyId, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.brabrix_sync_settings_updated",
        entityType: "company",
        entityId: companyId,
        details: {
          provider: result.provider,
          agentTokenSecretId: result.agentTokenSecretId,
          projectIdSecretId: result.projectIdSecretId,
          tenantIdSecretId: result.tenantIdSecretId,
          credentialSource: result.credentialSource,
          enabled: result.enabled,
        },
      });

      res.json(result);
    },
  );

  return router;
}
