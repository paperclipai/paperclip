import { githubBotCredentials } from "./chat-github-client.js";
import { toolAccessPolicyService } from "./tool-access-policy.js";
import { agents, toolCatalogEntries } from "@paperclipai/db";
import { syncGitHubBotTools } from "./chat-github-tools.js";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  chatEndpoints,
  chatEndpointResources,
  chatExternalPrincipals,
  chatIdentityLinks,
  chatGitHubConfigurations,
  chatGitHubReviews,
  companyMemberships,
  connectionGrants,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import {
  defaultGitHubReviewPolicy,
  updateGitHubChatConfigurationSchema,
  type GitHubChatConfiguration,
} from "@paperclipai/shared";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { toolAccessService } from "./tool-access.js";
import { logActivity } from "./activity-log.js";
import { githubBotRequest } from "./chat-github-client.js";
import { environmentService } from "./environments.js";
import { instanceSettingsService } from "./instance-settings.js";
import { resolveExecutionWorkspaceEnvironmentId } from "./execution-workspace-policy.js";

export function githubChatManagementService(db: Db, fetchImpl = fetch) {
  async function endpoint(id: string) {
    const [row] = await db
      .select()
      .from(chatEndpoints)
      .where(
        and(eq(chatEndpoints.id, id), eq(chatEndpoints.provider, "github")),
      );
    if (!row || row.status === "archived")
      throw notFound("GitHub bot not found");
    return row;
  }
  async function member(companyId: string, userId: string) {
    const [row] = await db
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
    if (!row || row.membershipRole === "viewer")
      throw forbidden(
        "An active company member with permission to start work is required",
      );
    return row;
  }
  async function configuration(endpointId: string, userId: string) {
    const bot = await endpoint(endpointId);
    const [saved] = await db
      .select()
      .from(chatGitHubConfigurations)
      .where(
        and(
          eq(chatGitHubConfigurations.companyId, bot.companyId),
          eq(chatGitHubConfigurations.endpointId, endpointId),
        ),
      );
    return (
      saved ?? {
        endpointId,
        companyId: bot.companyId,
        revision: 0,
        configuration: {
          version: 1,
          toolsEnabled: false,
          responsibleUserId: userId,
          memberAccess: "all_linked",
          people: [],
          defaults: defaultGitHubReviewPolicy(),
          repositories: {},
        } satisfies GitHubChatConfiguration,
      }
    );
  }
  async function saveConfiguration(
    endpointId: string,
    input: unknown,
    userId: string,
  ) {
    const bot = await endpoint(endpointId);
    await member(bot.companyId, userId);
    const parsed = updateGitHubChatConfigurationSchema.parse(input);
    const config = parsed.configuration;
    await member(bot.companyId, config.responsibleUserId);
    for (const person of config.people) {
      if (person.kind === "guest") {
        await member(bot.companyId, person.sponsorUserId);
        continue;
      }
      await member(bot.companyId, person.userId);
      const [linked] = await db
        .select({ externalId: chatExternalPrincipals.externalId })
        .from(chatIdentityLinks)
        .innerJoin(
          chatExternalPrincipals,
          eq(chatExternalPrincipals.id, chatIdentityLinks.principalId),
        )
        .where(
          and(
            eq(chatIdentityLinks.companyId, bot.companyId),
            eq(chatIdentityLinks.endpointId, endpointId),
            eq(chatIdentityLinks.paperclipUserId, person.userId),
            eq(chatIdentityLinks.status, "linked"),
            eq(chatExternalPrincipals.externalId, person.githubUserId),
          ),
        );
      if (!linked)
        throw badRequest(
          "Each member must connect and confirm their own GitHub account before being added",
        );
    }
    const resources = await db
      .select()
      .from(chatEndpointResources)
      .where(
        and(
          eq(chatEndpointResources.companyId, bot.companyId),
          eq(chatEndpointResources.endpointId, endpointId),
        ),
      );
    const repositoryIds = new Set(
      resources.map((resource) =>
        String(resource.metadata?.providerRepositoryId ?? ""),
      ),
    );
    if (Object.keys(config.repositories).some((id) => !repositoryIds.has(id)))
      throw badRequest(
        "Repository overrides must refer to this App installation",
      );
    await db.transaction(async (tx) => {
      await tx
        .select({ id: chatEndpoints.id })
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, endpointId))
        .for("update");
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`github-config:${endpointId}`}, 0))`,
      );
      const [current] = await tx
        .select()
        .from(chatGitHubConfigurations)
        .where(eq(chatGitHubConfigurations.endpointId, endpointId))
        .for("update");
      if ((current?.revision ?? 0) !== parsed.expectedRevision)
        throw conflict("This configuration changed. Refresh before saving.");
      const values = {
        companyId: bot.companyId,
        endpointId,
        revision: parsed.expectedRevision + 1,
        configuration: config,
        updatedByUserId: userId,
        updatedAt: new Date(),
      };
      await tx
        .insert(chatGitHubConfigurations)
        .values(values)
        .onConflictDoUpdate({
          target: chatGitHubConfigurations.endpointId,
          set: values,
        });
      // The list controls admission; this flag enables the existing restricted
      // guest execution path only when an explicit guest is present.
      await tx
        .update(chatEndpoints)
        .set({
          allowUnlinkedPeople: config.people.some((p) => p.kind === "guest"),
          sponsorUserId: config.responsibleUserId,
          updatedAt: new Date(),
        })
        .where(eq(chatEndpoints.id, endpointId));
      await syncGitHubBotTools(tx, bot, userId, config.toolsEnabled);
      await logActivity(tx as unknown as Db, {
        companyId: bot.companyId,
        actorType: "user",
        actorId: userId,
        action: "chat_github.configuration_updated",
        entityType: "tool_connection",
        entityId: bot.connectionId,
        details: { endpointId, revision: values.revision },
      });
    });
    return configuration(endpointId, userId);
  }
  async function personalConnections(endpointId: string, userId: string) {
    const bot = await endpoint(endpointId);
    await member(bot.companyId, userId);
    const rows = await db
      .select({ connection: toolConnections, grant: connectionGrants })
      .from(connectionGrants)
      .innerJoin(
        toolConnections,
        and(
          eq(toolConnections.id, connectionGrants.connectionId),
          eq(toolConnections.companyId, bot.companyId),
        ),
      )
      .where(
        and(
          eq(connectionGrants.companyId, bot.companyId),
          eq(connectionGrants.kind, "user"),
          eq(connectionGrants.subjectUserId, userId),
        ),
      );
    return rows
      .filter(
        ({ connection }) =>
          connection.config.sourceTemplateKey === "github" ||
          connection.transportConfig?.sourceTemplateKey === "github",
      )
      .map(({ connection, grant }) => ({
        connectionId: connection.id,
        name: connection.name,
        status: grant.status,
        login: grant.providerTenant?.github?.login ?? null,
        enabled: connection.enabled,
      }));
  }
  async function identity(
    endpointId: string,
    connectionId: string,
    userId: string,
    confirmedGithubUserId?: string,
  ) {
    const bot = await endpoint(endpointId);
    await member(bot.companyId, userId);
    if (!bot.providerAccountId)
      throw conflict("Verify the bot App installation first");
    const verified = await toolAccessService(db).verifyPersonalGitHubIdentity(
      bot.companyId,
      connectionId,
      userId,
    );
    if (confirmedGithubUserId === undefined) return verified;
    if (confirmedGithubUserId !== verified.githubUserId)
      throw conflict(
        "The connected GitHub account changed. Check and confirm its identity again.",
      );
    await db.transaction(async (tx) => {
      const [principal] = await tx
        .insert(chatExternalPrincipals)
        .values({
          companyId: bot.companyId,
          provider: "github",
          providerAccountId: bot.providerAccountId!,
          externalId: verified.githubUserId,
          kind: "user",
          handle: verified.login,
          displayName: verified.login,
        })
        .onConflictDoUpdate({
          target: [
            chatExternalPrincipals.companyId,
            chatExternalPrincipals.provider,
            chatExternalPrincipals.providerAccountId,
            chatExternalPrincipals.externalId,
          ],
          set: { handle: verified.login, updatedAt: new Date() },
        })
        .returning();
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${bot.companyId}:${principal!.id}`}, 0))`,
      );
      const [prior] = await tx
        .select()
        .from(chatIdentityLinks)
        .where(
          and(
            eq(chatIdentityLinks.endpointId, endpointId),
            eq(chatIdentityLinks.principalId, principal!.id),
          ),
        )
        .for("update");
      if (prior?.status === "linked" && prior.paperclipUserId !== userId)
        throw conflict(
          "This GitHub account is already linked to another Paperclip member",
        );
      const [grant] = await tx
        .select()
        .from(connectionGrants)
        .where(
          and(
            eq(connectionGrants.companyId, bot.companyId),
            eq(connectionGrants.id, verified.grantId),
            eq(connectionGrants.status, "active"),
            eq(connectionGrants.subjectUserId, userId),
          ),
        )
        .for("update");
      if (!grant)
        throw forbidden("Your personal GitHub connection was revoked");
      const values = {
        companyId: bot.companyId,
        endpointId,
        principalId: principal!.id,
        paperclipUserId: userId,
        status: "linked" as const,
        confirmedAt: new Date(),
        revokedAt: null,
        confirmationTokenHash: null,
        expiresAt: null,
        updatedAt: new Date(),
      };
      await tx
        .insert(chatIdentityLinks)
        .values(values)
        .onConflictDoUpdate({
          target: [chatIdentityLinks.endpointId, chatIdentityLinks.principalId],
          set: values,
        });
      await logActivity(tx as unknown as Db, {
        companyId: bot.companyId,
        actorType: "user",
        actorId: userId,
        action: "chat_github.identity_confirmed",
        entityType: "tool_connection",
        entityId: bot.connectionId,
        details: {
          endpointId,
          connectionId,
          githubUserId: verified.githubUserId,
        },
      });
    });
    return verified;
  }
  return {
    verification: async (endpointId: string) => {
      const bot = await endpoint(endpointId);
      const checks: Array<{
        key: string;
        label: string;
        ok: boolean;
        detail: string;
      }> = [];
      checks.push({
        key: "delivery",
        label: "Signed webhook delivery",
        ok: !!bot.setup.webhookVerifiedAt,
        detail: bot.setup.webhookVerifiedAt
          ? "GitHub delivered a signed webhook to this instance."
          : "Send or redeliver a ping from your App's webhook settings.",
      });
      const credentials = await githubBotCredentials(
        db,
        bot.companyId,
        endpointId,
      );
      const app = await githubBotRequest<{
        id?: number;
        permissions?: Record<string, string>;
        events?: string[];
      }>(fetchImpl, credentials.appJwt, "/app");
      checks.push({
        key: "app",
        label: "GitHub App identity",
        ok: String(app.id) === bot.botExternalId,
        detail: "The vaulted credentials must identify this bot's App.",
      });
      const installation = credentials.credentials.installationId
        ? await githubBotRequest<{
            permissions?: Record<string, string>;
            suspended_at?: string | null;
          }>(
            fetchImpl,
            credentials.appJwt,
            `/app/installations/${credentials.credentials.installationId}`,
          )
        : null;
      const permissions = installation?.permissions ?? {};
      const permissionsOk =
        !!installation &&
        !installation.suspended_at &&
        ["read", "write"].includes(permissions.contents ?? "") &&
        permissions.pull_requests === "write" &&
        permissions.checks === "write" &&
        app.events?.includes("pull_request") === true;
      checks.push({
        key: "permissions",
        label: "Review installation permissions",
        ok: permissionsOk,
        detail: permissionsOk
          ? "Contents read, Pull requests write, Checks write, and PR events are enabled."
          : "Add Contents read and Checks write to the App, subscribe to pull_request, and approve the permission upgrade on GitHub.",
      });
      const resources = await db
        .select()
        .from(chatEndpointResources)
        .where(
          and(
            eq(chatEndpointResources.companyId, bot.companyId),
            eq(chatEndpointResources.endpointId, endpointId),
            eq(chatEndpointResources.enabled, true),
          ),
        );
      const inaccessible: string[] = [];
      // Ask GitHub to authorize the selected repository IDs now. A cached
      // inventory alone cannot prove access after an installation is changed.
      for (let offset = 0; offset < resources.length; offset += 4) {
        await Promise.all(
          resources.slice(offset, offset + 4).map(async (resource) => {
            const repositoryId = String(
              resource.metadata?.providerRepositoryId ?? "",
            );
            try {
              if (
                !permissionsOk ||
                resource.availability !== "available" ||
                !/^[1-9][0-9]*$/.test(repositoryId) ||
                !Number.isSafeInteger(Number(repositoryId))
              )
                throw new Error("Unavailable repository");
              const issued = await githubBotRequest<{ token?: string }>(
                fetchImpl,
                credentials.appJwt,
                `/app/installations/${credentials.credentials.installationId}/access_tokens`,
                {
                  method: "POST",
                  body: {
                    repository_ids: [Number(repositoryId)],
                    permissions: {
                      contents: "read",
                      metadata: "read",
                      issues: "write",
                      pull_requests: "write",
                      checks: "write",
                    },
                  },
                },
              );
              if (!issued.token) throw new Error("Missing installation token");
            } catch {
              inaccessible.push(resource.label ?? resource.providerResourceId);
            }
          }),
        );
      }
      checks.push({
        key: "repositories",
        label: "Enabled repositories",
        ok: resources.length > 0 && inaccessible.length === 0,
        detail: inaccessible.length
          ? `Restore installation access and refresh: ${inaccessible.join(", ")}.`
          : resources.length
            ? `GitHub confirmed review access to all ${resources.length} enabled repositories.`
            : "Enable at least one repository from the App installation.",
      });
      const [agent] = await db
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.companyId, bot.companyId),
            eq(agents.id, bot.assignedAgentId),
          ),
        );
      checks.push({
        key: "runtime",
        label: "Agent runtime supports bot tools",
        ok:
          !!agent &&
          ["paperclip_runner", "codex_local"].includes(agent.adapterType),
        detail:
          "Use Paperclip Runner or Codex with managed MCP tools. Low-trust execution also requires a valid scoped boundary and isolated sandbox; the test task proves runtime execution.",
      });
      const [savedConfig] = await db
        .select()
        .from(chatGitHubConfigurations)
        .where(eq(chatGitHubConfigurations.endpointId, endpointId));
      if (
        agent &&
        (agent.permissions.trustPreset === "low_trust_review" ||
          savedConfig?.configuration.people.some(
            (person) => person.kind === "guest",
          ))
      ) {
        const settings = instanceSettingsService(db);
        const experimental = await settings.getExperimental();
        const environments = environmentService(db);
        const local = await environments.ensureLocalEnvironment(bot.companyId);
        const managed = experimental.enableManagedSandboxOnly
          ? await environments.findManagedSandboxEnvironment(bot.companyId)
          : null;
        const selected = resolveExecutionWorkspaceEnvironmentId({
          agentDefaultEnvironmentId: agent.defaultEnvironmentId,
          instanceDefaultEnvironmentId:
            (await settings.get()).defaultEnvironmentId ?? null,
          localDefaultEnvironmentId: local.id,
          managedSandboxOnly: experimental.enableManagedSandboxOnly,
          managedSandboxEnvironmentId: managed?.id,
        });
        const environment = await environments.getById(selected.environmentId);
        const owners = environment
          ? await environments.listBoundCompanyIds(environment.id)
          : [];
        const sandboxOk =
          experimental.enableIsolatedWorkspaces &&
          environment?.driver === "sandbox" &&
          environment.status === "active" &&
          (!owners.length || owners.includes(bot.companyId));
        checks.push({
          key: "isolation",
          label: "Low-trust and guest execution",
          ok: !!sandboxOk,
          detail: sandboxOk
            ? "An active sandbox environment is selected. Each task receives its own restricted trust boundary."
            : "Enable isolated workspaces and select an active sandbox environment for this agent before running low-trust or guest tasks.",
        });
      }
      const entries = await db
        .select()
        .from(toolCatalogEntries)
        .where(
          and(
            eq(toolCatalogEntries.companyId, bot.companyId),
            eq(toolCatalogEntries.connectionId, bot.connectionId),
            eq(toolCatalogEntries.status, "active"),
          ),
        );
      let toolsOk = entries.length >= 5;
      const denied: string[] = [];
      for (const entry of entries) {
        const decision = await toolAccessPolicyService(db).decide({
          companyId: bot.companyId,
          actor: {
            actorType: "agent",
            actorId: bot.assignedAgentId,
            agentId: bot.assignedAgentId,
          },
          runContext: {},
          request: {
            toolName: `github-bot.${bot.id}:${entry.toolName}`,
            applicationId: credentials.connection.applicationId,
            applicationKey: "github-chat",
            connectionId: bot.connectionId,
            catalogEntryId: entry.id,
            providerType: "paperclip_github_chat",
            upstreamToolName: entry.toolName,
            riskLevel: entry.riskLevel,
            arguments: {},
            sideEffecting: entry.riskLevel !== "read",
          },
        });
        if (
          entry.toolName !== "formal_review" &&
          !decision.allowed &&
          decision.decision !== "require_approval"
        ) {
          toolsOk = false;
          denied.push(entry.title ?? entry.toolName);
        }
      }
      checks.push({
        key: "tools",
        label: "Assigned agent's effective GitHub tools",
        ok: toolsOk,
        detail: toolsOk
          ? "The bot App's task-scoped tools are assigned. Each run and publication rechecks access."
          : denied.length
            ? `Repair tool policy for: ${denied.join(", ")}.`
            : "Assign the bot's GitHub tools to this agent below.",
      });
      return { checks, ready: checks.every((check) => check.ok) };
    },
    configuration,
    saveConfiguration,
    personalConnections,
    identity,
    lookupPerson: async (login: string) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}(?:\[bot\])?$/.test(login))
        throw badRequest("Enter a GitHub username");
      const user = await githubBotRequest<{
        id?: number;
        login?: string;
        type?: string;
      }>(fetchImpl, null, `/users/${encodeURIComponent(login)}`);
      if (
        !Number.isSafeInteger(user.id) ||
        !user.id ||
        !["User", "Bot"].includes(user.type ?? "") ||
        !user.login
      )
        throw badRequest("Choose a GitHub person or bot account");
      return { githubUserId: String(user.id), login: user.login };
    },
    reviews: async (endpointId: string) => {
      const bot = await endpoint(endpointId);
      return db
        .select()
        .from(chatGitHubReviews)
        .where(
          and(
            eq(chatGitHubReviews.companyId, bot.companyId),
            eq(chatGitHubReviews.endpointId, endpointId),
          ),
        )
        .orderBy(desc(chatGitHubReviews.createdAt))
        .limit(100);
    },
  };
}
