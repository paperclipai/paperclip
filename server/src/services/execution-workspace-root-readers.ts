import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, heartbeatRuns, issues, projects, executionWorkspaceRepositoryAccess, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import type { AuthorizationActor } from "./authorization.js";
import { measureRunPhase } from "./execution-preparation-timing.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";

type ReaderDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type ReaderEntry = Pick<typeof executionWorkspaceRepositoryAccess.$inferSelect, "scopeId" | "issueId" | "agentId" | "responsibleUserId">;
type ReaderAgent = Pick<typeof agents.$inferSelect, "id" | "companyId" | "permissions">;
type ReaderIssue = Pick<typeof issues.$inferSelect, "id" | "companyId" | "projectId" | "executionPolicy">;
type ReaderProject = Pick<typeof projects.$inferSelect, "companyId" | "executionWorkspacePolicy">;

export const rootReaderRunColumns = {
  id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
  responsibleUserId: heartbeatRuns.responsibleUserId, nativeIssueId: heartbeatRuns.nativeIssueId, issueId: heartbeatRuns.issueId,
  contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object('issueId', ${heartbeatRuns.contextSnapshot}->'issueId', 'taskId', ${heartbeatRuns.contextSnapshot}->'taskId', 'executionPolicy', ${heartbeatRuns.contextSnapshot}->'executionPolicy')`,
};

// This snapshot belongs to one guarded operation. Never retain it across admissions
// or publications: identities and permissions must be read again next time.
export async function loadRepositoryRootReaders<T extends ReaderEntry>(db: ReaderDb, companyId: string, entries: T[]) {
  const runIds = [...new Set(entries.map(entry => entry.scopeId))];
  const agentIds = [...new Set(entries.flatMap(entry => entry.agentId ? [entry.agentId] : []))];
  const issueIds = [...new Set(entries.flatMap(entry => entry.issueId ? [entry.issueId] : []))];
  const runs = new Map<string, Pick<typeof heartbeatRuns.$inferSelect, keyof typeof rootReaderRunColumns>>();
  const agentRows = new Map<string, ReaderAgent>();
  const issueRows = new Map<string, ReaderIssue>();
  await measureRunPhase("workspace.readers.identity", async () => {
    for (let offset = 0; offset < runIds.length; offset += 500) {
      for (const row of await db.select(rootReaderRunColumns).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, runIds.slice(offset, offset + 500))))) runs.set(row.id, row);
    }
    for (let offset = 0; offset < agentIds.length; offset += 500) {
      for (const row of await db.select({ id: agents.id, companyId: agents.companyId, permissions: agents.permissions }).from(agents).where(and(
        eq(agents.companyId, companyId), inArray(agents.id, agentIds.slice(offset, offset + 500))))) agentRows.set(row.id, row);
    }
    for (let offset = 0; offset < issueIds.length; offset += 500) {
      for (const row of await db.select({ id: issues.id, companyId: issues.companyId, projectId: issues.projectId,
        executionPolicy: issues.executionPolicy }).from(issues).where(and(
        eq(issues.companyId, companyId), inArray(issues.id, issueIds.slice(offset, offset + 500))))) issueRows.set(row.id, row);
    }
  });
  return entries.map(entry => {
    const run = runs.get(entry.scopeId);
    const agent = entry.agentId ? agentRows.get(entry.agentId) : undefined;
    const issue = entry.issueId ? issueRows.get(entry.issueId) : undefined;
    if (!run || !agent || !issue || run.agentId !== entry.agentId || run.responsibleUserId !== entry.responsibleUserId
      || (run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId ?? run.issueId) !== entry.issueId) {
      throw forbidden("Repository root retains a reader whose identity is no longer available");
    }
    const actor: AuthorizationActor = { type: "agent", source: "agent_jwt", companyId,
      agentId: agent.id, runId: run.id, onBehalfOfUserId: entry.responsibleUserId === "local-board" ? null : entry.responsibleUserId };
    return { entry, run, agent, issue, actor };
  });
}

export function requiresAnonymousRepositoryAcquisition(input: {
  companyId: string;
  issue: ReaderIssue;
  agent: ReaderAgent | undefined;
  project: ReaderProject | undefined;
  workspaceSourceProject: ReaderProject | undefined;
  run: Pick<typeof heartbeatRuns.$inferSelect, keyof typeof rootReaderRunColumns> | undefined;
  agentId: string | null;
  runId: string | null;
  explicitRunId?: string | null;
}) {
  const { companyId, issue, agent, project, workspaceSourceProject, run, agentId, runId } = input;
  if (agentId && !agent) throw forbidden("Task repository agent is unavailable");
  if (runId && (!run || (input.explicitRunId && run.agentId !== agentId)
    || (run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId ?? run.issueId) !== issue.id)) {
    throw forbidden("Task repository run identity is unavailable");
  }
  const trust = resolveCoreTrustPreset({ companyId, agent, project, workspaceSourceProject, issue,
    run: run ? { companyId: run.companyId, executionPolicy: run.contextSnapshot?.executionPolicy } : null });
  if (trust.kind === "denied") throw forbidden(trust.detail);
  return trust.kind === "low_trust_review";
}
