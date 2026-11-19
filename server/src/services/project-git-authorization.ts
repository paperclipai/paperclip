import { and, eq, isNull, sql } from "drizzle-orm";
import {
  companyMemberships,
  companySecrets,
  connectionGrants,
  heartbeatRuns,
  issues,
  projects,
  projectWorkspaces,
  toolConnections,
  toolConnectionInstalls,
  type Db,
} from "@paperclipai/db";
import type { ProjectGitAuthorization } from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { resolveManagedGitHubCredential } from "./git-credentials.js";
import { resolveGitHubOperationCredentials } from "./github-operation-credentials.js";
import { normalizeProjectRepositoryUrl, projectRepositoryIsPrivate } from "./project-repositories.js";
import { recordProjectLifecycleEvent } from "./resource-lifecycle-events.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { secretService } from "./secrets.js";
import { assertTaskWorkspaceExecutionAccess, assertTaskWorkspaceSourceProjectAccess } from "./task-workspace-access.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";
import { isCloudManagedInstance } from "./cloud-instance.js";
import { isCurrentCloudOwnerInstanceAdmin, loadCurrentCloudOwnerAuthority } from "./cloud-tenant-authority.js";
import { ghFetch } from "./github-fetch.js";

function isGitHubPat(connection: typeof toolConnections.$inferSelect): boolean {
  return connection.authKind === "api_key" && connection.config?.connectionMethodKey === "mcp-key";
}

function transientGitToken(token: string | undefined): string {
  if (!token || token.length > 4096 || /[\0\r\n]/.test(token) || token.startsWith("secret://")) {
    throw forbidden("GitHub credential unavailable");
  }
  return token;
}

