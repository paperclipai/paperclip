import { Router, type Request } from "express";
import { z } from "zod";
import { triggerUpdateActivityAction } from "../services/routine-trigger-update-plan.js";
import { listProtectedEnvironmentKeyHolders, protectedEnvironmentKeyWarnings } from "../services/protected-environment-keys.js";
import type { Db } from "@paperclipai/db";
import {
  createRoutineSchema,
  createDocumentAnnotationCommentSchema,
  createDocumentAnnotationThreadSchema,
  createRoutineTriggerSchema,
  ROUTINE_STATUSES,
  rotateRoutineTriggerSecretSchema,
  runRoutineSchema,
  updateDocumentAnnotationThreadSchema,
  updateRoutineSchema,
  updateRoutineTriggerSchema,
} from "@paperclipai/shared";
import { trackRoutineCreated } from "@paperclipai/shared/telemetry";
import { validate, validateIssueMutationBody } from "../middleware/validate.js";
import { accessService, documentAnnotationService, instanceSettingsService, logActivity, routineService } from "../services/index.js";
import { instanceSettingsService as experimentSettings } from "../services/instance-settings.js";
import { dashboardOwner } from "./responsibility-owner.js";
import { responsibilitiesDisabledError } from "../services/responsibilities-disabled.js";
import { agentPersonInCompany } from "./agent-person-authz.js";
import { assertCompanyAccess, getAccessibleResource, getActorInfo, hasCompanyAccess } from "./authz.js";
import { badRequest, forbidden, unauthorized, unprocessable, unsupportedMediaType } from "../errors.js";
import { getTelemetryClient } from "../telemetry.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

/** Filters for the routine list; all are applied in the query, before any limit. */
const listRoutinesQuerySchema = z.object({
  projectId: z.string().optional(),
  q: z.string().trim().min(1).max(200).optional(),
  status: z.enum(ROUTINE_STATUSES).optional(),
  assigneeAgentId: z.string().guid().optional(),
  responsibleUserId: z.string().trim().min(1).max(200).optional(),
  responsibilityId: z.string().guid().optional(),
  unfiled: z.enum(["true", "false"]).optional(),
});

