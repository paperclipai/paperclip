import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, approvals, issueApprovals, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { issueService } from "./issues.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { buildIssueBlockersResolvedWakeStateKey, findExistingIssueBlockersResolvedWakeForReadyState } from "./issue-dependency-wakeups.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Dark implementation checkpoint: no production emitter calls this function.
// Caller owns the transaction; no detached restore or external wake is allowed.
export async function restoreDependencyReadyIssueInTransaction(
  tx: Transaction,
  input: { companyId: string; dependentIssueId: string; resolvedBlockerIssueId: string },
  owner: {
    db: Db;
    activityPublications: NonNullable<Parameters<ReturnType<typeof issueService>["update"]>[3]>;
    actions: NonNullable<Parameters<ReturnType<typeof issueService>["update"]>[4]>;
  },
): Promise<string | null> {
  // Capture routing and caller-owned queues before any await. The caller must
  // publish/execute these queues only AFTER the outer transaction commits.
  const { companyId, dependentIssueId, resolvedBlockerIssueId } = input;
  const { db, activityPublications, actions } = owner;
  if (db === (tx as unknown as Db)) throw new Error("dependency_restore_requires_distinct_root_db");
  // Caller input is routing, not proof that the blocker completed. Keep its
  // authoritative status stable through this transaction. This is still dark:
  // graph-wide writer lock ordering/fences are not established by this lock.
  const [blocker] = await tx.select({ id: issues.id, companyId: issues.companyId, status: issues.status }).from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, resolvedBlockerIssueId)))
    .for("share");
  if (!blocker || blocker.id !== resolvedBlockerIssueId || blocker.companyId !== companyId
    || blocker.status !== "done") return null;
  const [dependent] = await tx.select().from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, dependentIssueId)))
    .for("update");
  if (!dependent || dependent.companyId !== companyId || dependent.id !== dependentIssueId
    || dependent.status !== "blocked" || !dependent.assigneeAgentId) return null;
  // Conservative dark boundary: unmodeled holds and leases are not authority
  // to resume. Cross-writer locking still needs integration.
  if (dependent.executionRunId || dependent.checkoutRunId || dependent.conversationAgentId
    || dependent.unblockDescriptor || dependent.executionState || dependent.executionPolicy) return null;
  // Reuse the authoritative tree snapshot, on the supplied transaction rather
  // than the root DB. This veto is NOT a concurrent hold-insertion/parent-edit
  // fence: the common tree/graph writer discipline is still a wiring prerequisite.
  if (await issueTreeControlService(tx as unknown as Db).getActivePauseHoldGate(companyId, dependentIssueId)) return null;
  const interactions = await tx.select({ status: issueThreadInteractions.status }).from(issueThreadInteractions)
    .where(and(eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, dependentIssueId)));
  if (interactions.some((row) => row.status === "pending")) return null;
  const gates = await tx.select({ status: approvals.status }).from(issueApprovals)
    .innerJoin(approvals, and(eq(issueApprovals.approvalId, approvals.id), eq(approvals.companyId, companyId)))
    .where(and(eq(issueApprovals.companyId, companyId), eq(issueApprovals.issueId, dependentIssueId)));
  if (gates.some((row) => row.status === "pending" || row.status === "revision_requested")) return null;
  const candidates = await issueService(tx as unknown as Db).listWakeableBlockedDependents(resolvedBlockerIssueId);
  const candidate = candidates.find((row) => row.id === dependentIssueId);
  if (!candidate || candidate.assigneeAgentId !== dependent.assigneeAgentId
    || !candidate.blockerIssueIds.includes(resolvedBlockerIssueId)) return null;
  // Capture the cycle BEFORE canonical metadata cleanup.
  const blockerIssueIds = [...candidate.blockerIssueIds];
  const idempotencyKey = buildIssueBlockersResolvedWakeStateKey({
    dependentIssueId, blockerIssueIds, blockedTransitionAt: dependent.blockedTransitionAt,
  });
  // Existing-intent plus still-blocked is ambiguous legacy state. Leave it
  // untouched in this dark slice; integration must define reconciliation.
  if (await findExistingIssueBlockersResolvedWakeForReadyState(tx as unknown as Db, {
    companyId, dependentIssueId, blockerIssueIds, blockedTransitionAt: dependent.blockedTransitionAt,
  })) return null;
  const restored = await issueService(db).update(dependentIssueId,
    { status: "todo", companyGuard: companyId }, tx, activityPublications, actions);
  if (!restored || restored.status !== "todo") throw new Error("dependency_restore_not_persisted");
  const [intent] = await tx.insert(agentWakeupRequests).values({
    companyId, agentId: dependent.assigneeAgentId, source: "automation", triggerDetail: "system",
    reason: "issue_blockers_resolved", status: "queued", idempotencyKey,
    requestedByActorType: "system", requestedByActorId: "dependency-restoration",
    payload: { issueId: dependentIssueId, taskId: dependentIssueId, resolvedBlockerIssueId, blockerIssueIds },
  }).returning({ id: agentWakeupRequests.id });
  if (!intent) throw new Error("dependency_restore_intent_not_persisted");
  return intent.id;
}
