import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { activityLog, type Db } from "@paperclipai/db";
import {
  patchInstanceSettingsSchema,
  patchInstanceExperimentalSettingsSchema,
  patchInstanceGeneralSettingsSchema,
  startTaskDrainRequestSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { retryOnTransientDbConnectionError } from "../middleware/auth.js";
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

// The scheduled call that stops every cancellable run for the opt-in
// termination option. `clearTimeout` cannot revoke a callback the event
// loop already queued (a timer that fires in the same tick a stop
// executes), so this variable only lets a later POST or a DELETE cancel a
// callback that has not fired yet. The generation check inside
// runTaskDrainTermination, below, is the actual control against a callback
// that already fired.
let taskDrainTerminationTimer: ReturnType<typeof setTimeout> | null = null;

// The initiating actor of an armed termination, held immutable from arm
// time through to the outcome record. The operator who armed the
// termination is the actor of the outcome, even though the outcome record
// writes later, on a timer, with no request in flight.
type TaskDrainActorSnapshot = {
  actorType: "agent" | "user";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
  actorSource: string;
  cloudControlRequestId: string | null;
};

// The termination the current timer is armed for, mirrored next to the
// timer handle above. A drain replacement (POST) or a drain deletion
// (DELETE) clears the timer before it knows whether its own replacement
// will succeed. If a later step in that same request then fails, the
// request re-arms the deadline from this snapshot, so a failed
// replacement or a failed stop never leaves a live drain with no timer.
//
// `generation` and `terminationId` answer two different questions.
// `generation` comes from the process-local counter in the heartbeat
// service, resets to 0 on every restart, and only proves whether this
// timer's callback still names the live in-memory drain. `terminationId`
// is a UUID minted once, when this termination is armed, and stays
// unique across process restarts, so the audit dedup key below can use
// it safely: an old activity row from before a restart can carry the
// same `generation` number as a new termination, but never the same
// `terminationId`.
type ArmedTaskDrainTermination = {
  generation: number;
  terminationId: string;
  initiatingActor: TaskDrainActorSnapshot;
  terminateAt: Date;
};
let armedTaskDrainTermination: ArmedTaskDrainTermination | null = null;

function clearTaskDrainTerminationTimer() {
  if (taskDrainTerminationTimer !== null) {
    clearTimeout(taskDrainTerminationTimer);
    taskDrainTerminationTimer = null;
  }
  armedTaskDrainTermination = null;
}

function buildTaskDrainActorSnapshot(req: Request): TaskDrainActorSnapshot {
  const actor = getActorInfo(req);
  return {
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    runId: actor.runId,
    agentApiKeyId: actor.agentApiKeyId,
    // getActorInfo folds every source it does not name into "session", so a
    // Cloud-initiated request needs its own check here to keep the true
    // source on the durable record.
    actorSource: req.actor?.source === "cloud_control" ? "cloud_control" : actor.actorSource,
    cloudControlRequestId: req.cloudControlRequestId ?? null,
  };
}

export function instanceSettingsRoutes(db: Db) {
  const router = Router();
  const svc = instanceSettingsService(db);
  const environments = environmentService(db);
  const heartbeat = heartbeatService(db);

  // Stop every cancellable run for the task-drain termination option, and
  // write one outcome activity row for every company — including a company
  // with no active run, so an operator can always tell the termination
  // ran. Runs inside withTaskDrainTransition, and its first step tests the
  // drain generation it was armed for: `clearTimeout` cannot revoke a
  // callback the event loop already queued, so this check is the actual
  // control against a stale callback (one a stop or a later start made
  // obsolete after the event loop had already queued it).
  async function runTaskDrainTermination(
    generation: number,
    terminationId: string,
    initiatingActor: TaskDrainActorSnapshot,
    terminateAt: Date,
  ) {
    await withTaskDrainTransition(async () => {
      if (!heartbeat.isTaskDrainGenerationLive(generation)) return;
      const executedAt = new Date();
      const outcomesByCompany = await heartbeat.terminateActiveRunsForTaskDrain(
        "Stopped by the task drain termination deadline",
      );
      // The runs above are already cancelled. There is no undo for that
      // step, so a transient database failure here must not lose the
      // outcome. Retry the company list read and the audit write together
      // on a transient connection drop.
      //
      // A dropped connection can happen after the server commits the
      // transaction but before the driver reports success. So a retry
      // cannot assume the first attempt never landed. `terminationId`
      // names this exact execution and never repeats — not even across a
      // process restart, unlike the in-memory generation number — so each
      // retry uses it as a key: it checks for an existing row first, and
      // writes only when that check finds none. This stops a retry after
      // an ambiguous failure from duplicating the row or its publication,
      // and it stops a termination after a restart from matching an old
      // row left by an unrelated termination that reused the same
      // generation number.
      //
      // If every retry still fails, log the full outcome. An operator can
      // then recover it from the application log even though the audit
      // table write did not land.
      const terminationEntityId = `task-drain-termination:${terminationId}`;
      try {
        await retryOnTransientDbConnectionError(async () => {
          const alreadyRecorded = await db
            .select({ id: activityLog.id })
            .from(activityLog)
            .where(and(
              eq(activityLog.action, "instance.task_drain.active_tasks_terminated"),
              eq(activityLog.entityType, "instance_settings"),
              eq(activityLog.entityId, terminationEntityId),
            ))
            .limit(1);
          if (alreadyRecorded.length > 0) return;

          const companyIds = await svc.listCompanyIds();
          const postCommitActivityPublications: ActivityPublication[] = [];
          await db.transaction((tx) =>
            Promise.all(
              companyIds.map((companyId) => {
                const outcome = outcomesByCompany.get(companyId) ?? {
                  attemptedRunIds: [] as string[],
                  cancelledRunIds: [] as string[],
                  failedRunIds: [] as string[],
                };
                return logActivity(tx as unknown as Db, {
                  companyId,
                  actorType: initiatingActor.actorType,
                  actorId: initiatingActor.actorId,
                  agentId: initiatingActor.agentId,
                  runId: initiatingActor.runId,
                  agentApiKeyId: initiatingActor.agentApiKeyId,
                  action: "instance.task_drain.active_tasks_terminated",
                  entityType: "instance_settings",
                  entityId: terminationEntityId,
                  details: {
                    terminateAt,
                    executedAt,
                    initiatingActor,
                    attemptedRunIds: outcome.attemptedRunIds,
                    attemptedRunCount: outcome.attemptedRunIds.length,
                    cancelledRunIds: outcome.cancelledRunIds,
                    cancelledRunCount: outcome.cancelledRunIds.length,
                    failedRunIds: outcome.failedRunIds,
                    failedRunCount: outcome.failedRunIds.length,
                  },
                }, postCommitActivityPublications);
              }),
            ),
          );
          publishActivitiesBestEffort(
            postCommitActivityPublications,
            "instance.task_drain.active_tasks_terminated",
          );
        });
      } catch (err) {
        logger.error(
          {
            err,
            generation,
            terminationId,
            terminateAt,
            executedAt,
            initiatingActor,
            outcomesByCompany: Object.fromEntries(outcomesByCompany),
          },
          "task drain termination ran but its audit record failed to write; recover the outcome from this log entry",
        );
      }
    });
  }

  // Arm the termination timer for the given deadline, and mirror it in
  // armedTaskDrainTermination so a later failed replacement or failed stop
  // can re-arm the same deadline instead of leaving a live drain with no
  // timer.
  function scheduleTaskDrainTermination(armed: ArmedTaskDrainTermination) {
    armedTaskDrainTermination = armed;
    const delayMs = Math.max(0, armed.terminateAt.getTime() - Date.now());
    taskDrainTerminationTimer = setTimeout(() => {
      // Only clear the shared snapshot when it still names this exact
      // callback. A callback the event loop already queued before a
      // later request replaced it (see the comment above
      // taskDrainTerminationTimer) must not clear a newer request's
      // timer out from under it; isTaskDrainGenerationLive, inside
      // runTaskDrainTermination, is what decides whether this callback
      // still gets to act.
      if (armedTaskDrainTermination === armed) {
        taskDrainTerminationTimer = null;
        armedTaskDrainTermination = null;
      }
      runTaskDrainTermination(
        armed.generation,
        armed.terminationId,
        armed.initiatingActor,
        armed.terminateAt,
      ).catch((err) => {
        logger.error({ err }, "task drain termination failed");
      });
    }, delayMs);
  }

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
      const initiatingActor = buildTaskDrainActorSnapshot(req);
      const companyIds = await svc.listCompanyIds();
      const ttlMs = req.body.ttlMs ?? null;
      const terminateActiveTasks = req.body.terminateActiveTasks ?? false;
      // The whole read-audit-apply sequence runs as one queued transition
      // (see withTaskDrainTransition above), so an overlapping start or
      // stop cannot commit its audit row, or apply its live state, out of
      // order against this one. computeTaskDrain runs inside the turn so
      // startedAt reflects the moment this request actually took effect,
      // not the moment it arrived and was queued behind another transition.
      const drain = await withTaskDrainTransition(async () => {
        // A repeated start replaces whatever termination the prior drain
        // armed. Clear it before this turn computes and applies the new
        // drain, so a stale timer can never fire alongside — or instead
        // of — the one this turn arms below. Keep a snapshot of what this
        // clear just disarmed: if a later step in this same request then
        // fails, the catch block below re-arms it from the snapshot, so a
        // failed replacement never leaves the prior, still-live drain with
        // no timer.
        const previousArmedTermination = armedTaskDrainTermination;
        clearTaskDrainTerminationTimer();
        try {
          const computed = heartbeat.computeTaskDrain({ ttlMs, terminateActiveTasks });
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
                  actorType: initiatingActor.actorType,
                  actorId: initiatingActor.actorId,
                  agentId: initiatingActor.agentId,
                  runId: initiatingActor.runId,
                  agentApiKeyId: initiatingActor.agentApiKeyId,
                  action: "instance.task_drain.started",
                  entityType: "instance_settings",
                  entityId: "default",
                  details: {
                    terminateActiveTasks: computed.terminateActiveTasks,
                    startedAt: computed.startedAt,
                    expiresAt: computed.expiresAt,
                    terminateAt: computed.terminateAt,
                    initiatingActor,
                  },
                }, postCommitActivityPublications),
              ),
            ),
          );
          const generation = heartbeat.applyTaskDrain(computed);
          // The audit record already committed, so a failure to publish it
          // here is not a reason to undo the drain: reverting the in-memory
          // state at this point would desync it from the committed row.
          // Swallow a publish failure so it cannot turn a committed mutation
          // into a false 500.
          publishActivitiesBestEffort(postCommitActivityPublications, "instance.task_drain.started");
          const terminateAt = computed.terminateAt;
          if (terminateAt) {
            scheduleTaskDrainTermination({
              generation,
              terminationId: randomUUID(),
              initiatingActor,
              terminateAt,
            });
          }
          return computed;
        } catch (err) {
          if (previousArmedTermination) {
            scheduleTaskDrainTermination(previousArmedTermination);
          }
          throw err;
        }
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
      // A stop must cancel a termination the current drain armed, before
      // the timer's own generation check would otherwise have to catch it.
      // Keep a snapshot of what this clear just disarmed: see the POST
      // handler above for why a later step's failure re-arms it from the
      // snapshot instead of leaving the still-live drain with no timer.
      const previousArmedTermination = armedTaskDrainTermination;
      clearTaskDrainTerminationTimer();
      try {
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
      } catch (err) {
        if (previousArmedTermination) {
          scheduleTaskDrainTermination(previousArmedTermination);
        }
        throw err;
      }
    });
    res.json({ wasActive });
  });

  return router;
}
