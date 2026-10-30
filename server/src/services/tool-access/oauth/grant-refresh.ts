import { writeToolConnectionHealthChange } from "../../tool-connection-health-notifications.js";
import type { ActorInfo } from "../types.js";
import { createOAuthClientProtocol, storedOAuthTokenEndpointAuthMethod } from "./client.js";
import { oauthConfig, normalizeOauthScopes, resolveGrantedOauthScopes } from "./metadata.js";
import { googleWorkspaceEffectiveScopes, isGoogleWorkspaceScopeGrant } from "@paperclipai/shared";
import { emitConnectionUpdated } from "../../connector-telemetry.js";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, companySecrets, toolConnections } from "@paperclipai/db";
import type { ToolCredentialSecretRef } from "@paperclipai/shared";
import { conflict, HttpError, unprocessable } from "../../../errors.js";
import { secretService } from "../../secrets.js";
import { isPaperclipCloudConnectorStrategy, PaperclipCloudConnectorError, type PaperclipCloudConnector } from "../../paperclip-cloud-connector.js";

import { actorForSecret, type OAuthCredentialStore } from "./credential-store.js";
import { withoutOAuthRefreshLease, withoutOAuthGrantRefreshLease, type OAuthRefreshLeases } from "./refresh-leases.js";
import { managedConnectorProfile, oauthGrantConfig, oauthGrantExpiresAtMs } from "./client-settings.js";
import { connectionSetupUrl, connectionReconnectUrl } from "../identifiers.js";
import { singleFlight } from "../single-flight.js";
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

type GrantRefreshDependencies = {
  now: () => Date;
  store: Pick<OAuthCredentialStore, "getOAuthGrantRow" | "resolveOAuthGrantSecret" | "createOrRotateOAuthSecret" | "oauthClientForConnection" | "syncCredentialBindings">;
  leases: Pick<OAuthRefreshLeases, "acquireOAuthGrantRefreshLease" | "clearOAuthGrantRefreshLease">;
  currentCloudConnector: () => PaperclipCloudConnector | null;
  getConnectionRow(idOrUid: string, companyId?: string): Promise<typeof toolConnections.$inferSelect>;
  exchangeOAuthToken: ReturnType<typeof createOAuthClientProtocol>["exchangeOAuthToken"];
};

