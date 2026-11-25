import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { captureRunIdentity, type RunIdentityCapture } from "./run-identity.js";

type ProjectToolResult<Run> = { run: Run; issue: typeof issues.$inferSelect; userId: string | null; localTrusted: boolean };
/** Resolve authority from the authenticated run, never caller-supplied user/task IDs. */
export function projectToolContext(db: Db, actor: Request["actor"], write?: boolean, resource?: string): Promise<ProjectToolResult<RunIdentityCapture<"task_authorization">["run"]>>;
export function projectToolContext(db: Db, actor: Request["actor"], write: boolean, resource: string, options: { includeExecutionInput: true }): Promise<ProjectToolResult<RunIdentityCapture<"project_execution">["run"]>>;
export async function projectToolContext(db: Db, actor: Request["actor"], write = false, resource = "Project", options?: { includeExecutionInput: true }) {
  if (actor.type !== "agent" || actor.source !== "agent_jwt" || !actor.runId || !actor.agentId || !actor.companyId) {
    throw forbidden(`${resource} tools require an authenticated agent run`);
  }
  // Acquire task/run locks before checking mode and session generation. A reset,
  // cancellation, or steering update cannot race a committing project mutation.
  const binding = { companyId: actor.companyId, agentId: actor.agentId, runId: actor.runId };
  const identity = options?.includeExecutionInput ? await captureRunIdentity(db, binding, { readScope: "project_execution" }) :
    await captureRunIdentity(db, binding, { readScope: "task_authorization" });
  const run = identity.run;
  const snapshot = run.contextSnapshot ?? {};
  const issueId = run.nativeIssueId ?? (typeof snapshot.issueId === "string" ? snapshot.issueId : null);
  if (!issueId) throw forbidden(`${resource} tools require a task-bound run`);
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, actor.companyId)));
  if (!issue) throw forbidden("Run task is unavailable");
  if (issue.conversationAgentId && Number(snapshot.conversationSessionGeneration ?? 0) !== issue.conversationSessionGeneration) {
    throw forbidden("Conversation session has changed");
  }
  if (write && !["standard", "skill_test"].includes(issue.workMode)) throw forbidden(`${resource} creation is unavailable in Ask or Plan mode`);
  const userId = identity.run.responsibleUserId;
  // local-board is a server-owned identity; never accepted from tool arguments.
  return { run, issue, userId, localTrusted: userId === "local-board" };
}
