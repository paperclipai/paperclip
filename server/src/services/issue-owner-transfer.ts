import { and, eq } from "drizzle-orm";
import { companyMemberships, instanceUserRoles, issues, type Db } from "@paperclipai/db";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";

type OwnerActor = Express.Request["actor"];
type OwnedIssue = { companyId: string; responsibleUserId: string | null; createdByUserId: string | null };

export async function canTransferIssueOwner(db: Db, actor: OwnerActor, issue: OwnedIssue) {
  // An agent's on-behalf-of identity is never authority to transfer ownership.
  if (actor.type !== "board" || !actor.userId || actor.source === "mcp_oauth") return false;
  if (actor.source === "local_implicit" || actor.isInstanceAdmin) return true;
  const [membership] = await db.select().from(companyMemberships).where(and(
    eq(companyMemberships.companyId, issue.companyId),
    eq(companyMemberships.principalType, "user"),
    eq(companyMemberships.principalId, actor.userId),
    eq(companyMemberships.status, "active"),
  )).limit(1);
  if (membership && (membership.membershipRole === "owner" || membership.membershipRole === "admin"
    || actor.userId === (issue.responsibleUserId ?? issue.createdByUserId))) return true;
  if (actor.source === "cloud_tenant") return false;
  const [admin] = await db.select().from(instanceUserRoles).where(and(
    eq(instanceUserRoles.userId, actor.userId), eq(instanceUserRoles.role, "instance_admin"),
  )).limit(1);
  return Boolean(admin);
}

export async function transferIssueOwner(db: Db, actor: OwnerActor, issueId: string, input: {
  responsibleUserId: string;
  expectedResponsibleUserId: string | null;
}) {
  return db.transaction(async (tx) => {
    const [issue] = await tx.select().from(issues).where(eq(issues.id, issueId)).for("update");
    if (!issue) throw notFound("Task not found");
    if (!(await canTransferIssueOwner(tx as unknown as Db, actor, issue))) {
      throw forbidden("Only the responsible owner or an administrator can transfer task ownership");
    }
    if (issue.responsibleUserId !== input.expectedResponsibleUserId) {
      throw conflict("The responsible owner changed. Refresh the task and try again.");
    }
    if (issue.executionRunId || issue.checkoutRunId) {
      throw conflict("Stop the active run before you transfer task ownership.");
    }
    const [target] = await tx.select().from(companyMemberships).where(and(
      eq(companyMemberships.companyId, issue.companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, input.responsibleUserId),
      eq(companyMemberships.status, "active"),
    )).limit(1);
    if (!target) throw unprocessable("Choose an active user in this company");
    if (issue.responsibleUserId === input.responsibleUserId) return issue;
    const [updated] = await tx.update(issues).set({
      responsibleUserId: input.responsibleUserId, updatedAt: new Date(),
    }).where(eq(issues.id, issue.id)).returning();
    await logActivity(tx as unknown as Db, {
      companyId: issue.companyId, actorType: "user", actorId: actor.userId!,
      action: "issue.updated", entityType: "issue", entityId: issue.id,
      details: { responsibleUserId: input.responsibleUserId, previousResponsibleUserId: issue.responsibleUserId },
    });
    return updated!;
  });
}