export function createOAuthGrantRefresh(db: Db, { now, store, leases, currentCloudConnector, getConnectionRow, exchangeOAuthToken }: GrantRefreshDependencies) {
  const oauthGrantRefreshFlights = new Map<string, Promise<unknown>>();
  const { getOAuthGrantRow, resolveOAuthGrantSecret, createOrRotateOAuthSecret, oauthClientForConnection, syncCredentialBindings } = store;
  const { acquireOAuthGrantRefreshLease, clearOAuthGrantRefreshLease } = leases;
  async function refreshOAuthGrantCredentials(input: {
    companyId: string;
    connectionId: string;
    grantId: string;
    forceRefresh?: boolean;
    actor?: ActorInfo;
    issueId?: string | null;
    heartbeatRunId?: string | null;
  }): Promise<typeof connectionGrants.$inferSelect> {
    const connection = await getConnectionRow(
      input.connectionId,
      input.companyId,
    );
    const initialGrant = await getOAuthGrantRow(input);
    const oauth = oauthConfig(connection);
    const oauthProvider =
      typeof oauth.provider === "string" ? oauth.provider : null;
    const oauthTokenUrl =
      typeof oauth.tokenUrl === "string" ? oauth.tokenUrl : null;
    if (
      connection.authKind === "oauth" &&
      connection.credentialSource === "paperclip_vault" &&
      isPaperclipCloudConnectorStrategy(oauth.strategy)
    ) {
      const grantOauth = oauthGrantConfig(initialGrant);
      const expiresAt =
        typeof grantOauth.accessTokenExpiresAt === "string"
          ? Date.parse(grantOauth.accessTokenExpiresAt)
          : Number.NaN;
      const refreshedAt =
        typeof grantOauth.refreshedAt === "string"
          ? Date.parse(grantOauth.refreshedAt)
          : Number.NaN;
      const rotationDue =
        Number.isFinite(expiresAt) &&
        (!Number.isFinite(refreshedAt) ||
          refreshedAt <= Date.now() - 30 * 24 * 60 * 60_000);
      const refreshDue =
        Number.isFinite(expiresAt) && expiresAt <= Date.now() + 60 * 60_000;
      // A GitHub App can deliberately issue a non-expiring ghu_ token. Its
      // continuity is checked against /user below; only an expiring token pair
      // enters this rotation path.
      if (!input.forceRefresh && !refreshDue && !rotationDue)
        return initialGrant;
      if (!Number.isFinite(expiresAt)) return initialGrant;

      return singleFlight(
        oauthGrantRefreshFlights,
        initialGrant.id,
        async () => {
          const lease = await acquireOAuthGrantRefreshLease(
            connection,
            initialGrant,
            true,
          );
          if (!lease.leaseId) return lease.grant;
          try {
            const grant = lease.grant;
            const profile = managedConnectorProfile(
              typeof oauth.connectorProfile === "string"
                ? oauth.connectorProfile
                : undefined,
            );
            const cloudConnector = currentCloudConnector();
            const connectorSubject =
              grant.kind === "agent" && grant.subjectAgentId
                ? `agent:${grant.subjectAgentId}`
                : grant.kind === "user" && grant.subjectUserId
                  ? grant.subjectUserId
                  : typeof oauth.connectorSubjectUserId === "string"
                    ? oauth.connectorSubjectUserId
                    : null;
            const accessRef = grant.credentialSecretRefs.find(
              (ref) => ref.configPath === "oauth.access_token",
            );
            const refreshRef = grant.credentialSecretRefs.find(
              (ref) => ref.configPath === "oauth.refresh_token",
            );
            if (
              !profile ||
              !cloudConnector ||
              !connectorSubject ||
              !accessRef ||
              !refreshRef
            ) {
              throw unprocessable("Managed authorization must be reconnected", {
                code: "oauth_reauthorization_required",
                setupUrl: connectionSetupUrl(connection),
                reconnectUrl: connectionReconnectUrl(connection),
              });
            }
            const refreshSecret = await resolveOAuthGrantSecret(
              connection,
              grant,
              refreshRef,
              input.actor,
              input,
            );
            let credentials;
            try {
              credentials = await cloudConnector.refresh({
                subject: connectorSubject,
                companyId: connection.companyId,
                profile: profile.id,
                refreshToken: refreshSecret.value,
              });
              if (profile.id === "workspace.all") {
                const requested = normalizeOauthScopes(oauthGrantConfig(grant).requestedScopes ?? oauthGrantConfig(grant).scopes);
                credentials.scopes = googleWorkspaceEffectiveScopes(requested, credentials.scopes);
              }
              if (profile.id === "workspace.all" && !isGoogleWorkspaceScopeGrant(credentials.scopes)) {
                throw new PaperclipCloudConnectorError("Google did not return verifiable permissions", "REAUTHORIZATION_REQUIRED");
              }
            } catch (error) {
              if (
                error instanceof PaperclipCloudConnectorError &&
                error.code === "REAUTHORIZATION_REQUIRED"
              ) {
                await db
                  .update(connectionGrants)
                  .set({ status: "needs_reauthorization", updatedAt: now() })
                  .where(
                    and(
                      eq(connectionGrants.id, grant.id),
                      eq(connectionGrants.companyId, grant.companyId),
                    ),
                  );
                throw unprocessable(
                  "Managed authorization must be reconnected",
                  {
                    code: "oauth_reauthorization_required",
                    setupUrl: connectionSetupUrl(connection),
                    reconnectUrl: connectionReconnectUrl(connection),
                  },
                );
              }
              throw error;
            }
            const credentialActor: ActorInfo | undefined =
              grant.kind === "user" && grant.subjectUserId
                ? { actorType: "user", actorId: grant.subjectUserId }
                : input.actor;
            const providerTenant = {
              ...(grant.providerTenant ?? {}),
              oauth: {
                ...withoutOAuthGrantRefreshLease(oauthGrantConfig(grant)),
                strategy: "paperclip_cloud_connector",
                accessTokenExpiresAt: credentials.accessTokenExpiresAt,
                scopes: credentials.scopes,
                tokenType: credentials.tokenType,
                refreshedAt: now().toISOString(),
                ...(credentials.refreshTokenExpiresAt
                  ? { refreshTokenExpiresAt: credentials.refreshTokenExpiresAt }
                  : {}),
              },
            };
            const updated = await db.transaction(async (tx) => {
              const [current] = await tx.select({ id: connectionGrants.id }).from(connectionGrants)
                .where(and(eq(connectionGrants.id, grant.id), eq(connectionGrants.companyId, grant.companyId),
                  eq(connectionGrants.status, "active"),
                  sql`${connectionGrants.providerTenant} -> 'oauth' -> 'refreshLease' ->> 'id' = ${lease.leaseId}`))
                .for("update");
              if (!current) throw conflict("OAuth credentials changed while refresh was in progress", {
                code: "oauth_refresh_superseded", retryable: true,
              });
              const txSecrets = secretService(tx);
              await txSecrets.rotate(
                accessRef.secretId,
                { value: credentials.accessToken },
                actorForSecret(credentialActor),
              );
              if (credentials.refreshToken) {
                await txSecrets.rotate(
                  refreshRef.secretId,
                  { value: credentials.refreshToken },
                  actorForSecret(credentialActor),
                );
              }
              const [committed] = await tx
                .update(connectionGrants)
                .set({
                  providerTenant,
                  status: "active",
                  updatedAt: now(),
                })
                .where(
                  and(
                    eq(connectionGrants.id, grant.id),
                    eq(connectionGrants.companyId, grant.companyId),
                    eq(connectionGrants.status, "active"),
                    sql`${connectionGrants.providerTenant} -> 'oauth' -> 'refreshLease' ->> 'id' = ${lease.leaseId}`,
                  ),
                )
                .returning();
              return committed;
            });
            if (!updated)
              throw conflict(
                "OAuth credentials changed while refresh was in progress",
                {
                  code: "oauth_refresh_superseded",
                  retryable: true,
                },
              );
            return updated;
          } finally {
            await clearOAuthGrantRefreshLease(lease.grant, lease.leaseId).catch(
              () => undefined,
            );
          }
        },
      );
    }
    if (
      connection.authKind !== "oauth" ||
      connection.credentialSource !== "paperclip_vault" ||
      !oauthTokenUrl ||
      !oauthProvider
    ) {
      return initialGrant;
    }
    const expiresAtMs = oauthGrantExpiresAtMs(initialGrant, connection);
    if (
      !input.forceRefresh &&
      (expiresAtMs === null || expiresAtMs > Date.now() + 60_000)
    ) {
      return initialGrant;
    }

    return singleFlight(oauthGrantRefreshFlights, initialGrant.id, async () => {
      const lease = await acquireOAuthGrantRefreshLease(
        connection,
        initialGrant,
        input.forceRefresh === true,
      );
      if (!lease.leaseId) return lease.grant;
      try {
        const grant = lease.grant;
        const refreshRef = grant.credentialSecretRefs.find(
          (ref) => ref.configPath === "oauth.refresh_token",
        );
        if (!refreshRef) {
          throw unprocessable(
            "OAuth credentials have expired and no refresh token is available",
            {
              code: "oauth_refresh_missing",
              setupUrl: connectionSetupUrl(connection),
              reconnectUrl: connectionReconnectUrl(connection),
            },
          );
        }
        const refreshSecret = await resolveOAuthGrantSecret(
          connection,
          grant,
          refreshRef,
          input.actor,
          input,
        );
        const credentialActor: ActorInfo | undefined =
          grant.kind === "user" && grant.subjectUserId
            ? { actorType: "user", actorId: grant.subjectUserId }
            : input.actor;
        const client = await oauthClientForConnection(
          connection,
          oauthProvider,
          credentialActor,
        );
        if (!client.clientId)
          throw unprocessable(
            `OAuth client id is not configured for ${oauthProvider}`,
          );
        const grantOauth = oauthGrantConfig(grant);
        let token: Awaited<ReturnType<typeof exchangeOAuthToken>>;
        try {
          token = await exchangeOAuthToken({
            tokenUrl: oauthTokenUrl,
            clientId: client.clientId,
            clientSecret: client.clientSecret,
            tokenEndpointAuthMethod: storedOAuthTokenEndpointAuthMethod(
              oauth,
              client.clientSecret,
            ),
            grantType: "refresh_token",
            scopes:
              normalizeOauthScopes(grantOauth.scopes).length > 0
                ? normalizeOauthScopes(grantOauth.scopes)
                : normalizeOauthScopes(oauth.scopes).length > 0
                  ? normalizeOauthScopes(oauth.scopes)
                  : normalizeOauthScopes(oauth.scope),
            refreshToken: refreshSecret.value,
            resource:
              typeof oauth.resource === "string" && oauth.resource
                ? oauth.resource
                : null,
          });
        } catch (error) {
          if (
            error instanceof HttpError &&
            asRecord(error.details).code === "oauth_reauthorization_required"
          ) {
            const retainedCredentialSecretRefs =
              grant.credentialSecretRefs.filter(
                (ref) =>
                  ref.configPath !== "oauth.access_token" &&
                  ref.configPath !== "oauth.refresh_token",
              );
            const providerTenant = {
              ...(grant.providerTenant ?? {}),
              oauth: {
                ...withoutOAuthGrantRefreshLease(grantOauth),
                accessTokenExpiresAt: undefined,
              },
            };
            const [marked] = await db
              .update(connectionGrants)
              .set({
                status: "needs_reauthorization",
                providerTenant,
                credentialSecretRefs: retainedCredentialSecretRefs,
                updatedAt: now(),
              })
              .where(
                and(
                  eq(connectionGrants.id, grant.id),
                  eq(connectionGrants.companyId, grant.companyId),
                  eq(connectionGrants.status, "active"),
                  sql`${connectionGrants.providerTenant} -> 'oauth' -> 'refreshLease' ->> 'id' = ${lease.leaseId}`,
                  sql`exists (
                select 1 from ${companySecrets}
                where ${companySecrets.id} = ${refreshRef.secretId}
                  and ${companySecrets.companyId} = ${connection.companyId}
                  and ${companySecrets.latestVersion} = ${refreshSecret.latestVersion}
              )`,
                ),
              )
              .returning();
            if (!marked) {
              const latest = await getOAuthGrantRow(input);
              const latestExpiresAt = oauthGrantExpiresAtMs(latest, connection);
              if (
                latest.status === "active" &&
                latestExpiresAt &&
                latestExpiresAt > Date.now() + 60_000
              )
                return latest;
              throw conflict(
                "OAuth credentials changed while refresh was in progress. Retry the request.",
                {
                  code: "oauth_refresh_superseded",
                  retryable: true,
                },
              );
            }
            if (marked.kind === "organization") {
              const latestConnection = await getConnectionRow(
                connection.id,
                connection.companyId,
              );
              const [reauthorizationRequired] = await writeToolConnectionHealthChange(db, latestConnection, tx => tx
                .update(toolConnections)
                .set({
                  status: "draft",
                  enabled: false,
                  credentialSecretRefs:
                    latestConnection.credentialSecretRefs.filter(
                      (ref) =>
                        ref.configPath !== "oauth.access_token" &&
                        ref.configPath !== "oauth.refresh_token",
                    ),
                  credentialRefs: latestConnection.credentialRefs.filter(
                    (ref) =>
                      ref.name !== "oauth.access_token" &&
                      ref.name !== "oauth.refresh_token",
                  ),
                  updatedAt: now(),
                })
                .where(
                  and(
                    eq(toolConnections.id, latestConnection.id),
                    eq(toolConnections.companyId, latestConnection.companyId),
                  ),
                )
                .returning());
              await syncCredentialBindings(reauthorizationRequired);
              emitConnectionUpdated(
                reauthorizationRequired,
                latestConnection,
                "credential_refresh",
              );
            } else {
              const activeGrantRefs = await db
                .select({
                  refs: connectionGrants.credentialSecretRefs,
                })
                .from(connectionGrants)
                .where(
                  and(
                    eq(connectionGrants.companyId, connection.companyId),
                    eq(connectionGrants.connectionId, connection.id),
                    eq(connectionGrants.status, "active"),
                  ),
                );
              await syncCredentialBindings(
                connection,
                activeGrantRefs.flatMap((row) => row.refs),
              );
            }
            throw new HttpError(error.status, error.message, {
              ...asRecord(error.details),
              setupUrl: connectionSetupUrl(connection),
              reconnectUrl: connectionReconnectUrl(connection),
            });
          }
          throw error;
        }

        if (connection.config.sourceTemplateKey === "google-workspace"
          && !isGoogleWorkspaceScopeGrant(normalizeOauthScopes(token.scope))) {
          await db.update(connectionGrants).set({ status: "needs_reauthorization", updatedAt: now() })
            .where(and(eq(connectionGrants.id, grant.id), eq(connectionGrants.companyId, connection.companyId)));
          throw unprocessable("Google did not return verifiable permissions. Reconnect Google Workspace.", { code: "oauth_reauthorization_required" });
        }
        let nextRefreshRef: ToolCredentialSecretRef | null = null;
        if (token.refreshToken) {
          nextRefreshRef = await createOrRotateOAuthSecret({
            companyId: connection.companyId,
            connection,
            configPath: "oauth.refresh_token",
            label: "OAuth refresh token",
            value: token.refreshToken,
            actor: credentialActor,
            existingRefs: grant.credentialSecretRefs,
            ownerUserId:
              grant.kind === "user"
                ? (grant.subjectUserId ?? undefined)
                : undefined,
          });
        }
        const accessRef = await createOrRotateOAuthSecret({
          companyId: connection.companyId,
          connection,
          configPath: "oauth.access_token",
          label: "OAuth access token",
          value: token.accessToken,
          actor: credentialActor,
          existingRefs: grant.credentialSecretRefs,
          ownerUserId:
            grant.kind === "user"
              ? (grant.subjectUserId ?? undefined)
              : undefined,
        });
        const nextCredentialSecretRefs = [
          ...grant.credentialSecretRefs.filter(
            (ref) =>
              ref.configPath !== "oauth.access_token" &&
              (!nextRefreshRef || ref.configPath !== "oauth.refresh_token"),
          ),
          accessRef,
          ...(nextRefreshRef ? [nextRefreshRef] : []),
        ];
        const expiresAt = token.expiresIn
          ? new Date(Date.now() + token.expiresIn * 1000).toISOString()
          : null;
        // A refresh carries no fresh authorization request, so the baseline stays what
        // Paperclip asked for when *this* grant was authorized. Judging the response against
        // the grant's own scopes instead would let an over-grant that the provider re-asserts
        // on every refresh read back as clean, because the widened grant would have become
        // its own baseline. The connection-level list is only a fallback for grants created
        // before the per-grant baseline existed — it is whichever callback ran last, so on a
        // connection two users authorized with different scopes it is the wrong baseline for
        // at least one of them.
        const refreshed = resolveGrantedOauthScopes({
          tokenScope: token.scope,
          requestedScopes:
            grantOauth.requestedScopes ??
            oauth.scopes ??
            oauth.scope ??
            grantOauth.scopes,
          previous: {
            scopes: grantOauth.scopes,
            scopeSource: grantOauth.scopeSource,
            unrequestedScopes: grantOauth.unrequestedScopes,
          },
        });
        if (connection.config.sourceTemplateKey === "google-workspace") {
          refreshed.scopes = googleWorkspaceEffectiveScopes(normalizeOauthScopes(grantOauth.requestedScopes ?? grantOauth.scopes), refreshed.scopes);
        }
        const providerTenant = {
          ...(grant.providerTenant ?? {}),
          oauth: {
            ...withoutOAuthGrantRefreshLease(grantOauth),
            strategy:
              typeof grantOauth.strategy === "string"
                ? grantOauth.strategy
                : "direct_oauth",
            accessTokenExpiresAt: expiresAt ?? undefined,
            scopes: refreshed.scopes,
            scopeSource: refreshed.scopeSource,
            unrequestedScopes: refreshed.unrequestedScopes,
            tokenType: token.tokenType,
            refreshedAt: now().toISOString(),
          },
        };
        const [updated] = await db
          .update(connectionGrants)
          .set({
            providerTenant,
            credentialSecretRefs: nextCredentialSecretRefs,
            status: "active",
            updatedAt: now(),
          })
          .where(
            and(
              eq(connectionGrants.id, grant.id),
              eq(connectionGrants.companyId, grant.companyId),
              eq(connectionGrants.status, "active"),
              sql`${connectionGrants.providerTenant} -> 'oauth' -> 'refreshLease' ->> 'id' = ${lease.leaseId}`,
            ),
          )
          .returning();
        if (!updated) {
          throw conflict(
            "OAuth credentials changed while refresh was in progress. Retry the request.",
            {
              code: "oauth_refresh_superseded",
              retryable: true,
            },
          );
        }
        if (grant.kind === "organization") {
          const latestConnection = await getConnectionRow(
            connection.id,
            connection.companyId,
          );
          const latestOauth = oauthConfig(latestConnection);
          const nextConfig = {
            ...latestConnection.config,
            oauth: {
              ...withoutOAuthRefreshLease(latestOauth),
              expiresAt,
              scope: token.scope ?? latestOauth.scope ?? null,
              tokenType: token.tokenType,
              refreshedAt: now().toISOString(),
            },
            providerMetadata: {
              ...asRecord(latestConnection.config.providerMetadata),
              oauth: {
                expiresAt,
                scope: token.scope ?? latestOauth.scope ?? null,
                // Carry the same provenance the grant just recorded. Without it a connection
                // read reverts to a bare scope with no source and no over-grant warning after
                // the first ordinary refresh, while the grant read still has both.
                scopeSource: refreshed.scopeSource,
                unrequestedScopes: refreshed.unrequestedScopes,
                tokenType: token.tokenType,
              },
            },
          };
          await db
            .update(toolConnections)
            .set({
              config: nextConfig,
              transportConfig: nextConfig,
              updatedAt: now(),
            })
            .where(
              and(
                eq(toolConnections.id, latestConnection.id),
                eq(toolConnections.companyId, latestConnection.companyId),
              ),
            );
        }
        const previousKeys = new Set(
          grant.credentialSecretRefs.map(
            (ref) => `${ref.secretId}:${ref.configPath}`,
          ),
        );
        const nextKeys = new Set(
          nextCredentialSecretRefs.map(
            (ref) => `${ref.secretId}:${ref.configPath}`,
          ),
        );
        if (
          previousKeys.size !== nextKeys.size ||
          [...previousKeys].some((key) => !nextKeys.has(key))
        ) {
          const activeGrantRefs = await db
            .select({
              refs: connectionGrants.credentialSecretRefs,
            })
            .from(connectionGrants)
            .where(
              and(
                eq(connectionGrants.companyId, connection.companyId),
                eq(connectionGrants.connectionId, connection.id),
                eq(connectionGrants.status, "active"),
              ),
            );
          await syncCredentialBindings(
            connection,
            activeGrantRefs.flatMap((row) => row.refs),
          );
        }
        return updated;
      } finally {
        await clearOAuthGrantRefreshLease(lease.grant, lease.leaseId).catch(
          () => undefined,
        );
      }
    });
  }
  return refreshOAuthGrantCredentials;
}
