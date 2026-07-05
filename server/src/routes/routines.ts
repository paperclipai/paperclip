import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createRoutineSchema,
  createDocumentAnnotationCommentSchema,
  createDocumentAnnotationThreadSchema,
  createRoutineTriggerSchema,
  rotateRoutineTriggerSecretSchema,
  runRoutineSchema,
  updateDocumentAnnotationThreadSchema,
  updateRoutineSchema,
  updateRoutineTriggerSchema,
} from "@paperclipai/shared";
import { trackRoutineCreated } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import { accessService, documentAnnotationService, logActivity, routineService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { forbidden, unauthorized } from "../errors.js";
import { getTelemetryClient } from "../telemetry.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

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

  function assertCanManageCompanyRoutine(req: Request, companyId: string, assigneeAgentId?: string | null) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return;
    if (req.actor.type !== "agent" || !req.actor.agentId) throw unauthorized();
    if (assigneeAgentId !== req.actor.agentId) {
      throw forbidden("Agents can only manage routines assigned to themselves");
    }
  }

  async function assertCanManageExistingRoutine(req: Request, routineId: string) {
    const routine = await svc.get(routineId);
    if (!routine) return null;
    assertCompanyAccess(req, routine.companyId);
    if (req.actor.type === "board") return routine;
    if (req.actor.type !== "agent" || !req.actor.agentId) throw unauthorized();
    if (routine.assigneeAgentId !== req.actor.agentId) {
      throw forbidden("Agents can only manage routines assigned to themselves");
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
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const result = await svc.list(companyId, { projectId });
    res.json(result);
  });

  router.post("/companies/:companyId/routines", validate(createRoutineSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertBoardCanAssignTasks(req, companyId);
    assertCanManageCompanyRoutine(req, companyId, req.body.assigneeAgentId);
    const created = await svc.create(companyId, req.body, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      runId: req.actor.runId ?? null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
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
    res.status(201).json(created);
  });

  router.get("/routines/:id", async (req, res) => {
    const detail = await svc.getDetail(req.params.id as string);
    if (!detail) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    assertCompanyAccess(req, detail.companyId);
    res.json(detail);
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
    if (assigneeWillChange) {
      await assertBoardCanAssignTasks(req, routine.companyId);
    }
    const statusWillActivate =
      req.body.status !== undefined &&
      req.body.status === "active" &&
      routine.status !== "active";
    if (statusWillActivate) {
      await assertBoardCanAssignTasks(req, routine.companyId);
    }
    if (
      req.actor.type === "agent" &&
      req.body.assigneeAgentId !== undefined &&
      req.body.assigneeAgentId !== req.actor.agentId
    ) {
      throw forbidden("Agents can only assign routines to themselves");
    }
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
      action: "routine.updated",
      entityType: "routine",
      entityId: routine.id,
      details: { title: updated?.title ?? routine.title },
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
    res.json(updated);
  });

  router.post("/routines/:id/revisions/:revisionId/restore", async (req, res) => {
    const routine = await assertCanManageExistingRoutine(req, req.params.id as string);
    if (!routine) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    await assertBoardCanAssignTasks(req, routine.companyId);
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
    const routine = await svc.get(req.params.id as string);
    if (!routine) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    assertCompanyAccess(req, routine.companyId);
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
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    await assertBoardCanAssignTasks(req, routine.companyId);
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
      action: "routine.trigger_updated",
      entityType: "routine_trigger",
      entityId: trigger.id,
      details: { routineId: routine.id, kind: updated?.trigger.kind ?? trigger.kind },
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
      res.status(404).json({ error: "Routine not found" });
      return;
    }
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
        res.status(404).json({ error: "Routine not found" });
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

  router.post("/routines/:id/run", validate(runRoutineSchema), async (req, res) => {
    const routine = await assertCanManageExistingRoutine(req, req.params.id as string);
    if (!routine) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    await assertBoardCanAssignTasks(req, routine.companyId);
    const run = await svc.runRoutine(routine.id, req.body, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? null : null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: routine.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "routine.run_triggered",
      entityType: "routine_run",
      entityId: run.id,
      details: { routineId: routine.id, source: run.source, status: run.status },
    });
    res.status(202).json(run);
  });

  router.post("/routine-triggers/public/:publicId/fire", async (req, res) => {
    const result = await svc.firePublicTrigger(req.params.publicId as string, {
      authorizationHeader: req.header("authorization"),
      signatureHeader: req.header("x-paperclip-signature"),
      hubSignatureHeader: req.header("x-hub-signature-256"),
      timestampHeader: req.header("x-paperclip-timestamp"),
      idempotencyKey: req.header("idempotency-key"),
      rawBody: (req as { rawBody?: Buffer }).rawBody ?? null,
      payload: typeof req.body === "object" && req.body !== null ? req.body as Record<string, unknown> : null,
    });
    res.status(202).json(result);
  });

  return router;
}
