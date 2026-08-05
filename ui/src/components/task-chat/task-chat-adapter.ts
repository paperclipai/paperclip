/**
 * Live adapter: normalize the existing IssueChatComment stream (including
 * optimistic echoes) into the redesign's TaskChatItem[] model. This is the
 * seam that lets the new render layer show live task data without touching the
 * comment data pipeline. Rich agent-run streaming (thinking/tool/diff) is
 * demonstrated in the harness and layered onto this adapter as a later step;
 * the baseline live thread renders the author-typed message history + optimistic
 * echo, which is the core legibility win.
 */
import type { Agent } from "@paperclipai/shared";
import type { IssueChatComment } from "@/lib/issue-chat-messages";
import type { TaskChatAuthorKind, TaskChatItem } from "./task-chat-model";

export interface TaskChatAdapterContext {
  agentMap?: Map<string, Agent>;
  userLabelMap?: ReadonlyMap<string, string> | null;
  currentUserId?: string | null;
  /**
   * Capitalized mode chip for agent-authored bubbles ("Agent mode" / "Plan
   * mode" / "Ask mode") — resolved per comment, so each reply is tagged with
   * the mode its request actually ran under (not the issue's current mode).
   */
  agentModeLabelFor?: (comment: IssueChatComment) => string | undefined;
}

function effectiveAgentId(comment: IssueChatComment): string | null {
  return comment.authorAgentId ?? comment.derivedAuthorAgentId ?? null;
}

function authorKind(comment: IssueChatComment): TaskChatAuthorKind {
  if (effectiveAgentId(comment)) return "agent";
  if (comment.authorType === "user") return "human";
  if (comment.authorType === "agent") return "agent";
  return "system";
}

/** Shared bubble-footer time format ("2:34 PM") — also used by the description bubble (PAP-375). */
export function formatTaskChatTimestamp(value: unknown): string | undefined {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value as string);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function commentsToTaskChatItems(
  comments: IssueChatComment[],
  ctx: TaskChatAdapterContext = {},
): TaskChatItem[] {
  const items: TaskChatItem[] = [];
  for (const comment of comments) {
    if (comment.deletedAt) continue;
    const kind = authorKind(comment);
    let authorName: string | undefined;
    let agentIcon: string | null | undefined;
    if (kind === "agent") {
      const agentId = effectiveAgentId(comment);
      authorName = (agentId && ctx.agentMap?.get(agentId)?.name) || "Agent";
      agentIcon = agentId ? ctx.agentMap?.get(agentId)?.icon : undefined;
    } else if (kind === "human") {
      authorName =
        (comment.authorUserId && ctx.userLabelMap?.get(comment.authorUserId)) || undefined;
    }
    const optimistic =
      comment.clientStatus === "queued"
        ? "queued"
        : comment.clientStatus === "pending"
          ? "pending"
          : undefined;
    items.push({
      id: comment.id || comment.clientId || `${comment.createdAt}`,
      kind: "message",
      author: kind,
      authorName,
      text: comment.body,
      timestamp: formatTaskChatTimestamp(comment.createdAt),
      optimistic,
      agentIcon,
      modeLabel: kind === "agent" ? ctx.agentModeLabelFor?.(comment) : undefined,
    });
  }
  return items;
}
