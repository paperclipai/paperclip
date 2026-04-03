import { Router } from "express";
import { eq, sql, and } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { goals, issues, agents, projects } from "@ironworksai/db";
import { assertCompanyAccess } from "./authz.js";
import { getVelocityData } from "../services/velocity.js";

export function goalStatsRoutes(db: Db) {
  const router = Router();

  router.get("/goals/:goalId/progress", async (req, res) => {
    const goalId = req.params.goalId as string;

    const [goal] = await db
      .select({ id: goals.id, companyId: goals.companyId })
      .from(goals)
      .where(eq(goals.id, goalId))
      .limit(1);

    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }

    assertCompanyAccess(req, goal.companyId);

    const [counts] = await db
      .select({
        totalIssues: sql<number>`count(*)`,
        completedIssues: sql<number>`count(*) filter (where ${issues.status} = 'done')`,
        inProgressIssues: sql<number>`count(*) filter (where ${issues.status} = 'in_progress')`,
        blockedIssues: sql<number>`count(*) filter (where ${issues.status} = 'blocked')`,
        todoIssues: sql<number>`count(*) filter (where ${issues.status} = 'todo')`,
      })
      .from(issues)
      .where(eq(issues.goalId, goalId));

    const total = Number(counts?.totalIssues ?? 0);
    const completed = Number(counts?.completedIssues ?? 0);
    const progressPercent = total > 0 ? Math.round((completed / total) * 100) : 0;

    const assignedAgents = await db
      .selectDistinct({ id: agents.id, name: agents.name })
      .from(agents)
      .innerJoin(issues, eq(issues.assigneeAgentId, agents.id))
      .where(eq(issues.goalId, goalId));

    const relatedProjects = await db
      .selectDistinct({ id: projects.id, name: projects.name })
      .from(projects)
      .innerJoin(issues, eq(issues.projectId, projects.id))
      .where(eq(issues.goalId, goalId));

    res.json({
      totalIssues: total,
      completedIssues: completed,
      inProgressIssues: Number(counts?.inProgressIssues ?? 0),
      blockedIssues: Number(counts?.blockedIssues ?? 0),
      todoIssues: Number(counts?.todoIssues ?? 0),
      progressPercent,
      agents: assignedAgents,
      projects: relatedProjects,
    });
  });

  router.get("/companies/:companyId/goals/progress", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const companyGoals = await db
      .select({
        id: goals.id,
        title: goals.title,
        status: goals.status,
        level: goals.level,
        totalIssues: sql<number>`count(${issues.id})`,
        completedIssues: sql<number>`count(*) filter (where ${issues.status} = 'done')`,
      })
      .from(goals)
      .leftJoin(issues, eq(issues.goalId, goals.id))
      .where(eq(goals.companyId, companyId))
      .groupBy(goals.id, goals.title, goals.status, goals.level);

    const result = companyGoals.map((g) => {
      const total = Number(g.totalIssues);
      const completed = Number(g.completedIssues);
      return {
        id: g.id,
        title: g.title,
        status: g.status,
        level: g.level,
        totalIssues: total,
        completedIssues: completed,
        progressPercent: total > 0 ? Math.round((completed / total) * 100) : 0,
      };
    });

    res.json(result);
  });

  /**
   * GET /companies/:companyId/velocity?weeks=12
   * Returns weekly issue completion/cancellation counts for the last N weeks.
   */
  router.get("/companies/:companyId/velocity", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const weeksParam = req.query.weeks;
    const weeks =
      typeof weeksParam === "string" && /^\d+$/.test(weeksParam)
        ? Math.min(Math.max(parseInt(weeksParam, 10), 1), 52)
        : 12;

    const data = await getVelocityData(db, companyId, weeks);
    res.json(data);
  });

  return router;
}
