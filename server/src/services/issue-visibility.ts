import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  authUsers,
  companyMemberships,
  issueCollaborators,
  principalPermissionGrants,
} from "@paperclipai/db";
import { extractAgentMentionIds, extractUserMentionIds } from "@paperclipai/shared";

export type VisibilityPrincipal =
  | { kind: "user"; userId: string; isInstanceAdmin?: boolean }
  | { kind: "agent"; agentId: string }
  | { kind: "system" };

export type CollaboratorReason = "creator" | "explicit" | "assignment" | "mention";

type IssueVisibilitySource = {
  id: string;
  companyId: string;
  visibility: string;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  assigneeUserId: string | null;
  assigneeAgentId: string | null;
};

export interface VisibilityContext {
  ownerCompanies: ReadonlySet<string>;
  grantedCompanies: ReadonlySet<string>;
  collabIssues: ReadonlySet<string>;
}

/** Pure decision: given already-resolved context sets, decide if the principal can see a private issue.
 *  Callers should short-circuit before calling this: non-private issues, system principals, and instance admins
 *  already have access. */
export function decidePrivateIssueAccess(
  principal: VisibilityPrincipal,
  issue: IssueVisibilitySource,
  ctx: VisibilityContext,
): boolean {
  if (principal.kind === "system") return true;
  if (issue.visibility !== "private") return true;
  if (principal.kind === "user" && principal.isInstanceAdmin) return true;
  if (principal.kind === "user") {
    if (issue.createdByUserId === principal.userId) return true;
    if (issue.assigneeUserId === principal.userId) return true;
  } else {
    if (issue.createdByAgentId === principal.agentId) return true;
    if (issue.assigneeAgentId === principal.agentId) return true;
  }
  if (ctx.ownerCompanies.has(issue.companyId)) return true;
  if (ctx.grantedCompanies.has(issue.companyId)) return true;
  return ctx.collabIssues.has(issue.id);
}

