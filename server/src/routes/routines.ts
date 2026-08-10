import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
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
import { assertCompanyAccess, getAccessibleResource, getActorInfo, hasCompanyAccess } from "./authz.js";
import { forbidden, unauthorized } from "../errors.js";
import { getTelemetryClient } from "../telemetry.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { RoutineRecoveryMutationAuthorization } from "../services/routines.js";

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

  function assertCanManageCompanyRoutine(req: Request, companyId: string, assigneeAgentId?: string | null) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return;
    if (req.actor.type !== "agent" || !req.actor.agentId) throw unauthorized();
    if (assigneeAgentId !== req.actor.agentId) {
      throw forbidden("Agents can only manage routines assigned to themselves");
    }
  }

  function recoveryInventoryIds(value: unknown, key: "routines" | "triggers") {
    const contract = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
    const recovery = contract?.routineRecovery &&
      typeof contract.routineRecovery === "object" &&
      !Array.isArray(contract.routineRecovery)
      ? contract.routineRecovery as Record<string, unknown>
      : null;
    const entries = recovery && Array.isArray(recovery[key]) ? recovery[key] : [];
    return entries
      .map((entry) =>
        entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.id === "string"
          ? entry.id
          : null,
      )
      .filter((id): id is string => Boolean(id));
  }

  async function activeRoutineRecoveryAuthorization(
    req: Request,
    routine: { id: string; companyId: string },
  ): Promise<RoutineRecoveryMutationAuthorization | null> {
    if (req.actor.type === "board") {
      const candidates = await db
        .select({
          actionId: issueRecoveryActions.id,
          attemptCount: issueRecoveryActions.attemptCount,
          ownerAgentId: issueRecoveryActions.ownerAgentId,
          recoveryIssueId: issues.id,
          executionContract: issues.executionContract,
          originId: issues.originId,
        })
        .from(issueRecoveryActions)
        .innerJoin(
          issues,
          and(
            eq(issues.id, issueRecoveryActions.sourceIssueId),
            eq(issues.companyId, issueRecoveryActions.companyId),
          ),
        )
        .where(
          and(
            eq(issueRecoveryActions.companyId, routine.companyId),
            eq(issueRecoveryActions.cause, "terminated_routine_owner"),
            inArray(issueRecoveryActions.status, ["active", "escalated"]),
          ),
        )
        .orderBy(desc(issueRecoveryActions.updatedAt));
      const candidate = candidates.find((entry) =>
        recoveryInventoryIds(entry.executionContract, "routines").includes(routine.id),
      );
      if (!candidate) return null;
      const terminatedAgentId = candidate.originId?.startsWith("agent_termination_routine_handoff:")
        ? candidate.originId.slice("agent_termination_routine_handoff:".length)
        : null;
      if (!terminatedAgentId) return null;
      return {
        actorType: "board",
        actionId: candidate.actionId,
        attemptCount: candidate.attemptCount,
        recoveryIssueId: candidate.recoveryIssueId,
        terminatedAgentId,
        ownerAgentId: candidate.ownerAgentId,
        runId: null,
        routineIds: recoveryInventoryIds(candidate.executionContract, "routines"),
        triggerIds: recoveryInventoryIds(candidate.executionContract, "triggers"),
      };
    }
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.runId) return null;
    const run = await db
      .select({ status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, req.actor.runId),
          eq(heartbeatRuns.companyId, routine.companyId),
          eq(heartbeatRuns.agentId, req.actor.agentId),
          eq(heartbeatRuns.status, "running"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    const context = run?.contextSnapshot;
    const routineIds = Array.isArray(context?.routineIds)
      ? context.routineIds.filter((value): value is string => typeof value === "string")
      : [];
    if (
      !context ||
      context.recoveryCause !== "terminated_routine_owner" ||
      context.source !== "issue_recovery_action" ||
      context.wakeReason !== "source_scoped_recovery_action" ||
      !routineIds.includes(routine.id) ||
      typeof context.recoveryActionId !== "string" ||
      typeof context.recoveryAttempt !== "number" ||
      typeof context.routineRecoveryIssueId !== "string" ||
      typeof context.terminatedAgentId !== "string"
    ) {
      return null;
    }
    const [authorization] = await db
      .select({
        actionId: issueRecoveryActions.id,
        attemptCount: issueRecoveryActions.attemptCount,
        ownerAgentId: issueRecoveryActions.ownerAgentId,
        recoveryIssueId: issues.id,
        executionContract: issues.executionContract,
      })
      .from(issueRecoveryActions)
      .innerJoin(
        issues,
        and(
          eq(issues.id, issueRecoveryActions.sourceIssueId),
          eq(issues.companyId, issueRecoveryActions.companyId),
        ),
      )
      .where(
        and(
          eq(issueRecoveryActions.id, context.recoveryActionId),
          eq(issueRecoveryActions.attemptCount, context.recoveryAttempt),
          eq(issueRecoveryActions.companyId, routine.companyId),
          eq(issueRecoveryActions.cause, "terminated_routine_owner"),
          eq(issueRecoveryActions.status, "active"),
          eq(issueRecoveryActions.ownerAgentId, req.actor.agentId),
          or(
            isNull(issueRecoveryActions.timeoutAt),
            gt(issueRecoveryActions.timeoutAt, new Date()),
          )!,
          eq(issues.id, context.routineRecoveryIssueId),
          eq(issues.assigneeAgentId, req.actor.agentId),
          eq(issues.originKind, "harness_liveness_escalation"),
          eq(issues.originId, `agent_termination_routine_handoff:${context.terminatedAgentId}`),
        ),
      )
      .limit(1);
    if (!authorization) return null;
    const contractRoutineIds = recoveryInventoryIds(authorization.executionContract, "routines");
    const triggerIds = recoveryInventoryIds(authorization.executionContract, "triggers");
    if (
      authorization.attemptCount !== context.recoveryAttempt ||
      authorization.recoveryIssueId !== context.routineRecoveryIssueId ||
      !contractRoutineIds.includes(routine.id)
    ) {
      return null;
    }
    return {
      actorType: "agent",
      actionId: authorization.actionId,
      attemptCount: authorization.attemptCount,
      recoveryIssueId: authorization.recoveryIssueId,
      terminatedAgentId: context.terminatedAgentId,
      ownerAgentId: authorization.ownerAgentId,
      runId: req.actor.runId,
      routineIds: contractRoutineIds,
      triggerIds,
    };
  }

  async function assertCanManageExistingRoutine(
    req: Request,
    routineId: string,
    options: { includeBoardRecoveryAuthorization?: boolean } = {},
  ) {
    const routine = await svc.get(routineId);
    if (!routine || !hasCompanyAccess(req, routine.companyId)) return null;
    assertCompanyAccess(req, routine.companyId);
    if (req.actor.type === "board") {
      return {
        routine,
        recoveryAuthorization: options.includeBoardRecoveryAuthorization === false
          ? null
          : await activeRoutineRecoveryAuthorization(req, routine),
      };
    }
    if (req.actor.type !== "agent" || !req.actor.agentId) throw unauthorized();
    if (routine.assigneeAgentId === req.actor.agentId && !req.actor.runId) {
      return { routine, recoveryAuthorization: null };
    }
    const recoveryAuthorization = await activeRoutineRecoveryAuthorization(req, routine);
    if (
      routine.assigneeAgentId !== req.actor.agentId &&
      !recoveryAuthorization
    ) {
      throw forbidden("Agents can only manage routines assigned to themselves");
    }
    return { routine, recoveryAuthorization };
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
    res.status(201).json(created);
  });

  router.get("/routines/:id", async (req, res) => {
    const detail = await getAccessibleResource(req, res, svc.getDetail(req.params.id as string), "Routine not found");
    if (!detail) return;
    res.json(detail);
  });

  router.get("/routines/:id/revisions", async (req, res) => {
    const accessResult = await assertCanManageExistingRoutine(req, req.params.id as string, {
      includeBoardRecoveryAuthorization: false,
    });
    if (!accessResult) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    const { routine } = accessResult;
    const revisions = await svc.listRevisions(routine.id);
    res.json(revisions);
  });

  router.get("/routines/:id/description/annotations", async (req, res) => {
    const accessResult = await assertCanManageExistingRoutine(req, req.params.id as string);
    if (!accessResult) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    const { routine } = accessResult;
    const status = req.query.status === "resolved" || req.query.status === "all" ? req.query.status : "open";
    const threads = await documentAnnotationsSvc.listThreadsForRoutineDocument(routine.id, routineDocumentKey, {
      status,
      includeComments: parseBooleanQuery(req.query.includeComments),
    });
    res.json(threads);
  });

  router.get("/routines/:id/description/annotations/:threadId", async (req, res) => {
    const accessResult = await assertCanManageExistingRoutine(req, req.params.id as string);
    if (!accessResult) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    const { routine } = accessResult;
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
      const accessResult = await assertCanManageExistingRoutine(req, req.params.id as string);
      if (!accessResult) {
        res.status(404).json({ error: "Routine not found" });
        return;
      }
      const { routine } = accessResult;
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
      const accessResult = await assertCanManageExistingRoutine(req, req.params.id as string);
      if (!accessResult) {
        res.status(404).json({ error: "Routine not found" });
        return;
      }
      const { routine } = accessResult;
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
      const accessResult = await assertCanManageExistingRoutine(req, req.params.id as string);
      if (!accessResult) {
        res.status(404).json({ error: "Routine not found" });
        return;
      }
      const { routine } = accessResult;
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
    const accessResult = await assertCanManageExistingRoutine(req, req.params.id as string, {
      includeBoardRecoveryAuthorization: false,
    });
    if (!accessResult) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    const { routine } = accessResult;
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
    const recoveryAuthorization = req.actor.type === "board"
      ? await activeRoutineRecoveryAuthorization(req, routine)
      : accessResult.recoveryAuthorization;
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
      routineRecoveryAuthorization: recoveryAuthorization,
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
    const accessResult = await assertCanManageExistingRoutine(req, req.params.id as string, {
      includeBoardRecoveryAuthorization: false,
    });
    if (!accessResult) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    const { routine } = accessResult;
    await assertBoardCanAssignTasks(req, routine.companyId);
    const recoveryAuthorization = req.actor.type === "board"
      ? await activeRoutineRecoveryAuthorization(req, routine)
      : accessResult.recoveryAuthorization;
    const result = await svc.restoreRevision(routine.id, req.params.revisionId as string, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      runId: req.actor.runId ?? null,
      routineRecoveryAuthorization: recoveryAuthorization,
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
    const accessResult = await assertCanManageExistingRoutine(req, req.params.id as string, {
      includeBoardRecoveryAuthorization: false,
    });
    if (!accessResult) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    const { routine } = accessResult;
    await assertBoardCanAssignTasks(req, routine.companyId);
    const recoveryAuthorization = req.actor.type === "board"
      ? await activeRoutineRecoveryAuthorization(req, routine)
      : accessResult.recoveryAuthorization;
    const created = await svc.createTrigger(routine.id, req.body, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      runId: req.actor.runId ?? null,
      routineRecoveryAuthorization: recoveryAuthorization,
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
    const accessResult = await assertCanManageExistingRoutine(req, trigger.routineId, {
      includeBoardRecoveryAuthorization: false,
    });
    if (!accessResult) {
      res.status(404).json({ error: "Routine trigger not found" });
      return;
    }
    const { routine } = accessResult;
    await assertBoardCanAssignTasks(req, routine.companyId);
    const recoveryAuthorization = req.actor.type === "board"
      ? await activeRoutineRecoveryAuthorization(req, routine)
      : accessResult.recoveryAuthorization;
    const updated = await svc.updateTrigger(trigger.id, req.body, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      runId: req.actor.runId ?? null,
      routineRecoveryAuthorization: recoveryAuthorization,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: routine.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
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
    const accessResult = await assertCanManageExistingRoutine(req, trigger.routineId);
    if (!accessResult) {
      res.status(404).json({ error: "Routine trigger not found" });
      return;
    }
    const { routine, recoveryAuthorization } = accessResult;
    const deleted = await svc.deleteTrigger(trigger.id, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      runId: req.actor.runId ?? null,
      routineRecoveryAuthorization: recoveryAuthorization,
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
      const accessResult = await assertCanManageExistingRoutine(req, trigger.routineId);
      if (!accessResult) {
        res.status(404).json({ error: "Routine trigger not found" });
        return;
      }
      const { routine, recoveryAuthorization } = accessResult;
      if (
        recoveryAuthorization &&
        req.actor.type === "agent" &&
        routine.assigneeAgentId !== req.actor.agentId
      ) {
        throw forbidden("Accept routine ownership before rotating its webhook secret");
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

  router.post("/routines/:id/run", validate(runRoutineSchema), async (req, res) => {
    const accessResult = await assertCanManageExistingRoutine(req, req.params.id as string, {
      includeBoardRecoveryAuthorization: false,
    });
    if (!accessResult) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    const { routine } = accessResult;
    await assertBoardCanAssignTasks(req, routine.companyId);
    const recoveryAuthorization = req.actor.type === "board"
      ? await activeRoutineRecoveryAuthorization(req, routine)
      : accessResult.recoveryAuthorization;
    const run = await svc.runRoutine(routine.id, req.body, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? null : null,
      runId: req.actor.runId ?? null,
      routineRecoveryAuthorization: recoveryAuthorization,
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
