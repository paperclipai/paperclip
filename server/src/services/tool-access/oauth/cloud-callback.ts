import { managedConnectorProfile } from "./client-settings.js";
import type { ActorInfo } from "../types.js";
import { oauthConfig, normalizeOauthScopes } from "./metadata.js";
import { connectionMethodForConnection } from "../connection-methods.js";
import { loadGitHubGrantMetadata } from "../github-access-discovery.js";
import { googleWorkspaceEffectiveScopes, isGoogleWorkspaceScopeGrant } from "@paperclipai/shared";
import { emitConnectionUpdated } from "../../connector-telemetry.js";
import { and, eq, gte, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, companyMemberships, principalPermissionGrants, issueThreadInteractions, toolApplications, toolConnections, toolOauthStates } from "@paperclipai/db";
import type { ConnectionGrantKind, ConnectToolAppResult } from "@paperclipai/shared";
import { getConnectableAppDefinition, recommendedDefaultsForApp } from "@paperclipai/shared";
import { badRequest, forbidden, HttpError, unprocessable } from "../../../errors.js";
import { secretService } from "../../secrets.js";
import { isPaperclipCloudConnectorStrategy, type PaperclipCloudConnector } from "../../paperclip-cloud-connector.js";

import type { OAuthStateStore } from "./state.js";
import type { OAuthCredentialStore } from "./credential-store.js";
import type { OAuthCatalogCompletion } from "./catalog-completion.js";
import type { RefreshConnectionCatalog } from "../catalog/contracts.js";

import { toApplication } from "../applications/projection.js";
import { groupedActions } from "../catalog/action-summary.js";

type Dependencies = {
  now: () => Date;
  getConnectionRow(idOrUid: string, companyId?: string): Promise<typeof toolConnections.$inferSelect>;
  state: OAuthStateStore;
  refreshCatalog: RefreshConnectionCatalog;
  finishOAuthCatalogWithRecommendedDefaults: OAuthCatalogCompletion;
  store: Pick<OAuthCredentialStore, "createOrRotateOAuthSecret" | "syncCredentialBindings">;
  currentCloudConnector: () => PaperclipCloudConnector | null;
};

