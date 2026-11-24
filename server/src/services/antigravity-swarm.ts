import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { activityLog, agents, heartbeatRuns, issueComments, type Db } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";
import { instanceSettingsService } from "./instance-settings.js";
import { PaperclipRunnerProviderProfileError } from "./native-runtime/provider-profile.js";

/**
 * Google Antigravity's native `/swarm`, started only by a signed-in user.
 *
 * Source of trust: the task composer applies `parseLeadingUserCommand` (the
 * one rule, packages/shared) to what the user typed and submits a structured
 * `nativeCommand: "swarm"`. The server accepts it only from a signed-in board
 * user, records the request in the activity log (server-written only) and
 * marks the assignee's wake with the comment id. A run is a swarm only when
 * that record exists. Comment text is never read as a command here, so
 * pasted, quoted, agent or API text stays text.
 *
 * A requested swarm that cannot run is refused with a plain message; it is
 * never run as an ordinary request.
 */
export const ANTIGRAVITY_SWARM_COMMAND = "swarm" as const;
export const ANTIGRAVITY_SWARM_UNAVAILABLE = "antigravity_swarm_unavailable";

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};

export function isAntigravityAgent(agent: { adapterType: string; adapterConfig: unknown } | null): boolean {
  const config = record(agent?.adapterConfig);
  return agent?.adapterType === "paperclip_runner" && config.provider === "acpx" && config.acpxAgent === "antigravity";
}

export function antigravitySwarmRefusal(input: {
  enabled: boolean;
  agent: { adapterType: string; adapterConfig: unknown } | null;
  remote?: boolean;
  planning?: boolean;
}): string | null {
  if (!input.enabled) {
    return "Swarm is not turned on for this Paperclip. An instance admin can turn on \"Google Antigravity swarm\" in Settings, Experimental.";
  }
  if (!isAntigravityAgent(input.agent)) return "Swarm works only for tasks assigned to a Google Antigravity agent.";
  if (input.planning) return "Swarm is not available while the task is in Plan mode: helpers change files. Approve the plan first, then send /swarm.";
  if (input.remote) return "Swarm is not available for this agent: it runs only on this computer, not in a cloud or remote environment.";
  return null;
}

/** The comment id a wake carries when the user asked for a swarm. Verified against the activity log before use. */
export function requestedAntigravitySwarmCommentId(context: unknown): string | null {
  const value = record(context).antigravitySwarmCommentId;
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

export const ANTIGRAVITY_SWARM_REQUESTED_ACTION = "issue.antigravity_swarm_requested";

async function swarmEnabled(db: Db): Promise<boolean> {
  return (await instanceSettingsService(db).getExperimentalReadOnly()).enableAntigravitySwarm === true;
}

/** Comment-time check, so an unavailable swarm is refused before anything is posted. */
export async function antigravitySwarmCommentRefusal(db: Db, issue: { companyId: string; assigneeAgentId: string | null; workMode?: string | null }): Promise<string | null> {
  const [agent] = issue.assigneeAgentId
    ? await db.select({ adapterType: agents.adapterType, adapterConfig: agents.adapterConfig }).from(agents)
      .where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, issue.companyId)))
    : [];
  return antigravitySwarmRefusal({ enabled: await swarmEnabled(db), agent: agent ?? null, planning: issue.workMode === "planning" });
}

/**
 * Run-time decision for the run a comment woke. Returns true when this run is
 * the user's swarm. Throws a plain-language failure when the swarm was asked
 * for but cannot run here, so the run is not silently an ordinary request.
 */
/**
 * Every run that re-creates a swarm request is that swarm, never ordinary work:
 * - a retry or automatic recovery inherits it through its retry link (the run
 *   column, or the context copy), following a bounded chain on the same task;
 * - any other wake on the task (blocker-stalled and stranded-work sweeps,
 *   continuations, restart recovery) runs it while the user's latest message is
 *   a swarm request that no successful swarm run has fulfilled.
 * The record check in resolveAntigravitySwarmRun still applies to the result.
 */
