import { agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import { extractAgentMentionIds } from "@paperclipai/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { issueService } from "./issues.js";

/**
 * @deprecated Wave 1 fan-out MVP wakes all mentioned agents; prefer TooManyMentionsError for caps.
 */
export class FanoutNotEnabledError extends Error {
  readonly code = "FANOUT_NOT_ENABLED" as const;

  constructor() {
    super("Fan-out is not enabled yet; mention one agent at a time.");
    this.name = "FanoutNotEnabledError";
  }
}

export const ROOM_MESSAGE_MAX_MENTIONS = 5;

export class TooManyMentionsError extends Error {
  readonly code = "TOO_MANY_MENTIONS" as const;
  readonly max: number;

  constructor(max: number = ROOM_MESSAGE_MAX_MENTIONS) {
    super(`Too many agent mentions; maximum is ${max}`);
    this.name = "TooManyMentionsError";
    this.max = max;
  }
}

export class TaskNotFoundError extends Error {
  readonly code = "TASK_NOT_FOUND" as const;

  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

export class TaskCompanyMismatchError extends Error {
  readonly code = "TASK_COMPANY_MISMATCH" as const;

  constructor() {
    super("Task does not belong to this company");
    this.name = "TaskCompanyMismatchError";
  }
}

export class InvalidMentionError extends Error {
  readonly code = "INVALID_MENTION" as const;

  constructor() {
    super("Message contains an agent mention that does not resolve to a company agent");
    this.name = "InvalidMentionError";
  }
}

export class TurnNotFoundError extends Error {
  readonly code = "TURN_NOT_FOUND" as const;

  constructor(roomMessageId: string) {
    super(`Conference Room turn not found: ${roomMessageId}`);
    this.name = "TurnNotFoundError";
  }
}

export type RoomMessageMode = "silent" | "adapter_wake_pending";

export type RoomMessagePrepared = {
  mode: RoomMessageMode;
  issueId: string;
  mentionedAgentIds?: string[];
};

export type RoomMessageResult = {
  mode: RoomMessageMode;
  issueId: string;
  commentId: string;
  roomMessageId: string;
  mentionedAgentIds?: string[];
};

export type RoomMessageActor = {
  agentId?: string;
  userId?: string;
  runId?: string | null;
};

export type RoomTurnStatusResult = {
  roomMessageId: string;
  issueId: string;
  commentId: string;
  hostRunId?: string;
  hostAgentId?: string;
  status:
    | "silent"
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "unknown";
  costUsd?: number;
};

const BOARD_OPERATIONS_ORIGIN_KIND = "conference_room";
const AGENT_URI_UUID_RE = /agent:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const KNOWN_TURN_STATUSES = new Set([
  "silent",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

function extractRunCostUsd(resultJson: Record<string, unknown> | null | undefined): number | undefined {
  if (!resultJson) return undefined;
  for (const key of ["total_cost_usd", "cost_usd", "costUsd"] as const) {
    const raw = resultJson[key];
    const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function mapHostRunStatus(status: string): RoomTurnStatusResult["status"] {
  if (KNOWN_TURN_STATUSES.has(status)) {
    return status as RoomTurnStatusResult["status"];
  }
  return "unknown";
}

export function roomMessageService(db: Db) {
  const issueSvc = issueService(db);

  async function findBoardOperationsIssueId(companyId: string): Promise<string | null> {
    const byOrigin = await issueSvc.list(companyId, {
      originKind: BOARD_OPERATIONS_ORIGIN_KIND,
      originId: companyId,
    });
    const originIssue = byOrigin.find(
      (issue) => issue.status !== "done" && issue.status !== "cancelled",
    );
    if (originIssue) return originIssue.id;

    const byTitle = await issueSvc.list(companyId, { q: "Board Operations" });
    const titleIssue = byTitle.find(
      (issue) =>
        issue.title === "Board Operations" &&
        issue.status !== "done" &&
        issue.status !== "cancelled",
    );
    return titleIssue?.id ?? null;
  }

  async function ensureBoardOperationsIssue(
    companyId: string,
    taskId?: string,
  ): Promise<string> {
    if (taskId) {
      const issue = await issueSvc.getById(taskId);
      if (!issue) {
        throw new TaskNotFoundError(taskId);
      }
      if (issue.companyId !== companyId) {
        throw new TaskCompanyMismatchError();
      }
      return issue.id;
    }

    const existing = await findBoardOperationsIssueId(companyId);
    if (existing) return existing;

    try {
      const created = await issueSvc.create(companyId, {
        title: "Board Operations",
        description: "Standing issue for board concierge conversations and decision log",
        status: "todo",
        priority: "medium",
        originKind: BOARD_OPERATIONS_ORIGIN_KIND,
        originId: companyId,
      });
      return created.id;
    } catch (err) {
      const raced = await findBoardOperationsIssueId(companyId);
      if (raced) return raced;
      throw err;
    }
  }

  async function findHostRunForRoomMessage(companyId: string, roomMessageId: string) {
    const roomMessageIdExpr = sql<string>`${heartbeatRuns.contextSnapshot} ->> 'roomMessageId'`;

    const [runByContext] = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          sql`${roomMessageIdExpr} = ${roomMessageId}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1);

    if (runByContext) return runByContext;

    const idempotencyKey = `room:${roomMessageId}:host`;
    const [wake] = await db
      .select({ runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
        ),
      )
      .orderBy(desc(agentWakeupRequests.createdAt))
      .limit(1);

    if (!wake?.runId) return null;

    const [runByWake] = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wake.runId))
      .limit(1);

    return runByWake ?? null;
  }

  /**
   * Resolve Board Ops issue + mention policy without writing a comment.
   * Callers must rate-limit wake paths before `commit`.
   */
  async function prepareMentionWake(input: {
    companyId: string;
    message: string;
    taskId?: string;
  }): Promise<RoomMessagePrepared> {
    const issueId = await ensureBoardOperationsIssue(input.companyId, input.taskId);
    const mentionedAgentIds = await issueSvc.findMentionedAgents(
      input.companyId,
      input.message,
    );

    if (mentionedAgentIds.length === 0) {
      const explicitMentionIds = extractAgentMentionIds(input.message);
      if (explicitMentionIds.length > 0 || AGENT_URI_UUID_RE.test(input.message)) {
        throw new InvalidMentionError();
      }

      return {
        mode: "silent",
        issueId,
      };
    }

    if (mentionedAgentIds.length > ROOM_MESSAGE_MAX_MENTIONS) {
      throw new TooManyMentionsError(ROOM_MESSAGE_MAX_MENTIONS);
    }

    return {
      mode: "adapter_wake_pending",
      issueId,
      mentionedAgentIds,
    };
  }

  /** Persist the board-chat comment after prepare (+ optional rate-limit) succeeded. */
  async function commit(input: {
    prepared: RoomMessagePrepared;
    message: string;
    actor: RoomMessageActor;
  }): Promise<RoomMessageResult> {
    const comment = await issueSvc.addComment(input.prepared.issueId, input.message, {
      agentId: input.actor.agentId,
      userId: input.actor.userId,
      runId: input.actor.runId,
    });

    return {
      mode: input.prepared.mode,
      issueId: input.prepared.issueId,
      commentId: comment.id,
      roomMessageId: comment.id,
      ...(input.prepared.mentionedAgentIds
        ? { mentionedAgentIds: input.prepared.mentionedAgentIds }
        : {}),
    };
  }

  return {
    ensureBoardOperationsIssue,
    prepareMentionWake,
    commit,

    async handle(input: {
      companyId: string;
      message: string;
      taskId?: string;
      actor: RoomMessageActor;
    }): Promise<RoomMessageResult> {
      const prepared = await prepareMentionWake({
        companyId: input.companyId,
        message: input.message,
        taskId: input.taskId,
      });
      return commit({
        prepared,
        message: input.message,
        actor: input.actor,
      });
    },

    async getTurnStatus(input: {
      companyId: string;
      roomMessageId: string;
    }): Promise<RoomTurnStatusResult> {
      const comment = await issueSvc.getComment(input.roomMessageId);
      if (!comment) {
        throw new TurnNotFoundError(input.roomMessageId);
      }

      const issue = await issueSvc.getById(comment.issueId);
      if (!issue || issue.companyId !== input.companyId) {
        throw new TurnNotFoundError(input.roomMessageId);
      }

      const hostRun = await findHostRunForRoomMessage(input.companyId, input.roomMessageId);
      if (!hostRun) {
        return {
          roomMessageId: input.roomMessageId,
          issueId: comment.issueId,
          commentId: comment.id,
          status: "silent",
        };
      }

      const resultJson = hostRun.resultJson as Record<string, unknown> | null | undefined;
      const costUsd = extractRunCostUsd(resultJson);

      return {
        roomMessageId: input.roomMessageId,
        issueId: comment.issueId,
        commentId: comment.id,
        hostRunId: hostRun.id,
        hostAgentId: hostRun.agentId,
        status: mapHostRunStatus(hostRun.status),
        ...(costUsd !== undefined ? { costUsd } : {}),
      };
    },
  };
}
