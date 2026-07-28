import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  DEFAULT_GLOBAL_CONCURRENCY,
  issueGraphLivenessAutoRecoveryRequestSchema,
  patchInstanceAdapterConcurrencySchema,
  patchInstanceSettingsSchema,
  patchInstanceExperimentalSettingsSchema,
  patchInstanceGeneralSettingsSchema,
  setInstanceAdapterPauseSchema,
  setInstanceRunPauseSchema,
  type InstanceRunControls,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { isCloudManagedInstance } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { heartbeatService, instanceSettingsService, logActivity } from "../services/index.js";
import { environmentService } from "../services/environments.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
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

export function instanceSettingsRoutes(db: Db) {
  const router = Router();
  const svc = instanceSettingsService(db);
  const environments = environmentService(db);
  const heartbeat = heartbeatService(db);

  router.get("/instance/settings", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await svc.get());
  });

  router.patch(
    "/instance/settings",
    validate(patchInstanceSettingsSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      if (Object.prototype.hasOwnProperty.call(req.body, "defaultEnvironmentId")) {
        await assertEnvironmentSelectionForCompany(
          environments,
          "instance",
          typeof req.body.defaultEnvironmentId === "string" ? req.body.defaultEnvironmentId : null,
        );
      }
      const updated = await svc.update(req.body);
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
            agentApiKeyId: actor.agentApiKeyId,
            action: "instance.settings.updated",
            entityType: "instance_settings",
            entityId: updated.id,
            details: {
              defaultEnvironmentId: updated.defaultEnvironmentId,
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );
      res.json(updated);
    },
  );

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
      // Floor: on cloud-managed instances the execution mode is pinned by the
      // platform (the execution-policy bootstrap writes it at boot). No
      // instance admin — including a computed owner-admin — may change it: a
      // forced provider switch would strand runs on a provider the platform
      // never provisioned. Same-value writes pass so settings forms that echo
      // the full general-settings object keep working. Absent and "any" both
      // mean unrestricted, so they compare equal.
      if (
        isCloudManagedInstance() &&
        Object.prototype.hasOwnProperty.call(req.body, "executionMode")
      ) {
        const current = await svc.getGeneral();
        if ((req.body.executionMode ?? "any") !== (current.executionMode ?? "any")) {
          throw forbidden("executionMode is platform-managed on cloud-managed instances", {
            code: "execution_mode_platform_managed",
          });
        }
      }
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
            agentApiKeyId: actor.agentApiKeyId,
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
    // or instance admin. Updating them remains instance-admin only because
    // this payload includes instance-wide operational controls.
    assertBoardOrgAccess(req);
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
            agentApiKeyId: actor.agentApiKeyId,
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

  async function logRunControlsChange(
    req: Request,
    action: string,
    details: Record<string, unknown>,
  ) {
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
          action,
          entityType: "instance_settings",
          entityId: "default",
          details,
        }),
      ),
    );
  }

  router.get("/instance/settings/run-controls", async (req, res) => {
    // Run-control state (instance pause, adapter pauses, concurrency caps) is
    // readable by any authenticated org member; mutations require instance-admin.
    assertBoardOrgAccess(req);
    res.json(await svc.getRunControls());
  });

  router.post(
    "/instance/settings/run-controls/pause",
    validate(setInstanceRunPauseSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const actor = getActorInfo(req);
      const updated = await svc.updateRunControls((current): InstanceRunControls => ({
        ...current,
        pauseAll: {
          reason: req.body.reason ?? null,
          pausedAt: new Date(),
          pausedBy: actor.actorId ?? actor.actorType,
        },
      }));
      await logRunControlsChange(req, "instance.run_controls.paused", {
        reason: req.body.reason ?? null,
      });
      res.json(updated);
    },
  );

  router.delete("/instance/settings/run-controls/pause", async (req, res) => {
    assertCanManageInstanceSettings(req);
    const updated = await svc.updateRunControls((current): InstanceRunControls => ({
      ...current,
      pauseAll: null,
    }));
    await logRunControlsChange(req, "instance.run_controls.resumed", {});
    res.json(updated);
  });

  router.post(
    "/instance/settings/run-controls/adapter-pauses",
    validate(setInstanceAdapterPauseSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const actor = getActorInfo(req);
      const { adapterType, reason } = req.body;
      const updated = await svc.updateRunControls((current): InstanceRunControls => ({
        ...current,
        adapterPauses: {
          ...current.adapterPauses,
          [adapterType]: {
            reason: reason ?? null,
            pausedAt: new Date(),
            pausedBy: actor.actorId ?? actor.actorType,
          },
        },
      }));
      await logRunControlsChange(req, "instance.run_controls.adapter_paused", {
        adapterType,
        reason: reason ?? null,
      });
      res.json(updated);
    },
  );

  router.delete("/instance/settings/run-controls/adapter-pauses/:adapterType", async (req, res) => {
    assertCanManageInstanceSettings(req);
    const adapterType = req.params.adapterType as string;
    const updated = await svc.updateRunControls((current): InstanceRunControls => {
      const adapterPauses = { ...current.adapterPauses };
      delete adapterPauses[adapterType];
      return { ...current, adapterPauses };
    });
    await logRunControlsChange(req, "instance.run_controls.adapter_resumed", { adapterType });
    res.json(updated);
  });

  router.patch(
    "/instance/settings/run-controls/concurrency",
    validate(patchInstanceAdapterConcurrencySchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const patch = (req.body.adapterConcurrency ?? {}) as Record<string, number | null>;
      const globalConcurrency =
        Object.prototype.hasOwnProperty.call(req.body, "globalConcurrency")
          ? (req.body.globalConcurrency as number | null | undefined)
          : undefined;
      const updated = await svc.updateRunControls((current): InstanceRunControls => {
        const adapterConcurrency = { ...current.adapterConcurrency };
        for (const [adapterType, cap] of Object.entries(patch)) {
          if (cap === null) {
            delete adapterConcurrency[adapterType];
          } else {
            adapterConcurrency[adapterType] = cap;
          }
        }
        return {
          ...current,
          adapterConcurrency,
          ...(globalConcurrency === undefined
            ? {}
            : { globalConcurrency: globalConcurrency ?? DEFAULT_GLOBAL_CONCURRENCY }),
        };
      });
      await logRunControlsChange(req, "instance.run_controls.concurrency_updated", {
        adapterConcurrency: patch,
        ...(globalConcurrency === undefined ? {} : { globalConcurrency }),
      });
      res.json(updated);
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
            agentApiKeyId: actor.agentApiKeyId,
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
