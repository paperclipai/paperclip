import { and, eq, sql } from "drizzle-orm";
import { activityLog, agents, issueComments, type Db } from "@paperclipai/db";
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
  const commentId = requestedAntigravitySwarmCommentId(input.context);
  if (!commentId) return false;
  const [requested] = await db.select({ id: activityLog.id }).from(activityLog)
    .innerJoin(issueComments, and(eq(issueComments.id, commentId), eq(issueComments.issueId, input.issueId), eq(issueComments.companyId, input.companyId)))
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
      summary: "Started a Google Antigravity swarm with helpers. Helper actions are approved automatically by Antigravity's auto mode, which keeps file changes in the task folder; helper shell commands are not visible to Paperclip and Paperclip does not sandbox them on this computer. Usage is one total for the coordinator and its helpers.",
    },
  });
  return true;
}
