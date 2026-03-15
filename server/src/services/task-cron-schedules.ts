import type { Db } from "@paperclipai/db";
import { cronSchedules, issues } from "@paperclipai/db";
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { issueService } from "./issues.js";
import { heartbeatService } from "./heartbeat.js";
import { logger } from "../middleware/logger.js";

type CronScheduleRow = typeof cronSchedules.$inferSelect;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeTimezone(value: string | null | undefined) {
  const candidate = (value ?? "UTC").trim();
  try {
    // Throws RangeError when the timezone is invalid.
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return "UTC";
  }
}

export function computeNextCronTrigger(input: {
  expression: string;
  timezone: string;
  from: Date;
}): Date {
  const interval = CronExpressionParser.parse(input.expression, {
    currentDate: input.from,
    tz: normalizeTimezone(input.timezone),
  });
  return interval.next().toDate();
}

function defaultIssueTitle(schedule: CronScheduleRow) {
  return `Recurring task: ${schedule.name}`;
}

function defaultIssueDescription(schedule: CronScheduleRow) {
  return [
    "Created automatically from a task cron schedule.",
    "",
    `- Schedule ID: \`${schedule.id}\``,
    `- Cron: \`${schedule.expression}\` (${schedule.timezone})`,
  ].join("\n");
}

