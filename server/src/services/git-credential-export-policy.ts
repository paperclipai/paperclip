import { isUuidLike } from "@paperclipai/shared";
import { agents, heartbeatRuns, issues, projects, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";
import { isLowTrustQuarantined } from "./source-trust.js";

/** A raw Git credential cannot enforce the low-trust read-only tool boundary. */
export async function allowsGitCredentialExport(db: Db, run: typeof heartbeatRuns.$inferSelect) {
  const issueId = run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId ?? run.nativeIssueId;
  if (issueId !== undefined && issueId !== null && (typeof issueId !== "string" || !isUuidLike(issueId))) return false;
  const [agent] = await db.select({ companyId: agents.companyId, permissions: agents.permissions }).from(agents)
    .where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)));
  if (!agent) return false;
  const [issue] = typeof issueId === "string" ? await db.select({ companyId: issues.companyId, projectId: issues.projectId,
    executionPolicy: issues.executionPolicy, sourceTrust: issues.sourceTrust }).from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId))) : [];
  if (issueId !== undefined && issueId !== null && !issue) return false;
  if (isLowTrustQuarantined(issue?.sourceTrust)) return false;
  const projectId = issue?.projectId ?? run.contextSnapshot?.projectId;
  if (projectId !== undefined && projectId !== null && (typeof projectId !== "string" || !isUuidLike(projectId))) return false;
  const [project] = typeof projectId === "string" ? await db.select({ companyId: projects.companyId,
    executionWorkspacePolicy: projects.executionWorkspacePolicy }).from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, run.companyId))) : [];
  if (projectId !== undefined && projectId !== null && !project) return false;
  return resolveCoreTrustPreset({ companyId: run.companyId, agent, project, issue,
    run: { companyId: run.companyId, executionPolicy: run.contextSnapshot?.executionPolicy } }).kind === "standard";
}
