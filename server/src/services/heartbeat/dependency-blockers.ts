import { and, asc, eq, inArray } from "drizzle-orm";
import { issueRelations, issues, type Db } from "@paperclipai/db";
import type { issueService } from "../issues.js";

export async function listUnresolvedBlockerSummaries(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  issueId: string,
  unresolvedBlockerIssueIds: string[],
) {
  const ids = [...new Set(unresolvedBlockerIssueIds.filter(Boolean))];
  if (ids.length === 0) return [];
  return dbOrTx
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      priority: issues.priority,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.issueId, issues.id))
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        eq(issueRelations.relatedIssueId, issueId),
        inArray(issues.id, ids),
      ),
    )
    .orderBy(asc(issues.title));
}

export async function withCurrentDependencyBlockers(
  db: Db,
  issuesSvc: Pick<ReturnType<typeof issueService>, "listDependencyReadiness">,
  input: { companyId: string; issueId: string | null; context: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  if (!input.issueId || input.context.dependencyBlockedInteraction !== true) return input.context;
  const readiness = (await issuesSvc.listDependencyReadiness(input.companyId, [input.issueId])).get(input.issueId);
  const unresolvedBlockerIssueIds = readiness?.unresolvedBlockerIssueIds ?? [];
  const {
    dependencyBlockedInteraction: _blocked,
    unresolvedBlockerIssueIds: _ids,
    unresolvedBlockerCount: _count,
    unresolvedBlockerSummaries: _summaries,
    ...rest
  } = input.context;
  if (unresolvedBlockerIssueIds.length === 0) return rest;
  return {
    ...rest,
    dependencyBlockedInteraction: true,
    unresolvedBlockerIssueIds,
    unresolvedBlockerCount: unresolvedBlockerIssueIds.length,
    unresolvedBlockerSummaries: await listUnresolvedBlockerSummaries(
      db, input.companyId, input.issueId, unresolvedBlockerIssueIds),
  };
}
