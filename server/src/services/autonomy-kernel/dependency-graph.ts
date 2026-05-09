import { and, eq } from "drizzle-orm";
import { issues, issueRelations } from "@paperclipai/db";
import type { AutonomyKernelContext, PreflightRunRequest } from "./types.js";

export interface DependencyEvaluation {
  status: "allow" | "blocked" | "deny";
  reason: string | null;
  blockingIssueIds: string[];
}

const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

export function createDependencyGraphService(context: AutonomyKernelContext) {
  const { db } = context;

  return {
    async evaluateDependencies(request: PreflightRunRequest): Promise<DependencyEvaluation> {
      if (!request.issueId) {
        return { status: "allow", reason: null, blockingIssueIds: [] };
      }

      const [issue] = await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, request.companyId), eq(issues.id, request.issueId)))
        .limit(1);
      if (!issue) {
        return { status: "deny", reason: `Issue ${request.issueId} does not exist in company`, blockingIssueIds: [] };
      }

      const relations = await db
        .select({ relation: issueRelations, blocker: issues })
        .from(issueRelations)
        .innerJoin(issues, and(eq(issues.companyId, issueRelations.companyId), eq(issues.id, issueRelations.issueId)))
        .where(
          and(
            eq(issueRelations.companyId, request.companyId),
            eq(issueRelations.relatedIssueId, request.issueId),
            eq(issueRelations.type, "blocks"),
          ),
        );

      const invalidSelfEdges = relations.filter((row) => row.relation.issueId === row.relation.relatedIssueId);
      if (invalidSelfEdges.length > 0) {
        return {
          status: "deny",
          reason: `Issue ${request.issueId} has an invalid self-blocking dependency edge`,
          blockingIssueIds: [request.issueId],
        };
      }

      const openBlockers = relations
        .map((row) => row.blocker)
        .filter((row) => !TERMINAL_ISSUE_STATUSES.has(row.status) && row.hiddenAt === null);
      if (openBlockers.length > 0) {
        return {
          status: "blocked",
          reason: `Issue ${request.issueId} is blocked by ${openBlockers.length} open dependencies`,
          blockingIssueIds: openBlockers.map((row) => row.id),
        };
      }

      return { status: "allow", reason: null, blockingIssueIds: [] };
    },
  };
}
