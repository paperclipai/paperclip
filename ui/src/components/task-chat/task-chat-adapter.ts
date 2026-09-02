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
import { resolveCommentAttribution } from "@/lib/comment-attribution";
import type { TaskChatAuthorKind, TaskChatItem, TaskChatMessageItem } from "./task-chat-model";

export interface TaskChatAdapterContext {
  agentMap?: Map<string, Agent>;
  userLabelMap?: ReadonlyMap<string, string> | null;
  currentUserId?: string | null;
  /**
   * Task's current assignee. Agent comments from anyone else are cross-issue
   * writes and get a "for {user}" attribution chip (the open cross-task write design (attribution)).
   */
  issueAssigneeAgentId?: string | null;
  verificationCaveatsByRunId?: ReadonlyMap<string, TaskChatMessageItem["verificationCaveats"]>;
}

function effectiveAgentId(comment: IssueChatComment): string | null {
  return comment.authorAgentId ?? comment.derivedAuthorAgentId ?? null;
}

function authorKind(comment: IssueChatComment): TaskChatAuthorKind {
  // System authorship wins over any derivable run→agent linkage (PAP-443):
  // recovery notices carry a derivedAuthorAgentId but must not render as
  // agent bubbles.
  if (comment.authorType === "system") return "system";
  if (effectiveAgentId(comment)) return "agent";
  if (comment.authorType === "user") return "human";
  return "agent";
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
    let onBehalfOfUserName: string | undefined;
    if (kind === "agent") {
      const agentId = effectiveAgentId(comment);
      authorName = (agentId && ctx.agentMap?.get(agentId)?.name) || "Agent";
      agentIcon = agentId ? ctx.agentMap?.get(agentId)?.icon : undefined;
      onBehalfOfUserName = resolveCommentAttribution({
        authorAgentId: agentId,
        onBehalfOfUserId: comment.onBehalfOfUserId ?? null,
        issueAssigneeAgentId: ctx.issueAssigneeAgentId,
        resolveUserLabel: (userId) => ctx.userLabelMap?.get(userId),
      })?.userName;
    } else if (kind === "human") {
      authorName =
        (comment.authorUserId && ctx.userLabelMap?.get(comment.authorUserId)) || undefined;
    }
    const queued = comment.queueState === "queued" || comment.clientStatus === "queued";
    const optimistic =
      queued
        ? "queued"
        : comment.clientStatus === "pending"
          ? "pending"
          : undefined;
    const createdAtIso =
      comment.createdAt instanceof Date
        ? comment.createdAt.toISOString()
        : comment.createdAt
          ? String(comment.createdAt)
          : undefined;
    // Durable run-authored comments already carry their source run directly.
    // Activity-derived `runId` is a useful fallback for older rows, but it may
    // arrive later (or be omitted entirely for server-materialized final
    // replies). Prefer the stored provenance so settled-response decorations
    // such as verification caveats are never lost.
    const sourceRunId = comment.createdByRunId
      ?? comment.runId
      ?? comment.derivedCreatedByRunId
      ?? null;
    items.push({
      id: comment.id || comment.clientId || `${comment.createdAt}`,
      kind: "message",
      author: kind,
      authorName,
      text: comment.body,
      timestamp: formatTaskChatTimestamp(comment.createdAt),
      optimistic,
      queueTargetRunId: queued ? comment.queueTargetRunId ?? null : null,
      verificationCaveats: sourceRunId
        ? ctx.verificationCaveatsByRunId?.get(sourceRunId)
        : undefined,
      agentIcon,
      onBehalfOfUserName,
      // System notices carry their structured hints through to the render
      // layer (PAP-443); other authors keep the item lean.
      presentation: kind === "system" ? comment.presentation ?? null : undefined,
      metadata: kind === "system" ? comment.metadata ?? null : undefined,
      runAgentId: kind === "system" ? comment.runAgentId ?? null : undefined,
      createdAtIso: kind === "system" ? createdAtIso : undefined,
    });
  }
  return items;
}