export function routineRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const svc = routineService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const documentAnnotationsSvc = documentAnnotationService(db);
  const access = accessService(db);
  const routineDocumentKey = "description";

  function parseBooleanQuery(value: unknown) {
    return value === true || value === "true" || value === "1";
  }

  function annotationActorInput(req: Request) {
    const actor = getActorInfo(req);
    return {
      actor,
      annotationActor: {
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
        runId: actor.runId,
      },
    };
  }

  async function remapRoutineDescriptionAnnotations(req: Request, routineId: string) {
    const doc = await svc.getDescriptionDocument(routineId);
    if (!doc) return;
    const remapped = await documentAnnotationsSvc.remapOpenThreadsForRoutineDocument({
      routineId,
      key: routineDocumentKey,
      documentId: doc.id,
      nextRevisionId: doc.latestRevisionId,
      nextRevisionNumber: doc.latestRevisionNumber,
      nextBody: doc.body,
    });
    const actor = getActorInfo(req);
    for (const remap of remapped) {
      await logActivity(db, {
        companyId: doc.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "routine.document_annotation_remapped",
        entityType: "routine",
        entityId: routineId,
        details: {
          key: doc.key,
          documentKey: doc.key,
          documentId: doc.id,
          threadId: remap.thread.id,
          revisionNumber: doc.latestRevisionNumber,
          anchorState: remap.thread.anchorState,
          anchorConfidence: remap.thread.anchorConfidence,
          snapshotId: remap.snapshot.id,
        },
      });
    }
  }

  async function assertBoardCanAssignTasks(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") return;
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const allowed = await access.canUser(companyId, req.actor.userId, "tasks:assign");
    if (!allowed) {
      throw forbidden("Missing permission: tasks:assign");
    }
  }

  async function canChangeResponsibleUser(req: Request, companyId: string) {
    if (req.actor.type !== "board") return false;
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
    // Match assertCompanyAccess's write restrictions even on this GET route.
    if (Array.isArray(req.actor.memberships)) {
      const membership = req.actor.memberships.find((item) => item.companyId === companyId);
      if (!membership || membership.status !== "active" || membership.membershipRole === "viewer") return false;
    }
    return access.canUser(companyId, req.actor.userId, "tasks:assign");
  }

  function assertCanManageCompanyRoutine(req: Request, companyId: string, assigneeAgentId?: string | null) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return;
    if (req.actor.type !== "agent" || !req.actor.agentId) throw unauthorized();
    if (assigneeAgentId !== req.actor.agentId) {
      throw forbidden("Agents can only manage routines assigned to themselves");
    }
  }

  /**
   * The person an agent acts for on this routine: the person who directed its
   * run, when that person is responsible for the routine. Null otherwise.
   */
  async function agentActsForRoutinePerson(req: Request, routine: { companyId: string; responsibleUserId: string | null }) {
    const person = await agentPersonInCompany(db, req, routine.companyId);
    return person && routine.responsibleUserId === person.userId ? person.userId : null;
  }

  /**
   * What a person needs tasks:assign for (who runs a routine, turning it on,
   * its schedule): an agent may do it on a routine it runs and keeps running,
   * and on any other only when the person it acts for may assign tasks.
   */
  async function assertAgentCanAssign(req: Request, routine: { companyId: string; responsibleUserId: string | null }, runsIt: boolean) {
    if (req.actor.type !== "agent" || runsIt) return;
    const actsFor = await agentActsForRoutinePerson(req, routine);
    if (!actsFor || !(await access.canUser(routine.companyId, actsFor, "tasks:assign"))) {
      throw forbidden("Agents can change who runs a routine, turn it on or change its schedule only on routines they run, unless the person they act for may assign tasks");
    }
  }

  async function assertCanManageExistingRoutine(req: Request, routineId: string) {
    const routine = await svc.get(routineId);
    if (!routine || !hasCompanyAccess(req, routine.companyId)) return null;
    assertCompanyAccess(req, routine.companyId);
    if (req.actor.type === "board") return routine;
    if (req.actor.type !== "agent" || !req.actor.agentId) throw unauthorized();
    // An agent manages its own routines, and those of the person its run works for.
    if (routine.assigneeAgentId !== req.actor.agentId && !(await agentActsForRoutinePerson(req, routine))) {
      throw forbidden("Agents can only manage routines assigned to themselves, or routines the person they work for is responsible for");
    }
    return routine;
  }

  async function logRoutineRevisionCreated(req: Request, input: {
    companyId: string;
    routineId: string;
    revisionId: string | null;
    revisionNumber: number;
    changeSummary?: string | null;
    triggerCount?: number | null;
  }) {
    if (!input.revisionId) return;
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "routine.revision_created",
      entityType: "routine",
      entityId: input.routineId,
      details: {
        revisionId: input.revisionId,
        revisionNumber: input.revisionNumber,
        changeSummary: input.changeSummary ?? null,
        triggerCount: input.triggerCount ?? null,
      },
    });
  }

  router.get("/companies/:companyId/routines", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { q, unfiled, ...filters } = listRoutinesQuerySchema.parse(req.query);
    // The responsibility filters read filed work, which is part of the Responsibilities experiment.
    if ((filters.responsibilityId || unfiled === "true")
      && (await experimentSettings(db).getExperimental()).enableResponsibilities !== true) {
      throw responsibilitiesDisabledError();
    }
    const ownerUserId = filters.responsibilityId || unfiled === "true" ? await dashboardOwner(db, req, companyId) : undefined;
    const result = await svc.list(companyId, { ...filters, ownerUserId, ...(q ? { query: q } : {}), ...(unfiled === "true" ? { unfiled: true } : {}) });
    res.json(result);
  });

  router.post("/companies/:companyId/routines", validate(createRoutineSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertBoardCanAssignTasks(req, companyId);
    assertCanManageCompanyRoutine(req, companyId, req.body.assigneeAgentId);
    const created = await svc.create(companyId, req.body, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      ...(req.actor.type === "agent" ? { actorResponsibleUserId: req.actor.onBehalfOfUserId ?? null } : {}),
      runId: req.actor.runId ?? null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "routine.created",
      entityType: "routine",
      entityId: created.id,
      details: { title: created.title, assigneeAgentId: created.assigneeAgentId },
    });
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackRoutineCreated(telemetryClient);
    }
    await logRoutineRevisionCreated(req, {
      companyId,
      routineId: created.id,
      revisionId: created.latestRevisionId,
      revisionNumber: created.latestRevisionNumber,
      changeSummary: "Created routine",
      triggerCount: 0,
    });
    const configurationWarnings = req.body.env !== undefined
      ? protectedEnvironmentKeyWarnings(await listProtectedEnvironmentKeyHolders(db), req.body.env, "env") : [];
    res.status(201).json({ ...created, ...(configurationWarnings.length ? { configurationWarnings } : {}) });
  });

  router.get("/routines/:id", async (req, res) => {
    const detail = await getAccessibleResource(req, res, svc.getDetail(req.params.id as string), "Routine not found");
    if (!detail) return;
    res.json({ ...detail, canChangeResponsibleUser: await canChangeResponsibleUser(req, detail.companyId) });
  });

  router.get("/routines/:id/revisions", async (req, res) => {
    const routine = await assertCanManageExistingRoutine(req, req.params.id as string);
    if (!routine) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    const revisions = await svc.listRevisions(routine.id);
    res.json(revisions);
  });

  router.get("/routines/:id/description/annotations", async (req, res) => {
    const routine = await assertCanManageExistingRoutine(req, req.params.id as string);
    if (!routine) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    const status = req.query.status === "resolved" || req.query.status === "all" ? req.query.status : "open";
    const threads = await documentAnnotationsSvc.listThreadsForRoutineDocument(routine.id, routineDocumentKey, {
      status,
      includeComments: parseBooleanQuery(req.query.includeComments),
    });
    res.json(threads);
  });

  router.get("/routines/:id/description/annotations/:threadId", async (req, res) => {
    const routine = await assertCanManageExistingRoutine(req, req.params.id as string);
    if (!routine) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    const thread = await documentAnnotationsSvc.getThreadForRoutineDocument(
      routine.id,
      routineDocumentKey,
      req.params.threadId as string,
    );
    if (!thread) {
      res.status(404).json({ error: "Annotation thread not found" });
      return;
    }
    res.json(thread);
  });

  router.post(
    "/routines/:id/description/annotations",
    validate(createDocumentAnnotationThreadSchema),
    async (req, res) => {
      const routine = await assertCanManageExistingRoutine(req, req.params.id as string);
      if (!routine) {
        res.status(404).json({ error: "Routine not found" });
        return;
      }
      const { actor, annotationActor } = annotationActorInput(req);
      const thread = await documentAnnotationsSvc.createRoutineThread(
        routine.id,
        routineDocumentKey,
        req.body,
        annotationActor,
      );
      const firstComment = thread.comments[0];
      await logActivity(db, {
        companyId: routine.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "routine.document_annotation_thread_created",
        entityType: "routine",
        entityId: routine.id,
        details: {
          key: thread.documentKey,
          documentKey: thread.documentKey,
          documentId: thread.documentId,
          threadId: thread.id,
          commentId: firstComment?.id ?? null,
          revisionNumber: thread.currentRevisionNumber,
          quote: thread.selectedText.slice(0, 240),
        },
      });
      res.status(201).json(thread);
    },
  );

  router.post(
    "/routines/:id/description/annotations/:threadId/comments",
    validate(createDocumentAnnotationCommentSchema),
    async (req, res) => {
      const routine = await assertCanManageExistingRoutine(req, req.params.id as string);
      if (!routine) {
        res.status(404).json({ error: "Routine not found" });
        return;
      }
      const { actor, annotationActor } = annotationActorInput(req);
      const comment = await documentAnnotationsSvc.addRoutineComment(
        routine.id,
        routineDocumentKey,
        req.params.threadId as string,
        req.body,
        annotationActor,
      );
      await logActivity(db, {
        companyId: routine.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "routine.document_annotation_comment_added",
        entityType: "routine",
        entityId: routine.id,
        details: {
          key: routineDocumentKey,
          documentKey: routineDocumentKey,
          threadId: comment.threadId,
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
        },
      });
      res.status(201).json(comment);
    },
  );

  router.patch(
    "/routines/:id/description/annotations/:threadId",
    validate(updateDocumentAnnotationThreadSchema),
    async (req, res) => {
      const routine = await assertCanManageExistingRoutine(req, req.params.id as string);
      if (!routine) {
        res.status(404).json({ error: "Routine not found" });
        return;
      }
      const { actor, annotationActor } = annotationActorInput(req);
      const thread = await documentAnnotationsSvc.updateRoutineThread(
        routine.id,
        routineDocumentKey,
        req.params.threadId as string,
        req.body,
        annotationActor,
      );
      await logActivity(db, {
        companyId: routine.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: thread.status === "resolved"
          ? "routine.document_annotation_thread_resolved"
          : "routine.document_annotation_thread_reopened",
        entityType: "routine",
        entityId: routine.id,
        details: {
          key: thread.documentKey,
          documentKey: thread.documentKey,
          documentId: thread.documentId,
          threadId: thread.id,
          status: thread.status,
        },
      });
      res.json(thread);
    },
  );

  router.patch("/routines/:id", validate(updateRoutineSchema), async (req, res) => {
    const routine = await assertCanManageExistingRoutine(req, req.params.id as string);
    if (!routine) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    const assigneeWillChange =
      req.body.assigneeAgentId !== undefined &&
      req.body.assigneeAgentId !== routine.assigneeAgentId;
    if (req.body.responsibleUserId !== undefined) {
      if (req.actor.type !== "board") {
        throw forbidden("Only people can change routine responsibility");
      }
      await assertBoardCanAssignTasks(req, routine.companyId);
    }
    if (assigneeWillChange) {
      await assertBoardCanAssignTasks(req, routine.companyId);
      // Taking a routine from another agent, or handing one on, is an assignment the person must be allowed to make.
      await assertAgentCanAssign(req, routine, false);
    }
    const statusWillActivate =
      req.body.status !== undefined &&
      req.body.status === "active" &&
      routine.status !== "active";
    if (statusWillActivate || req.body.schedule !== undefined) {
      await assertBoardCanAssignTasks(req, routine.companyId);
      await assertAgentCanAssign(req, routine, routine.assigneeAgentId === req.actor.agentId && !assigneeWillChange);
    }
    const actsFor = req.actor.type === "agent" ? await agentActsForRoutinePerson(req, routine) : null;
    const updated = await svc.update(routine.id, req.body, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      runId: req.actor.runId ?? null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: routine.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "routine.updated",
      entityType: "routine",
      entityId: routine.id,
      details: {
        title: updated?.title ?? routine.title,
        ...(actsFor ? { onBehalfOfUserId: actsFor } : {}),
        ...(req.body.responsibleUserId !== undefined ? {
          previousResponsibleUserId: updated?.previousResponsibleUserId,
          responsibleUserId: updated?.responsibleUserId,
        } : {}),
      },
    });
    if (updated && updated.latestRevisionId !== routine.latestRevisionId) {
      await remapRoutineDescriptionAnnotations(req, routine.id);
      await logRoutineRevisionCreated(req, {
        companyId: routine.companyId,
        routineId: routine.id,
        revisionId: updated.latestRevisionId,
        revisionNumber: updated.latestRevisionNumber,
        changeSummary: "Updated routine",
        triggerCount: null,
      });
    }
    if (updated) {
      const { previousResponsibleUserId: _previousResponsibleUserId, ...response } = updated;
      const configurationWarnings = req.body.env !== undefined
        ? protectedEnvironmentKeyWarnings(await listProtectedEnvironmentKeyHolders(db), req.body.env, "env") : [];
      res.json({ ...response, ...(configurationWarnings.length ? { configurationWarnings } : {}) });
    } else {
      res.json(null);
    }
  });

  router.post("/routines/:id/revisions/:revisionId/restore", async (req, res) => {
    const routine = await assertCanManageExistingRoutine(req, req.params.id as string);
    if (!routine) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    await assertBoardCanAssignTasks(req, routine.companyId);
    // A restore can make the agent run the routine and turn it on: on a routine it does not run, the
    // person it acts for must be allowed to assign. (The service refuses any agent restore that would
    // hand the routine to another agent.)
    await assertAgentCanAssign(req, routine, routine.assigneeAgentId === req.actor.agentId);
    const result = await svc.restoreRevision(routine.id, req.params.revisionId as string, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      runId: req.actor.runId ?? null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: routine.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "routine.revision_restored",
      entityType: "routine",
      entityId: routine.id,
      details: {
        revisionId: result.revision.id,
        revisionNumber: result.revision.revisionNumber,
        restoredFromRevisionId: result.restoredFromRevisionId,
        restoredFromRevisionNumber: result.restoredFromRevisionNumber,
        triggerCount: result.revision.snapshot.triggers.length,
      },
    });
    await remapRoutineDescriptionAnnotations(req, routine.id);
    res.json(result);
  });

  router.get("/routines/:id/runs", async (req, res) => {
    const routine = await getAccessibleResource(req, res, svc.get(req.params.id as string), "Routine not found");
    if (!routine) return;
    const limit = Number(req.query.limit ?? 50);
    const result = await svc.listRuns(routine.id, Number.isFinite(limit) ? limit : 50);
    res.json(result);
  });

  router.post("/routines/:id/triggers", validate(createRoutineTriggerSchema), async (req, res) => {
    const routine = await assertCanManageExistingRoutine(req, req.params.id as string);
    if (!routine) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    await assertBoardCanAssignTasks(req, routine.companyId);
    await assertAgentCanAssign(req, routine, routine.assigneeAgentId === req.actor.agentId);
    // A standing check runs on its agent's heartbeat wake-ups, which only
    // happens while the responsibilities experiment is on.
    if (req.body.kind === "heartbeat" && (await instanceSettingsService(db).getExperimental()).enableResponsibilities !== true) {
      throw unprocessable("Standing checks are not enabled", { code: "standing_checks_not_enabled" });
    }
    const created = await svc.createTrigger(routine.id, req.body, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      runId: req.actor.runId ?? null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: routine.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "routine.trigger_created",
      entityType: "routine_trigger",
      entityId: created.trigger.id,
      details: { routineId: routine.id, kind: created.trigger.kind },
    });
    await logRoutineRevisionCreated(req, {
      companyId: routine.companyId,
      routineId: routine.id,
      revisionId: created.revision.id,
      revisionNumber: created.revision.revisionNumber,
      changeSummary: created.revision.changeSummary,
      triggerCount: created.revision.snapshot.triggers.length,
    });
    res.status(201).json(created);
  });

  router.patch("/routine-triggers/:id", validate(updateRoutineTriggerSchema), async (req, res) => {
    const trigger = await svc.getTrigger(req.params.id as string);
    if (!trigger) {
      res.status(404).json({ error: "Routine trigger not found" });
      return;
    }
    const routine = await assertCanManageExistingRoutine(req, trigger.routineId);
    if (!routine) {
      res.status(404).json({ error: "Routine trigger not found" });
      return;
    }
    await assertBoardCanAssignTasks(req, routine.companyId);
    await assertAgentCanAssign(req, routine, routine.assigneeAgentId === req.actor.agentId);
    const updated = await svc.updateTrigger(trigger.id, req.body, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      runId: req.actor.runId ?? null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: routine.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: triggerUpdateActivityAction(req.body),
      entityType: "routine",
      entityId: routine.id,
      details: { triggerId: trigger.id, kind: updated?.trigger.kind ?? trigger.kind },
    });
    if (updated) {
      await logRoutineRevisionCreated(req, {
        companyId: routine.companyId,
        routineId: routine.id,
        revisionId: updated.revision.id,
        revisionNumber: updated.revision.revisionNumber,
        changeSummary: updated.revision.changeSummary,
        triggerCount: updated.revision.snapshot.triggers.length,
      });
    }
    res.json(updated?.trigger ?? null);
  });

  router.delete("/routine-triggers/:id", async (req, res) => {
    const trigger = await svc.getTrigger(req.params.id as string);
    if (!trigger) {
      res.status(404).json({ error: "Routine trigger not found" });
      return;
    }
    const routine = await assertCanManageExistingRoutine(req, trigger.routineId);
    if (!routine) {
      res.status(404).json({ error: "Routine trigger not found" });
      return;
    }
    // Removing a schedule changes when the routine runs, like changing it.
    await assertAgentCanAssign(req, routine, routine.assigneeAgentId === req.actor.agentId);
    const deleted = await svc.deleteTrigger(trigger.id, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      runId: req.actor.runId ?? null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: routine.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "routine.trigger_deleted",
      entityType: "routine_trigger",
      entityId: trigger.id,
      details: { routineId: routine.id, kind: trigger.kind },
    });
    if (deleted.revision) {
      await logRoutineRevisionCreated(req, {
        companyId: routine.companyId,
        routineId: routine.id,
        revisionId: deleted.revision.id,
        revisionNumber: deleted.revision.revisionNumber,
        changeSummary: deleted.revision.changeSummary,
        triggerCount: deleted.revision.snapshot.triggers.length,
      });
    }
    res.status(204).end();
  });

  router.post(
    "/routine-triggers/:id/rotate-secret",
    validate(rotateRoutineTriggerSecretSchema),
    async (req, res) => {
      const trigger = await svc.getTrigger(req.params.id as string);
      if (!trigger) {
        res.status(404).json({ error: "Routine trigger not found" });
        return;
      }
      const routine = await assertCanManageExistingRoutine(req, trigger.routineId);
      if (!routine) {
        res.status(404).json({ error: "Routine trigger not found" });
        return;
      }
      const rotated = await svc.rotateTriggerSecret(trigger.id, {
        agentId: req.actor.type === "agent" ? req.actor.agentId : null,
        userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
        runId: req.actor.runId ?? null,
      });
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: routine.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "routine.trigger_secret_rotated",
        entityType: "routine_trigger",
        entityId: trigger.id,
        details: { routineId: routine.id },
      });
      await logRoutineRevisionCreated(req, {
        companyId: routine.companyId,
        routineId: routine.id,
        revisionId: rotated.revision.id,
        revisionNumber: rotated.revision.revisionNumber,
        changeSummary: rotated.revision.changeSummary,
        triggerCount: rotated.revision.snapshot.triggers.length,
      });
      res.json(rotated);
    },
  );

  router.post("/routines/:id/run", validateIssueMutationBody(runRoutineSchema), async (req, res) => {
    const routine = await assertCanManageExistingRoutine(req, req.params.id as string);
    if (!routine) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    await assertBoardCanAssignTasks(req, routine.companyId);
    // Starting another agent's routine starts that agent's work, as an assignment does.
    await assertAgentCanAssign(req, routine, routine.assigneeAgentId === req.actor.agentId);
    const input = req.actor.type === "agent" ? { ...req.body, source: "manual" as const } : req.body;
    const run = await svc.runRoutine(routine.id, input, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? null : null,
      runId: req.actor.runId ?? null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: routine.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "routine.run_triggered",
      entityType: "routine_run",
      entityId: run.id,
      details: { routineId: routine.id, source: run.source, status: run.status },
    });
    res.status(202).json(run);
  });

  router.post("/routine-triggers/public/:publicId/fire", async (req, res) => {
    if (!req.is("application/json")) {
      throw unsupportedMediaType("Send the webhook payload with Content-Type: application/json");
    }
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      throw badRequest("Webhook payload must be a JSON object");
    }
    const idempotencyScope = req.header("x-paperclip-idempotency-scope");
    if (idempotencyScope != null && idempotencyScope !== "trigger" && idempotencyScope !== "routine") {
      throw badRequest("X-Paperclip-Idempotency-Scope must be trigger or routine");
    }
    const result = await svc.firePublicTrigger(req.params.publicId as string, {
      sourceRunToken: req.header("x-paperclip-source-run-token"),
      idempotencyScope: idempotencyScope as "trigger" | "routine" | undefined,
      authorizationHeader: req.header("authorization"),
      signatureHeader: req.header("x-paperclip-signature"),
      hubSignatureHeader: req.header("x-hub-signature-256"),
      firefliesSignatureHeader: req.header("x-hub-signature"),
      timestampHeader: req.header("x-paperclip-timestamp"),
      idempotencyKey: req.header("idempotency-key") ?? req.header("x-github-delivery"),
      rawBody: (req as { rawBody?: Buffer }).rawBody ?? null,
      payload: typeof req.body === "object" && req.body !== null ? req.body as Record<string, unknown> : null,
    });
    res.status(202).json(result);
  });

  return router;
}