/** Consent is for this exact personal grant, independent of tasks and agent delegation. */
export function projectGitAuthorizationService(db: Db) {
  async function project(companyId: string, projectId: string, allowArchived = false) {
    const [row] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)));
    if (!row || (!allowArchived && row.archivedAt)) throw notFound("Active project not found");
    return row;
  }
  async function eligible(companyId: string, userId: string) {
    const [member] = await db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      );
    if (!member || member.membershipRole === "viewer") return [];
    const rows = await db
      .select({ grant: connectionGrants, connection: toolConnections })
      .from(connectionGrants)
      .innerJoin(
        toolConnections,
        and(eq(toolConnections.id, connectionGrants.connectionId), eq(toolConnections.companyId, companyId)),
      )
      .innerJoin(
        toolConnectionInstalls,
        and(
          eq(toolConnectionInstalls.connectionId, toolConnections.id),
          eq(toolConnectionInstalls.companyId, companyId),
          eq(toolConnectionInstalls.targetType, "company"),
          eq(toolConnectionInstalls.targetId, companyId),
        ),
      )
      .where(
        and(
          eq(connectionGrants.companyId, companyId),
          eq(connectionGrants.kind, "user"),
          eq(connectionGrants.subjectUserId, userId),
          eq(connectionGrants.status, "active"),
          eq(toolConnections.enabled, true),
          eq(toolConnections.status, "active"),
        ),
      );
    return rows.filter(
      ({ grant, connection }) =>
        (connection.config?.sourceTemplateKey === "github" ||
          connection.transportConfig?.sourceTemplateKey === "github") &&
        (isGitHubPat(connection)
          ? grant.credentialSecretRefs.some((ref) => ref.configPath === "credentials.authorization")
          : Boolean(grant.providerTenant?.github?.repositoryCount && grant.providerTenant.github.installationCount > 0)),
    );
  }
  async function read(companyId: string, projectId: string, userId: string): Promise<ProjectGitAuthorization> {
    const row = await project(companyId, projectId, true);
    return {
      grantId: row.gitAuthorizationGrantId,
      authorizedByUserId: row.gitAuthorizedByUserId,
      options: (await eligible(companyId, userId)).map(({ grant, connection }) => ({
        grantId: grant.id,
        connectionName: connection.name,
        login: grant.providerTenant?.github?.login ?? "Personal access token",
      })),
    };
  }
  return {
    read,
    async set(companyId: string, projectId: string, userId: string, grantId: string | null) {
      const publication = await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(projects)
          .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)))
          .for("update");
        if (!row || (row.archivedAt && grantId)) throw notFound("Active project not found");
        if (grantId && !(await eligible(companyId, userId)).some(({ grant }) => grant.id === grantId)) {
          throw forbidden("Select your own active company-installed GitHub authorization");
        }
        await tx
          .update(projects)
          .set({
            gitAuthorizationGrantId: grantId,
            gitAuthorizedByUserId: grantId ? userId : null,
            updatedAt: new Date(),
          })
          .where(eq(projects.id, row.id));
        await recordProjectLifecycleEvent(tx as unknown as Db, companyId, projectId);
        const { publication } = await persistActivity(tx as unknown as Db, {
          companyId,
          actorType: "user",
          actorId: userId,
          action: grantId ? "project.git_authorized" : "project.git_authorization_revoked",
          entityType: "project",
          entityId: projectId,
          details: { grantId },
        });
        return publication;
      });
      publishActivity(publication);
      return read(companyId, projectId, userId);
    },
    async resolve(
      input: { companyId: string; projectId: string; workspaceId: string; expectedRepository?: string; expectedRepositoryId?: string; requireConnected?: boolean },
      scope?: {
        projectId: string;
        workspaceId?: string;
        runId?: string;
        agentId?: string;
        operation?: "prepare" | "inspect" | "remove";
      },
    ) {
      if (
        !scope ||
        scope.projectId !== input.projectId ||
        (scope.workspaceId && scope.workspaceId !== input.workspaceId)
      )
        throw forbidden("Git credentials require a matching host project operation");
      const cleanup = scope.workspaceId === input.workspaceId && !scope.runId && !scope.agentId &&
        (scope.operation === "inspect" || scope.operation === "remove");
      const row = await project(input.companyId, input.projectId, cleanup);
      const [workspace] = await db
        .select()
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.companyId, input.companyId),
            eq(projectWorkspaces.projectId, input.projectId),
            eq(projectWorkspaces.id, input.workspaceId),
          ),
        );
      if (!workspace?.repoUrl) throw forbidden("Git credentials require a configured project repository");
      const repo = normalizeProjectRepositoryUrl(workspace.repoUrl);
      if (input.expectedRepository && repo.fullName.toLowerCase() !== input.expectedRepository.toLowerCase())
        throw forbidden("Project repository changed before GitHub authorization");
      let isPrivate: boolean;
      try {
        isPrivate = await projectRepositoryIsPrivate(db, input.companyId, workspace);
      } catch (error) {
        // A private PAT-only repository may not have a catalog visibility snapshot.
        // Continue only with explicit background consent; GitHub verifies it below.
        if (scope.runId || scope.agentId || !row.gitAuthorizationGrantId ||
          !(error instanceof Error) || !error.message.startsWith("Repository visibility is unavailable")) throw error;
        const fallback = row.gitAuthorizedByUserId && (await eligible(input.companyId, row.gitAuthorizedByUserId))
          .find(({ grant }) => grant.id === row.gitAuthorizationGrantId);
        if (!fallback || !isGitHubPat(fallback.connection)) throw error;
        isPrivate = true;
      }
      if (scope.runId || scope.agentId) {
        if (!scope.runId || !scope.agentId) throw forbidden("Incomplete foreground Git identity");
        const [run] = await db
          .select({
            status: heartbeatRuns.status,
            issueId: heartbeatRuns.issueId,
            contextIssueId: sql<string | null>`${heartbeatRuns.contextSnapshot}->>'issueId'`,
            taskId: sql<string | null>`${heartbeatRuns.contextSnapshot}->>'taskId'`,
            responsibleUserId: heartbeatRuns.responsibleUserId,
            nativeIssueId: heartbeatRuns.nativeIssueId,
          })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.id, scope.runId),
              eq(heartbeatRuns.companyId, input.companyId),
              eq(heartbeatRuns.agentId, scope.agentId),
            ),
          );
        const issueId = run?.issueId ?? run?.nativeIssueId ?? run?.contextIssueId ?? run?.taskId;
        const [issue] =
          typeof issueId === "string"
            ? await db
                .select({ executionWorkspaceId: issues.executionWorkspaceId })
                .from(issues)
                .where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)))
            : [];
        if (!run || run.status !== "running" || !issue || typeof issueId !== "string")
          throw forbidden("Active task run is unavailable");
        await assertTaskWorkspaceExecutionAccess(db, {
          type: "agent", source: "agent_jwt", companyId: input.companyId,
          agentId: scope.agentId, runId: scope.runId,
          onBehalfOfUserId: run.responsibleUserId === "local-board" ? null : run.responsibleUserId,
        }, input.companyId, {
          issueId, workspaceId: issue.executionWorkspaceId, projectWorkspaceId: workspace.id,
        });
        if (!isPrivate && !input.requireConnected) return null;
        const result = await resolveGitHubOperationCredentials(db, {
          companyId: input.companyId,
          runId: scope.runId,
          agentId: scope.agentId,
        });
        if (result.status !== "available") throw forbidden(result.reason ?? "Run GitHub authorization unavailable");
        return transientGitToken(result.env.PAPERCLIP_GIT_TOKEN);
      }
      if (!isPrivate && !input.requireConnected) return null;
      if (!row.gitAuthorizationGrantId)
        throw forbidden("Authorize this project's GitHub connection before provisioning private repositories");
      const selected =
        row.gitAuthorizedByUserId &&
        (await eligible(input.companyId, row.gitAuthorizedByUserId)).find(
          ({ grant }) => grant.id === row.gitAuthorizationGrantId,
        );
      if (!row.gitAuthorizedByUserId || !selected)
        throw forbidden("Project GitHub authorization is unavailable; reconnect or select an authorization");
      const cloud = isCloudManagedInstance();
      const isInstanceAdmin = cloud && await isCurrentCloudOwnerInstanceAdmin(db, row.gitAuthorizedByUserId,
        await loadCurrentCloudOwnerAuthority(row.gitAuthorizedByUserId));
      await assertTaskWorkspaceSourceProjectAccess(db, {
        type: "board", source: cloud ? "cloud_tenant" : "session", userId: row.gitAuthorizedByUserId, isInstanceAdmin,
      }, input.companyId, row.id);
      if (resolveCoreTrustPreset({ companyId: input.companyId, workspaceSourceProject: row }).kind !== "standard")
        throw forbidden("GitHub credentials are not available to low-trust or unverified projects");
      if (isGitHubPat(selected.connection)) {
        const ref = selected.grant.credentialSecretRefs.find((item) => item.configPath === "credentials.authorization");
        const [secret] = ref ? await db.select({ definitionId: companySecrets.userSecretDefinitionId }).from(companySecrets).where(and(
          eq(companySecrets.id, ref.secretId), eq(companySecrets.companyId, input.companyId),
          eq(companySecrets.ownerUserId, row.gitAuthorizedByUserId), eq(companySecrets.scope, "user"),
          eq(companySecrets.status, "active"), isNull(companySecrets.deletedAt),
        )).limit(1) : [];
        if (!ref || !secret?.definitionId) throw forbidden("Project GitHub credential unavailable; reconnect the selected authorization");
        const value = await secretService(db).resolveUserSecretValue(input.companyId, {
          definitionId: secret.definitionId, responsibleUserId: row.gitAuthorizedByUserId,
          version: ref.versionSelector ?? "latest", required: true,
        }, { consumerType: "system", consumerId: "workspace-git-credential", actorType: "system", responsibleUserId: row.gitAuthorizedByUserId });
        const token = transientGitToken(value?.value);
        const response = await ghFetch(`https://api.github.com/repos/${repo.fullName}`, {
          headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
          redirect: "error", signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw forbidden("Project GitHub authorization does not include this repository");
        const repository = await response.json() as { id?: number; full_name?: string; private?: boolean; permissions?: { pull?: boolean } };
        const storedRepositoryId = workspace.metadata?.githubRepositoryId;
        if (repository.full_name?.toLowerCase() !== repo.fullName.toLowerCase() || repository.permissions?.pull !== true ||
          ((storedRepositoryId != null || input.expectedRepositoryId !== undefined) && !Number.isSafeInteger(repository.id)) ||
          (input.expectedRepositoryId !== undefined && String(repository.id) !== input.expectedRepositoryId) ||
          (storedRepositoryId != null && String(repository.id) !== storedRepositoryId))
          throw forbidden("Project GitHub authorization does not include this repository");
        if (repository.private === false && !input.requireConnected) return null;
        if (typeof repository.private !== "boolean") throw forbidden("Repository visibility is unavailable");
        return token;
      }
      // Project consent follows this connection's repository access, including future project sources.
      if (
        !selected.grant.providerTenant?.github?.repositories?.some(
          (r) => r.fullName.toLowerCase() === repo.fullName.toLowerCase() &&
            (input.expectedRepositoryId === undefined || r.id === input.expectedRepositoryId),
        )
      ) {
        throw forbidden("Project GitHub authorization does not include this repository; refresh Connector access");
      }
      const resolved = await resolveManagedGitHubCredential(db, secretService(db), input.companyId, {
        responsibleUserId: row.gitAuthorizedByUserId,
        explicitGrantId: row.gitAuthorizationGrantId,
        allowStandingDelegation: false,
      });
      if (!resolved.credential || resolved.credential.grantId !== row.gitAuthorizationGrantId)
        throw forbidden("Project GitHub credential unavailable; reconnect the selected authorization");
      return transientGitToken(resolved.credential.token);
    },
  };
}
