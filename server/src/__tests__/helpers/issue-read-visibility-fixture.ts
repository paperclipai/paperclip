import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agents, authUsers, companies, companyMemberships, heartbeatRuns, issueAccessGrants, issueRelations, issues,
  projectAccessMembers, projects, type Db,
} from "@paperclipai/db";
import type { AuthorizationActor } from "../../services/authorization.js";

/** Every actor type and membership role that can reach a task read. */
export const ISSUE_READ_VISIBILITY_ACTORS = [
  "board owner", "board admin", "board operator", "board viewer", "board member", "board key operator",
  "cloud tenant owner", "cloud tenant viewer", "instance admin", "local implicit board", "board without membership",
  "agent key", "assignee agent key", "agent run for owner", "agent run for operator", "agent run for viewer",
  "agent run for owner, membership read from the database", "agent run for a user without membership",
  "agent authorized by operator", "agent authorized by owner for owner",
  "low-trust agent bounded to tasks", "low-trust agent bounded to a subtree",
  "agent of another company", "unauthenticated",
] as const;
export type IssueReadVisibilityActorName = (typeof ISSUE_READ_VISIBILITY_ACTORS)[number];

export type IssueReadVisibilityFixture = Awaited<ReturnType<typeof seedIssueReadVisibilityFixture>>;

/**
 * One company whose tasks cover every way a task read is allowed or denied:
 * open tasks, private tasks readable through creation, assignment, a grant or
 * a private ancestor, private tasks nobody in the fixture may read, tasks of a
 * private project, a hidden task, tasks of another company and missing IDs.
 * `publicCount` sizes the open group; the other groups are fixed.
 */
