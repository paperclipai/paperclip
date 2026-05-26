import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";

export type PeerTrustTargetIssue = {
  id: string;
  companyId: string;
  goalId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
};

// Shared trust-boundary check for peer cross-agent actions
// (nudge, request_unstick, etc.) per EDE-31 §5.1. An actor is authorized when
// any of the following hold:
//   - the actor is the target assignee
//   - the actor is assigned to any sibling issue under the same goalId
//   - the actor is the assignee of any ancestor issue (parent chain)
//   - the actor is in the chain of command above the target assignee
export async function canActOnTargetIssue(
  actorAgentId: string,
  targetIssue: PeerTrustTargetIssue,
  db: Db,
): Promise<boolean> {
  if (targetIssue.assigneeAgentId === actorAgentId) return true;

  if (targetIssue.goalId) {
    const actorIssueInGoal = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, targetIssue.companyId),
          eq(issues.goalId, targetIssue.goalId),
          eq(issues.assigneeAgentId, actorAgentId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (actorIssueInGoal) return true;
  }

  let ancestorId: string | null = targetIssue.parentId;
  const visited = new Set<string>();
  while (ancestorId && !visited.has(ancestorId)) {
    visited.add(ancestorId);
    const ancestor = await db
      .select({
        id: issues.id,
        assigneeAgentId: issues.assigneeAgentId,
        parentId: issues.parentId,
      })
      .from(issues)
      .where(eq(issues.id, ancestorId))
      .then((rows) => rows[0] ?? null);
    if (!ancestor) break;
    if (ancestor.assigneeAgentId === actorAgentId) return true;
    ancestorId = ancestor.parentId;
  }

  if (targetIssue.assigneeAgentId) {
    const assigneeRow = await db
      .select({ reportsTo: agents.reportsTo })
      .from(agents)
      .where(eq(agents.id, targetIssue.assigneeAgentId))
      .then((rows) => rows[0] ?? null);
    let managerId: string | null = assigneeRow?.reportsTo ?? null;
    const chainVisited = new Set<string>();
    while (managerId && !chainVisited.has(managerId)) {
      chainVisited.add(managerId);
      if (managerId === actorAgentId) return true;
      const mgr = await db
        .select({ reportsTo: agents.reportsTo })
        .from(agents)
        .where(eq(agents.id, managerId))
        .then((rows) => rows[0] ?? null);
      managerId = mgr?.reportsTo ?? null;
    }
  }

  return false;
}
