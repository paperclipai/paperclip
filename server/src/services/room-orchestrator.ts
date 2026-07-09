import type { Db } from "@paperclipai/db";
import { heartbeatService } from "./heartbeat.js";

export class AgentNotInvokableError extends Error {
  readonly code = "AGENT_NOT_INVOKABLE" as const;

  constructor(message: string) {
    super(message);
    this.name = "AgentNotInvokableError";
  }
}

export type RoomOrchestratorActor = {
  type: "user" | "board" | "agent" | "system";
  id: string;
};

export type RoomHostRunResult = {
  mode: "host_run";
  issueId: string;
  roomMessageId: string;
  commentId: string;
  hostAgentId: string;
  hostRunId: string;
  status: string;
};

export function roomOrchestratorService(db: Db) {
  const heartbeat = heartbeatService(db);

  return {
    async wakeHost(input: {
      companyId: string;
      issueId: string;
      roomMessageId: string;
      commentId: string;
      body: string;
      targetAgentId: string;
      actor: RoomOrchestratorActor;
    }): Promise<RoomHostRunResult> {
      const idempotencyKey = `room:${input.roomMessageId}:host`;

      try {
        const run = await heartbeat.wakeup(input.targetAgentId, {
          source: "on_demand",
          triggerDetail: "manual",
          reason: "conference_room_mentioned",
          payload: {
            issueId: input.issueId,
            commentId: input.roomMessageId,
            roomMessageId: input.roomMessageId,
            companyId: input.companyId,
            bodyPreview: input.body.slice(0, 500),
          },
          idempotencyKey,
          requestedByActorType:
            input.actor.type === "board" || input.actor.type === "user"
              ? "user"
              : input.actor.type === "agent"
                ? "agent"
                : "system",
          requestedByActorId: input.actor.id,
          contextSnapshot: {
            issueId: input.issueId,
            taskId: input.issueId,
            commentId: input.roomMessageId,
            wakeCommentId: input.roomMessageId,
            wakeReason: "conference_room_mentioned",
            source: "board_chat.mention",
            roomMessageId: input.roomMessageId,
            forceFreshSession: true,
            companyId: input.companyId,
          },
        });

        if (!run) {
          throw new AgentNotInvokableError(
            "Wake was skipped — agent may be paused, terminated, or not invokable.",
          );
        }

        return {
          mode: "host_run",
          issueId: input.issueId,
          roomMessageId: input.roomMessageId,
          commentId: input.commentId,
          hostAgentId: input.targetAgentId,
          hostRunId: run.id,
          status: run.status,
        };
      } catch (err) {
        if (err instanceof AgentNotInvokableError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        if (
          /not_invokable|paused|terminated|invokable|conflict/i.test(message) ||
          (err as { status?: number })?.status === 409
        ) {
          throw new AgentNotInvokableError(
            message || "Agent is not invokable for Conference Room wake.",
          );
        }
        throw err;
      }
    },
  };
}
