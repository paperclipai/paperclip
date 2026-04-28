import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  assignRt2ParticipantSchema,
  claimRt2ExecutionSchema,
  createOneLinerInboundDraftSchema,
  completeRt2ExecutionSchema,
  createRt2BoardAttachmentSchema,
  createRt2BoardChecklistItemSchema,
  createRt2TaskSchema,
  createRt2TodoSchema,
  endRt2ParticipantSchema,
  enqueueRt2ExecutionSchema,
  failRt2ExecutionSchema,
  failRt2CaptureDraftSchema,
  promoteRt2CaptureDraftSchema,
  reorderRt2BoardChecklistSchema,
  startRt2ExecutionSchema,
  updateRt2BoardCardSchema,
  updateRt2BoardChecklistItemSchema,
  updateRt2TaskCapacitySchema,
  buildOneLinerRewardEvidence,
} from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { issueService } from "../services/issues.js";
import { rt2TaskExecutionService } from "../services/rt2-task-execution.js";
import { rt2TaskEngineService } from "../services/rt2-task-engine.js";
import { rt2WorkBoardService } from "../services/rt2-work-board.js";
import { assertCompanyAccess } from "./authz.js";
import { logActivity } from "../services/activity-log.js";

function assertBoardActor(req: Request): string {
  if (req.actor.type !== "board" || !req.actor.userId) {
    throw forbidden("Board user required");
  }
  return req.actor.userId;
}

