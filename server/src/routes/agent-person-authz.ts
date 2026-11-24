import type { Request } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { heartbeatRuns, issueComments, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { loadRunBoundIssue } from "../services/issue-creation-source.js";

const directedRuns = new WeakMap<Request, Promise<boolean>>();

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function wakeCommentIds(context: Record<string, unknown>): string[] {
  const ids = Array.isArray(context.wakeCommentIds) ? context.wakeCommentIds : [];
  return [...ids, context.wakeCommentId].filter((id): id is string => typeof id === "string" && isUuidLike(id));
}

async function resolveDirectedByPerson(db: Db, req: Request): Promise<boolean> {
  const actor = req.actor;
  if (actor.type !== "agent" || !actor.agentId || !actor.runId || !actor.onBehalfOfUserId || !isUuidLike(actor.runId)) return false;
  const personUserId = actor.onBehalfOfUserId;
  const [run] = await db
    .select({
      companyId: heartbeatRuns.companyId,
      issueId: heartbeatRuns.issueId,
      nativeIssueId: heartbeatRuns.nativeIssueId,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, actor.runId), eq(heartbeatRuns.agentId, actor.agentId)));
  if (!run || (actor.companyId && run.companyId !== actor.companyId)) return false;

  // The person wrote a message that woke this run.
  const commentIds = wakeCommentIds(asRecord(run.contextSnapshot));
  if (commentIds.length > 0) {
    const [byPerson] = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(and(
        eq(issueComments.companyId, run.companyId),
        inArray(issueComments.id, commentIds),
        eq(issueComments.authorUserId, personUserId),
      ))
      .limit(1);
    if (byPerson) return true;
  }

  // The run's own task is one the person made (their chat, or a task they made). Parents do not count:
  // an agent can move a task it made under someone's task, and the task tree is not evidence of who asked.
  const issue = await loadRunBoundIssue(db, run);
  return issue?.createdByUserId === personUserId;
}

/**
 * Whether the person an agent's run works for directed that run: they wrote a
 * message that woke it, or its own task is one they made, such as their chat.
 * Both are recorded by the server, not by the agent. A run also works for a
 * person another member named as a task's responsible person, a routine's
 * person, or the company default, and for the person of a subtask an agent
 * made; those runs do not borrow that person's authority.
 */
export function agentRunDirectedByPerson(db: Db, req: Request): Promise<boolean> {
  let directed = directedRuns.get(req);
  if (!directed) {
    directed = resolveDirectedByPerson(db, req);
    directedRuns.set(req, directed);
  }
  return directed;
}

/**
 * The person an agent's run works for, while they are an active member of
 * `companyId` and directed the run (see `agentRunDirectedByPerson`). An agent
 * acting for them may do some of what they could; each route says what.
 */
export async function agentPersonInCompany(db: Db, req: Request, companyId: string): Promise<{ userId: string; role: string | null } | null> {
  if (req.actor.type !== "agent" || !req.actor.onBehalfOfUserId) return null;
  const membership = req.actor.onBehalfOfMemberships?.find((item) => item.companyId === companyId && item.status === "active");
  if (!membership || !(await agentRunDirectedByPerson(db, req))) return null;
  return { userId: req.actor.onBehalfOfUserId, role: membership.membershipRole ?? null };
}

/**
 * A directed agent run may manage the dashboard of the person who directed it.
 */
export async function agentActsForResponsibilityOwner(db: Db, req: Request, companyId: string, ownerUserId: string): Promise<string | null> {
  const person = await agentPersonInCompany(db, req, companyId);
  if (!person) return null;
  return person.userId === ownerUserId && (!req.actor.authorizingUserId || req.actor.authorizingUserId === ownerUserId) ? person.userId : null;
}

/** Why an agent may not act for a person here, for its error messages. */
export const AGENT_PERSON_RULE =
  "An agent acts for a person only in that person's own chat or task, or when their message woke the run";
