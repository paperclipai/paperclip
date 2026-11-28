import { agents, documentRevisions, documents, issueDocuments, statusDecisions, type Db } from "@paperclipai/db";
import { agentInteractionDenial } from "../agent-interaction-policy.js";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import { and, eq, lt, ne, notExists, sql, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

export const NATIVE_AGENT_BLOCKER_CONTINUATION_CODE = "native_agent_blocker_continuation";
export const NATIVE_AGENT_BLOCKER_HANDOFF_CODE = "native_agent_blocker_needs_person";
export const NATIVE_AGENT_BLOCKER_MAX_CONTINUATIONS = 1;
/**
 * A run that saved new task work may continue past the single plain
 * continuation, but not forever: an agent that saves a sliver of work and
 * names a next action in every run would otherwise chain fresh sessions
 * without end. Past this cap the blocker goes to the board.
 */
export const NATIVE_AGENT_BLOCKER_MAX_PROGRESS_CONTINUATIONS = 6;
/** Spent progress continuations hand the task back to the agent that created it, once. */
export const NATIVE_AGENT_BLOCKER_SPLIT_CODE = "native_agent_blocker_split_requested";

export function nativeAgentBlockerSplitAction(nextAction: string): string {
  return ("The assigned agent saved work in every run but could not finish this task across "
    + `${NATIVE_AGENT_BLOCKER_MAX_PROGRESS_CONTINUATIONS} fresh sessions: it is too large for one task. `
    + "As the agent that created it, split the remaining work into child tasks of this task that each have one "
    + "deliverable a few runs can finish, ordered with blockers, starting from the saved documents. "
    + `The assigned agent named this remaining work: ${nextAction}`).slice(0, 2_000);
}

/**
 * The creating agent may take the task back only when it is a different,
 * usable agent that the assignee may hand work to, and only the first time.
 */
export async function resolveNativeAgentBlockerSplitOwner(db: Db, input: {
  companyId: string; issueId: string; createdByAgentId: string | null; runAgentId: string;
}): Promise<string | null> {
  const creatorId = input.createdByAgentId;
  if (!creatorId || creatorId === input.runAgentId) return null;
  const [creator] = await db.select({ status: agents.status }).from(agents)
    .where(and(eq(agents.companyId, input.companyId), eq(agents.id, creatorId))).limit(1);
  if (!creator || ["terminated", "pending_approval", "paused"].includes(creator.status)) return null;
  const [earlier] = await db.select({ id: statusDecisions.id }).from(statusDecisions).where(and(
    eq(statusDecisions.companyId, input.companyId), eq(statusDecisions.issueId, input.issueId),
    eq(statusDecisions.reasonCode, NATIVE_AGENT_BLOCKER_SPLIT_CODE),
  )).limit(1);
  if (earlier) return null;
  try {
    const denial = await agentInteractionDenial(db, { companyId: input.companyId, actorAgentId: input.runAgentId,
      operation: "assign", issueId: input.issueId, targetAgentId: creatorId });
    return denial ? null : creatorId;
  } catch {
    return null;
  }
}
export const NATIVE_AGENT_BLOCKER_CONTINUATION_DELAY_MS = 30_000;
export const NATIVE_AGENT_BLOCKER_MESSAGE =
  "The agent reported a blocker it owns. Paperclip continues the task in a fresh session.";
export const NATIVE_AGENT_BLOCKER_HINT = "The previous run stopped on a blocker that it said the agent itself owns. "
  + "Paperclip started this fresh session to continue. Earlier attempts may already have completed some steps: "
  + "check the workspace files, this task's documents and its comments before repeating a step, and never post a comment or save a document that already exists. "
  + "Save completed work in the task documents and name the exact next action if work remains. "
  + "Resolve the blocker yourself if you can, then finish the remaining work and report the real outcome. "
  + "If only a person can resolve it, report the blocker with owner kind user and the exact action that person must take.";

/** Require new work saved by this run, excluding generated handoff summaries and reverted revisions. */
export async function hasNativeAgentBlockerProgress(db: Db, input: {
  companyId: string; issueId: string; runId: string; agentId: string;
}): Promise<boolean> {
  const previous = alias(documentRevisions, "previous_work_revision");
  const normalize = (body: SQLWrapper) => sql<string>`btrim(regexp_replace(${body}, '[[:space:]]+', ' ', 'g'))`;
  const [progress] = await db.select({ id: documentRevisions.id }).from(issueDocuments)
    .innerJoin(documents, and(
      eq(documents.companyId, input.companyId),
      eq(documents.id, issueDocuments.documentId),
    ))
    .innerJoin(documentRevisions, and(
      eq(documentRevisions.companyId, input.companyId),
      eq(documentRevisions.documentId, documents.id),
      eq(documentRevisions.id, documents.latestRevisionId),
    ))
    .where(and(
      eq(issueDocuments.companyId, input.companyId),
      eq(issueDocuments.issueId, input.issueId),
      ne(issueDocuments.key, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY),
      eq(documentRevisions.createdByRunId, input.runId),
      eq(documentRevisions.createdByAgentId, input.agentId),
      ne(normalize(documentRevisions.body), ""),
      notExists(db.select({ id: previous.id }).from(previous).where(and(
        eq(previous.companyId, input.companyId),
        eq(previous.documentId, documentRevisions.documentId),
        lt(previous.revisionNumber, documentRevisions.revisionNumber),
        eq(normalize(previous.body), normalize(documentRevisions.body)),
      ))),
    )).limit(1);
  return Boolean(progress);
}
