import { createHash } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  issues,
  securityAuditLog,
  forceReassignIdempotency,
} from "@paperclipai/db";

const CHAIN_DEPTH_CAP = 100;
const LIVE_STATUSES = new Set(["active", "idle", "paused"]);

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function canonicalJson(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as object).sort());
}

type OrphanEvidence = {
  matchedCondition: string;
  computedAt: string;
  assigneeExists: boolean;
  assigneeStatus: string | null;
  chainReachesLiveRoot: boolean;
};

type ForceReassignInput = {
  issueId: string;
  fromAssigneeId: string;
  toAssigneeId: string;
  reason: string;
  idempotencyKey: string;
  actorId: string;
};

type ForceReassignOutput = {
  issueId: string;
  fromAssigneeId: string;
  toAssigneeId: string;
  wasIdempotent: boolean;
};

export function forceReassignService(db: Db) {
  async function isOrphaned(
    companyId: string,
    assigneeAgentId: string,
  ): Promise<{ orphaned: boolean; evidence: OrphanEvidence }> {
    const evidence: OrphanEvidence = {
      matchedCondition: "none",
      computedAt: new Date().toISOString(),
      assigneeExists: false,
      assigneeStatus: null,
      chainReachesLiveRoot: false,
    };

    if (!assigneeAgentId) {
      return { orphaned: false, evidence };
    }

    const assignee = await db
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, assigneeAgentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);

    if (!assignee) {
      evidence.matchedCondition = "assignee_missing_or_deleted";
      evidence.computedAt = new Date().toISOString();
      return { orphaned: true, evidence };
    }

    evidence.assigneeExists = true;
    evidence.assigneeStatus = assignee.status;

    if (assignee.status === "terminated" || assignee.status === "uninvokable") {
      const chainValid = await chainReachesLiveRoot(assignee.id, companyId);
      evidence.chainReachesLiveRoot = chainValid;
      if (!chainValid) {
        evidence.matchedCondition = "assignee_terminated_and_chain_broken";
        return { orphaned: true, evidence };
      }
      evidence.matchedCondition = "assignee_terminated_but_chain_valid";
      return { orphaned: false, evidence };
    }

    const chainValid = await chainReachesLiveRoot(assignee.id, companyId);
    evidence.chainReachesLiveRoot = chainValid;
    if (!chainValid) {
      evidence.matchedCondition = "chain_broken_but_assignee_alive";
      return { orphaned: false, evidence };
    }

    evidence.matchedCondition = "healthy";
    return { orphaned: false, evidence };
  }

  async function chainReachesLiveRoot(
    agentId: string,
    companyId: string,
  ): Promise<boolean> {
    const visited = new Set<string>();
    let currentId: string | null = agentId;

    while (currentId && visited.size < CHAIN_DEPTH_CAP) {
      if (visited.has(currentId)) return false;
      visited.add(currentId);

      const rows = await db
        .select({ id: agents.id, reportsTo: agents.reportsTo, status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, currentId), eq(agents.companyId, companyId)));

      const row = rows[0];
      if (!row) return false;
      if (!LIVE_STATUSES.has(row.status)) return false;
      if (!row.reportsTo) return true;

      currentId = row.reportsTo;
    }

    return false;
  }

  async function forceReassign(input: ForceReassignInput): Promise<ForceReassignOutput> {
    const { issueId, fromAssigneeId, toAssigneeId, reason, idempotencyKey, actorId } = input;

    const result = await db.transaction(async (tx) => {
      // Reserve the idempotency key first. The unique PK guarantees only one
      // concurrent caller creates the row; conflicting callers read the stored
      // result and return without performing duplicate side effects.
      const idempotencyInsert = await tx
        .insert(forceReassignIdempotency)
        .values({ idempotencyKey, issueId: null })
        .onConflictDoNothing({ target: forceReassignIdempotency.idempotencyKey })
        .returning();

      if (idempotencyInsert.length === 0) {
        const existing = await tx
          .select()
          .from(forceReassignIdempotency)
          .where(eq(forceReassignIdempotency.idempotencyKey, idempotencyKey))
          .then((rows) => rows[0] ?? null);

        return {
          issueId: existing?.issueId ?? issueId,
          fromAssigneeId,
          toAssigneeId,
          wasIdempotent: true,
        };
      }
      await tx.execute(
        sql`select ${issues.id} from ${issues} where ${issues.id} = ${issueId} for update`,
      );

      const issueResult = await tx
        .select()
        .from(issues)
        .where(eq(issues.id, issueId));

      const issue = issueResult[0];
      if (!issue) throw new Error("not_found");

      if (issue.assigneeAgentId !== fromAssigneeId) {
        throw new Error("expected_from_mismatch");
      }

      const targetResult = await tx
        .select({ id: agents.id, status: agents.status, companyId: agents.companyId })
        .from(agents)
        .where(and(eq(agents.id, toAssigneeId), eq(agents.companyId, issue.companyId)));

      const target = targetResult[0];
      if (!target) throw new Error("target_not_found");
      if (target.companyId !== issue.companyId) throw new Error("tenant_isolation_violation");
      if (!LIVE_STATUSES.has(target.status)) throw new Error("target_not_invokable");

      const evidence: OrphanEvidence = {
        matchedCondition: "none",
        computedAt: new Date().toISOString(),
        assigneeExists: false,
        assigneeStatus: null,
        chainReachesLiveRoot: false,
      };

      const assigneeResult = await tx
        .select({ id: agents.id, status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, fromAssigneeId), eq(agents.companyId, issue.companyId)));

      const assignee = assigneeResult[0];

      if (!assignee) {
        evidence.matchedCondition = "assignee_missing_or_deleted";
        evidence.computedAt = new Date().toISOString();
      } else {
        evidence.assigneeExists = true;
        evidence.assigneeStatus = assignee.status;

        let chainValid = false;
        const visited = new Set<string>();
        let currentId: string | null = assignee.id;

        while (currentId && visited.size < CHAIN_DEPTH_CAP) {
          if (visited.has(currentId)) break;
          visited.add(currentId);

          const agentRows = await tx
            .select({ id: agents.id, reportsTo: agents.reportsTo, status: agents.status })
            .from(agents)
            .where(and(eq(agents.id, currentId), eq(agents.companyId, issue.companyId)));

          const agentRow = agentRows[0];
          if (!agentRow) break;
          if (!LIVE_STATUSES.has(agentRow.status)) break;

          if (!agentRow.reportsTo) {
            chainValid = true;
            break;
          }

          currentId = agentRow.reportsTo;
        }

        evidence.chainReachesLiveRoot = chainValid;

        if (assignee.status === "terminated" || assignee.status === "uninvokable") {
          evidence.matchedCondition = chainValid
            ? "assignee_terminated_but_chain_valid"
            : "assignee_terminated_and_chain_broken";
        } else if (!chainValid) {
          evidence.matchedCondition = "chain_broken_but_assignee_alive";
        } else {
          evidence.matchedCondition = "healthy";
        }
      }

      const orphaned = evidence.matchedCondition === "assignee_missing_or_deleted" ||
        evidence.matchedCondition === "assignee_terminated_and_chain_broken";

      if (!orphaned) {
        throw new Error("issue_not_orphaned");
      }

      const chain: Array<{ id: string; reportsTo: string | null; status: string; role: string; companyId: string }> = [];
      const chainVisited = new Set<string>();
      let chainId: string | null = fromAssigneeId;

      while (chainId && chain.length < CHAIN_DEPTH_CAP) {
        if (chainVisited.has(chainId)) break;
        chainVisited.add(chainId);

        const agentRows = await tx
          .select({
            id: agents.id,
            reportsTo: agents.reportsTo,
            status: agents.status,
            role: agents.role,
            companyId: agents.companyId,
          })
          .from(agents)
          .where(and(eq(agents.id, chainId), eq(agents.companyId, issue.companyId)));

        const agentRow = agentRows[0];
        if (!agentRow) break;

        chain.push(agentRow);
        chainId = agentRow.reportsTo;
      }

      const leaseAction = issue.checkoutRunId ? "REVOKED" : null;
      const versionBefore = issue.version;
      const versionAfter = versionBefore + 1;
      const fromAssigneeStatus = chain.length > 0 ? chain[0].status : "missing";
      const toAssigneeStatus = target.status;

      await tx
        .update(issues)
        .set({
          assigneeAgentId: toAssigneeId,
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          assigneeUninvokable: "false",
          assigneeUninvokableAt: null,
          assigneeLivenessStatus: "healthy",
          version: versionAfter,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issueId));

      const prevHashRows = await tx
        .select({ hash: securityAuditLog.hash })
        .from(securityAuditLog)
        .where(eq(securityAuditLog.tenantId, issue.companyId))
        .orderBy(sql`${securityAuditLog.seq} desc`)
        .limit(1);

      const prevHash = prevHashRows[0]?.hash ?? null;

      const maxSeqRows = await tx
        .select({ max: sql<number>`coalesce(max(${securityAuditLog.seq}), 0)` })
        .from(securityAuditLog)
        .where(eq(securityAuditLog.tenantId, issue.companyId));

      const nextSeq = (maxSeqRows[0]?.max ?? 0) + 1;

      const auditRecord = {
        seq: nextSeq,
        eventType: "ISSUE_FORCE_REASSIGN",
        tenantId: issue.companyId,
        issueId: issue.id,
        actorId,
        actorRole: null,
        actorScopes: ["issue:force_reassign"] as string[],
        fromAssigneeId: fromAssigneeId,
        fromAssigneeStatus,
        fromChainSnapshot: chain,
        toAssigneeId,
        toAssigneeStatus,
        orphanEvidence: evidence,
        reason,
        leaseAction,
        issueVersionBefore: versionBefore,
        issueVersionAfter: versionAfter,
        idempotencyKey: null as string | null,
        requestId: null as string | null,
        dualControlConfirmerId: null as string | null,
        prevHash,
      };

      const createdAt = new Date();
      const recordForHash = {
        ...auditRecord,
        createdAt: createdAt.toISOString(),
      };
      const hash = sha256(canonicalJson(recordForHash) + (prevHash ?? ""));

      const auditRows = await tx
        .insert(securityAuditLog)
        .values({
          ...auditRecord,
          createdAt,
          hash,
          prevHash,
        })
        .returning();

      await tx
        .update(forceReassignIdempotency)
        .set({
          issueId,
          auditId: auditRows[0]?.id ?? null,
        })
        .where(eq(forceReassignIdempotency.idempotencyKey, idempotencyKey));

      return {
        issueId,
        fromAssigneeId,
        toAssigneeId,
        wasIdempotent: false,
      };
    });

    return result;
  }

  async function sweepOrphanedIssues(companyId: string, maxReassign: number = 10): Promise<number> {
    const orphanedIssues = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          sql`${issues.status} in ('todo', 'in_progress', 'in_review', 'blocked')`,
          sql`${issues.assigneeAgentId} is not null`,
        ),
      )
      .limit(100);

    let flagged = 0;

    for (const issue of orphanedIssues) {
      if (flagged >= maxReassign) break;
      if (!issue.assigneeAgentId) continue;

      const { orphaned } = await isOrphaned(issue.companyId, issue.assigneeAgentId);
      if (!orphaned) continue;

      await db
        .update(issues)
        .set({
          assigneeUninvokable: "true",
          assigneeUninvokableAt: new Date(),
          assigneeLivenessStatus: "orphaned",
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issue.id));

      flagged++;
    }

    return flagged;
  }

  async function getLatestAuditHash(tenantId: string): Promise<string | null> {
    const rows = await db
      .select({ hash: securityAuditLog.hash })
      .from(securityAuditLog)
      .where(eq(securityAuditLog.tenantId, tenantId))
      .orderBy(sql`${securityAuditLog.seq} desc`)
      .limit(1);

    return rows[0]?.hash ?? null;
  }

  async function verifyAuditChain(tenantId: string): Promise<{ valid: boolean; rowCount: number }> {
    const rows = await db
      .select()
      .from(securityAuditLog)
      .where(eq(securityAuditLog.tenantId, tenantId))
      .orderBy(sql`${securityAuditLog.seq} asc`);

    if (rows.length === 0) return { valid: true, rowCount: 0 };

    let prevHash: string | null = null;

    for (const row of rows) {
      if (row.prevHash !== prevHash) {
        return { valid: false, rowCount: rows.length };
      }

      const recordForHash = {
        seq: row.seq,
        eventType: row.eventType,
        tenantId: row.tenantId,
        issueId: row.issueId,
        actorId: row.actorId,
        actorRole: row.actorRole,
        actorScopes: row.actorScopes,
        fromAssigneeId: row.fromAssigneeId,
        fromAssigneeStatus: row.fromAssigneeStatus,
        fromChainSnapshot: row.fromChainSnapshot,
        toAssigneeId: row.toAssigneeId,
        toAssigneeStatus: row.toAssigneeStatus,
        orphanEvidence: row.orphanEvidence,
        reason: row.reason,
        leaseAction: row.leaseAction,
        issueVersionBefore: row.issueVersionBefore,
        issueVersionAfter: row.issueVersionAfter,
        idempotencyKey: row.idempotencyKey,
        requestId: row.requestId,
        dualControlConfirmerId: row.dualControlConfirmerId,
        prevHash: row.prevHash,
        createdAt: row.createdAt?.toISOString() ?? "",
      };

      const expectedHash = sha256(canonicalJson(recordForHash) + (prevHash ?? ""));
      if (expectedHash !== row.hash) {
        return { valid: false, rowCount: rows.length };
      }

      prevHash = row.hash;
    }

    return { valid: true, rowCount: rows.length };
  }

  return {
    isOrphaned,
    chainReachesLiveRoot,
    forceReassign,
    sweepOrphanedIssues,
    getLatestAuditHash,
    verifyAuditChain,
  };
}