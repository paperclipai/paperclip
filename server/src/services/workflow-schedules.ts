import { and, asc, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowSchedules, workflows } from "@paperclipai/db";
import type {
  CreateWorkflowSchedule,
  UpdateWorkflowSchedule,
  WorkflowSchedule,
} from "@paperclipai/shared";
import { nextCronTickFromExpression, validateCron } from "./cron.js";
import { workflowService } from "./workflows.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";
import { notFound, unprocessable } from "../errors.js";

export interface WorkflowScheduleActor {
  userId: string | null;
}

function toWorkflowSchedule(row: typeof workflowSchedules.$inferSelect): WorkflowSchedule {
  return {
    id: row.id,
    companyId: row.companyId,
    workflowId: row.workflowId,
    title: row.title,
    status: row.status,
    cronExpression: row.cronExpression,
    timezone: row.timezone,
    templateMarkdown: row.templateMarkdown,
    lastFiredAt: row.lastFiredAt,
    nextRunAt: row.nextRunAt,
    createdByUserId: row.createdByUserId ?? null,
    updatedByUserId: row.updatedByUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function workflowScheduleService(db: Db) {
  const workflowSvc = workflowService(db);

  async function getWorkflowScheduleById(id: string) {
    const row = await db.select().from(workflowSchedules).where(eq(workflowSchedules.id, id)).then((rows) => rows[0] ?? null);
    return row ? toWorkflowSchedule(row) : null;
  }

  return {
    listForWorkflow: async (workflowId: string) => {
      const rows = await db
        .select()
        .from(workflowSchedules)
        .where(eq(workflowSchedules.workflowId, workflowId))
        .orderBy(desc(workflowSchedules.updatedAt), asc(workflowSchedules.title));
      return rows.map(toWorkflowSchedule);
    },

    get: getWorkflowScheduleById,

    create: async (workflowId: string, input: CreateWorkflowSchedule, actor: WorkflowScheduleActor) => {
      const workflow = await db.select().from(workflows).where(eq(workflows.id, workflowId)).then((rows) => rows[0] ?? null);
      if (!workflow) throw notFound("Workflow not found");

      const cronError = validateCron(input.cronExpression);
      if (cronError) throw unprocessable(cronError);

      const nextRunAt = nextCronTickFromExpression(input.cronExpression, new Date());
      if (!nextRunAt) throw unprocessable("Cron expression does not produce a future fire time");

      const [inserted] = await db.insert(workflowSchedules).values({
        companyId: workflow.companyId,
        workflowId,
        title: input.title,
        status: input.status ?? "active",
        cronExpression: input.cronExpression,
        timezone: "UTC",
        templateMarkdown: input.templateMarkdown,
        lastFiredAt: null,
        nextRunAt,
        createdByUserId: actor.userId ?? "board",
        updatedByUserId: actor.userId ?? "board",
      }).returning();
      if (!inserted) throw unprocessable("Failed to create workflow schedule");
      return toWorkflowSchedule(inserted);
    },

    update: async (id: string, patch: UpdateWorkflowSchedule, actor: WorkflowScheduleActor) => {
      const existing = await db.select().from(workflowSchedules).where(eq(workflowSchedules.id, id)).then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const nextTitle = patch.title === undefined ? existing.title : patch.title;
      const nextStatus = patch.status === undefined ? existing.status : patch.status;
      const nextCronExpression = patch.cronExpression === undefined ? existing.cronExpression : patch.cronExpression;
      const nextTemplateMarkdown = patch.templateMarkdown === undefined ? existing.templateMarkdown : patch.templateMarkdown;
      let nextRunAt = existing.nextRunAt;

      if (patch.cronExpression !== undefined) {
        const cronError = validateCron(nextCronExpression);
        if (cronError) throw unprocessable(cronError);
      }

      if (nextStatus === "active" && (patch.cronExpression !== undefined || existing.status !== "active" || existing.nextRunAt == null)) {
        nextRunAt = nextCronTickFromExpression(nextCronExpression, new Date());
        if (!nextRunAt) throw unprocessable("Cron expression does not produce a future fire time");
      }

      const [updated] = await db.update(workflowSchedules).set({
        title: nextTitle,
        status: nextStatus,
        cronExpression: nextCronExpression,
        timezone: "UTC",
        templateMarkdown: nextTemplateMarkdown,
        nextRunAt,
        updatedByUserId: actor.userId ?? "board",
        updatedAt: new Date(),
      }).where(eq(workflowSchedules.id, id)).returning();

      return updated ? toWorkflowSchedule(updated) : null;
    },

    delete: async (id: string) => {
      const existing = await db.select().from(workflowSchedules).where(eq(workflowSchedules.id, id)).then((rows) => rows[0] ?? null);
      if (!existing) return false;
      await db.delete(workflowSchedules).where(eq(workflowSchedules.id, id));
      return true;
    },

    tickScheduledRuns: async (now: Date = new Date()) => {
      const due = await db
        .select({
          schedule: workflowSchedules,
          workflow: workflows,
        })
        .from(workflowSchedules)
        .innerJoin(workflows, eq(workflowSchedules.workflowId, workflows.id))
        .where(
          and(
            eq(workflowSchedules.status, "active"),
            inArray(workflows.status, ["active", "paused", "archived"]),
            isNotNull(workflowSchedules.nextRunAt),
            lte(workflowSchedules.nextRunAt, now),
          ),
        )
        .orderBy(asc(workflowSchedules.nextRunAt), asc(workflowSchedules.createdAt));

      let triggered = 0;
      let skipped = 0;

      for (const row of due) {
        if (!row.schedule.nextRunAt) continue;
        const nextRunAt = nextCronTickFromExpression(row.schedule.cronExpression, now);
        if (!nextRunAt) continue;

        const claimed = await db
          .update(workflowSchedules)
          .set({
            nextRunAt,
            updatedAt: now,
            ...(row.workflow.status === "active" ? { lastFiredAt: now } : {}),
          })
          .where(
            and(
              eq(workflowSchedules.id, row.schedule.id),
              eq(workflowSchedules.status, "active"),
              eq(workflowSchedules.nextRunAt, row.schedule.nextRunAt),
            ),
          )
          .returning({ id: workflowSchedules.id })
          .then((rows) => rows[0] ?? null);
        if (!claimed) continue;

        if (row.workflow.status !== "active") {
          skipped += 1;
          continue;
        }

        try {
          const run = await workflowSvc.runManual(row.workflow.id, {
            inputMarkdown: row.schedule.templateMarkdown,
          });
          triggered += 1;
          await logActivity(db, {
            companyId: row.workflow.companyId,
            actorType: "system",
            actorId: "workflow-scheduler",
            action: "workflow.run_started",
            entityType: "workflow_run",
            entityId: run.id,
            details: {
              workflowId: row.workflow.id,
              workflowScheduleId: row.schedule.id,
              source: "schedule",
            },
          });
        } catch (err) {
          logger.error({
            err,
            workflowId: row.workflow.id,
            workflowScheduleId: row.schedule.id,
          }, "workflow schedule tick failed to enqueue workflow run");
        }
      }

      return { triggered, skipped };
    },
  };
}
