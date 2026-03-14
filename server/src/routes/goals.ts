import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createGoalSchema, updateGoalSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { activityService, goalService, heartbeatService, logActivity, projectService, resolveCeoAgentId } from "../services/index.js";
import { logger } from "../middleware/logger.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function goalRoutes(db: Db) {
  const router = Router();
  const svc = goalService(db);
  const projectsSvc = projectService(db);
  const heartbeat = heartbeatService(db);
  const activitySvc = activityService(db);

  router.get("/companies/:companyId/goals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    res.json(result);
  });

  router.get("/goals/:id", async (req, res) => {
    const id = req.params.id as string;
    const goal = await svc.getById(id);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    assertCompanyAccess(req, goal.companyId);
    res.json(goal);
  });

  // Goal heartbeat-context endpoint — parallels GET /issues/:id/heartbeat-context
  router.get("/goals/:id/heartbeat-context", async (req, res) => {
    const id = req.params.id as string;
    const goal = await svc.getById(id);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    assertCompanyAccess(req, goal.companyId);

    const [ancestors, children, linkedProjects, goalIssues, recentActivity] = await Promise.all([
      svc.getAncestors(goal.id),
      svc.getChildren(goal.id),
      svc.getLinkedProjects(goal.id),
      svc.getIssuesForGoal(goal.id),
      activitySvc.list({ companyId: goal.companyId, entityType: "goal", entityId: goal.id }),
    ]);

    res.json({
      goal: {
        id: goal.id,
        title: goal.title,
        description: goal.description,
        status: goal.status,
        level: goal.level,
        parentId: goal.parentId,
        ownerAgentId: goal.ownerAgentId,
        reviewPolicy: goal.reviewPolicy,
        updatedAt: goal.updatedAt,
      },
      ancestors,
      children,
      linkedProjects,
      issues: goalIssues,
      recentActivity,
    });
  });

  router.post("/companies/:companyId/goals", validate(createGoalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const goal = await svc.create(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.created",
      entityType: "goal",
      entityId: goal.id,
      details: { title: goal.title },
    });
    res.status(201).json(goal);
  });

  router.patch("/goals/:id", validate(updateGoalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const goal = await svc.update(id, req.body);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.updated",
      entityType: "goal",
      entityId: goal.id,
      details: req.body,
    });

    // Goal activation wakeup: fire when status transitions to "active"
    if (existing.status !== "active" && goal.status === "active") {
      void (async () => {
        const targetAgentId = goal.ownerAgentId ?? (await resolveCeoAgentId(db, goal.companyId));
        if (targetAgentId) {
          heartbeat
            .wakeup(targetAgentId, {
              source: "automation",
              triggerDetail: "system",
              reason: "goal_activated",
              payload: { goalId: goal.id, mutation: "activate" },
              contextSnapshot: {
                goalId: goal.id,
                wakeReason: "goal_activated",
                source: "goal.activated",
              },
            })
            .catch((err) => logger.warn({ err, goalId: goal.id }, "failed to wake agent on goal activation"));
        }
      })();
    }

    // Subgoal completion detection: when a child goal transitions to "achieved",
    // check if all sibling goals are done
    if (existing.status !== "achieved" && goal.status === "achieved" && goal.parentId) {
      void (async () => {
        const openCount = await svc.countOpenSubgoals(goal.parentId!);
        if (openCount === 0) {
          const parent = await svc.getById(goal.parentId!);
          if (parent) {
            const targetAgentId = parent.ownerAgentId ?? (await resolveCeoAgentId(db, parent.companyId));
            if (targetAgentId) {
              heartbeat
                .wakeup(targetAgentId, {
                  source: "automation",
                  triggerDetail: "system",
                  reason: "goal_work_complete",
                  payload: { goalId: parent.id },
                  contextSnapshot: {
                    goalId: parent.id,
                    wakeReason: "goal_work_complete",
                    source: "goal.subgoal_completed",
                  },
                })
                .catch((err) => logger.warn({ err, goalId: parent.id }, "failed to wake agent on subgoal completion"));
            }
          }
        }
      })();
    }

    res.json(goal);
  });

  // Pursue endpoint: opt existing active goals into automation
  router.post("/goals/:id/pursue", async (req, res) => {
    const id = req.params.id as string;
    const goal = await svc.getById(id);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    assertCompanyAccess(req, goal.companyId);

    if (goal.status === "achieved" || goal.status === "cancelled") {
      res.status(409).json({ error: `Cannot pursue a goal with status "${goal.status}"` });
      return;
    }

    // Set ownerAgentId to CEO if not already set
    let updatedGoal = goal;
    if (!goal.ownerAgentId) {
      const ceoId = await resolveCeoAgentId(db, goal.companyId);
      if (ceoId) {
        updatedGoal = (await svc.update(id, { ownerAgentId: ceoId })) ?? goal;
      }
    }

    const targetAgentId = updatedGoal.ownerAgentId ?? (await resolveCeoAgentId(db, goal.companyId));
    if (!targetAgentId) {
      res.status(422).json({ error: "No CEO agent found to pursue this goal" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.pursued",
      entityType: "goal",
      entityId: goal.id,
    });

    void heartbeat
      .wakeup(targetAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "goal_activated",
        payload: { goalId: goal.id, mutation: "pursue" },
        contextSnapshot: {
          goalId: goal.id,
          wakeReason: "goal_activated",
          source: "goal.pursued",
        },
      })
      .catch((err) => logger.warn({ err, goalId: goal.id }, "failed to wake agent on goal pursue"));

    res.json(updatedGoal);
  });

  // Link a project to a goal
  router.post("/goals/:id/link-project", async (req, res) => {
    const goalId = req.params.id as string;
    const { projectId } = req.body as { projectId?: string };
    if (!projectId) {
      res.status(400).json({ error: "projectId is required" });
      return;
    }
    const goal = await svc.getById(goalId);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    assertCompanyAccess(req, goal.companyId);
    const project = await projectsSvc.getById(projectId);
    if (!project || project.companyId !== goal.companyId) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await svc.linkProject(goalId, projectId, goal.companyId);
    res.json({ linked: true, goalId, projectId });
  });

  // Unlink a project from a goal
  router.delete("/goals/:id/link-project/:projectId", async (req, res) => {
    const goalId = req.params.id as string;
    const projectId = req.params.projectId as string;
    const goal = await svc.getById(goalId);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    assertCompanyAccess(req, goal.companyId);
    await svc.unlinkProject(goalId, projectId);
    res.json({ unlinked: true, goalId, projectId });
  });

  router.delete("/goals/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const goal = await svc.remove(id);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.deleted",
      entityType: "goal",
      entityId: goal.id,
    });

    res.json(goal);
  });

  return router;
}
