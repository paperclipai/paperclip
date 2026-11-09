import { credentialScope } from "./client-settings.js";
import { withoutOAuthRefreshLease } from "./refresh-leases.js";
import type { ActorInfo } from "../types.js";
import { createOAuthDiscovery } from "./discovery.js";
import { createOAuthClientProtocol, storedOAuthTokenEndpointAuthMethod } from "./client.js";
import { normalizeOAuthProviderError, oauthProviderErrorMessage } from "./provider-errors.js";
import { oauthConfig, normalizeOauthScopes, resolveGrantedOauthScopes } from "./metadata.js";
import { connectionMethodForConnection } from "../connection-methods.js";
import { googleWorkspaceEffectiveScopes, isGoogleWorkspaceScopeGrant } from "@paperclipai/shared";
import { emitConnectionUpdated } from "../../connector-telemetry.js";
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, companyMemberships, principalPermissionGrants, issueThreadInteractions, toolApplications, toolConnections } from "@paperclipai/db";
import type { ConnectToolAppResult } from "@paperclipai/shared";
import { getConnectableAppDefinition, recommendedDefaultsForApp } from "@paperclipai/shared";
import { badRequest, forbidden, HttpError, unprocessable } from "../../../errors.js";
import { secretService } from "../../secrets.js";

import type { OAuthStateStore } from "./state.js";
import type { OAuthCredentialStore } from "./credential-store.js";
import type { OAuthCatalogCompletion } from "./catalog-completion.js";
import type { RefreshConnectionCatalog, CheckConnectionHealth } from "../catalog/contracts.js";
import type { ConnectionSetupPolicy } from "../connections/setup-policy.js";

import { toApplication } from "../applications/projection.js";
import { groupedActions } from "../catalog/action-summary.js";

import { assertOAuthRedirectConstraints, assertOAuthCallbackIssuer } from "./authorization-constraints.js";
import type { createOrganizationGrantStore } from "../connections/organization-grant.js";
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

type Dependencies = {
  now: () => Date;
  getConnectionRow(idOrUid: string, companyId?: string): Promise<typeof toolConnections.$inferSelect>;
  state: OAuthStateStore;
  refreshCatalog: RefreshConnectionCatalog;
  finishOAuthCatalogWithRecommendedDefaults: OAuthCatalogCompletion;
  store: Pick<OAuthCredentialStore, "createOrRotateOAuthSecret" | "oauthClientForConnection" | "syncCredentialBindings">;
  setupPolicy: ConnectionSetupPolicy;
  checkConnectionHealth: CheckConnectionHealth;
  ensureDefaultOrganizationGrant: ReturnType<typeof createOrganizationGrantStore>;
  oauthEndpointsForConnection: ReturnType<typeof createOAuthDiscovery>["oauthEndpointsForConnection"];
  exchangeOAuthToken: ReturnType<typeof createOAuthClientProtocol>["exchangeOAuthToken"];
};

