import { and, eq, getTableColumns, inArray } from "drizzle-orm";
import { agents, caseHandoffs, issues, workflows, type Db } from "@paperclipai/db";
import { authorizationService, issueReadSqlCondition, type AuthorizationActor } from "./authorization.js";

type CaseSummaryDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type CaseWorkIdentity = { id: string; companyId: string; workIssueId: string | null; workflowId?: string | null };
const { actorContext: _actorContext, workflowPrompt: _prompt, baseWorkflowDocumentRevisionId: _base, ...publicHandoffColumns } = getTableColumns(caseHandoffs);

/** Enrich an already-authorized page in batches; never load one task per case. */
export async function enrichCaseWork<T extends CaseWorkIdentity>(
  db: CaseSummaryDb,
  companyId: string,
  rows: T[],
  actor: AuthorizationActor,
) {
  if (!rows.length) return [];
  const issueIds = [...new Set(rows.flatMap(row => row.workIssueId ? [row.workIssueId] : []))];
  const workflowIds = [...new Set(rows.flatMap(row => row.workflowId ? [row.workflowId] : []))];
  const workflowById = new Map((workflowIds.length ? await db.select({ id: workflows.id, name: workflows.name }).from(workflows)
    .where(and(eq(workflows.companyId, companyId), inArray(workflows.id, workflowIds))) : []).map(row => [row.id, row]));
  const readCondition = await issueReadSqlCondition(db, actor);
  const [workRows, pendingRows] = await Promise.all([
    issueIds.length ? db.select({
      id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status,
      statusVersion: issues.statusVersion, assigneeAgentId: issues.assigneeAgentId,
    }).from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds), readCondition)) : [],
    db.select(publicHandoffColumns).from(caseHandoffs).where(and(
      eq(caseHandoffs.companyId, companyId), inArray(caseHandoffs.caseId, rows.map(row => row.id)),
      inArray(caseHandoffs.state, ["awaiting_release", "pending_dispatch", "awaiting_completion"]),
    )),
  ]);
  const access = authorizationService(db);
  const workDecisions = await access.decideReads(actor, workRows.map(row => ({
    type: "issue" as const, companyId, issueId: row.id,
  })));
  const visibleWork = workRows.filter((_, index) => workDecisions[index]?.allowed);
  const workById = new Map(visibleWork.map(row => [row.id, row]));
  // A malformed/legacy link must not expose pending task instructions merely
  // because its case is readable. The primary task has its own access boundary.
  const primaryByCase = new Map(rows.map(row => [row.id, row.workIssueId]));
  const pendingByCase = new Map(pendingRows.filter(row => primaryByCase.get(row.caseId) === row.issueId && workById.has(row.issueId))
    .map(row => [row.caseId, row]));
  const agentIds = [...new Set([
    ...visibleWork.map(row => row.assigneeAgentId),
    ...[...pendingByCase.values()].flatMap(row => [row.fromAgentId, row.toAgentId]),
  ].filter((id): id is string => !!id))];
  // A directory-wide read is deliberately conservative for scoped/low-trust
  // callers. It avoids expanding their boundary or issuing per-agent queries.
  const directoryRead = agentIds.length ? await access.decide({ actor, action: "agent:read",
    resource: { type: "agent", companyId } }) : null;
  const names = new Map(directoryRead?.allowed ? (await db.select({ id: agents.id, name: agents.name }).from(agents)
    .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)))).map(row => [row.id, row.name]) : []);
  return rows.map(row => {
    const work = row.workIssueId ? workById.get(row.workIssueId) : null;
    const pending = pendingByCase.get(row.id);
    return {
      ...row,
      workflow: row.workflowId ? workflowById.get(row.workflowId) ?? null : null,
      workIssue: work ? { ...work, assigneeAgentName: work.assigneeAgentId ? names.get(work.assigneeAgentId) ?? null : null } : null,
      pendingHandoff: pending ? { ...pending, fromAgentName: pending.fromAgentId ? names.get(pending.fromAgentId) ?? null : null,
        toAgentName: pending.toAgentId ? names.get(pending.toAgentId) ?? null : null } : null,
    };
  });
}