export function createCloudOAuthCallback(db: Db, dependencies: Dependencies) {
  const { now, getConnectionRow, state, store, refreshCatalog, finishOAuthCatalogWithRecommendedDefaults, currentCloudConnector } = dependencies;
  const { consumeOAuthState, validateOAuthState, rejectPendingOAuthInteraction } = state;
  const { createOrRotateOAuthSecret, syncCredentialBindings } = store;
  async function completePaperclipCloudConnectorCallback(input: {
    state: string;
    claimId?: string | null;
    error?: string | null;
    actor?: ActorInfo;
  }): Promise<ConnectToolAppResult> {
    // Keep the local state live until the sealed claim is in the durable vault.
    // The broker binds repeat claim requests to this stable state value, so a
    // transient broker, database, or secret-store failure can retry safely.
    const stateRow = await validateOAuthState(input.state, input.actor);
    let connection = await getConnectionRow(
      stateRow.connectionId,
      stateRow.companyId,
    );
    const preCloudCallbackLifecycle = {
      status: connection.status,
      enabled: connection.enabled,
    };
    // The connection lifecycle, not the incidental presence of its app profile,
    // distinguishes setup from reauthorization. New connections and connections
    // revived after removal are drafts until this callback completes. A profile
    // may legitimately survive removal because an MCP gateway retains it, or be
    // intentionally archived on an otherwise active connection; neither case
    // should invert whether recommended defaults are rebuilt.
    const shouldFinalizeManagedDefaults = connection.status === "draft";
    const sourceTemplateKey =
      typeof connection.config.sourceTemplateKey === "string"
        ? connection.config.sourceTemplateKey
        : null;
    const galleryEntry = sourceTemplateKey
      ? getConnectableAppDefinition(sourceTemplateKey)
      : null;
    const method = galleryEntry
      ? connectionMethodForConnection(galleryEntry, connection)
      : null;
    const providerName = galleryEntry?.name ?? "Google Workspace";
    if (input.error) {
      const consumedState = await consumeOAuthState(input.state, input.actor);
      await rejectPendingOAuthInteraction(consumedState, input.actor);
      throw new HttpError(
        400,
        `${providerName} authorization did not complete. Start a new ${providerName} connection to try again.`,
        {
          code:
            input.error === "access_denied"
              ? "oauth_authorization_denied"
              : "paperclip_cloud_connector_failed",
        },
      );
    }
    if (!input.claimId)
      throw badRequest(
        `${providerName} callback is missing a claim identifier`,
      );
    const cloudConnector = currentCloudConnector();
    if (!cloudConnector) {
      throw unprocessable(
        `${providerName} connections through Paperclip are not available on this instance yet`,
        {
          code: "paperclip_cloud_connector_unavailable",
        },
      );
    }
    const subjectUserId = stateRow.subjectUserId;
    const subjectAgentId = stateRow.subjectAgentId;
    if (
      !method ||
      !isPaperclipCloudConnectorStrategy(method.oauthStrategy) ||
      (!subjectUserId && !subjectAgentId)
    ) {
      throw badRequest(
        "OAuth state does not belong to a managed connector flow",
      );
    }
    const connectorProfile = method.connectorProfile;
    const profile = managedConnectorProfile(connectorProfile);
    if (!profile) throw badRequest("Managed connector profile is invalid");
    const connectorSubject = subjectAgentId
      ? `agent:${subjectAgentId}`
      : subjectUserId!;
    const credentials = await cloudConnector.claim({
      subject: connectorSubject,
      companyId: stateRow.companyId,
      profile: profile.id,
      claimId: input.claimId,
      redemptionId: input.state,
      ...(profile.id === "workspace.all" && stateRow.requestedScopes ? { scopes: stateRow.requestedScopes } : {}),
    });
    if (profile.id === "workspace.all") {
      const requested = normalizeOauthScopes(stateRow.requestedScopes);
      credentials.scopes = googleWorkspaceEffectiveScopes(requested, credentials.scopes);
      if (!isGoogleWorkspaceScopeGrant(credentials.scopes)) throw unprocessable("Google did not grant any selected service permissions", { code: "oauth_scope_grant_invalid" });
    }
    const refreshToken = credentials.refreshToken;
    if ((profile.provider === "google" || profile.provider === "asana") && !refreshToken) {
      throw unprocessable(
        `${providerName} did not return offline access. Reconnect and grant the requested permissions.`,
        {
          code: "oauth_refresh_missing",
        },
      );
    }
    const githubMetadata =
      profile.provider === "github"
        ? await loadGitHubGrantMetadata(
            credentials.accessToken,
            fetch,
            credentials.appSlug,
          )
        : null;
    const authorizingUserId =
      subjectUserId ??
      (stateRow.createdByActorType === "user"
        ? stateRow.createdByActorId
        : null);
    if (!authorizingUserId)
      throw forbidden(
        `A signed-in connection manager must authorize ${providerName}`,
      );

    await db.transaction(async (tx) => {
      // Keep connector credential persistence serialized with membership
      // suspension, downgrade, and removal. A successful claim is only durable
      // while the initiating user still holds connection-management authority.
      const [membership] = await tx
        .select({
          id: companyMemberships.id,
          membershipRole: companyMemberships.membershipRole,
        })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, connection.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, authorizingUserId),
            eq(companyMemberships.status, "active"),
            ne(companyMemberships.membershipRole, "viewer"),
          ),
        )
        .limit(1)
        .for("update");
      if (!membership) {
        throw forbidden(
          `Your company membership no longer permits connection changes. Restore non-viewer access before you connect ${providerName} again.`,
        );
      }
      if (subjectAgentId) {
        const roleCanManage =
          membership.membershipRole === "owner" ||
          membership.membershipRole === "admin";
        const [explicitManagerGrant] = roleCanManage
          ? []
          : await tx
              .select({
                id: principalPermissionGrants.id,
              })
              .from(principalPermissionGrants)
              .where(
                and(
                  eq(principalPermissionGrants.companyId, connection.companyId),
                  eq(principalPermissionGrants.principalType, "user"),
                  eq(principalPermissionGrants.principalId, authorizingUserId),
                  eq(
                    principalPermissionGrants.permissionKey,
                    "tools:manage_connections",
                  ),
                ),
              )
              .limit(1)
              .for("update");
        if (!roleCanManage && !explicitManagerGrant) {
          throw forbidden(
            "Only a connection manager can authorize a dedicated agent identity.",
          );
        }
      }
      const [consumedState] = await tx
        .delete(toolOauthStates)
        .where(
          and(
            eq(toolOauthStates.state, input.state),
            gte(toolOauthStates.expiresAt, new Date()),
          ),
        )
        .returning({ state: toolOauthStates.state });
      if (!consumedState)
        throw badRequest(
          "OAuth state was not found, expired, or has already been used",
        );
      const txSecrets = secretService(tx);
      const txSecretContext = { dbClient: tx, secretClient: txSecrets };
      const personalCredential = connection.credentialPolicy === "per_user";
      const agentCredential = connection.credentialPolicy === "per_agent";
      const grantKind: ConnectionGrantKind = agentCredential
        ? "agent"
        : personalCredential
          ? "user"
          : "organization";
      const [existingCredentialGrant] = await tx
        .select()
        .from(connectionGrants)
        .where(
          and(
            eq(connectionGrants.companyId, connection.companyId),
            eq(connectionGrants.connectionId, connection.id),
            eq(connectionGrants.kind, grantKind),
            agentCredential
              ? eq(connectionGrants.subjectAgentId, subjectAgentId!)
              : personalCredential
                ? eq(connectionGrants.subjectUserId, subjectUserId!)
                : eq(connectionGrants.isDefault, true),
          ),
        )
        .limit(1)
        .for("update");
      await tx.select({ id: toolApplications.id }).from(toolApplications)
        .where(and(eq(toolApplications.id, connection.applicationId), eq(toolApplications.companyId, connection.companyId)))
        .for("update");
      await tx.select({ id: toolConnections.id }).from(toolConnections)
        .where(and(eq(toolConnections.id, connection.id), eq(toolConnections.companyId, connection.companyId)))
        .for("update");
      const existingRefs =
        existingCredentialGrant?.credentialSecretRefs ??
        (personalCredential || agentCredential
          ? []
          : connection.credentialSecretRefs);
      const accessRef = await createOrRotateOAuthSecret(
        {
          companyId: connection.companyId,
          connection,
          configPath: "oauth.access_token",
          label: `${providerName} access token`,
          value: credentials.accessToken,
          actor: input.actor,
          existingRefs,
          ownerUserId: personalCredential ? subjectUserId! : undefined,
        },
        txSecretContext,
      );
      const refreshRef = refreshToken
        ? await createOrRotateOAuthSecret(
            {
              companyId: connection.companyId,
              connection,
              configPath: "oauth.refresh_token",
              label: `${providerName} refresh token`,
              value: refreshToken,
              actor: input.actor,
              existingRefs,
              ownerUserId: personalCredential ? subjectUserId! : undefined,
            },
            txSecretContext,
          )
        : null;
      const credentialSecretRefs = [
        ...existingRefs.filter(
          (ref) =>
            ref.configPath !== "oauth.access_token" &&
            ref.configPath !== "oauth.refresh_token",
        ),
        accessRef,
        ...(refreshRef ? [refreshRef] : []),
      ];
      const grantValues = {
        providerTenant: {
          name: githubMetadata?.login ?? providerName,
          externalId: credentials.subject,
          oauth: {
            strategy: "paperclip_cloud_connector",
            accessTokenExpiresAt: credentials.accessTokenExpiresAt,
            scopes: credentials.scopes,
            requestedScopes: stateRow.requestedScopes ?? undefined,
            tokenType: credentials.tokenType,
            ...(credentials.refreshTokenExpiresAt
              ? { refreshTokenExpiresAt: credentials.refreshTokenExpiresAt }
              : {}),
            ...(credentials.accessTokenExpiresAt
              ? { refreshedAt: now().toISOString() }
              : {}),
          },
          ...(githubMetadata ? { github: githubMetadata } : {}),
        },
        credentialSecretRefs,
        status: "active" as const,
        revokedAt: null,
        revokedByAgentId: null,
        revokedByUserId: null,
        updatedAt: now(),
      };
      if (existingCredentialGrant) {
        await tx
          .update(connectionGrants)
          .set(grantValues)
          .where(eq(connectionGrants.id, existingCredentialGrant.id));
      } else {
        await tx.insert(connectionGrants).values({
          companyId: connection.companyId,
          connectionId: connection.id,
          kind: grantKind,
          subjectUserId: personalCredential ? subjectUserId : null,
          subjectAgentId: agentCredential ? subjectAgentId : null,
          ...grantValues,
          isDefault: grantKind === "organization",
          createdByUserId: authorizingUserId,
        });
      }
      const nextConfig = {
        ...connection.config,
        oauth: {
          ...oauthConfig(connection),
          strategy: "paperclip_cloud_connector",
          provider: galleryEntry?.slug,
          connectorProfile,
          connectorSubjectUserId: subjectUserId,
          connectorSubjectAgentId: subjectAgentId,
          resource: method.defaults?.serverUrl,
          scopes: [...profile.scopes],
        },
      };
      [connection] = await tx
        .update(toolConnections)
        .set({
          status: shouldFinalizeManagedDefaults ? "draft" : "active",
          enabled: shouldFinalizeManagedDefaults ? false : true,
          authKind: "oauth",
          config: nextConfig,
          transportConfig: nextConfig,
          credentialRefs:
            personalCredential || agentCredential
              ? connection.credentialRefs.filter(
                  (ref) => ref.name !== "oauth.access_token",
                )
              : [
                  ...connection.credentialRefs.filter(
                    (ref) => ref.name !== "oauth.access_token",
                  ),
                  {
                    name: "oauth.access_token",
                    secretId: accessRef.secretId,
                    version: "latest" as const,
                    placement: "header" as const,
                    key: "Authorization",
                    prefix: "Bearer ",
                  },
                ],
          credentialSecretRefs:
            personalCredential || agentCredential
              ? connection.credentialSecretRefs.filter(
                  (ref) =>
                    ref.configPath !== "oauth.access_token" &&
                    ref.configPath !== "oauth.refresh_token",
                )
              : credentialSecretRefs,
          updatedAt: now(),
        })
        .where(eq(toolConnections.id, connection.id))
        .returning();
      await tx
        .update(toolApplications)
        .set({
          status: shouldFinalizeManagedDefaults ? "draft" : "active",
          updatedAt: now(),
        })
        .where(eq(toolApplications.id, connection.applicationId));
      await syncCredentialBindings(
        connection,
        personalCredential || agentCredential ? credentialSecretRefs : [],
        tx,
      );
      const linkedInteractionKind = stateRow.interactionId
        ? await tx
            .select({ kind: issueThreadInteractions.kind })
            .from(issueThreadInteractions)
            .where(eq(issueThreadInteractions.id, stateRow.interactionId))
            .limit(1)
            .then((rows) => rows[0]?.kind ?? null)
        : null;
      if (
        stateRow.interactionId &&
        linkedInteractionKind === "request_confirmation"
      ) {
        await tx
          .update(issueThreadInteractions)
          .set({
            status: "accepted",
            result: { version: 1, outcome: "accepted" },
            resolvedByUserId: authorizingUserId,
            resolvedAt: now(),
            updatedAt: now(),
          })
          .where(eq(issueThreadInteractions.id, stateRow.interactionId));
      }
    });
    // The transaction above committed the connection's lifecycle write; a
    // Paperclip Cloud connector callback is the managed variant of an OAuth
    // callback completion.
    emitConnectionUpdated(connection, preCloudCallbackLifecycle, "oauth_callback");
    if (githubMetadata) {
      const [githubGrant] = await db
        .select({ id: connectionGrants.id })
        .from(connectionGrants)
        .where(
          and(
            eq(connectionGrants.companyId, connection.companyId),
            eq(connectionGrants.connectionId, connection.id),
            subjectAgentId
              ? and(
                  eq(connectionGrants.kind, "agent"),
                  eq(connectionGrants.subjectAgentId, subjectAgentId),
                )
              : and(
                  eq(connectionGrants.kind, "user"),
                  eq(connectionGrants.subjectUserId, subjectUserId!),
                ),
          ),
        )
        .limit(1);
      if (!githubGrant) throw new Error("GitHub grant was not persisted");
      await Promise.all(
        githubMetadata.installationIds.map((installationId) =>
          cloudConnector.setWebhookBinding({
            subject: connectorSubject,
            companyId: connection.companyId,
            id: `${githubGrant.id}_${installationId}`,
            installationId,
            connectionId: connection.id,
            grantId: githubGrant.id,
            active: true,
            accessToken: credentials.accessToken,
          }),
        ),
      );
    }
    const refresh = await refreshCatalog(connection.id, input.actor, {
      enableAllByDefault: false,
      quarantineManagedOAuthDraft: shouldFinalizeManagedDefaults,
      skipDefaultProfileSync: true,
      credentialHeaders: { Authorization: `Bearer ${credentials.accessToken}` },
    });
    const recommended = recommendedDefaultsForApp(galleryEntry!, method.key);
    const suggestedDefaults = subjectAgentId
      ? { ...recommended, access: { agentIds: [subjectAgentId] } as const }
      : recommended;
    const finished = shouldFinalizeManagedDefaults
      ? await finishOAuthCatalogWithRecommendedDefaults({
          interactionId: stateRow.interactionId,
          connection,
          catalog: refresh.catalog,
          suggestedDefaults,
          activateQuarantined: true,
          actor: input.actor,
        })
      : null;
    const activatedCatalogEntryIds = new Set(
      shouldFinalizeManagedDefaults
        ? refresh.catalog
            .filter((entry) => entry.status === "quarantined")
            .map((entry) => entry.id)
        : [],
    );
    const catalog = refresh.catalog.map((entry) =>
      activatedCatalogEntryIds.has(entry.id)
        ? { ...entry, status: "active" as const }
        : entry,
    );
    const [application] = await db
      .select()
      .from(toolApplications)
      .where(eq(toolApplications.id, connection.applicationId));
    return {
      connectionId: connection.id,
      application: toApplication(application),
      connection: finished?.connection ?? refresh.connection,
      catalog,
      actions: groupedActions(catalog),
      suggestedDefaults,
      auth: null,
    };
  }
  return completePaperclipCloudConnectorCallback;
}
