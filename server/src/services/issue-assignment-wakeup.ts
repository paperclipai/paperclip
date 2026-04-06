import { logger } from "../middleware/logger.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation" | "mention" | "approval_response" | "message" | "skill_available";

export interface IssueAssignmentWakeupDeps {
  wakeup: (
    agentId: string,
    opts: {
      source?: WakeupSource;
      triggerDetail?: WakeupTriggerDetail;
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

export function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  rethrowOnError?: boolean;
}) {
  if (!input.issue.assigneeAgentId || input.issue.status === "backlog") return;

  return input.heartbeat
    .wakeup(input.issue.assigneeAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: input.reason,
      payload: { issueId: input.issue.id, mutation: input.mutation },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: { issueId: input.issue.id, source: input.contextSource },
    })
    .catch((err) => {
      logger.warn({ err, issueId: input.issue.id }, "failed to wake assignee on issue assignment");
      if (input.rethrowOnError) throw err;
      return null;
    });
}

/**
 * Extract agent IDs mentioned via @AgentName in text.
 * Case-insensitive match against known agents in the company.
 */
export function extractAgentMentions(
  text: string,
  companyAgents: Array<{ id: string; name: string; status: string }>,
): string[] {
  const mentionedIds: string[] = [];
  for (const agent of companyAgents) {
    if (agent.status === "terminated") continue;
    const pattern = new RegExp(`@${agent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (pattern.test(text)) {
      mentionedIds.push(agent.id);
    }
  }
  return mentionedIds;
}

/**
 * Queue wakeup requests for all mentioned agents.
 */
export function queueMentionWakeups(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issueId: string;
  mentionedAgentIds: string[];
  commentId?: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
}) {
  for (const agentId of input.mentionedAgentIds) {
    void input.heartbeat
      .wakeup(agentId, {
        source: "mention",
        triggerDetail: "system",
        reason: "Mentioned in issue comment",
        payload: { issueId: input.issueId, commentId: input.commentId },
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId ?? null,
      })
      .catch((err: unknown) => {
        console.error(`[mention-wakeup] Failed to wake agent ${agentId}:`, err);
      });
  }
}
