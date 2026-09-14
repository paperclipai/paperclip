import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  patchInstanceSettingsSchema,
  patchInstanceExperimentalSettingsSchema,
  patchInstanceGeneralSettingsSchema,
  startTaskDrainRequestSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { isCloudManagedInstance } from "../services/cloud-instance.js";
import { getHiddenSettings } from "../services/settings-visibility.js";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  heartbeatService,
  instanceSettingsService,
  logActivity,
  publishActivity,
  type ActivityPublication,
} from "../services/index.js";
import { environmentService } from "../services/environments.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
import { assertBoardOrgAccess, getActorInfo } from "./authz.js";

function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a)
      && Array.isArray(b)
      && a.length === b.length
      && a.every((value, i) => sameJsonValue(value, b[i]))
    );
  }
  const aKeys = Object.keys(a);
  const bKeys = new Set(Object.keys(b));
  return aKeys.length === bKeys.size && aKeys.every((key) =>
    bKeys.has(key) && sameJsonValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/**
 * Floor writes to operator-hidden settings. Same-value writes pass so clients
 * that echo a full GET response keep working (the executionMode precedent);
 * only a write that would actually change a hidden setting is rejected.
 */
async function assertNoHiddenSettingChanges(
  body: Record<string, unknown>,
  getCurrent: () => Promise<object>,
  isHiddenField: (field: string) => boolean,
) {
  const hiddenKeys = Object.keys(body).filter(isHiddenField);
  if (hiddenKeys.length === 0) return;
  const current = (await getCurrent()) as Record<string, unknown>;
  for (const key of hiddenKeys) {
    if (sameJsonValue(body[key], current[key])) continue;
    throw forbidden(`${key} is managed by the hosting operator on this instance`, {
      code: "settings_operator_managed",
    });
  }
}

/**
 * Publish activity events for an already-committed mutation. The audit row
 * exists in the database no matter what happens here, so a publish failure
 * must not turn into a route error: that would report the mutation as
 * failed to the caller when it in fact succeeded. Log and swallow instead.
 */
function publishActivitiesBestEffort(publications: ActivityPublication[], action: string) {
  for (const publication of publications) {
    try {
      publishActivity(publication);
    } catch (err) {
      logger.error({ err, action, companyId: publication.companyId }, "failed to publish activity event");
    }
  }
}

function assertCanManageInstanceSettings(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

// A task-drain start or stop reads the live drain state, writes an audit
// transaction, and only then mutates the process-local drain state. The
// audit write is an async gap: two overlapping requests can commit their
// transactions in one order but reach the in-memory mutation in the other
// order, so a stale transition would win, the audit log would not match the
// live state, and the response for the newer request would not match what
// actually ended up live. Run each request's whole read-audit-apply
// sequence through this queue so overlapping requests execute one at a
// time, in the order they enter it: audit order and apply order then always
// agree, and each response reports exactly the state its own request
// produced.
let taskDrainTransitionQueue: Promise<void> = Promise.resolve();

function withTaskDrainTransition<T>(run: () => Promise<T>): Promise<T> {
  const turn = taskDrainTransitionQueue.then(run);
  // Normalize to a settled void promise for the next caller in line, so a
  // rejected transition (a failed audit write, for example) cannot wedge
  // every later transition behind it.
  taskDrainTransitionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
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
      // An explicit tenant write of the instance default reclassifies its
      // attribution: whatever the default becomes — including a deliberate
      // re-selection of the managed sandbox row — it is tenant-chosen, so
      // the reconciliation stamp marker must not survive to let a later
      // managed-sandbox-only mode-off pass mistake the tenant's choice for a
      // stamp and revert it. The marker clear and the settings write commit
      // in ONE transaction, so no partial failure can desync attribution
      // from the default (neither a stale stamp on a tenant choice, nor a
      // reconciliation default that lost its marker and can never revert).
      const writesDefault = Object.prototype.hasOwnProperty.call(req.body, "defaultEnvironmentId");
      const managedSandbox = writesDefault
        ? await environments.findManagedSandboxEnvironment(undefined, { includeArchived: true })
        : null;
      const updated = await db.transaction(async (tx) => {
        if (managedSandbox?.metadata?.managedDefaultStamped === true) {
          const { managedDefaultStamped: _cleared, ...remainingMetadata } = managedSandbox.metadata;
          await environments.update(managedSandbox.id, { metadata: remainingMetadata }, { db: tx });
        }
        return svc.update(req.body, { db: tx });
      });
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
      const hidden = getHiddenSettings();
      await assertNoHiddenSettingChanges(
        req.body,
        () => svc.getGeneral(),
        (field) => hidden.has(`instance.general.${field}`),
      );
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
      // Hiding the whole Experimental page floors every toggle; otherwise
      // only individually hidden keys are floored.
      const hidden = getHiddenSettings();
      await assertNoHiddenSettingChanges(
        req.body,
        () => svc.getExperimental(),
        (field) =>
          hidden.has("instance.experimental") || hidden.has(`instance.experimental.${field}`),
      );
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

  router.get("/instance/task-drain", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(heartbeat.getTaskDrainStatus());
  });

  router.post(
    "/instance/task-drain",
    validate(startTaskDrainRequestSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const actor = getActorInfo(req);
      const companyIds = await svc.listCompanyIds();
      const ttlMs = req.body.ttlMs ?? null;
      // The whole read-audit-apply sequence runs as one queued transition
      // (see withTaskDrainTransition above), so an overlapping start or
      // stop cannot commit its audit row, or apply its live state, out of
      // order against this one. computeTaskDrain runs inside the turn so
      // startedAt reflects the moment this request actually took effect,
      // not the moment it arrived and was queued behind another transition.
      const drain = await withTaskDrainTransition(async () => {
        const computed = heartbeat.computeTaskDrain({ ttlMs });
        // One transaction for every company's audit row, so a write that
        // succeeds for one company and fails for another never leaves a
        // partial activity history behind — either every company gets the
        // record, or none does. The drain mutation below runs only after
        // this transaction commits, so a failed write leaves the live
        // drain untouched and there is no partial state to roll back.
        const postCommitActivityPublications: ActivityPublication[] = [];
        await db.transaction((tx) =>
          Promise.all(
            companyIds.map((companyId) =>
              logActivity(tx as unknown as Db, {
                companyId,
                actorType: actor.actorType,
                actorId: actor.actorId,
                agentId: actor.agentId,
                runId: actor.runId,
                agentApiKeyId: actor.agentApiKeyId,
                action: "instance.task_drain.started",
                entityType: "instance_settings",
                entityId: "default",
                details: {
                  startedAt: computed.startedAt,
                  expiresAt: computed.expiresAt,
                },
              }, postCommitActivityPublications),
            ),
          ),
        );
        heartbeat.applyTaskDrain(computed);
        // The audit record already committed, so a failure to publish it
        // here is not a reason to undo the drain: reverting the in-memory
        // state at this point would desync it from the committed row.
        // Swallow a publish failure so it cannot turn a committed mutation
        // into a false 500.
        publishActivitiesBestEffort(postCommitActivityPublications, "instance.task_drain.started");
        return computed;
      });
      res.json(drain);
    },
  );

  router.delete("/instance/task-drain", async (req, res) => {
    assertCanManageInstanceSettings(req);
    const actor = getActorInfo(req);
    const companyIds = await svc.listCompanyIds();
    // See the POST handler above for why the whole read-audit-apply
    // sequence runs inside withTaskDrainTransition: it queues this stop
    // behind any transition already in flight, so it cannot read a status
    // an overlapping request is about to make stale, and its audit row and
    // its live-state mutation always land in the same order as every other
    // queued transition.
    const wasActive = await withTaskDrainTransition(async () => {
      const priorStatus = heartbeat.getTaskDrainStatus();
      // Read wasActive once, here, and use this same value for the audit
      // detail and the response body below. A TTL that expires between two
      // separate reads would otherwise make the two values disagree.
      const wasActive = priorStatus.draining;
      // See the POST handler above for why this is one transaction, and why
      // the drain mutation runs only after it commits.
      const postCommitActivityPublications: ActivityPublication[] = [];
      await db.transaction((tx) =>
        Promise.all(
          companyIds.map((companyId) =>
            logActivity(tx as unknown as Db, {
              companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              agentApiKeyId: actor.agentApiKeyId,
              action: "instance.task_drain.stopped",
              entityType: "instance_settings",
              entityId: "default",
              details: {
                wasActive,
              },
            }, postCommitActivityPublications),
          ),
        ),
      );
      heartbeat.stopTaskDrain();
      // See the POST handler above for why a publish failure here is
      // swallowed instead of failing the route: the audit record already
      // committed, so a publish failure here must not undo a drain-stop
      // that is already correct in the database, and must not report the
      // stop as failed when it succeeded.
      publishActivitiesBestEffort(postCommitActivityPublications, "instance.task_drain.stopped");
      return wasActive;
    });
    res.json({ wasActive });
  });

  return router;
}