async function inheritedSwarmCommentId(db: Db, companyId: string, issueId: string, runId: string, context: unknown): Promise<string | null> {
  const [current] = await db.select({ retryOfRunId: heartbeatRuns.retryOfRunId }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)));
  let retryOf: unknown = current?.retryOfRunId ?? record(context).retryOfRunId;
  for (let hop = 0; hop < 8 && typeof retryOf === "string" && /^[0-9a-f-]{36}$/i.test(retryOf); hop++) {
    const [source] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot, retryOfRunId: heartbeatRuns.retryOfRunId }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, retryOf), eq(heartbeatRuns.companyId, companyId),
        sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueId}`));
    if (!source) return null;
    const inherited = requestedAntigravitySwarmCommentId(source.contextSnapshot);
    if (inherited) return inherited;
    retryOf = source.retryOfRunId ?? record(source.contextSnapshot).retryOfRunId;
  }
  return null;
}

async function pendingSwarmCommentId(db: Db, companyId: string, issueId: string): Promise<string | null> {
  const [latest] = await db.select({ id: issueComments.id }).from(issueComments)
    .where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      isNotNull(issueComments.authorUserId), isNull(issueComments.authorAgentId)))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(1);
  if (!latest) return null;
  const [fulfilled] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "succeeded"),
      sql`${heartbeatRuns.contextSnapshot}->>'antigravitySwarmCommentId' = ${latest.id}`)).limit(1);
  return fulfilled ? null : latest.id;
}

export async function recordAntigravitySwarmRequest(db: Db, input: { companyId: string; issueId: string; commentId: string; userId: string }): Promise<void> {
  await logActivity(db, {
    companyId: input.companyId, actorType: "user", actorId: input.userId, issueId: input.issueId,
    action: ANTIGRAVITY_SWARM_REQUESTED_ACTION, entityType: "issue", entityId: input.issueId,
    details: { commentId: input.commentId, summary: "Asked the Google Antigravity agent to run a swarm." },
  });
}

/**
 * Run-time decision for the run a comment woke. Returns true when this run is
 * the user's swarm. Throws a plain-language failure when the swarm was asked
 * for but cannot run here, so the run is not silently an ordinary request.
 */
export async function resolveAntigravitySwarmRun(db: Db, input: {
  companyId: string;
  issueId: string;
  runId: string;
  agent: { id: string; adapterType: string; adapterConfig: unknown };
  context: unknown;
  remote: boolean;
  planning: boolean;
}): Promise<boolean> {
  const commentId = requestedAntigravitySwarmCommentId(input.context)
    ?? await inheritedSwarmCommentId(db, input.companyId, input.issueId, input.runId, input.context)
    ?? await pendingSwarmCommentId(db, input.companyId, input.issueId);
  if (!commentId) return false;
  const [requested] = await db.select({ id: activityLog.id }).from(activityLog)
    .innerJoin(issueComments, and(eq(issueComments.id, commentId), eq(issueComments.issueId, input.issueId), eq(issueComments.companyId, input.companyId),
      isNotNull(issueComments.authorUserId), isNull(issueComments.authorAgentId)))
    .where(and(eq(activityLog.companyId, input.companyId), eq(activityLog.action, ANTIGRAVITY_SWARM_REQUESTED_ACTION),
      eq(activityLog.entityId, input.issueId), eq(activityLog.actorType, "user"), eq(activityLog.actorId, issueComments.authorUserId),
      sql`${activityLog.details}->>'commentId' = ${commentId}`))
    .limit(1);
  if (!requested) return false;
  const refusal = antigravitySwarmRefusal({ enabled: await swarmEnabled(db), agent: input.agent, remote: input.remote, planning: input.planning });
  if (refusal) throw new PaperclipRunnerProviderProfileError(ANTIGRAVITY_SWARM_UNAVAILABLE, refusal);
  await logActivity(db, {
    companyId: input.companyId, actorType: "system", actorId: "paperclip", agentId: input.agent.id, runId: input.runId,
    issueId: input.issueId, action: "issue.antigravity_swarm_started", entityType: "issue", entityId: input.issueId,
    details: {
      commentId,
      summary: "Started a Google Antigravity swarm with helpers. Helper actions are approved automatically by Antigravity's auto mode. Paperclip does not sandbox the helpers on this computer and cannot see their shell commands, which can write outside the task folder (for example in temp directories). Usage is one total for the coordinator and its helpers.",
    },
  });
  return true;
}
