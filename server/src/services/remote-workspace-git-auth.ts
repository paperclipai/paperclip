import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { createGitRemoteAuthProvider } from "./git-credentials.js";

/** Bind credentials to the current run's identity, including shared workspace users. */
export async function createRemoteWorkspaceGitAuth(db: Db, companyId: string, runId: string,
  create: typeof createGitRemoteAuthProvider = createGitRemoteAuthProvider) {
  const [run] = await db.select({ agentId: heartbeatRuns.agentId, responsibleUserId: heartbeatRuns.responsibleUserId,
    nativeIssueId: heartbeatRuns.nativeIssueId, issueId: heartbeatRuns.issueId, status: heartbeatRuns.status,
    contextIssueId: sql<unknown>`${heartbeatRuns.contextSnapshot}->'issueId'`,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
  const issueId = run?.nativeIssueId ?? run?.issueId ?? run?.contextIssueId;
  if (!run || run.status !== "running" || typeof issueId !== "string"
    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(issueId)) throw new Error("remote_workspace_git_run_unavailable");
  return create(db, companyId, { issueId, heartbeatRunId: runId, agentId: run.agentId,
    responsibleUserId: run.responsibleUserId === "local-board" ? null : run.responsibleUserId });
}