export function issueVisibilityService(db: Db) {
  async function getMembershipRole(
    companyId: string,
    principalType: "user" | "agent",
    principalId: string,
  ): Promise<string | null> {
    const row = await db
      .select({ role: companyMemberships.membershipRole, status: companyMemberships.status })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, principalType),
          eq(companyMemberships.principalId, principalId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!row || row.status !== "active") return null;
    return row.role ?? null;
  }

  async function hasSeePrivateGrant(
    companyId: string,
    principalType: "user" | "agent",
    principalId: string,
  ): Promise<boolean> {
    const grant = await db
      .select({ id: principalPermissionGrants.id })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
          eq(principalPermissionGrants.permissionKey, "issues:see_private"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return Boolean(grant);
  }

  async function isCollaborator(
    issueId: string,
    principalType: "user" | "agent",
    principalId: string,
  ): Promise<boolean> {
    const row = await db
      .select({ id: issueCollaborators.id })
      .from(issueCollaborators)
      .where(
        and(
          eq(issueCollaborators.issueId, issueId),
          eq(issueCollaborators.principalType, principalType),
          eq(issueCollaborators.principalId, principalId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  async function canSeeIssue(principal: VisibilityPrincipal, issue: IssueVisibilitySource): Promise<boolean> {
    if (principal.kind === "system") return true;
    if (issue.visibility !== "private") return true;

    if (principal.kind === "user") {
      if (principal.isInstanceAdmin) return true;
      if (issue.createdByUserId === principal.userId) return true;
      if (issue.assigneeUserId === principal.userId) return true;
      const role = await getMembershipRole(issue.companyId, "user", principal.userId);
      if (role === "owner") return true;
      if (await hasSeePrivateGrant(issue.companyId, "user", principal.userId)) return true;
      return isCollaborator(issue.id, "user", principal.userId);
    }

    if (principal.kind === "agent") {
      if (issue.createdByAgentId === principal.agentId) return true;
      if (issue.assigneeAgentId === principal.agentId) return true;
      if (await hasSeePrivateGrant(issue.companyId, "agent", principal.agentId)) return true;
      return isCollaborator(issue.id, "agent", principal.agentId);
    }

    return false;
  }

  async function filterVisibleIssues<T extends IssueVisibilitySource>(
    principal: VisibilityPrincipal,
    rows: T[],
  ): Promise<T[]> {
    if (principal.kind === "system") return rows;
    if (rows.length === 0) return rows;
    const privateRows = rows.filter((r) => r.visibility === "private");
    if (privateRows.length === 0) return rows;

    if (principal.kind === "user" && principal.isInstanceAdmin) return rows;

    const companyIds = Array.from(new Set(privateRows.map((r) => r.companyId)));
    const privateIssueIds = privateRows.map((r) => r.id);

    const principalType: "user" | "agent" = principal.kind === "user" ? "user" : "agent";
    const principalId = principal.kind === "user" ? principal.userId : principal.agentId;

    const [memberships, grants, collabs] = await Promise.all([
      principal.kind === "user"
        ? db
            .select({ companyId: companyMemberships.companyId, role: companyMemberships.membershipRole })
            .from(companyMemberships)
            .where(
              and(
                inArray(companyMemberships.companyId, companyIds),
                eq(companyMemberships.principalType, principalType),
                eq(companyMemberships.principalId, principalId),
                eq(companyMemberships.status, "active"),
              ),
            )
        : Promise.resolve([] as { companyId: string; role: string | null }[]),
      db
        .select({ companyId: principalPermissionGrants.companyId })
        .from(principalPermissionGrants)
        .where(
          and(
            inArray(principalPermissionGrants.companyId, companyIds),
            eq(principalPermissionGrants.principalType, principalType),
            eq(principalPermissionGrants.principalId, principalId),
            eq(principalPermissionGrants.permissionKey, "issues:see_private"),
          ),
        ),
      db
        .select({ issueId: issueCollaborators.issueId })
        .from(issueCollaborators)
        .where(
          and(
            inArray(issueCollaborators.issueId, privateIssueIds),
            eq(issueCollaborators.principalType, principalType),
            eq(issueCollaborators.principalId, principalId),
          ),
        ),
    ]);

    const ctx: VisibilityContext = {
      ownerCompanies: new Set(memberships.filter((m) => m.role === "owner").map((m) => m.companyId)),
      grantedCompanies: new Set(grants.map((g) => g.companyId)),
      collabIssues: new Set(collabs.map((c) => c.issueId)),
    };
    return rows.filter((row) => decidePrivateIssueAccess(principal, row, ctx));
  }

  async function ensureCollaborator(params: {
    companyId: string;
    issueId: string;
    principalType: "user" | "agent";
    principalId: string;
    reason: CollaboratorReason;
    addedByUserId?: string | null;
    addedByAgentId?: string | null;
  }): Promise<void> {
    await db
      .insert(issueCollaborators)
      .values({
        companyId: params.companyId,
        issueId: params.issueId,
        principalType: params.principalType,
        principalId: params.principalId,
        reason: params.reason,
        addedByUserId: params.addedByUserId ?? null,
        addedByAgentId: params.addedByAgentId ?? null,
      })
      .onConflictDoNothing({
        target: [
          issueCollaborators.issueId,
          issueCollaborators.principalType,
          issueCollaborators.principalId,
        ],
      });
  }

  async function listCollaborators(issueId: string) {
    return db
      .select({
        id: issueCollaborators.id,
        issueId: issueCollaborators.issueId,
        principalType: issueCollaborators.principalType,
        principalId: issueCollaborators.principalId,
        reason: issueCollaborators.reason,
        createdAt: issueCollaborators.createdAt,
        displayName: sql<string | null>`COALESCE(${authUsers.name}, ${agents.name})`,
        email: authUsers.email,
      })
      .from(issueCollaborators)
      .leftJoin(
        authUsers,
        and(eq(issueCollaborators.principalType, "user"), eq(issueCollaborators.principalId, authUsers.id)),
      )
      .leftJoin(
        agents,
        and(
          eq(issueCollaborators.principalType, "agent"),
          eq(issueCollaborators.principalId, sql`${agents.id}::text`),
        ),
      )
      .where(eq(issueCollaborators.issueId, issueId))
      .orderBy(issueCollaborators.createdAt);
  }

  async function removeCollaborator(params: {
    issueId: string;
    principalType: "user" | "agent";
    principalId: string;
  }) {
    await db
      .delete(issueCollaborators)
      .where(
        and(
          eq(issueCollaborators.issueId, params.issueId),
          eq(issueCollaborators.principalType, params.principalType),
          eq(issueCollaborators.principalId, params.principalId),
        ),
      );
  }

  async function resolveMentionsToCollaborators(params: {
    companyId: string;
    issueId: string;
    body: string;
    addedByUserId?: string | null;
    addedByAgentId?: string | null;
  }) {
    const agentIds = extractAgentMentionIds(params.body);
    const userIds = extractUserMentionIds(params.body);
    if (agentIds.length === 0 && userIds.length === 0) return;

    if (agentIds.length > 0) {
      const verified = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, params.companyId), inArray(agents.id, agentIds)));
      for (const agent of verified) {
        await ensureCollaborator({
          companyId: params.companyId,
          issueId: params.issueId,
          principalType: "agent",
          principalId: agent.id,
          reason: "mention",
          addedByUserId: params.addedByUserId ?? null,
          addedByAgentId: params.addedByAgentId ?? null,
        });
      }
    }

    if (userIds.length > 0) {
      const verified = await db
        .select({ id: companyMemberships.principalId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, params.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.status, "active"),
            inArray(companyMemberships.principalId, userIds),
          ),
        );
      for (const row of verified) {
        await ensureCollaborator({
          companyId: params.companyId,
          issueId: params.issueId,
          principalType: "user",
          principalId: row.id,
          reason: "mention",
          addedByUserId: params.addedByUserId ?? null,
          addedByAgentId: params.addedByAgentId ?? null,
        });
      }
    }
  }

  return {
    canSeeIssue,
    filterVisibleIssues,
    ensureCollaborator,
    listCollaborators,
    removeCollaborator,
    resolveMentionsToCollaborators,
  };
}
