import { and, eq, isNotNull, ne } from "drizzle-orm";
import { issueComments, issues, type Db } from "@paperclipai/db";
import { logActivity, type ActivityPublication, type LogActivityInput } from "./activity-log.js";

/** Longest provisional chat title, in characters, before it is cut at a word boundary. */
export const PROVISIONAL_CHAT_TITLE_MAX_LENGTH = 50;

/**
 * A provisional chat title from the person's first message: its first non-empty line without markdown
 * markup, cut at a word boundary. Null when the message has no text (for example only attachments).
 */
export function chatTitleFromMessage(body: string, maxLength = PROVISIONAL_CHAT_TITLE_MAX_LENGTH): string | null {
  const line = body.split(/\r?\n/).map(entry => entry.trim()).find(Boolean);
  if (!line) return null;
  const text = line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, "")
    .replace(/[`*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  const characters = [...text];
  if (characters.length <= maxLength) return text;
  const cut = characters.slice(0, maxLength).join("");
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary >= maxLength / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/**
 * Names a new chat after the person's first message while its title is still provisional, so the chat
 * never shows only its default name. The agent can still replace it once; a manual rename ends both.
 * Runs inside the transaction that stores the message, after the chat row is locked.
 */
export async function setProvisionalChatTitle(
  tx: Db,
  input: { companyId: string; issueId: string; commentId: string; body: string; actor: Pick<LogActivityInput, "actorType" | "actorId"> },
  publications: ActivityPublication[],
) {
  const [chat] = await tx.select({ title: issues.title, titleNeedsGeneration: issues.titleNeedsGeneration, conversationAgentId: issues.conversationAgentId })
    .from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  if (!chat?.conversationAgentId || !chat.titleNeedsGeneration) return;
  const [earlier] = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.issueId, input.issueId), isNotNull(issueComments.authorUserId), ne(issueComments.id, input.commentId),
  )).limit(1);
  if (earlier) return;
  const title = chatTitleFromMessage(input.body);
  if (!title || title === chat.title) return;
  await tx.update(issues).set({ title, updatedAt: new Date() }).where(and(
    eq(issues.id, input.issueId), eq(issues.companyId, input.companyId), eq(issues.titleNeedsGeneration, true),
  ));
  await logActivity(tx, {
    companyId: input.companyId, actorType: input.actor.actorType, actorId: input.actor.actorId,
    action: "issue.updated", entityType: "issue", entityId: input.issueId,
    details: { title, previous: { title: chat.title }, titleNeedsGeneration: true, titleSource: "first_message" },
  }, publications);
}

/** Whether a chat still waits for its first agent turn: no agent has written in it yet. */
export async function chatAwaitsFirstAgentTurn(db: Db, companyId: string, issueId: string) {
  const [reply] = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId), isNotNull(issueComments.authorAgentId),
  )).limit(1);
  return !reply;
}

/** The directive a chat's first agent turn gets while its title is provisional. */
export const CHAT_TITLE_DIRECTIVE = "Give this conversation a short descriptive title of a few words in the person's language: call set_task_title once with that title and onlyIfProvisional: true, early in this turn. If that tool is unavailable, PUT /api/issues/<this chat's id>/title with {title, onlyIfProvisional: true} using your normal Paperclip authentication. Do not mention the title in your reply.";
