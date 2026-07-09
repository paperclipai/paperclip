import type { Db } from "@paperclipai/db";
import { issueService } from "./issues.js";

export class FanoutNotEnabledError extends Error {
  readonly code = "FANOUT_NOT_ENABLED" as const;

  constructor() {
    super("Fan-out is not enabled yet; mention one agent at a time.");
    this.name = "FanoutNotEnabledError";
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

export type RoomMessageMode = "silent" | "adapter_wake_pending";

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

export function roomMessageService(db: Db) {
  const issueSvc = issueService(db);

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

    const companyIssues = await issueSvc.list(companyId, { q: "Board Operations" });
    const boardIssue = companyIssues.find(
      (issue) =>
        issue.title === "Board Operations" &&
        issue.status !== "done" &&
        issue.status !== "cancelled",
    );
    if (boardIssue) return boardIssue.id;

    const created = await issueSvc.create(companyId, {
      title: "Board Operations",
      description: "Standing issue for board concierge conversations and decision log",
      status: "todo",
      priority: "medium",
    });
    return created.id;
  }

  return {
    ensureBoardOperationsIssue,

    async handle(input: {
      companyId: string;
      message: string;
      taskId?: string;
      actor: RoomMessageActor;
    }): Promise<RoomMessageResult> {
      const issueId = await ensureBoardOperationsIssue(input.companyId, input.taskId);
      const comment = await issueSvc.addComment(issueId, input.message, {
        agentId: input.actor.agentId,
        userId: input.actor.userId,
        runId: input.actor.runId,
      });

      const mentionedAgentIds = await issueSvc.findMentionedAgents(
        input.companyId,
        input.message,
      );

      if (mentionedAgentIds.length === 0) {
        return {
          mode: "silent",
          issueId,
          commentId: comment.id,
          roomMessageId: comment.id,
        };
      }

      if (mentionedAgentIds.length > 1) {
        throw new FanoutNotEnabledError();
      }

      return {
        mode: "adapter_wake_pending",
        issueId,
        commentId: comment.id,
        roomMessageId: comment.id,
        mentionedAgentIds,
      };
    },
  };
}
