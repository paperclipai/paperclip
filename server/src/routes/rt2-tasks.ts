import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createRt2TaskSchema,
  createRt2TodoSchema,
  endRt2ParticipantSchema,
  updateRt2TaskCapacitySchema,
} from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { publishLiveEvent } from "../services/live-events.js";
import { issueService } from "../services/issues.js";
import { rt2TaskEngineService } from "../services/rt2-task-engine.js";
import { assertCompanyAccess } from "./authz.js";

function assertBoardActor(req: Request): string {
  if (req.actor.type !== "board" || !req.actor.userId) {
    throw forbidden("Board user required");
  }
  return req.actor.userId;
}

export function rt2TaskRoutes(db: Db) {
  const router = Router();
  const svc = rt2TaskEngineService(db);
  const issuesSvc = issueService(db);

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
    publishLiveEvent({
      companyId,
      type: "rt2.task.updated",
      payload: {
        taskIssueId: issue.id,
        projectId: issue.projectId,
        mutation: "created",
      },
    });

    res.status(201).json({ issueId: issue.id });
  });

  router.get("/rt2/tasks/:taskIssueId", async (req, res) => {
    const task = await svc.getTaskMeta(req.params.taskIssueId as string);
    assertCompanyAccess(req, task.companyId);

    const detail = await svc.getDetail(task.issueId);
    res.json(detail);
  });

  router.post("/rt2/tasks/:taskIssueId/join", async (req, res) => {
    const actorUserId = assertBoardActor(req);
    const task = await svc.getTaskMeta(req.params.taskIssueId as string);
    assertCompanyAccess(req, task.companyId);

    const participant = await svc.joinTask(task.issueId, actorUserId);
    publishLiveEvent({
      companyId: task.companyId,
      type: "rt2.participant.updated",
      payload: {
        taskIssueId: task.issueId,
        projectId: task.projectId,
        participantUserId: participant.userId,
        mutation: "joined",
      },
    });

    res.status(201).json(participant);
  });

  router.patch("/rt2/tasks/:taskIssueId/capacity", validate(updateRt2TaskCapacitySchema), async (req, res) => {
    const actorUserId = assertBoardActor(req);
    const task = await svc.getTaskMeta(req.params.taskIssueId as string);
    assertCompanyAccess(req, task.companyId);

    const updated = await svc.updateCapacity(task.issueId, actorUserId, req.body);
    publishLiveEvent({
      companyId: updated.companyId,
      type: "rt2.participant.updated",
      payload: {
        taskIssueId: updated.issueId,
        projectId: updated.projectId,
        capacity: updated.capacity,
        mutation: "capacity_changed",
      },
    });

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
      publishLiveEvent({
        companyId: ended.companyId,
        type: "rt2.participant.updated",
        payload: {
          taskIssueId: ended.issueId,
          projectId: ended.projectId,
          participantUserId: ended.userId,
          mutation: "ended",
        },
      });

      res.json(ended);
    },
  );

  router.post("/rt2/tasks/:taskIssueId/todos", validate(createRt2TodoSchema), async (req, res) => {
    const actorUserId = assertBoardActor(req);
    const task = await svc.getTaskMeta(req.params.taskIssueId as string);
    assertCompanyAccess(req, task.companyId);

    const todo = await svc.createTodo(task.issueId, actorUserId, req.body);
    publishLiveEvent({
      companyId: task.companyId,
      type: "rt2.todo.updated",
      payload: {
        taskIssueId: task.issueId,
        projectId: task.projectId,
        todoIssueId: todo.id,
        mutation: "created",
      },
    });

    res.status(201).json(todo);
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
    publishLiveEvent({
      companyId: started.companyId,
      type: "rt2.todo.updated",
      payload: {
        taskIssueId: started.taskIssueId,
        projectId: started.projectId,
        todoIssueId: started.todo.id,
        mutation: "started",
      },
    });

    res.json(started.todo);
  });

  return router;
}