export function createDirectOAuthCallback(db: Db, dependencies: Dependencies) {
  const { now, getConnectionRow, state, store, setupPolicy, refreshCatalog, finishOAuthCatalogWithRecommendedDefaults, checkConnectionHealth, ensureDefaultOrganizationGrant, oauthEndpointsForConnection, exchangeOAuthToken } = dependencies;
  const { consumeOAuthState, rejectPendingOAuthInteraction } = state;
  const { createOrRotateOAuthSecret, oauthClientForConnection, syncCredentialBindings } = store;
  const { assertConnectorConnectionSetupEnabled } = setupPolicy;
  async function completeOAuthCallback(input: {
    state: string;
    code?: string | null;
    /**
     * RFC 6749 `error`. Untrusted, and deliberately the *only* thing read from a
     * failed callback — `error_description` and `error_uri` are not accepted as
     * input at all, so there is nothing for a hostile provider to reflect
     * through (PAP-17108).
     */
    error?: string | null;
    redirectUri: string;
    /** RFC 9207 `iss`, when the authorization server returns it. */
    iss?: string | null;
    actor?: ActorInfo;
  }): Promise<ConnectToolAppResult> {
    // Binding first, outcome second: the provider's report of a failure is only
    // acted on once the callback is bound to a state Paperclip issued and to the
    // actor that started the flow, so an unsolicited callback cannot drive any
    // path here. Consuming the state up front is what makes a denial terminal —
    // a refused request must not stay completable by a later code (PAP-17109).
    const stateRow = await consumeOAuthState(input.state, input.actor);
    if (input.error) {
      await rejectPendingOAuthInteraction(stateRow, input.actor);
      const providerError = normalizeOAuthProviderError(input.error);
      throw new HttpError(
        400,
        oauthProviderErrorMessage(
          providerError,
          "The authorization server denied the request.",
        ),
        {
          code: "oauth_authorization_denied",
          providerError,
        },
      );
    }
    // Neither a code nor an error is not a usable answer either. It still spends
    // the request: the recovery is a fresh authorization, not a state left live
    // waiting for a better callback.
    if (!input.code) throw badRequest("OAuth callback is missing a code");

    let connection = await getConnectionRow(
      stateRow.connectionId,
      stateRow.companyId,
    );
    // Reauthorization refreshes credentials and catalog without rebuilding the
    // operator's action profile, policy rules, or access bindings.
    const shouldFinalizeDefaults = connection.status === "draft";
    const preCallbackLifecycle = {
      status: connection.status,
      enabled: connection.enabled,
    };
    await assertConnectorConnectionSetupEnabled(connection);
    const sourceTemplateKey =
      typeof connection.config.sourceTemplateKey === "string"
        ? connection.config.sourceTemplateKey
        : null;
    const galleryEntry = sourceTemplateKey
      ? getConnectableAppDefinition(sourceTemplateKey)
      : null;
    assertOAuthRedirectConstraints(galleryEntry, input.redirectUri);
    const endpoints = await oauthEndpointsForConnection(
      connection,
      null,
      input.redirectUri,
    );
    assertOAuthCallbackIssuer(connection, endpoints, input.iss);
    // Generic states created before requested scopes were persisted may still
    // complete after an upgrade. Keep their original cached/discovered scope set.
    const authorizedScopes = normalizeOauthScopes(
      stateRow.requestedScopes ?? (galleryEntry ? [] : endpoints.scopes),
    );
    const client = await oauthClientForConnection(
      connection,
      endpoints.provider,
      input.actor,
    );
    if (!client.clientId)
      throw unprocessable(
        `OAuth client id is not configured for ${endpoints.provider}`,
      );

    const token = await exchangeOAuthToken({
      tokenUrl: endpoints.tokenUrl,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      tokenEndpointAuthMethod: storedOAuthTokenEndpointAuthMethod(
        oauthConfig(connection),
        client.clientSecret,
      ),
      redirectUri: input.redirectUri,
      codeVerifier: stateRow.codeVerifier,
      code: input.code,
      resource: endpoints.resource,
    });
    if (sourceTemplateKey === "google-workspace" && !isGoogleWorkspaceScopeGrant(normalizeOauthScopes(token.scope))) {
      throw unprocessable("Google did not return a supported permission grant. Reconnect and choose the Google services you want to use.", { code: "oauth_scope_grant_invalid" });
    }
    if (sourceTemplateKey === "google-workspace") {
      token.scope = googleWorkspaceEffectiveScopes(authorizedScopes, normalizeOauthScopes(token.scope)).join(" ");
      if (!token.scope) throw unprocessable("Google did not grant any selected service permissions", { code: "oauth_scope_grant_invalid" });
    }
    const connectedAt = now();
    const expiresAt = token.expiresIn
      ? new Date(connectedAt.getTime() + token.expiresIn * 1000).toISOString()
      : null;
    if (stateRow.subjectUserId) {
      let personalCredentialSecretRefs: typeof connectionGrants.$inferSelect.credentialSecretRefs =
        [];
      await db.transaction(async (tx) => {
        // Serialize callback persistence with suspension/removal. Those paths
        // lock this same membership row before sweeping personal credentials.
        const [membership] = await tx
          .select({ id: companyMemberships.id })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, connection.companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, stateRow.subjectUserId!),
              eq(companyMemberships.status, "active"),
              ne(companyMemberships.membershipRole, "viewer"),
            ),
          )
          .limit(1)
          .for("update");
        if (!membership) {
          throw forbidden(
            "Your company membership no longer permits connection changes. Ask a company owner to restore non-viewer access before you authorize this connection again.",
          );
        }
        const txSecrets = secretService(tx);
        const txSecretContext = { dbClient: tx, secretClient: txSecrets };

        const [existingUserGrant] = await tx
          .select()
          .from(connectionGrants)
          .where(
            and(
              eq(connectionGrants.companyId, connection.companyId),
              eq(connectionGrants.connectionId, connection.id),
              eq(connectionGrants.kind, "user"),
              eq(connectionGrants.subjectUserId, stateRow.subjectUserId!),
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
        const subjectCredentialSecretRefs =
          existingUserGrant?.credentialSecretRefs ?? [];
        const accessRef = await createOrRotateOAuthSecret(
          {
            companyId: connection.companyId,
            connection,
            configPath: "oauth.access_token",
            label: "OAuth access token",
            value: token.accessToken,
            actor: input.actor,
            existingRefs: subjectCredentialSecretRefs,
            ownerUserId: stateRow.subjectUserId!,
          },
          txSecretContext,
        );
        const nextCredentialSecretRefs = [
          ...subjectCredentialSecretRefs.filter(
            (ref) =>
              ref.configPath !== "oauth.access_token" &&
              ref.configPath !== "oauth.refresh_token",
          ),
          accessRef,
        ];
        if (token.refreshToken) {
          nextCredentialSecretRefs.push(
            await createOrRotateOAuthSecret(
              {
                companyId: connection.companyId,
                connection,
                configPath: "oauth.refresh_token",
                label: "OAuth refresh token",
                value: token.refreshToken,
                actor: input.actor,
                existingRefs: subjectCredentialSecretRefs,
                ownerUserId: stateRow.subjectUserId!,
              },
              txSecretContext,
            ),
          );
        } else {
          const existingRefreshRef = subjectCredentialSecretRefs.find(
            (ref) => ref.configPath === "oauth.refresh_token",
          );
          if (existingRefreshRef)
            nextCredentialSecretRefs.push(existingRefreshRef);
        }

        const grantedScopes = resolveGrantedOauthScopes({
          tokenScope: token.scope,
          requestedScopes: authorizedScopes,
        });
        const grantValues = {
          providerTenant: {
            ...(existingUserGrant?.providerTenant ?? {}),
            oauth: {
              ...asRecord(asRecord(existingUserGrant?.providerTenant).oauth),
              strategy: "direct_oauth",
              accessTokenExpiresAt: expiresAt ?? undefined,
              scopes: grantedScopes.scopes,
              scopeSource: grantedScopes.scopeSource,
              unrequestedScopes: grantedScopes.unrequestedScopes,
              // Per-grant, because two users can authorize the same connection with
              // different scopes. The connection-level list is whichever callback ran last,
              // so it is the wrong baseline for anyone else's refresh.
              requestedScopes: authorizedScopes,
              tokenType: token.tokenType,
              refreshedAt: connectedAt.toISOString(),
            },
          },
          credentialSecretRefs: nextCredentialSecretRefs,
          status: "active" as const,
          revokedAt: null,
          revokedByAgentId: null,
          revokedByUserId: null,
          updatedAt: new Date(),
        };
        if (existingUserGrant) {
          await tx
            .update(connectionGrants)
            .set(grantValues)
            .where(eq(connectionGrants.id, existingUserGrant.id));
        } else {
          await tx.insert(connectionGrants).values({
            companyId: connection.companyId,
            connectionId: connection.id,
            kind: "user",
            subjectUserId: stateRow.subjectUserId!,
            ...grantValues,
            isDefault: false,
            createdByUserId: stateRow.subjectUserId!,
          });
        }
        personalCredentialSecretRefs = nextCredentialSecretRefs;
        const nextConfig = {
          ...connection.config,
          oauth: {
            ...withoutOAuthRefreshLease(oauthConfig(connection)),
            provider: endpoints.provider,
            authorizationUrl: endpoints.authorizationUrl,
            tokenUrl: endpoints.tokenUrl,
            metadataUrl: endpoints.metadataUrl ?? null,
            scopes: authorizedScopes,
            clientIdEnv: client.clientIdEnv,
            clientSecretEnv: client.clientSecret
              ? client.clientSecretEnv
              : null,
            credentialScope: credentialScope(connection, input.actor),
            issuer: endpoints.issuer ?? oauthConfig(connection).issuer ?? null,
            resource:
              endpoints.resource ?? oauthConfig(connection).resource ?? null,
            expiresAt,
            scope: token.scope,
            tokenType: token.tokenType,
            connectedAt: connectedAt.toISOString(),
          },
          providerMetadata: {
            ...asRecord(connection.config.providerMetadata),
            oauth: {
              expiresAt,
              scope: token.scope,
              scopeSource: grantedScopes.scopeSource,
              unrequestedScopes: grantedScopes.unrequestedScopes,
              tokenType: token.tokenType,
            },
          },
        };
        const [updatedConnection] = await tx
          .update(toolConnections)
          .set({
            status: "active",
            enabled: true,
            authKind: "oauth",
            credentialPolicy: connection.credentialPolicy,
            config: nextConfig,
            transportConfig: nextConfig,
            // A personal-only connection keeps tokens exclusively on its user
            // grant. Adding a personal identity to an existing shared/fallback
            // connection must not erase that connection's organization token.
            credentialRefs:
              connection.credentialPolicy === "per_user"
                ? connection.credentialRefs.filter(
                    (ref) => ref.name !== "oauth.access_token",
                  )
                : connection.credentialRefs,
            credentialSecretRefs:
              connection.credentialPolicy === "per_user"
                ? connection.credentialSecretRefs.filter(
                    (ref) =>
                      ref.configPath !== "oauth.access_token" &&
                      ref.configPath !== "oauth.refresh_token",
                  )
                : connection.credentialSecretRefs,
            updatedAt: new Date(),
          })
          .where(eq(toolConnections.id, connection.id))
          .returning();
        if (!updatedConnection)
          throw new Error("OAuth connection was not found");
        connection = updatedConnection;
        await tx
          .update(toolApplications)
          .set({
            status: "active",
            updatedAt: new Date(),
          })
          .where(eq(toolApplications.id, connection.applicationId));
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
              resolvedByUserId: stateRow.subjectUserId!,
              resolvedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(issueThreadInteractions.id, stateRow.interactionId),
                eq(issueThreadInteractions.companyId, connection.companyId),
              ),
            );
        }
        await syncCredentialBindings(
          connection,
          connection.credentialPolicy === "per_user"
            ? personalCredentialSecretRefs
            : [],
          tx,
        );
      });
      emitConnectionUpdated(
        connection,
        preCallbackLifecycle,
        "oauth_callback",
      );

      // Personal OAuth used to return immediately after saving the grant. That
      // left the connection draft/paused and its catalog empty, so the person
      // who had just consented landed on a false "Nothing to test" state.
      // Activate and discover with the just-issued token before returning.
      const refresh = await refreshCatalog(connection.id, input.actor, {
        enableAllByDefault: shouldFinalizeDefaults,
        skipDefaultProfileSync: shouldFinalizeDefaults,
        credentialHeaders: { Authorization: `Bearer ${token.accessToken}` },
      });
      const [application] = await db
        .select()
        .from(toolApplications)
        .where(eq(toolApplications.id, connection.applicationId));
      if (!application)
        throw new Error("OAuth connection application was not found");
      const suggestedDefaults = galleryEntry
        ? recommendedDefaultsForApp(
            galleryEntry,
            connectionMethodForConnection(galleryEntry, connection).key,
          )
        : { access: "all_agents" as const, askFirstRiskLevels: [] };
      const finished = shouldFinalizeDefaults
        ? await finishOAuthCatalogWithRecommendedDefaults({
            interactionId: stateRow.interactionId,
            connection,
            catalog: refresh.catalog,
            suggestedDefaults,
            actor: input.actor,
          })
        : null;
      return {
        connectionId: refresh.connection.id,
        application: toApplication(application),
        connection: finished?.connection ?? refresh.connection,
        catalog: refresh.catalog,
        actions: groupedActions(refresh.catalog),
        suggestedDefaults,
        auth: null,
      };
    }

    const organizationActorUserId =
      stateRow.createdByActorType === "user" ? stateRow.createdByActorId : null;
    if (!organizationActorUserId) {
      throw forbidden(
        "Organization OAuth completion requires the user who started sign-in",
      );
    }
    await db.transaction(async (tx) => {
      // Keep callback persistence serialized with membership suspension, role
      // downgrade, and removal. Once this row is locked, authority cannot be
      // revoked between the live check and the shared credential/grant writes.
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
            eq(companyMemberships.principalId, organizationActorUserId),
            eq(companyMemberships.status, "active"),
            ne(companyMemberships.membershipRole, "viewer"),
          ),
        )
        .limit(1)
        .for("update");
      if (!membership) {
        throw forbidden(
          "Your company membership no longer permits connection changes. Ask a company owner to restore non-viewer access before you authorize this connection again.",
        );
      }
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
                eq(
                  principalPermissionGrants.principalId,
                  organizationActorUserId,
                ),
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
          "Only a company owner, admin, or member with connection-manager permission can share credentials with the organization.",
        );
      }
      await tx.select({ id: connectionGrants.id }).from(connectionGrants)
        .where(and(eq(connectionGrants.companyId, connection.companyId), eq(connectionGrants.connectionId, connection.id),
          eq(connectionGrants.kind, "organization"), eq(connectionGrants.isDefault, true)))
        .for("update");
      await tx.select({ id: toolApplications.id }).from(toolApplications)
        .where(and(eq(toolApplications.id, connection.applicationId), eq(toolApplications.companyId, connection.companyId)))
        .for("update");
      await tx.select({ id: toolConnections.id }).from(toolConnections)
        .where(and(eq(toolConnections.id, connection.id), eq(toolConnections.companyId, connection.companyId)))
        .for("update");
      const txSecrets = secretService(tx);
      const txSecretContext = { dbClient: tx, secretClient: txSecrets };

      const subjectCredentialSecretRefs = connection.credentialSecretRefs;
      const accessRef = await createOrRotateOAuthSecret(
        {
          companyId: connection.companyId,
          connection,
          configPath: "oauth.access_token",
          label: "OAuth access token",
          value: token.accessToken,
          actor: input.actor,
        },
        txSecretContext,
      );
      const nextCredentialSecretRefs = [
        ...subjectCredentialSecretRefs.filter(
          (ref) =>
            ref.configPath !== "oauth.access_token" &&
            ref.configPath !== "oauth.refresh_token",
        ),
        accessRef,
      ];
      if (token.refreshToken) {
        nextCredentialSecretRefs.push(
          await createOrRotateOAuthSecret(
            {
              companyId: connection.companyId,
              connection,
              configPath: "oauth.refresh_token",
              label: "OAuth refresh token",
              value: token.refreshToken,
              actor: input.actor,
            },
            txSecretContext,
          ),
        );
      } else {
        const existingRefreshRef = subjectCredentialSecretRefs.find(
          (ref) => ref.configPath === "oauth.refresh_token",
        );
        if (existingRefreshRef)
          nextCredentialSecretRefs.push(existingRefreshRef);
      }
      const organizationGrantedScopes = resolveGrantedOauthScopes({
        tokenScope: token.scope,
        requestedScopes: authorizedScopes,
      });
      const nextConfig = {
        ...connection.config,
        oauth: {
          ...withoutOAuthRefreshLease(oauthConfig(connection)),
          provider: endpoints.provider,
          authorizationUrl: endpoints.authorizationUrl,
          tokenUrl: endpoints.tokenUrl,
          metadataUrl: endpoints.metadataUrl ?? null,
          scopes: authorizedScopes,
          clientIdEnv: client.clientIdEnv,
          clientSecretEnv: client.clientSecret ? client.clientSecretEnv : null,
          credentialScope: credentialScope(connection, input.actor),
          // Keep the issuer and resource this grant was minted against so refresh,
          // reconnect, revoke and diagnostics resolve the same authorization server
          // instead of re-discovering one from a possibly-changed endpoint.
          issuer: endpoints.issuer ?? oauthConfig(connection).issuer ?? null,
          resource:
            endpoints.resource ?? oauthConfig(connection).resource ?? null,
          expiresAt,
          scope: token.scope,
          tokenType: token.tokenType,
          connectedAt: connectedAt.toISOString(),
        },
        providerMetadata: {
          ...asRecord(connection.config.providerMetadata),
          oauth: {
            expiresAt,
            scope: token.scope,
            scopeSource: organizationGrantedScopes.scopeSource,
            unrequestedScopes: organizationGrantedScopes.unrequestedScopes,
            tokenType: token.tokenType,
          },
        },
      };
      const [updatedConnection] = await tx
        .update(toolConnections)
        .set({
          status: "active",
          enabled: true,
          authKind: "oauth",
          config: nextConfig,
          transportConfig: nextConfig,
          credentialSecretRefs: nextCredentialSecretRefs,
          credentialRefs: [
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
          updatedAt: new Date(),
        })
        .where(eq(toolConnections.id, connection.id))
        .returning();
      connection = updatedConnection;
      await tx
        .update(toolApplications)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(toolApplications.id, connection.applicationId));
      // The organization grant is created before OAuth has any secrets to attach.
      // Synchronize it after every successful callback/rotation so all real tool
      // execution paths receive the credentials that setup and catalog discovery
      // just proved.
      await ensureDefaultOrganizationGrant(connection, tx, undefined, {
        scopes: organizationGrantedScopes.scopes,
        scopeSource: organizationGrantedScopes.scopeSource,
        unrequestedScopes: organizationGrantedScopes.unrequestedScopes,
        requestedScopes: authorizedScopes,
      });
      await syncCredentialBindings(connection, [], tx);
    });
    emitConnectionUpdated(
      connection,
      preCallbackLifecycle,
      "oauth_callback",
    );

    await checkConnectionHealth(connection.id, input.actor);
    const refresh = await refreshCatalog(connection.id, input.actor, {
      enableAllByDefault: shouldFinalizeDefaults,
      skipDefaultProfileSync: shouldFinalizeDefaults,
    });
    const [application] = await db
      .select()
      .from(toolApplications)
      .where(eq(toolApplications.id, connection.applicationId));
    const suggestedDefaults = galleryEntry
      ? recommendedDefaultsForApp(
          galleryEntry,
          connectionMethodForConnection(galleryEntry, connection).key,
        )
      : {
          access: "all_agents" as const,
          askFirstRiskLevels: [],
        };
    const finished = shouldFinalizeDefaults
      ? await finishOAuthCatalogWithRecommendedDefaults({
          interactionId: stateRow.interactionId,
          connection,
          catalog: refresh.catalog,
          suggestedDefaults,
          actor: input.actor,
        })
      : null;
    return {
      connectionId: refresh.connection.id,
      application: toApplication(application),
      connection: finished?.connection ?? refresh.connection,
      catalog: refresh.catalog,
      actions: groupedActions(refresh.catalog),
      suggestedDefaults,
      auth: null,
    };
  }
  return completeOAuthCallback;
}