export function rt2TaskRoutes(db: Db) {
  const router = Router();
  const svc = rt2TaskEngineService(db);
  const executionSvc = rt2TaskExecutionService(db);
  const issuesSvc = issueService(db);
  const boardSvc = rt2WorkBoardService(db);

  router.get("/companies/:companyId/rt2/tasks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const projectId = String(req.query.projectId ?? "").trim();
    if (!projectId) {
      throw badRequest("projectId is required");
    }

    const tasks = await svc.listByProject(companyId, projectId);
    res.json(tasks);
  });

  router.post("/companies/:companyId/rt2/tasks", validate(createRt2TaskSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actorUserId = assertBoardActor(req);

    const issue = await svc.createTask(companyId, actorUserId, req.body);
    const basePrice = req.body.deliverables.reduce(
      (total: number, deliverable: { basePrice: number }) => total + deliverable.basePrice,
      0,
    );

    res.status(201).json({
      issueId: issue.id,
      deliverables: req.body.deliverables.map((deliverable: { title: string; type: "document" | "artifact"; basePrice: number }) => ({
        title: deliverable.title,
        type: deliverable.type,
        basePrice: deliverable.basePrice,
      })),
      rewardEvidence: buildOneLinerRewardEvidence({
        basePrice,
        deliverableCount: req.body.deliverables.length,
        source: "web",
      }),
    });
  });

  router.post(
    "/companies/:companyId/rt2/one-liner/inbound-draft",
    validate(createOneLinerInboundDraftSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actorUserId = assertBoardActor(req);

      const storedDraft = await boardSvc.createInboundDraft(companyId, actorUserId, req.body);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "rt2.capture.inbound_draft_created",
        entityType: "capture_draft",
        entityId: storedDraft.id,
        details: {
          source: storedDraft.source,
          status: storedDraft.status,
          duplicateOfDraftId: storedDraft.duplicateOfDraftId,
          permissionStatus: storedDraft.permissionStatus,
        },
      });
      res.status(201).json({
        draft: storedDraft.parsedDraft,
        inbound: {
          id: storedDraft.id,
          source: storedDraft.source,
          channel: storedDraft.channel,
          externalUserId: storedDraft.externalUserId,
          status: storedDraft.status,
          duplicateOfDraftId: storedDraft.duplicateOfDraftId,
          permissionStatus: storedDraft.permissionStatus,
          reviewRequired: true,
        },
      });
    },
  );

  router.get("/companies/:companyId/rt2/work-board", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const issueIds = String(req.query.issueIds ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    res.json(await boardSvc.getBoardOverview(companyId, issueIds));
  });

  router.patch("/companies/:companyId/rt2/work-board/cards/:issueId", validate(updateRt2BoardCardSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actorUserId = assertBoardActor(req);
    const card = await boardSvc.updateCard(companyId, req.params.issueId as string, actorUserId, req.body);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId,
      action: "rt2.work_board.card_updated",
      entityType: "issue",
      entityId: req.params.issueId as string,
      details: req.body,
    });
    res.json(card);
  });

  router.post("/companies/:companyId/rt2/work-board/cards/:issueId/checklist", validate(createRt2BoardChecklistItemSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actorUserId = assertBoardActor(req);
    const item = await boardSvc.addChecklistItem(companyId, req.params.issueId as string, actorUserId, req.body);
    res.status(201).json(item);
  });

  router.patch("/companies/:companyId/rt2/work-board/cards/:issueId/checklist/:itemId", validate(updateRt2BoardChecklistItemSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardActor(req);
    res.json(await boardSvc.updateChecklistItem(companyId, req.params.issueId as string, req.params.itemId as string, req.body));
  });

  router.post("/companies/:companyId/rt2/work-board/cards/:issueId/checklist/reorder", validate(reorderRt2BoardChecklistSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardActor(req);
    res.json(await boardSvc.reorderChecklist(companyId, req.params.issueId as string, req.body.orderedItemIds));
  });

  router.post("/companies/:companyId/rt2/work-board/cards/:issueId/attachments", validate(createRt2BoardAttachmentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actorUserId = assertBoardActor(req);
    res.status(201).json(await boardSvc.addAttachment(companyId, req.params.issueId as string, actorUserId, req.body));
  });

  router.get("/companies/:companyId/rt2/capture-drafts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardActor(req);
    res.json(await boardSvc.listCaptureQueue(companyId));
  });

  router.post("/companies/:companyId/rt2/capture-drafts/:draftId/promote", validate(promoteRt2CaptureDraftSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actorUserId = assertBoardActor(req);
    const draft = await boardSvc.promoteCaptureDraft(companyId, req.params.draftId as string, actorUserId, req.body);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId,
      action: "rt2.capture.draft_promoted",
      entityType: "capture_draft",
      entityId: draft.id,
      details: { target: draft.promotionTarget, promotedIssueId: draft.promotedIssueId, promotedWorkProductId: draft.promotedWorkProductId },
    });
    res.json(draft);
  });

  router.post("/companies/:companyId/rt2/capture-drafts/:draftId/fail", validate(failRt2CaptureDraftSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actorUserId = assertBoardActor(req);
    const draft = await boardSvc.failCaptureDraft(companyId, req.params.draftId as string, actorUserId, req.body);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId,
      action: "rt2.capture.draft_failed",
      entityType: "capture_draft",
      entityId: draft.id,
      details: { failureCode: draft.failureCode, failureMessage: draft.failureMessage, status: draft.status },
    });
    res.json(draft);
  });

  router.get("/rt2/tasks/:taskIssueId", async (req, res) => {
    const task = await svc.getTaskMeta(req.params.taskIssueId as string);
    assertCompanyAccess(req, task.companyId);

    const detail = await svc.getDetail(task.issueId);
    res.json(detail);
  });

  router.get("/rt2/tasks/:taskIssueId/assignable-users", async (req, res) => {
    const task = await svc.getTaskMeta(req.params.taskIssueId as string);
    assertCompanyAccess(req, task.companyId);

    const users = await svc.listAssignableUsers(task.issueId);
    res.json(users);
  });

  router.post("/rt2/tasks/:taskIssueId/join", async (req, res) => {
    const actorUserId = assertBoardActor(req);
    const task = await svc.getTaskMeta(req.params.taskIssueId as string);
    assertCompanyAccess(req, task.companyId);

    const participant = await svc.joinTask(task.issueId, actorUserId);

    res.status(201).json(participant);
  });

  router.post("/rt2/tasks/:taskIssueId/participants", validate(assignRt2ParticipantSchema), async (req, res) => {
    const actorUserId = assertBoardActor(req);
    const task = await svc.getTaskMeta(req.params.taskIssueId as string);
    assertCompanyAccess(req, task.companyId);

    const participant = await svc.assignParticipant(task.issueId, actorUserId, req.body);

    res.status(201).json(participant);
  });

  router.patch("/rt2/tasks/:taskIssueId/capacity", validate(updateRt2TaskCapacitySchema), async (req, res) => {
    const actorUserId = assertBoardActor(req);
    const task = await svc.getTaskMeta(req.params.taskIssueId as string);
    assertCompanyAccess(req, task.companyId);

    const updated = await svc.updateCapacity(task.issueId, actorUserId, req.body);

    res.json(updated);
  });

  router.post(
    "/rt2/tasks/:taskIssueId/participants/:userId/end",
    validate(endRt2ParticipantSchema),
    async (req, res) => {
      const actorUserId = assertBoardActor(req);
      const task = await svc.getTaskMeta(req.params.taskIssueId as string);
      assertCompanyAccess(req, task.companyId);

      const ended = await svc.endParticipant(task.issueId, actorUserId, req.params.userId as string, req.body);

      res.json(ended);
    },
  );

  router.post("/rt2/tasks/:taskIssueId/todos", validate(createRt2TodoSchema), async (req, res) => {
    const actorUserId = assertBoardActor(req);
    const task = await svc.getTaskMeta(req.params.taskIssueId as string);
    assertCompanyAccess(req, task.companyId);

    const todo = await svc.createTodo(task.issueId, actorUserId, req.body);

    res.status(201).json(todo);
  });

  router.post("/rt2/tasks/:taskIssueId/executions", validate(enqueueRt2ExecutionSchema), async (req, res) => {
    const actorUserId = assertBoardActor(req);
    const task = await svc.getTaskMeta(req.params.taskIssueId as string);
    assertCompanyAccess(req, task.companyId);

    const attempt = await executionSvc.enqueue(task.issueId, actorUserId, req.body);

    res.status(201).json(attempt);
  });

  router.post("/rt2/executions/:attemptId/claim", validate(claimRt2ExecutionSchema), async (req, res) => {
    assertBoardActor(req);
    const attemptBefore = await executionSvc.getAttempt(req.params.attemptId as string);
    assertCompanyAccess(req, attemptBefore.companyId);

    const attempt = await executionSvc.claim(attemptBefore.id, req.body);

    res.json(attempt);
  });

  router.post("/rt2/executions/:attemptId/start", validate(startRt2ExecutionSchema), async (req, res) => {
    assertBoardActor(req);
    const attemptBefore = await executionSvc.getAttempt(req.params.attemptId as string);
    assertCompanyAccess(req, attemptBefore.companyId);

    const attempt = await executionSvc.start(attemptBefore.id, req.body);

    res.json(attempt);
  });

  router.post("/rt2/executions/:attemptId/complete", validate(completeRt2ExecutionSchema), async (req, res) => {
    assertBoardActor(req);
    const attemptBefore = await executionSvc.getAttempt(req.params.attemptId as string);
    assertCompanyAccess(req, attemptBefore.companyId);

    const attempt = await executionSvc.complete(attemptBefore.id, req.body);

    res.json(attempt);
  });

  router.post("/rt2/executions/:attemptId/fail", validate(failRt2ExecutionSchema), async (req, res) => {
    assertBoardActor(req);
    const attemptBefore = await executionSvc.getAttempt(req.params.attemptId as string);
    assertCompanyAccess(req, attemptBefore.companyId);

    const attempt = await executionSvc.fail(attemptBefore.id, req.body);

    res.json(attempt);
  });

  router.post("/rt2/executions/:attemptId/retry", async (req, res) => {
    const actorUserId = assertBoardActor(req);
    const attemptBefore = await executionSvc.getAttempt(req.params.attemptId as string);
    assertCompanyAccess(req, attemptBefore.companyId);

    const attempt = await executionSvc.retry(attemptBefore.id, actorUserId);

    res.status(201).json(attempt);
  });

  router.post("/rt2/todos/:todoIssueId/start", async (req, res) => {
    assertBoardActor(req);
    const todo = await issuesSvc.getById(req.params.todoIssueId as string);
    if (!todo) {
      res.status(404).json({ error: "RT2 todo not found" });
      return;
    }
    assertCompanyAccess(req, todo.companyId);

    const started = await svc.startTodo(todo.id);

    res.json(started.todo);
  });

  return router;
}
