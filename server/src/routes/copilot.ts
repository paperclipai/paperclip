import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { issueComments, issues } from "@paperclipai/db";
import { z } from "zod";
import { forbidden, HttpError, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import { agentService, heartbeatService, issueService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const BOARD_COPILOT_THREAD_TITLE = "Board Copilot Thread";
const BOARD_COPILOT_THREAD_DESCRIPTION =
  "Dedicated high-priority board copilot conversation thread. Created automatically.";
const BOARD_COPILOT_WAKE_PRIORITY = 100;
const BOARD_COPILOT_DUPLICATE_WINDOW_MS = 10_000;
const BOARD_COPILOT_HISTORY_DEFAULT_LIMIT = 30;
const BOARD_COPILOT_HISTORY_MAX_LIMIT = 100;
const BOARD_COPILOT_CONTEXT_MAX_FILTERS = 24;

const routeContextSchema = z.object({
  pageKind: z.string().trim().min(1).max(64),
  pagePath: z.string().trim().min(1).max(1024),
  entityType: z.string().trim().min(1).max(64).optional().nullable(),
  entityId: z.string().trim().min(1).max(128).optional().nullable(),
  title: z.string().trim().max(256).optional().nullable(),
  filters: z
    .record(z.string().max(64), z.string().max(128))
    .refine(
      (filters) => Object.keys(filters).length <= BOARD_COPILOT_CONTEXT_MAX_FILTERS,
      `Context filters cannot exceed ${BOARD_COPILOT_CONTEXT_MAX_FILTERS} entries`,
    )
    .optional(),
});

const sendCopilotMessageSchema = z.object({
  body: z.string().min(1).max(40000),
  context: routeContextSchema.optional(),
});

const createCopilotThreadSchema = z.object({
  contextIssueId: z.string().trim().min(1).max(128).optional().nullable(),
});

function isWakeableAgentStatus(status: string) {
  return status !== "paused" && status !== "terminated" && status !== "pending_approval";
}

function rankCopilotAgent(role: string | null | undefined) {
  const normalized = (role ?? "").trim().toLowerCase();
  if (normalized === "coo") return 0;
  if (normalized === "ceo") return 1;
  if (normalized === "cto") return 2;
  return 10;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isSameCopilotThreadRun(
  run: { contextSnapshot?: Record<string, unknown> | null },
  threadIssueId: string,
) {
  const context = run.contextSnapshot ?? {};
  const issueId = readNonEmptyString(context.issueId);
  if (issueId === threadIssueId) return true;
  const taskKey = readNonEmptyString(context.taskKey);
  return taskKey === `board-copilot-thread:${threadIssueId}`;
}

function runIssueId(run: { contextSnapshot?: Record<string, unknown> | null }) {
  const context = run.contextSnapshot ?? {};
  return readNonEmptyString(context.issueId);
}

function formatCopilotContextBlock(context: z.infer<typeof routeContextSchema> | undefined) {
  if (!context) return "";
  // Keep metadata in an HTML comment while neutralizing comment terminators from user-supplied values.
  const safeSerialized = JSON.stringify(context)
    .replaceAll("<!--", "<\\!--")
    .replaceAll("-->", "--\\>");
  return `<!-- paperclip:board-copilot-context ${safeSerialized} -->\n\n`;
}

function toThreadResponse(issue: {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  originId?: string | null;
  updatedAt: Date;
}) {
  return {
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    issueStatus: issue.status,
    issuePriority: issue.priority,
    assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
    threadOwnerUserId: issue.originId ?? null,
    updatedAt: issue.updatedAt,
  };
}

function toThreadHistoryResponse(issue: {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  originId?: string | null;
  updatedAt: Date;
  hiddenAt?: Date | null;
}) {
  return {
    ...toThreadResponse(issue),
    hiddenAt: issue.hiddenAt ?? null,
  };
}

export function copilotRoutes(db: Db) {
  const router = Router();
  const issuesSvc = issueService(db);
  const agentsSvc = agentService(db);
  const heartbeat = heartbeatService(db);

  async function findOpenThreadIssue(companyId: string, userId: string) {
    return db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        companyId: issues.companyId,
        originKind: issues.originKind,
        originId: issues.originId,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "board_copilot_thread"),
          eq(issues.originId, userId),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function pickCopilotAssignee(companyId: string, contextIssueRef?: string | null) {
    const contextRef = contextIssueRef?.trim() || null;
    if (contextRef) {
      const contextIssue = await issuesSvc.getById(contextRef);
      if (
        contextIssue &&
        contextIssue.companyId === companyId &&
        contextIssue.assigneeAgentId
      ) {
        const contextAssignee = await agentsSvc.getById(contextIssue.assigneeAgentId);
        if (
          contextAssignee &&
          contextAssignee.companyId === companyId &&
          isWakeableAgentStatus(contextAssignee.status)
        ) {
          return contextAssignee;
        }
      }
    }

    const candidates = (await agentsSvc.list(companyId))
      .filter((agent) => isWakeableAgentStatus(agent.status))
      .sort((left, right) => {
        const rankDelta = rankCopilotAgent(left.role) - rankCopilotAgent(right.role);
        if (rankDelta !== 0) return rankDelta;
        return left.createdAt.getTime() - right.createdAt.getTime();
      });
    return candidates[0] ?? null;
  }

  async function ensureThreadIssue(input: {
    companyId: string;
    userId: string;
    contextIssueRef?: string | null;
  }) {
    const existing = await findOpenThreadIssue(input.companyId, input.userId);

    if (!existing) {
      const preferredAssignee = await pickCopilotAssignee(input.companyId, input.contextIssueRef);
      if (!preferredAssignee) {
        throw unprocessable(
          "No invokable agents are available for the board copilot thread. Resume at least one agent and retry.",
        );
      }
      try {
        const created = await issuesSvc.create(input.companyId, {
          title: BOARD_COPILOT_THREAD_TITLE,
          description: BOARD_COPILOT_THREAD_DESCRIPTION,
          status: "todo",
          priority: "high",
          originKind: "board_copilot_thread",
          originId: input.userId,
          assigneeAgentId: preferredAssignee.id,
          createdByUserId: input.userId,
        });
        return created;
      } catch (error) {
        if ((error as { constraint?: string }).constraint !== "issues_open_board_copilot_thread_uq") {
          throw error;
        }
        const raced = await issuesSvc.list(input.companyId, {
          originKind: "board_copilot_thread",
          originId: input.userId,
          includeClosed: true,
          includeRelations: false,
          limit: 1,
        });
        const thread = raced[0];
        if (!thread) throw error;
        return thread;
      }
    }

    let currentAssigneeWakeable = false;
    if (existing.assigneeAgentId) {
      const currentAssignee = await agentsSvc.getById(existing.assigneeAgentId);
      currentAssigneeWakeable = Boolean(
        currentAssignee &&
        currentAssignee.companyId === input.companyId &&
        isWakeableAgentStatus(currentAssignee.status),
      );
    }

    if (!currentAssigneeWakeable) {
      const preferredAssignee = await pickCopilotAssignee(input.companyId, input.contextIssueRef);
      if (!preferredAssignee) {
        throw unprocessable(
          "No invokable agents are available for the board copilot thread. Resume at least one agent and retry.",
        );
      }
      const updated = await issuesSvc.update(existing.id, {
        assigneeAgentId: preferredAssignee.id,
        assigneeUserId: null,
        actorUserId: input.userId,
      });
      if (updated) return updated;
    }

    const hydrated = await issuesSvc.getById(existing.id);
    if (!hydrated) {
      throw new HttpError(500, "Failed to load board copilot thread issue");
    }
    return hydrated;
  }

  router.get("/companies/:companyId/copilot/thread", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") {
      throw forbidden("Only board users can access copilot thread state");
    }

    const userId = req.actor.userId ?? "local-board";
    const contextIssueRef = typeof req.query.contextIssueId === "string" ? req.query.contextIssueId : null;
    const thread = await ensureThreadIssue({ companyId, userId, contextIssueRef });
    res.json(toThreadResponse(thread));
  });

  router.get("/companies/:companyId/copilot/threads", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") {
      throw forbidden("Only board users can access copilot thread history");
    }

    const userId = req.actor.userId ?? "local-board";
    const parsedLimit =
      typeof req.query.limit === "string" && req.query.limit.trim().length > 0
        ? Number(req.query.limit)
        : null;
    const limit =
      parsedLimit && Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(Math.floor(parsedLimit), BOARD_COPILOT_HISTORY_MAX_LIMIT)
        : BOARD_COPILOT_HISTORY_DEFAULT_LIMIT;

    const threads = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        originId: issues.originId,
        updatedAt: issues.updatedAt,
        hiddenAt: issues.hiddenAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "board_copilot_thread"),
          eq(issues.originId, userId),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(limit);

    res.json(threads.map((thread) => toThreadHistoryResponse(thread)));
  });

  router.post(
    "/companies/:companyId/copilot/thread/new",
    validate(createCopilotThreadSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      if (req.actor.type !== "board") {
        throw forbidden("Only board users can create copilot threads");
      }

      const actor = getActorInfo(req);
      const userId = req.actor.userId ?? "local-board";
      const contextIssueRef =
        typeof req.body.contextIssueId === "string" && req.body.contextIssueId.trim().length > 0
          ? req.body.contextIssueId.trim()
          : null;

      const existingThread = await findOpenThreadIssue(companyId, userId);
      if (existingThread) {
        const hiddenAt = new Date();
        const archived = await issuesSvc.update(existingThread.id, {
          hiddenAt,
          actorUserId: userId,
        });
        if (archived) {
          await logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "issue.copilot_thread_archived",
            entityType: "issue",
            entityId: existingThread.id,
            details: {
              source: "board_copilot",
              identifier: existingThread.identifier,
              issueTitle: existingThread.title,
              hiddenAt: hiddenAt.toISOString(),
            },
          });
        }
      }

      const thread = await ensureThreadIssue({ companyId, userId, contextIssueRef });
      await logActivity(db, {
        companyId: thread.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.copilot_thread_created",
        entityType: "issue",
        entityId: thread.id,
        details: {
          source: "board_copilot",
          identifier: thread.identifier,
          issueTitle: thread.title,
          contextIssueRef,
          replacedThreadIssueId: existingThread?.id ?? null,
        },
      });

      res.status(201).json(toThreadResponse(thread));
    },
  );

  router.post(
    "/companies/:companyId/copilot/thread/messages",
    validate(sendCopilotMessageSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      if (req.actor.type !== "board") {
        throw forbidden("Only board users can post copilot thread messages");
      }

      const actor = getActorInfo(req);
      const userId = req.actor.userId ?? "local-board";
      const context = req.body.context as z.infer<typeof routeContextSchema> | undefined;
      const contextIssueRef =
        context?.entityType === "issue" && typeof context.entityId === "string" ? context.entityId : null;
      const thread = await ensureThreadIssue({ companyId, userId, contextIssueRef });

      const body = String(req.body.body ?? "").trim();
      if (!body) {
        throw unprocessable("Message body cannot be empty");
      }

      const persistedBody = `${formatCopilotContextBlock(context)}${body}`;
      const duplicateCutoff = new Date(Date.now() - BOARD_COPILOT_DUPLICATE_WINDOW_MS);
      const duplicateComment = await db
        .select({
          id: issueComments.id,
          companyId: issueComments.companyId,
          issueId: issueComments.issueId,
          authorAgentId: issueComments.authorAgentId,
          authorUserId: issueComments.authorUserId,
          body: issueComments.body,
          createdAt: issueComments.createdAt,
          updatedAt: issueComments.updatedAt,
        })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            eq(issueComments.issueId, thread.id),
            eq(issueComments.authorUserId, userId),
            eq(issueComments.body, persistedBody),
            gte(issueComments.createdAt, duplicateCutoff),
          ),
        )
        .orderBy(desc(issueComments.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (duplicateComment) {
        return res.status(200).json({
          thread: toThreadResponse(thread),
          comment: duplicateComment,
          wakeup: {
            enqueued: false,
            warning: "Duplicate message ignored",
          },
        });
      }

      const isClosed = thread.status === "done" || thread.status === "cancelled";
      let effectiveThread = thread;
      if (isClosed) {
        const reopened = await issuesSvc.update(thread.id, {
          status: "todo",
          actorUserId: userId,
        });
        if (reopened) effectiveThread = reopened;
      }

      const comment = await issuesSvc.addComment(effectiveThread.id, persistedBody, {
        userId,
        runId: actor.runId,
      });

      await logActivity(db, {
        companyId: effectiveThread.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: effectiveThread.id,
        details: {
          source: "board_copilot",
          originKind: effectiveThread.originKind,
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
          identifier: effectiveThread.identifier,
          issueTitle: effectiveThread.title,
          contextPageKind: context?.pageKind ?? null,
          contextPagePath: context?.pagePath ?? null,
          contextEntityType: context?.entityType ?? null,
          contextEntityId: context?.entityId ?? null,
        },
      });

      let wakeupEnqueued = false;
      let wakeupWarning: string | null = null;
      if (effectiveThread.assigneeAgentId) {
        const interruptedRunIds: string[] = [];
        let preemptPartialFailure = false;
        try {
          const liveRuns = await heartbeat.list(effectiveThread.companyId, effectiveThread.assigneeAgentId);
          for (const candidate of liveRuns) {
            if (candidate.status !== "queued" && candidate.status !== "running") continue;
            if (isSameCopilotThreadRun(candidate, effectiveThread.id)) continue;
            try {
              const interruptedIssueId = runIssueId(candidate);
              const cancelled = await heartbeat.cancelRun(candidate.id);
              if (!cancelled || cancelled.status !== "cancelled") continue;
              interruptedRunIds.push(cancelled.id);
              await logActivity(db, {
                companyId: cancelled.companyId,
                actorType: actor.actorType,
                actorId: actor.actorId,
                agentId: actor.agentId,
                runId: actor.runId,
                action: "heartbeat.cancelled",
                entityType: "heartbeat_run",
                entityId: cancelled.id,
                details: {
                  source: "board_copilot_preempt",
                  issueId: effectiveThread.id,
                  interruptedRunId: cancelled.id,
                  interruptedIssueId,
                  agentId: cancelled.agentId,
                },
              });
            } catch (error) {
              preemptPartialFailure = true;
              logger.warn(
                { err: error, issueId: effectiveThread.id, interruptedRunId: candidate.id },
                "failed to preempt active run for board copilot",
              );
            }
          }
        } catch (error) {
          logger.warn(
            { err: error, issueId: effectiveThread.id, assigneeAgentId: effectiveThread.assigneeAgentId },
            "failed to preempt active runs for board copilot",
          );
          wakeupWarning = "Failed to preempt assignee before board copilot wakeup";
        }
        if (preemptPartialFailure && !wakeupWarning) {
          wakeupWarning = "Failed to preempt one or more active runs before board copilot wakeup";
        }

        try {
          const run = await heartbeat.wakeup(effectiveThread.assigneeAgentId, {
            source: "on_demand",
            triggerDetail: "manual",
            reason: "board_copilot_message",
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            payload: {
              issueId: effectiveThread.id,
              commentId: comment.id,
              context: context ?? null,
              source: "board_copilot",
              ...(interruptedRunIds.length > 0
                ? {
                    interruptedRunIds,
                    interruptedRunId: interruptedRunIds[interruptedRunIds.length - 1] ?? null,
                  }
                : {}),
            },
            contextSnapshot: {
              issueId: effectiveThread.id,
              taskId: effectiveThread.id,
              taskKey: `board-copilot-thread:${effectiveThread.id}`,
              commentId: comment.id,
              wakeCommentId: comment.id,
              wakeReason: "board_copilot_message",
              source: "board.copilot",
              priority: BOARD_COPILOT_WAKE_PRIORITY,
              boardCopilotContext: context ?? null,
              ...(interruptedRunIds.length > 0
                ? {
                    interruptedRunIds,
                    interruptedRunId: interruptedRunIds[interruptedRunIds.length - 1] ?? null,
                  }
                : {}),
            },
          });
          wakeupEnqueued = Boolean(run);
        } catch (error) {
          if (error instanceof HttpError && (error.status === 409 || error.status === 422)) {
            wakeupWarning = error.message;
          } else {
            logger.warn(
              { err: error, issueId: effectiveThread.id, assigneeAgentId: effectiveThread.assigneeAgentId },
              "failed to enqueue board copilot wakeup",
            );
            wakeupWarning = "Failed to enqueue copilot run";
          }
        }
      } else {
        wakeupWarning = "Board copilot thread has no assignee agent";
      }

      res.status(201).json({
        thread: toThreadResponse(effectiveThread),
        comment,
        wakeup: {
          enqueued: wakeupEnqueued,
          warning: wakeupWarning,
        },
      });
    },
  );

  return router;
}
