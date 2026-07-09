import type { Db } from "@paperclipai/db";
import { redactCurrentUserText } from "../log-redaction.js";
import { redactSensitiveText } from "../redaction.js";
import { heartbeatService } from "./heartbeat.js";
import { instanceSettingsService } from "./instance-settings.js";

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

export type RoomFanoutHostRun = {
  agentId: string;
  runId: string;
  status: string;
};

export type RoomFanoutResult = {
  mode: "fanout";
  issueId: string;
  roomMessageId: string;
  commentId: string;
  hostRuns: RoomFanoutHostRun[];
  delegationStatus: "pending";
};

function roomWakeIdempotencyKey(roomMessageId: string, agentId: string, singleHost: boolean): string {
  // Single-mention path keeps the legacy `:host` key for turn-status lookup compatibility.
  if (singleHost) return `room:${roomMessageId}:host`;
  return `room:${roomMessageId}:agent:${agentId}`;
}

export function roomOrchestratorService(db: Db) {
  const heartbeat = heartbeatService(db);

  async function wakeOne(input: {
    companyId: string;
    issueId: string;
    roomMessageId: string;
    commentId: string;
    body: string;
    targetAgentId: string;
    actor: RoomOrchestratorActor;
    singleHost: boolean;
  }): Promise<{ agentId: string; runId: string; status: string }> {
    const idempotencyKey = roomWakeIdempotencyKey(
      input.roomMessageId,
      input.targetAgentId,
      input.singleHost,
    );
    const { censorUsernameInLogs } = await instanceSettingsService(db).getGeneral();
    const bodyPreview = redactSensitiveText(
      redactCurrentUserText(input.body.slice(0, 500), {
        enabled: censorUsernameInLogs,
      }),
    );

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
          bodyPreview,
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
        agentId: input.targetAgentId,
        runId: run.id,
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
  }

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
      const woken = await wakeOne({ ...input, singleHost: true });
      return {
        mode: "host_run",
        issueId: input.issueId,
        roomMessageId: input.roomMessageId,
        commentId: input.commentId,
        hostAgentId: woken.agentId,
        hostRunId: woken.runId,
        status: woken.status,
      };
    },

    async wakeMentionedAgents(input: {
      companyId: string;
      issueId: string;
      roomMessageId: string;
      commentId: string;
      body: string;
      targetAgentIds: string[];
      actor: RoomOrchestratorActor;
    }): Promise<RoomFanoutResult> {
      const hostRuns: RoomFanoutHostRun[] = [];
      for (const targetAgentId of input.targetAgentIds) {
        const woken = await wakeOne({
          companyId: input.companyId,
          issueId: input.issueId,
          roomMessageId: input.roomMessageId,
          commentId: input.commentId,
          body: input.body,
          targetAgentId,
          actor: input.actor,
          singleHost: false,
        });
        hostRuns.push({
          agentId: woken.agentId,
          runId: woken.runId,
          status: woken.status,
        });
      }

      return {
        mode: "fanout",
        issueId: input.issueId,
        roomMessageId: input.roomMessageId,
        commentId: input.commentId,
        hostRuns,
        delegationStatus: "pending",
      };
    },
  };
}