export function taskCronService(db: Db) {
  const issuesSvc = issueService(db);
  const heartbeat = heartbeatService(db);

  async function getById(id: string) {
    return db
      .select()
      .from(cronSchedules)
      .where(eq(cronSchedules.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function listForAgent(companyId: string, agentId: string) {
    return db
      .select()
      .from(cronSchedules)
      .where(and(eq(cronSchedules.companyId, companyId), eq(cronSchedules.agentId, agentId)))
      .orderBy(asc(cronSchedules.createdAt));
  }

  async function listForIssue(companyId: string, issueId: string) {
    return db
      .select()
      .from(cronSchedules)
      .where(and(eq(cronSchedules.companyId, companyId), eq(cronSchedules.issueId, issueId)))
      .orderBy(asc(cronSchedules.createdAt));
  }

  async function createSchedule(
    companyId: string,
    input: {
      agentId: string;
      issueId?: string | null;
      name: string;
      expression: string;
      timezone?: string | null;
      enabled?: boolean;
      issueMode?: "create_new" | "reuse_existing" | "reopen_existing";
      issueTemplate?: Record<string, unknown> | null;
      payload?: Record<string, unknown> | null;
    },
  ) {
    const timezone = normalizeTimezone(input.timezone);
    const enabled = input.enabled ?? true;
    const nextTriggerAt = enabled
      ? computeNextCronTrigger({
        expression: input.expression,
        timezone,
        from: new Date(),
      })
      : null;

    const [row] = await db
      .insert(cronSchedules)
      .values({
        companyId,
        agentId: input.agentId,
        issueId: input.issueId ?? null,
        name: input.name,
        expression: input.expression,
        timezone,
        enabled,
        issueMode: input.issueMode ?? "create_new",
        issueTemplate: input.issueTemplate ?? {},
        payload: input.payload ?? {},
        nextTriggerAt,
      })
      .returning();
    return row!;
  }

  async function updateSchedule(
    id: string,
    input: Partial<{
      issueId: string | null;
      name: string;
      expression: string;
      timezone: string | null;
      enabled: boolean;
      issueMode: "create_new" | "reuse_existing" | "reopen_existing";
      issueTemplate: Record<string, unknown> | null;
      payload: Record<string, unknown> | null;
    }>,
  ) {
    const existing = await getById(id);
    if (!existing) return null;

    const expression = input.expression ?? existing.expression;
    const timezone = normalizeTimezone(input.timezone ?? existing.timezone);
    const enabled = input.enabled ?? existing.enabled;
    const shouldRecomputeNext =
      input.expression !== undefined || input.timezone !== undefined || input.enabled !== undefined;

    const patch: Partial<typeof cronSchedules.$inferInsert> = {
      updatedAt: new Date(),
      issueId: input.issueId ?? existing.issueId,
      name: input.name ?? existing.name,
      expression,
      timezone,
      enabled,
      issueMode: input.issueMode ?? (existing.issueMode as "create_new" | "reuse_existing" | "reopen_existing"),
      issueTemplate: input.issueTemplate ?? (asRecord(existing.issueTemplate) ?? {}),
      payload: input.payload ?? (asRecord(existing.payload) ?? {}),
    };

    if (shouldRecomputeNext) {
      patch.nextTriggerAt = enabled
        ? computeNextCronTrigger({
          expression,
          timezone,
          from: new Date(),
        })
        : null;
    }

    return db
      .update(cronSchedules)
      .set(patch)
      .where(eq(cronSchedules.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function deleteSchedule(id: string) {
    return db
      .delete(cronSchedules)
      .where(eq(cronSchedules.id, id))
      .returning()
      .then((rows) => rows.length > 0);
  }

  async function ensureIssueForSchedule(schedule: CronScheduleRow) {
    const mode = (schedule.issueMode as "create_new" | "reuse_existing" | "reopen_existing") ?? "create_new";
    const issueTemplate = asRecord(schedule.issueTemplate) ?? {};
    const payload = asRecord(schedule.payload) ?? {};

    const createIssue = async () =>
      issuesSvc.create(schedule.companyId, {
        title: asString(issueTemplate.title) ?? defaultIssueTitle(schedule),
        description:
          asString(issueTemplate.description) ??
          asString(payload.description) ??
          defaultIssueDescription(schedule),
        status: asString(issueTemplate.status) ?? "todo",
        priority: asString(issueTemplate.priority) ?? "medium",
        projectId: asString(issueTemplate.projectId),
        goalId: asString(issueTemplate.goalId),
        parentId: asString(issueTemplate.parentId),
        assigneeAgentId: schedule.agentId,
        billingCode: asString(issueTemplate.billingCode),
        requestDepth: 0,
        createdByAgentId: null,
        createdByUserId: null,
      });

    if (mode === "create_new") {
      return createIssue();
    }

    if (schedule.issueId) {
      const existing = await issuesSvc.getById(schedule.issueId);
      if (existing && existing.companyId === schedule.companyId) {
        if (mode === "reopen_existing" && (existing.status === "done" || existing.status === "cancelled")) {
          const reopened = await issuesSvc.update(existing.id, { status: "todo" });
          return reopened ?? existing;
        }
        return existing;
      }
    }

    const created = await createIssue();
    await db
      .update(cronSchedules)
      .set({
        issueId: created.id,
        updatedAt: new Date(),
      })
      .where(eq(cronSchedules.id, schedule.id));
    return created;
  }

  async function tickDueSchedules(now = new Date()) {
    const dueSchedules = await db
      .select()
      .from(cronSchedules)
      .where(
        and(
          eq(cronSchedules.enabled, true),
          or(lte(cronSchedules.nextTriggerAt, now), isNull(cronSchedules.nextTriggerAt)),
        ),
      )
      .orderBy(asc(cronSchedules.nextTriggerAt), asc(cronSchedules.createdAt))
      .limit(100);

    let checked = dueSchedules.length;
    let dispatched = 0;
    let failed = 0;

    for (const schedule of dueSchedules) {
      try {
        const issue = await ensureIssueForSchedule(schedule);
        const nextTriggerAt = computeNextCronTrigger({
          expression: schedule.expression,
          timezone: schedule.timezone,
          from: now,
        });
        await db
          .update(cronSchedules)
          .set({
            lastTriggeredAt: now,
            nextTriggerAt,
            updatedAt: now,
          })
          .where(eq(cronSchedules.id, schedule.id));

        const run = await heartbeat.wakeup(schedule.agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "task_cron",
          payload: {
            issueId: issue.id,
            cronScheduleId: schedule.id,
            cronScheduleName: schedule.name,
            cronExpression: schedule.expression,
            cronTimezone: schedule.timezone,
            cronPayload: asRecord(schedule.payload) ?? {},
          },
          requestedByActorType: "system",
          requestedByActorId: `task_cron:${schedule.id}`,
          contextSnapshot: {
            source: "task_cron",
            issueId: issue.id,
            wakeReason: "task_cron",
            taskCron: {
              scheduleId: schedule.id,
              scheduleName: schedule.name,
              expression: schedule.expression,
              timezone: schedule.timezone,
              issueMode: schedule.issueMode,
              issueAction: schedule.issueId ? "attached_or_reopened" : "created",
            },
          },
        });
        if (run) dispatched += 1;
      } catch (err) {
        failed += 1;
        logger.error(
          {
            err,
            scheduleId: schedule.id,
            companyId: schedule.companyId,
            agentId: schedule.agentId,
          },
          "task cron dispatch failed",
        );
      }
    }

    return {
      checked,
      dispatched,
      failed,
    };
  }

  async function attachIssue(scheduleId: string, issueId: string) {
    return db
      .update(cronSchedules)
      .set({
        issueId,
        updatedAt: new Date(),
      })
      .where(eq(cronSchedules.id, scheduleId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function detachIssue(scheduleId: string) {
    return db
      .update(cronSchedules)
      .set({
        issueId: null,
        updatedAt: new Date(),
      })
      .where(eq(cronSchedules.id, scheduleId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function issueExistsInCompany(issueId: string, companyId: string) {
    const row = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  return {
    getById,
    listForAgent,
    listForIssue,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    tickDueSchedules,
    attachIssue,
    detachIssue,
    issueExistsInCompany,
  };
}
