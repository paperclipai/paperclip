import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { captureRunIdentity } from "./run-identity.js";

/** Resolve authority from the authenticated run, never caller-supplied user/task IDs. */
export async function projectToolContext(db: Db, actor: Request["actor"], write = false) {
  if (actor.type !== "agent" || actor.source !== "agent_jwt" || !actor.runId || !actor.agentId || !actor.companyId) {
    throw forbidden("Project tools require an authenticated agent run");
  }
  // Acquire task/run locks before checking mode and session generation. A reset,
  // cancellation, or steering update cannot race a committing project mutation.
  const identity = await captureRunIdentity(db, { companyId: actor.companyId, agentId: actor.agentId, runId: actor.runId });
  const run = identity.run;
  const snapshot = run.contextSnapshot ?? {};
  const issueId = run.nativeIssueId ?? (typeof snapshot.issueId === "string" ? snapshot.issueId : null);
  if (!issueId) throw forbidden("Project tools require a task-bound run");
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, actor.companyId)));
  if (!issue) throw forbidden("Run task is unavailable");
  if (issue.conversationAgentId && Number(snapshot.conversationSessionGeneration ?? 0) !== issue.conversationSessionGeneration) {
    throw forbidden("Conversation session has changed");
  }
  if (write && !["standard", "skill_test"].includes(issue.workMode)) throw forbidden("Project creation is unavailable in Ask or Plan mode");
  const userId = identity.run.responsibleUserId;
  // local-board is a server-owned identity; never accepted from tool arguments.
  return { run, issue, userId, localTrusted: userId === "local-board" };
}
