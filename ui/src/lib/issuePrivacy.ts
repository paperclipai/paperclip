import type { CurrentBoardAccess } from "../api/access";
import type { Issue, Project } from "@paperclipai/shared";
import type {
  IssueAccessGrant,
  IssueAccessGrantAgentVisibility,
  IssueAccessGrantSource,
} from "@paperclipai/shared";

/**
 * Client mirror of the server's `issueGrantAgentVisibility`
 * (server/src/routes/issues.ts) — reads an agent's visibility mode out of its
 * loosely-typed `permissions.authorizationPolicy.agentVisibility.mode`. Used to
 * preview the shared-agent caution *before* a grant exists (the enriched grant
 * carries `agentVisibility`, but the add flow only has the candidate agent).
 */
export function agentVisibilityFromPermissions(
  permissions: unknown,
): IssueAccessGrantAgentVisibility | null {
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return null;
  const authorizationPolicy = (permissions as Record<string, unknown>).authorizationPolicy;
  if (!authorizationPolicy || typeof authorizationPolicy !== "object" || Array.isArray(authorizationPolicy)) {
    return null;
  }
  const agentVisibility = (authorizationPolicy as Record<string, unknown>).agentVisibility;
  if (!agentVisibility || typeof agentVisibility !== "object" || Array.isArray(agentVisibility)) return null;
  const mode = (agentVisibility as Record<string, unknown>).mode;
  return mode === "private" || mode === "discoverable" ? mode : null;
}

/**
 * Locked decision `trust-agent`: a *shared* agent is any agent not explicitly
 * scoped to `private`. Sharing a private task with one means its memory &
 * workspace may carry residual private context into later runs for other
 * people, so the amber caution fires. Users and private/dedicated agents never
 * trip it.
 */
export function isSharedAgentVisibility(
  agentVisibility: IssueAccessGrantAgentVisibility | null,
): boolean {
  return agentVisibility !== "private";
}

export function grantIsSharedAgent(grant: IssueAccessGrant): boolean {
  return grant.subjectType === "agent" && isSharedAgentVisibility(grant.agentVisibility);
}

/** Only explicit + assignment grants are revocable from the share sheet; project grants are managed on the project. */
export function grantIsRevocable(source: IssueAccessGrantSource): boolean {
  return source === "explicit" || source === "assignment";
}

/** Keep this UI gate aligned with assertCanManageIssuePrivacy on the server. */
export function canManageIssuePrivacy(
  issue: Pick<Issue, "companyId" | "responsibleUserId" | "createdByUserId" | "assigneeUserId"> | undefined,
  userId: string | null,
  access: CurrentBoardAccess | undefined,
): boolean {
  if (!issue || !access) return false;
  if (access.source === "local_implicit" || access.isInstanceAdmin) return true;
  if (userId && [issue.responsibleUserId, issue.createdByUserId, issue.assigneeUserId].includes(userId)) return true;
  return access.memberships?.some(member => member.companyId === issue.companyId
    && member.status === "active" && ["owner", "admin"].includes(member.membershipRole ?? "")) ?? false;
}

export function canManageProjectPrivacy(project: Pick<Project, "companyId" | "privacyOwnerUserId" | "personalOwnerUserId">, userId: string | null, access: CurrentBoardAccess | undefined): boolean {
  return canManageIssuePrivacy({ companyId: project.companyId, responsibleUserId: project.privacyOwnerUserId ?? null,
    createdByUserId: project.personalOwnerUserId ?? null, assigneeUserId: null }, userId, access);
}
