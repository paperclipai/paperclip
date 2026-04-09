import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  patchInstanceExperimentalSettingsSchema,
  patchInstanceGeneralSettingsSchema,
  patchInstanceBackupSettingsSchema,
  type InstanceBackupSettings,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { instanceSettingsService, logActivity } from "../services/index.js";
import { getActorInfo } from "./authz.js";
import { readConfigFile, updateConfigFile } from "../config-store.js";
import { loadConfig } from "../config.js";

function assertCanManageInstanceSettings(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

export function instanceSettingsRoutes(db: Db) {
  const router = Router();
  const svc = instanceSettingsService(db);

  router.get("/instance/settings/general", async (req, res) => {
    // General settings (e.g. keyboardShortcuts) are readable by any
    // authenticated board user.  Only PATCH requires instance-admin.
    if (req.actor.type !== "board") {
      throw forbidden("Board access required");
    }
    res.json(await svc.getGeneral());
  });

  router.patch(
    "/instance/settings/general",
    validate(patchInstanceGeneralSettingsSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const updated = await svc.updateGeneral(req.body);
      const actor = getActorInfo(req);
      const companyIds = await svc.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.general_updated",
            entityType: "instance_settings",
            entityId: updated.id,
            details: {
              general: updated.general,
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );
      res.json(updated.general);
    },
  );

  router.get("/instance/settings/experimental", async (req, res) => {
    // Experimental settings are readable by any authenticated board user.
    // Only PATCH requires instance-admin.
    if (req.actor.type !== "board") {
      throw forbidden("Board access required");
    }
    res.json(await svc.getExperimental());
  });

  router.patch(
    "/instance/settings/experimental",
    validate(patchInstanceExperimentalSettingsSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const updated = await svc.updateExperimental(req.body);
      const actor = getActorInfo(req);
      const companyIds = await svc.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.experimental_updated",
            entityType: "instance_settings",
            entityId: updated.id,
            details: {
              experimental: updated.experimental,
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );
      res.json(updated.experimental);
    },
  );

  router.get("/instance/settings/backup", async (req, res) => {
    assertCanManageInstanceSettings(req);
    // Read from runtime config (reflects env vars + config file)
    const runtimeConfig = loadConfig();
    const backup: InstanceBackupSettings = {
      enabled: runtimeConfig.databaseBackupEnabled,
      intervalMinutes: runtimeConfig.databaseBackupIntervalMinutes,
      retentionDays: runtimeConfig.databaseBackupRetentionDays,
      dir: runtimeConfig.databaseBackupDir,
    };
    // Also include whether config file exists for UI feedback
    const configFile = readConfigFile();
    res.json({
      ...backup,
      configFileExists: configFile !== null,
      requiresRestart: true,
    });
  });

  router.patch(
    "/instance/settings/backup",
    validate(patchInstanceBackupSettingsSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const configFile = readConfigFile();
      if (!configFile) {
        res.status(400).json({
          error: "No config file found. Run `paperclipai onboard` first.",
        });
        return;
      }
      const updated = updateConfigFile((config) => ({
        ...config,
        database: {
          ...config.database,
          backup: {
            ...config.database.backup,
            ...req.body,
          },
        },
      }));
      const actor = getActorInfo(req);
      const companyIds = await svc.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.backup_updated",
            entityType: "instance_settings",
            entityId: "backup",
            details: {
              backup: updated.database.backup,
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );
      res.json({
        ...updated.database.backup,
        configFileExists: true,
        requiresRestart: true,
      });
    },
  );

  return router;
}
