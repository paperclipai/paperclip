import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  issueGraphLivenessAutoRecoveryRequestSchema,
  patchInstanceExperimentalSettingsSchema,
  patchInstanceGeneralSettingsSchema,
  type DataRecoveryItemType,
} from "@paperclipai/shared";
import { forbidden, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { dataRecoveryService, heartbeatService, instanceSettingsService, logActivity } from "../services/index.js";
import { assertBoardOrgAccess, getActorInfo } from "./authz.js";

function assertCanManageInstanceSettings(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

const dataRecoveryItemTypes = new Set<DataRecoveryItemType>(["company", "agent", "project", "issue"]);

function parseDataRecoveryItemType(value: string | undefined): DataRecoveryItemType {
  if (value && dataRecoveryItemTypes.has(value as DataRecoveryItemType)) {
    return value as DataRecoveryItemType;
  }
  throw unprocessable("Unsupported recoverable item type");
}

export function instanceSettingsRoutes(db: Db) {
  const router = Router();
  const svc = instanceSettingsService(db);
  const heartbeat = heartbeatService(db);
  const recovery = dataRecoveryService(db);

  router.get("/instance/settings/general", async (req, res) => {
    // General settings (e.g. keyboardShortcuts) are readable by any
    // authenticated org member or instance admin. Only PATCH requires instance-admin.
    assertBoardOrgAccess(req);
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
    // Experimental settings are readable by any authenticated org member
    // or instance admin. Only PATCH requires instance-admin.
    assertBoardOrgAccess(req);
    res.json(await svc.getExperimental());
  });

  router.get("/instance/settings/data-recovery", async (req, res) => {
    assertCanManageInstanceSettings(req);
    res.json({ items: await recovery.list() });
  });

  router.get("/instance/settings/data-recovery/:type/:id", async (req, res) => {
    assertCanManageInstanceSettings(req);
    const type = parseDataRecoveryItemType(req.params.type);
    res.json(await recovery.details(type, req.params.id as string));
  });

  router.post("/instance/settings/data-recovery/:type/:id/restore", async (req, res) => {
    assertCanManageInstanceSettings(req);
    const type = parseDataRecoveryItemType(req.params.type);
    const item = await recovery.restore(type, req.params.id as string);
    const actor = getActorInfo(req);
    if (item.companyId) {
      await logActivity(db, {
        companyId: item.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "instance.data_recovery.restored",
        entityType: item.type,
        entityId: item.id,
        details: {
          type: item.type,
          state: item.state,
        },
      });
    }
    res.json({ item });
  });

  router.post("/instance/settings/data-recovery/agent/:id/rename", async (req, res) => {
    assertCanManageInstanceSettings(req);
    const name = typeof req.body?.name === "string" ? req.body.name : "";
    const item = await recovery.renameAgent(req.params.id as string, name);
    const actor = getActorInfo(req);
    if (item.companyId) {
      await logActivity(db, {
        companyId: item.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "instance.data_recovery.renamed",
        entityType: item.type,
        entityId: item.id,
        details: {
          type: item.type,
          state: item.state,
          name: item.name,
        },
      });
    }
    res.json({ item });
  });

  router.delete("/instance/settings/data-recovery/:type/:id", async (req, res) => {
    assertCanManageInstanceSettings(req);
    const type = parseDataRecoveryItemType(req.params.type);
    const item = await recovery.deletePermanent(type, req.params.id as string);
    const actor = getActorInfo(req);
    if (item.companyId && item.type !== "company") {
      await logActivity(db, {
        companyId: item.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "instance.data_recovery.deleted",
        entityType: item.type,
        entityId: item.id,
        details: {
          type: item.type,
          state: item.state,
        },
      });
    }
    res.json({ item });
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

  router.post(
    "/instance/settings/experimental/issue-graph-liveness-auto-recovery/preview",
    validate(issueGraphLivenessAutoRecoveryRequestSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      res.json(await heartbeat.buildIssueGraphLivenessAutoRecoveryPreview({
        lookbackHours: req.body.lookbackHours,
      }));
    },
  );

  router.post(
    "/instance/settings/experimental/issue-graph-liveness-auto-recovery/run",
    validate(issueGraphLivenessAutoRecoveryRequestSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const actor = getActorInfo(req);
      const result = await heartbeat.reconcileIssueGraphLiveness({
        runId: actor.runId,
        force: true,
        lookbackHours: req.body.lookbackHours,
      });
      const companyIds = await svc.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.issue_graph_liveness_auto_recovery_run",
            entityType: "instance_settings",
            entityId: "default",
            details: {
              lookbackHours: result.lookbackHours,
              escalationsCreated: result.escalationsCreated,
              existingEscalations: result.existingEscalations,
              skippedOutsideLookback: result.skippedOutsideLookback,
              escalationIssueIds: result.escalationIssueIds,
            },
          }),
        ),
      );
      res.json(result);
    },
  );

  return router;
}
