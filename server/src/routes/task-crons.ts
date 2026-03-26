import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agents, cronSchedules, issues as issuesTable } from "@paperclipai/db";
import {
  attachTaskCronIssueSchema,
  createTaskCronScheduleSchema,
  updateTaskCronScheduleSchema,
} from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { validate } from "../middleware/validate.js";
import { assertBoardOrOwnAgent, assertCompanyAccess, getActorInfo } from "./authz.js";
import { issueService, logActivity, taskCronService } from "../services/index.js";
import { notFound } from "../errors.js";

async function resolveIssueId(db: Db, rawIssueId: string) {
  const issuesSvc = issueService(db);
  if (/^[A-Z]+-\d+$/i.test(rawIssueId)) {
    const issue = await issuesSvc.getByIdentifier(rawIssueId);
    return issue?.id ?? null;
  }
  return rawIssueId;
}

export function taskCronRoutes(db: Db) {
  const router = Router();
  const schedules = taskCronService(db);
  const issuesSvc = issueService(db);

  router.get("/companies/:companyId/task-cron-schedules", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const projectId = req.query.projectId as string | undefined;

    if (projectId) {
      // When scoped to a project, only return schedules linked to issues in that project
      const rows = await db
        .select({
          id: schedulesTable.id,
          companyId: schedulesTable.companyId,
          agentId: schedulesTable.agentId,
          issueId: schedulesTable.issueId,
          name: schedulesTable.name,
          expression: schedulesTable.expression,
          timezone: schedulesTable.timezone,
          enabled: schedulesTable.enabled,
          issueMode: schedulesTable.issueMode,
          issueTemplate: schedulesTable.issueTemplate,
          payload: schedulesTable.payload,
          lastTriggeredAt: schedulesTable.lastTriggeredAt,
          nextTriggerAt: schedulesTable.nextTriggerAt,
          createdAt: schedulesTable.createdAt,
          updatedAt: schedulesTable.updatedAt,
        })
        .from(schedulesTable)
        .innerJoin(issuesTable, eq(schedulesTable.issueId, issuesTable.id))
        .where(
          and(
            eq(schedulesTable.companyId, companyId),
            eq(issuesTable.projectId, projectId),
          ),
        )
        .orderBy(schedulesTable.createdAt);
      res.json(rows);
      return;
    }

    const rows = await db
      .select()
      .from(schedulesTable)
      .where(eq(schedulesTable.companyId, companyId))
      .orderBy(schedulesTable.createdAt);
    res.json(rows);
  });

  router.get("/agents/:id/task-cron-schedules", async (req, res) => {
    const agentId = req.params.id as string;
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    assertCompanyAccess(req, agent.companyId);
    const rows = await schedules.listForAgent(agent.companyId, agentId);
    res.json(rows);
  });

  router.post("/agents/:id/task-cron-schedules", validate(createTaskCronScheduleSchema), async (req, res) => {
    const agentId = req.params.id as string;
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    assertBoardOrOwnAgent(req, agent.id);
    assertCompanyAccess(req, agent.companyId);

    const body = req.body as {
      name: string;
      expression: string;
      timezone?: string;
      enabled?: boolean;
      issueMode?: "create_new" | "reuse_existing" | "reopen_existing";
      issueId?: string | null;
      issueTemplate?: Record<string, unknown> | null;
      payload?: Record<string, unknown> | null;
    };
    if (body.issueId) {
      const issueExists = await schedules.issueExistsInCompany(body.issueId, agent.companyId);
      if (!issueExists) throw notFound("Issue not found in company");
    }
    const row = await schedules.createSchedule(agent.companyId, {
      agentId: agent.id,
      name: body.name,
      expression: body.expression,
      timezone: body.timezone,
      enabled: body.enabled,
      issueMode: body.issueMode,
      issueId: body.issueId ?? null,
      issueTemplate: body.issueTemplate ?? null,
      payload: body.payload ?? null,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "task_cron.created",
      entityType: "task_cron_schedule",
      entityId: row.id,
      details: { agentId: row.agentId, issueId: row.issueId, expression: row.expression, timezone: row.timezone },
    });

    res.status(201).json(row);
  });

  router.patch("/task-cron-schedules/:id", validate(updateTaskCronScheduleSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await schedules.getById(id);
    if (!existing) throw notFound("Task cron schedule not found");
    assertBoardOrOwnAgent(req, existing.agentId);
    assertCompanyAccess(req, existing.companyId);

    const body = req.body as {
      name?: string;
      expression?: string;
      timezone?: string | null;
      enabled?: boolean;
      issueMode?: "create_new" | "reuse_existing" | "reopen_existing";
      issueId?: string | null;
      issueTemplate?: Record<string, unknown> | null;
      payload?: Record<string, unknown> | null;
    };
    if (body.issueId) {
      const issueExists = await schedules.issueExistsInCompany(body.issueId, existing.companyId);
      if (!issueExists) throw notFound("Issue not found in company");
    }
    const row = await schedules.updateSchedule(id, body);
    if (!row) throw notFound("Task cron schedule not found");
    res.json(row);
  });

  router.delete("/task-cron-schedules/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await schedules.getById(id);
    if (!existing) throw notFound("Task cron schedule not found");
    assertBoardOrOwnAgent(req, existing.agentId);
    assertCompanyAccess(req, existing.companyId);
    await schedules.deleteSchedule(id);
    res.json({ ok: true });
  });

  router.get("/issues/:issueId/task-cron-schedules", async (req, res) => {
    const rawIssueId = req.params.issueId as string;
    const issueId = await resolveIssueId(db, rawIssueId);
    if (!issueId) throw notFound("Issue not found");
    const issue = await issuesSvc.getById(issueId);
    if (!issue) throw notFound("Issue not found");
    assertCompanyAccess(req, issue.companyId);
    const rows = await schedules.listForIssue(issue.companyId, issue.id);
    res.json(rows);
  });

  router.post(
    "/issues/:issueId/task-cron-schedules",
    validate(createTaskCronScheduleSchema),
    async (req, res) => {
      const rawIssueId = req.params.issueId as string;
      const issueId = await resolveIssueId(db, rawIssueId);
      if (!issueId) throw notFound("Issue not found");
      const issue = await issuesSvc.getById(issueId);
      if (!issue) throw notFound("Issue not found");
      if (!issue.assigneeAgentId) throw notFound("Issue has no assigned agent");
      assertBoardOrOwnAgent(req, issue.assigneeAgentId);
      assertCompanyAccess(req, issue.companyId);

      const body = req.body as {
        name: string;
        expression: string;
        timezone?: string;
        enabled?: boolean;
        issueMode?: "create_new" | "reuse_existing" | "reopen_existing";
        issueTemplate?: Record<string, unknown> | null;
        payload?: Record<string, unknown> | null;
      };
      const row = await schedules.createSchedule(issue.companyId, {
        agentId: issue.assigneeAgentId,
        issueId: issue.id,
        name: body.name,
        expression: body.expression,
        timezone: body.timezone,
        enabled: body.enabled,
        issueMode: body.issueMode ?? "reopen_existing",
        issueTemplate: body.issueTemplate ?? null,
        payload: body.payload ?? null,
      });
      res.status(201).json(row);
    },
  );

  router.post("/task-cron-schedules/:id/attach-issue", validate(attachTaskCronIssueSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await schedules.getById(id);
    if (!existing) throw notFound("Task cron schedule not found");
    assertBoardOrOwnAgent(req, existing.agentId);
    assertCompanyAccess(req, existing.companyId);
    const issueId = (req.body as { issueId: string }).issueId;
    const issueExists = await schedules.issueExistsInCompany(issueId, existing.companyId);
    if (!issueExists) throw notFound("Issue not found in company");
    const updated = await schedules.attachIssue(id, issueId);
    if (!updated) throw notFound("Task cron schedule not found");
    res.json(updated);
  });

  router.post("/task-cron-schedules/:id/detach-issue", async (req, res) => {
    const id = req.params.id as string;
    const existing = await schedules.getById(id);
    if (!existing) throw notFound("Task cron schedule not found");
    assertBoardOrOwnAgent(req, existing.agentId);
    assertCompanyAccess(req, existing.companyId);
    const updated = await schedules.detachIssue(id);
    if (!updated) throw notFound("Task cron schedule not found");
    res.json(updated);
  });

  return router;
}

const schedulesTable = cronSchedules;
