import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companies,
  issueContinuationLinks,
  issueRelations,
  issues,
} from "@paperclipai/db";
import type { CreateIssueContinuation } from "@paperclipai/shared";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type IssueRow = typeof issues.$inferSelect;

export class IssueContinuationError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
  }
}

function fingerprint(...values: string[]) {
  return createHash("sha256").update(values.join("\u0000")).digest("hex");
}

function hasGraphCycle(edges: Map<string, string[]>) {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const cyclic = (edges.get(id) ?? []).some(visit);
    visiting.delete(id);
    visited.add(id);
    return cyclic;
  };
  return [...edges.keys()].some(visit);
}

async function canonicalRoot(tx: Tx, companyId: string, issueId: string) {
  let current = issueId;
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    const predecessor = await tx.select({ predecessorIssueId: issueContinuationLinks.predecessorIssueId })
      .from(issueContinuationLinks)
      .where(and(eq(issueContinuationLinks.companyId, companyId), eq(issueContinuationLinks.successorIssueId, current)))
      .orderBy(asc(issueContinuationLinks.createdAt), asc(issueContinuationLinks.id))
      .limit(1)
      .then((rows) => rows[0]?.predecessorIssueId ?? null);
    if (!predecessor) return current;
    current = predecessor;
  }
  throw new IssueContinuationError("Persisted continuation graph contains a cycle");
}

export function issueContinuationService(db: Db) {
  async function create(input: {
    companyId: string;
    predecessorIssueId: string;
    actorAgentId: string | null;
    actorUserId: string | null;
    runId: string | null;
    request: CreateIssueContinuation;
  }) {
    return db.transaction(async (tx) => {
      const [companyLock] = await tx.select({ id: companies.id }).from(companies)
        .where(eq(companies.id, input.companyId)).limit(1).for("update");
      if (!companyLock) throw new IssueContinuationError("Company not found", 404);
      const [predecessor] = await tx.select().from(issues).where(and(
        eq(issues.id, input.predecessorIssueId), eq(issues.companyId, input.companyId),
      )).limit(1).for("update");
      if (!predecessor) throw new IssueContinuationError("Predecessor issue not found", 404);

      const dependencyIssueIds = [...new Set(input.request.dependencyIssueIds)].sort();
      if (dependencyIssueIds.includes(predecessor.id)) {
        throw new IssueContinuationError("A continuation cannot depend on its predecessor");
      }
      if (dependencyIssueIds.length > 0) {
        const dependencyRows = await tx.select({ id: issues.id }).from(issues).where(and(
          eq(issues.companyId, input.companyId), inArray(issues.id, dependencyIssueIds),
        ));
        if (dependencyRows.length !== dependencyIssueIds.length) {
          throw new IssueContinuationError("Continuation dependencies must be accessible same-company issues");
        }
      }

      const rootIssueId = await canonicalRoot(tx, input.companyId, predecessor.id);
      const dependencyFingerprint = fingerprint(...dependencyIssueIds);
      const continuationFingerprint = fingerprint(rootIssueId, input.request.deliverableKey, dependencyFingerprint);
      const [existing] = await tx.select().from(issueContinuationLinks).where(and(
        eq(issueContinuationLinks.companyId, input.companyId),
        eq(issueContinuationLinks.continuationFingerprint, continuationFingerprint),
      )).limit(1);
      if (existing) {
        const [successor] = await tx.select().from(issues).where(and(
          eq(issues.id, existing.successorIssueId), eq(issues.companyId, input.companyId),
        )).limit(1);
        if (!successor) throw new IssueContinuationError("Continuation successor no longer exists", 409);
        return { link: existing, successor, rootIssueId, deduplicated: true };
      }

      const [linkRows, blockerRows] = await Promise.all([
        tx.select({ from: issueContinuationLinks.predecessorIssueId, to: issueContinuationLinks.successorIssueId })
          .from(issueContinuationLinks).where(eq(issueContinuationLinks.companyId, input.companyId)),
        tx.select({ from: issueRelations.issueId, to: issueRelations.relatedIssueId })
          .from(issueRelations).where(and(eq(issueRelations.companyId, input.companyId), eq(issueRelations.type, "blocks"))),
      ]);
      const edges = new Map<string, string[]>();
      for (const edge of [...linkRows, ...blockerRows]) edges.set(edge.from, [...(edges.get(edge.from) ?? []), edge.to]);
      if (hasGraphCycle(edges)) throw new IssueContinuationError("Continuation/blocker graph contains a cycle");

      const [company] = await tx.update(companies)
        .set({ issueCounter: sql`${companies.issueCounter} + 1` })
        .where(eq(companies.id, input.companyId))
        .returning();
      if (!company) throw new IssueContinuationError("Company not found", 404);
      const nextIssueNumber = company.issueCounter;
      const successorId = randomUUID();
      const [successor] = await tx.insert(issues).values({
        id: successorId,
        companyId: input.companyId,
        projectId: predecessor.projectId,
        projectWorkspaceId: predecessor.projectWorkspaceId,
        goalId: predecessor.goalId,
        parentId: predecessor.parentId,
        title: input.request.successor.title,
        description: input.request.successor.description ?? null,
        status: "todo",
        priority: predecessor.priority,
        assigneeAgentId: input.request.successor.assigneeAgentId ?? null,
        assigneeUserId: input.request.successor.assigneeUserId ?? null,
        createdByAgentId: input.actorAgentId,
        createdByUserId: input.actorUserId,
        responsibleUserId: predecessor.responsibleUserId,
        issueNumber: nextIssueNumber,
        identifier: `${company.issuePrefix}-${nextIssueNumber}`,
        billingCode: predecessor.billingCode,
        originKind: "manual",
      }).returning();
      if (dependencyIssueIds.length > 0) {
        await tx.insert(issueRelations).values(dependencyIssueIds.map((issueId) => ({
          companyId: input.companyId, issueId, relatedIssueId: successorId, type: "blocks" as const,
          createdByAgentId: input.actorAgentId, createdByUserId: input.actorUserId,
        })));
      }
      const [link] = await tx.insert(issueContinuationLinks).values({
        companyId: input.companyId,
        predecessorIssueId: predecessor.id,
        successorIssueId: successorId,
        kind: input.request.kind,
        residualScope: input.request.kind === "residual" ? input.request.residualScope : null,
        deliverableKey: input.request.deliverableKey,
        dependencyFingerprint,
        continuationFingerprint,
        createdByAgentId: input.actorAgentId,
        createdByUserId: input.actorUserId,
        createdByRunId: input.runId,
      }).returning();
      return { link: link!, successor: successor!, rootIssueId, deduplicated: false };
    });
  }

  return { create };
}
