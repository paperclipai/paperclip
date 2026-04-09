import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import type { SsoProviderConfig } from "@paperclipai/shared";
import { patchInstanceExperimentalSettingsSchema, patchInstanceGeneralSettingsSchema, patchInstanceSsoSettingsSchema } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { instanceSettingsService, logActivity } from "../services/index.js";
import { getActorInfo } from "./authz.js";

function assertCanManageInstanceSettings(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

export function instanceSettingsRoutes(
  db: Db,
  opts?: { onSsoSettingsChanged?: (providers: SsoProviderConfig[]) => void },
) {
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

  router.get("/instance/settings/sso", async (req, res) => {
    assertCanManageInstanceSettings(req);
    res.json(await svc.getSso());
  });

  router.patch(
    "/instance/settings/sso",
    validate(patchInstanceSsoSettingsSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const updated = await svc.updateSso(req.body);

      const activeProviders = updated.sso.enabled ? updated.sso.providers : [];
      opts?.onSsoSettingsChanged?.(activeProviders);

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
            action: "instance.settings.sso_updated",
            entityType: "instance_settings",
            entityId: updated.id,
            details: {
              sso: { enabled: updated.sso.enabled, providerCount: updated.sso.providers.length },
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );
      res.json(updated.sso);
    },
  );

  return router;
}
