import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createPreUpdateBackupSchema,
  dismissInstanceUpdateSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { getActorInfo } from "./authz.js";
import { instanceSettingsService, logActivity } from "../services/index.js";
import {
  instanceUpdateSafetyService,
  type InstanceUpdateSafetyOptions,
} from "../services/instance-update-safety.js";

type InstanceUpdateSafetyRouteService = ReturnType<typeof instanceUpdateSafetyService>;

function assertCanManageUpdates(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

function isRouteService(value: InstanceUpdateSafetyOptions | InstanceUpdateSafetyRouteService): value is InstanceUpdateSafetyRouteService {
  return typeof (value as InstanceUpdateSafetyRouteService).getUpdateStatus === "function";
}

async function logInstanceUpdateAction(
  db: Db,
  req: Request,
  action: string,
  details: Record<string, unknown>,
) {
  const actor = getActorInfo(req);
  const settingsSvc = instanceSettingsService(db);
  const companyIds = await settingsSvc.listCompanyIds();
  await Promise.all(
    companyIds.map((companyId) =>
      logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action,
        entityType: "instance_update",
        entityId: "default",
        details,
      }),
    ),
  );
}

export function instanceUpdateSafetyRoutes(
  db: Db,
  serviceOrOptions: InstanceUpdateSafetyOptions | InstanceUpdateSafetyRouteService,
) {
  const router = Router();
  const svc = isRouteService(serviceOrOptions)
    ? serviceOrOptions
    : instanceUpdateSafetyService(db, serviceOrOptions);

  router.get("/instance/update-status", async (req, res) => {
    assertCanManageUpdates(req);
    res.json(await svc.getUpdateStatus(false));
  });

  router.post("/instance/update-status/check", async (req, res) => {
    assertCanManageUpdates(req);
    const status = await svc.checkNow();
    await logInstanceUpdateAction(db, req, "instance.update_status_checked", {
      currentVersion: status.currentVersion,
      latestVersion: status.latestVersion,
      updateAvailable: status.updateAvailable,
      checkSource: status.checkSource,
      error: status.error,
    });
    res.json(status);
  });

  router.patch(
    "/instance/update-status/dismiss",
    validate(dismissInstanceUpdateSchema),
    async (req, res) => {
      assertCanManageUpdates(req);
      const status = await svc.dismissUpdate(req.body.version);
      await logInstanceUpdateAction(db, req, "instance.update_status_dismissed", {
        dismissedVersion: status.settings.dismissedVersion,
        latestVersion: status.latestVersion,
      });
      res.json(status);
    },
  );

  router.get("/instance/backups/pre-update", async (req, res) => {
    assertCanManageUpdates(req);
    const targetVersion = typeof req.query.targetVersion === "string" && req.query.targetVersion.trim()
      ? req.query.targetVersion.trim()
      : null;
    res.json(await svc.getPreUpdateBackupStatus(targetVersion));
  });

  router.post(
    "/instance/backups/pre-update",
    validate(createPreUpdateBackupSchema),
    async (req, res) => {
      assertCanManageUpdates(req);
      const backup = await svc.createPreUpdateBackup(req.body);
      await logInstanceUpdateAction(db, req, "instance.pre_update_backup_created", {
        backupId: backup.id,
        targetVersion: backup.targetVersion,
        status: backup.status,
        manifestPath: backup.manifestPath,
        storageProvider: backup.storageProvider,
        warnings: backup.warnings,
      });
      res.status(201).json(backup);
    },
  );

  return router;
}