export async function seedIssueReadVisibilityFixture(db: Db, input: { publicCount?: number } = {}) {
  const companyId = randomUUID(), foreignCompanyId = randomUUID();
  const tag = companyId.replaceAll("-", "").slice(0, 6).toUpperCase();
  const foreignTag = foreignCompanyId.replaceAll("-", "").slice(0, 6).toUpperCase();
  await db.insert(companies).values([
    { id: companyId, name: `Visibility ${companyId}`, issuePrefix: `V${tag}`, requireBoardApprovalForNewAgents: false },
    { id: foreignCompanyId, name: `Foreign ${foreignCompanyId}`, issuePrefix: `F${foreignTag}`, requireBoardApprovalForNewAgents: false },
  ]);

  const roles = ["owner", "admin", "operator", "viewer", "member"] as const;
  const users = Object.fromEntries(roles.map((role) => [role, `user-${role}-${randomUUID()}`])) as Record<(typeof roles)[number], string>;
  const outsiderUserId = `user-outsider-${randomUUID()}`, strangerUserId = `user-stranger-${randomUUID()}`;
  const now = new Date();
  await db.insert(authUsers).values([...Object.values(users), outsiderUserId, strangerUserId].map((id) => ({
    id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
  })));
  await db.insert(companyMemberships).values([
    ...roles.map((role) => ({ companyId, principalType: "user", principalId: users[role], status: "active", membershipRole: role })),
    { companyId, principalType: "user", principalId: strangerUserId, status: "active", membershipRole: "operator" },
    { companyId: foreignCompanyId, principalType: "user", principalId: outsiderUserId, status: "active", membershipRole: "owner" },
  ]);

  const readerAgentId = randomUUID(), assigneeAgentId = randomUUID(), lowTrustAgentId = randomUUID();
  const lowTrustRootAgentId = randomUUID(), foreignAgentId = randomUUID();
  await db.insert(agents).values([
    { id: readerAgentId, companyId, name: "Reader", role: "engineer", adapterType: "process" },
    { id: assigneeAgentId, companyId, name: "Assignee", role: "engineer", adapterType: "process" },
    { id: lowTrustAgentId, companyId, name: "Low trust", role: "engineer", adapterType: "process" },
    { id: lowTrustRootAgentId, companyId, name: "Low trust root", role: "engineer", adapterType: "process" },
    { id: foreignAgentId, companyId: foreignCompanyId, name: "Foreign", role: "engineer", adapterType: "process" },
  ]);

  const openProjectId = randomUUID(), privateProjectId = randomUUID();
  await db.insert(projects).values([
    { id: openProjectId, companyId, name: "Open project" },
    { id: privateProjectId, companyId, name: "Private project", visibility: "private" },
  ]);
  await db.insert(projectAccessMembers).values({ companyId, projectId: privateProjectId, subjectType: "user", subjectId: users.admin });

  const publicCount = input.publicCount ?? 6;
  const publicIds = Array.from({ length: publicCount }, () => randomUUID());
  const boundaryRootId = publicIds[0]!, boundaryChildId = publicIds[1]!;
  await db.insert(issues).values(publicIds.map((id, index) => ({
    id, companyId, title: `Open ${index}`, status: "todo",
    projectId: index % 3 === 2 ? openProjectId : null,
    parentId: index === 1 ? boundaryRootId : null,
    assigneeAgentId: index % 4 === 3 ? assigneeAgentId : null,
    createdByUserId: strangerUserId,
  })));

  /** A private root and two generations below it. Descendants inherit privacy and are readable only through an ancestor. */
  async function privateTree(title: string, root: Partial<typeof issues.$inferInsert>) {
    const rootId = randomUUID(), childId = randomUUID(), grandchildId = randomUUID();
    await db.insert(issues).values({
      id: rootId, companyId, title: `${title} root`, status: "todo", visibility: "private", privacyRootIssueId: rootId,
      createdByUserId: strangerUserId, responsibleUserId: strangerUserId, ...root,
    });
    await db.insert(issues).values({
      id: childId, companyId, title: `${title} child`, status: "todo", parentId: rootId, visibility: "private",
      privacyRootIssueId: rootId, privacyParentIssueId: rootId, createdByUserId: strangerUserId,
    });
    await db.insert(issues).values({
      id: grandchildId, companyId, title: `${title} grandchild`, status: "todo", parentId: childId, visibility: "private",
      privacyRootIssueId: rootId, privacyParentIssueId: childId, createdByUserId: strangerUserId,
    });
    return [rootId, childId, grandchildId];
  }
  const ownedPrivateIds = await privateTree("Owner private", { createdByUserId: users.owner, responsibleUserId: users.owner });
  const grantedPrivateIds = await privateTree("Granted private", {});
  await db.insert(issueAccessGrants).values([
    { issueId: grantedPrivateIds[0]!, subjectType: "user", subjectId: users.operator, source: "explicit" },
    { issueId: grantedPrivateIds[0]!, subjectType: "agent", subjectId: readerAgentId, source: "explicit" },
    // A revoked grant must stay ineffective on both paths.
    { issueId: grantedPrivateIds[0]!, subjectType: "user", subjectId: users.viewer, source: "explicit", revokedAt: now },
  ]);
  const assignedPrivateIds = await privateTree("Assigned private", { assigneeAgentId });
  const unreadablePrivateIds = await privateTree("Stranger private", {});

  const privateProjectIssueIds = [randomUUID(), randomUUID()];
  await db.insert(issues).values(privateProjectIssueIds.map((id, index) => ({
    id, companyId, title: `Private project ${index}`, status: "todo", projectId: privateProjectId, createdByUserId: strangerUserId,
  })));

  const hiddenId = randomUUID();
  await db.insert(issues).values({ id: hiddenId, companyId, title: "Hidden", status: "todo", hiddenAt: now });

  // Blocked open tasks, so the summaries route also filters their blockers.
  const blockedIds = [randomUUID(), randomUUID()];
  await db.insert(issues).values(blockedIds.map((id, index) => ({ id, companyId, title: `Blocked ${index}`, status: "blocked" })));
  await db.insert(issueRelations).values([
    { companyId, issueId: publicIds[2 % publicCount]!, relatedIssueId: blockedIds[0]!, type: "blocks" as const },
    { companyId, issueId: unreadablePrivateIds[0]!, relatedIssueId: blockedIds[0]!, type: "blocks" as const },
    { companyId, issueId: ownedPrivateIds[1]!, relatedIssueId: blockedIds[1]!, type: "blocks" as const },
  ]);

  const foreignPrivateId = randomUUID();
  const foreignIds = [randomUUID(), foreignPrivateId];
  await db.insert(issues).values([
    { id: foreignIds[0]!, companyId: foreignCompanyId, title: "Foreign open", status: "todo" },
    { id: foreignPrivateId, companyId: foreignCompanyId, title: "Foreign private", status: "todo", visibility: "private",
      privacyRootIssueId: foreignPrivateId, createdByUserId: outsiderUserId },
  ]);
  const missingIds = [randomUUID(), randomUUID()];

  // Open tasks the task-bounded low-trust agent may read; the private one in its boundary stays unreadable.
  const boundedTaskIds = [2, 5, 7].map((index) => publicIds[index % publicCount]!);
  await db.update(agents).set({ permissions: { trustPreset: "low_trust_review",
    authorizationPolicy: { trustBoundary: { mode: "low_trust_review", companyId, issueIds: [...boundedTaskIds, grantedPrivateIds[1]!] } } },
  }).where(eq(agents.id, lowTrustAgentId));
  await db.update(agents).set({ permissions: { trustPreset: "low_trust_review",
    authorizationPolicy: { trustBoundary: { mode: "low_trust_review", companyId, rootIssueId: boundaryRootId } } },
  }).where(eq(agents.id, lowTrustRootAgentId));

  const runId = randomUUID();
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: readerAgentId, status: "running", contextSnapshot: { issueId: publicIds[0]! } });

  const board = (role: (typeof roles)[number], source: AuthorizationActor["source"] = "session"): AuthorizationActor => ({
    type: "board", source, userId: users[role], companyIds: [companyId],
    memberships: [{ companyId, membershipRole: role, status: "active" }], isInstanceAdmin: false,
  });
  const agent = (agentId: string, extra: Partial<AuthorizationActor> = {}): AuthorizationActor => ({
    type: "agent", agentId, companyId, source: "agent_key", ...extra,
  });
  const actors: Record<IssueReadVisibilityActorName, AuthorizationActor> = {
    "board owner": board("owner"),
    "board admin": board("admin"),
    "board operator": board("operator"),
    "board viewer": board("viewer"),
    "board member": board("member"),
    "board key operator": board("operator", "board_key"),
    "cloud tenant owner": board("owner", "cloud_tenant"),
    "cloud tenant viewer": board("viewer", "cloud_tenant"),
    "instance admin": { ...board("admin"), isInstanceAdmin: true },
    "local implicit board": { type: "board", source: "local_implicit", userId: "local-board", companyIds: [companyId], isInstanceAdmin: true },
    "board without membership": { type: "board", source: "session", userId: outsiderUserId, companyIds: [foreignCompanyId],
      memberships: [{ companyId: foreignCompanyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false },
    "agent key": agent(readerAgentId),
    "assignee agent key": agent(assigneeAgentId),
    "agent run for owner": agent(readerAgentId, { source: "agent_jwt", runId, onBehalfOfUserId: users.owner,
      onBehalfOfMemberships: [{ companyId, membershipRole: "owner", status: "active" }] }),
    "agent run for operator": agent(readerAgentId, { source: "agent_jwt", runId, onBehalfOfUserId: users.operator,
      onBehalfOfMemberships: [{ companyId, membershipRole: "operator", status: "active" }] }),
    "agent run for viewer": agent(readerAgentId, { source: "agent_jwt", runId, onBehalfOfUserId: users.viewer,
      onBehalfOfMemberships: [{ companyId, membershipRole: "viewer", status: "active" }] }),
    "agent run for owner, membership read from the database": agent(assigneeAgentId, { source: "agent_jwt", onBehalfOfUserId: users.owner }),
    "agent run for a user without membership": agent(readerAgentId, { source: "agent_jwt", runId, onBehalfOfUserId: outsiderUserId }),
    "agent authorized by operator": agent(readerAgentId, { authorizingUserId: users.operator }),
    "agent authorized by owner for owner": agent(assigneeAgentId, { onBehalfOfUserId: users.owner, authorizingUserId: users.owner,
      onBehalfOfMemberships: [{ companyId, membershipRole: "owner", status: "active" }] }),
    "low-trust agent bounded to tasks": agent(lowTrustAgentId),
    "low-trust agent bounded to a subtree": agent(lowTrustRootAgentId),
    "agent of another company": { type: "agent", agentId: foreignAgentId, companyId: foreignCompanyId, source: "agent_key" },
    "unauthenticated": { type: "none", source: "none" },
  };

  const companyIssueIds = [
    ...publicIds, ...ownedPrivateIds, ...grantedPrivateIds, ...assignedPrivateIds, ...unreadablePrivateIds,
    ...privateProjectIssueIds, ...blockedIds, hiddenId,
  ];
  return {
    companyId, foreignCompanyId, users, outsiderUserId, strangerUserId,
    readerAgentId, assigneeAgentId, lowTrustAgentId, lowTrustRootAgentId, foreignAgentId, runId,
    openProjectId, privateProjectId,
    publicIds, boundaryRootId, boundaryChildId, boundedTaskIds, ownedPrivateIds, grantedPrivateIds, assignedPrivateIds, unreadablePrivateIds,
    privateProjectIssueIds, blockedIds, hiddenId, foreignIds, missingIds, companyIssueIds,
    /** Every ID a caller might ask for, readable or not. */
    allIds: [...companyIssueIds, ...foreignIds, ...missingIds],
    actors,
  };
}
