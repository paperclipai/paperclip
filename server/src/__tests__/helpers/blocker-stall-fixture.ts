import { randomUUID } from "node:crypto";
import { agents, agentWakeupRequests, companies, issueRecoveryActions, issueRelations, issues, type Db } from "@paperclipai/db";
import { issueBlockerStalledWakeKey } from "../../services/recovery/blocker-stall-wakeups.js";

export type BlockerStallFixture = Awaited<ReturnType<typeof seedBlockerStall>>;

export async function seedBlockerStallCompany(db: Db, agentStatus: "idle" | "paused" = "idle") {
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Stall", issuePrefix: `S${companyId.slice(0, 6)}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: agentStatus });
  return { companyId, agentId };
}

export async function seedBlockerStall(db: Db, company: { companyId: string; agentId: string },
  options: { parent?: boolean; dependents?: number } = {}) {
  const { companyId, agentId } = company;
  const waiter = { companyId, status: "blocked" as const, assigneeAgentId: agentId };
  const [parent] = options.parent === false ? [null]
    : await db.insert(issues).values({ ...waiter, title: "Parent" }).returning();
  const [stalled] = await db.insert(issues).values({ ...waiter, title: "Stalled", parentId: parent?.id ?? null }).returning();
  const dependents = options.dependents ? await db.insert(issues).values(Array.from({ length: options.dependents },
    (_, index) => ({ ...waiter, title: `Dependent ${index}` }))).returning() : [];
  if (dependents.length) {
    await db.insert(issueRelations).values(dependents.map(dependent => ({ companyId, issueId: stalled!.id,
      relatedIssueId: dependent.id, type: "blocks" as const })));
  }
  const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: stalled!.id, kind: "run_recovery",
    status: "escalated", ownerType: "board", cause: "execution_recovery_budget_exhausted", fingerprint: `fixture-${stalled!.id}`,
    nextAction: "Retry the run or reassign the task" }).returning();
  const stall = { companyId, issueId: stalled!.id, actionId: action!.id, parentId: parent?.id ?? null };
  return { companyId, agentId, parent, stalled: stalled!, dependents, action: action!, stall };
}

export async function markStallWakeDelivered(db: Db, fixture: Pick<BlockerStallFixture, "companyId" | "agentId" | "stall">,
  waiterIssueId: string, status = "queued") {
  await db.insert(agentWakeupRequests).values({ companyId: fixture.companyId, agentId: fixture.agentId, source: "automation",
    triggerDetail: "system", reason: "issue_blocker_stalled", payload: { issueId: waiterIssueId }, status,
    idempotencyKey: issueBlockerStalledWakeKey({ waiterIssueId, stalledIssueId: fixture.stall.issueId,
      recoveryActionId: fixture.stall.actionId }) });
}
