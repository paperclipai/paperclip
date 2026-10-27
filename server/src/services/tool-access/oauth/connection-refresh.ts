import type { ActorInfo } from "../types.js";
import { createOAuthClientProtocol, storedOAuthTokenEndpointAuthMethod } from "./client.js";
import { oauthConfig, normalizeOauthScopes } from "./metadata.js";
import { emitConnectionUpdated } from "../../connector-telemetry.js";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets, toolConnections } from "@paperclipai/db";
import { conflict, HttpError, unprocessable } from "../../../errors.js";
import { secretService } from "../../secrets.js";

import type { OAuthCredentialStore } from "./credential-store.js";
import { withoutOAuthRefreshLease, type OAuthRefreshLeases } from "./refresh-leases.js";
import { oauthExpiresAtMs, oauthSecretRef } from "./client-settings.js";
import { connectionSetupUrl, connectionReconnectUrl } from "../identifiers.js";
import { singleFlight } from "../single-flight.js";
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

type LegacyRefreshDependencies = {
  now: () => Date;
  secrets: ReturnType<typeof secretService>;
  store: Pick<OAuthCredentialStore, "createOrRotateOAuthSecret" | "oauthClientForConnection" | "syncCredentialBindings">;
  leases: Pick<OAuthRefreshLeases, "acquireOAuthRefreshLease" | "clearOAuthRefreshLease">;
  getConnectionRow(idOrUid: string, companyId?: string): Promise<typeof toolConnections.$inferSelect>;
  exchangeOAuthToken: ReturnType<typeof createOAuthClientProtocol>["exchangeOAuthToken"];
};

export function createLegacyOAuthRefresh(db: Db, { now, secrets, store, leases, getConnectionRow, exchangeOAuthToken }: LegacyRefreshDependencies) {
  // These maps remove duplicate work inside one service instance. OAuth also
// uses the database refresh lease below as its cross-process boundary.
const oauthRefreshFlights = new Map<string, Promise<unknown>>();
  const { createOrRotateOAuthSecret, oauthClientForConnection, syncCredentialBindings } = store;
  const { acquireOAuthRefreshLease, clearOAuthRefreshLease } = leases;
  async function markOAuthReauthorizationRequired(
    connection: typeof toolConnections.$inferSelect,
    guard: {
      leaseId: string;
      refreshSecretId: string;
      refreshTokenVersion: number;
    },
  ) {
    const oauth = oauthConfig(connection);
    const nextCredentialSecretRefs = connection.credentialSecretRefs.filter(
      (ref) =>
        ref.configPath !== "oauth.access_token" &&
        ref.configPath !== "oauth.refresh_token",
    );
    const nextCredentialRefs = connection.credentialRefs.filter(
      (ref) => ref.name !== "oauth.access_token",
    );
    const nextConfig = {
      ...connection.config,
      oauth: {
        ...withoutOAuthRefreshLease(oauth),
        expiresAt: null,
        reauthorizationRequiredAt: now().toISOString(),
      },
    };
    const [updated] = await db
      .update(toolConnections)
      .set({
        status: "draft",
        enabled: false,
        healthStatus: "error",
        healthMessage:
          "OAuth authorization expired. Reconnect this app to continue.",
        lastError: "oauth_reauthorization_required",
        config: nextConfig,
        transportConfig: nextConfig,
        credentialSecretRefs: nextCredentialSecretRefs,
        credentialRefs: nextCredentialRefs,
        updatedAt: now(),
      })
      .where(
        and(
          eq(toolConnections.id, connection.id),
          eq(toolConnections.companyId, connection.companyId),
          sql`${toolConnections.config} -> 'oauth' -> 'refreshLease' ->> 'id' = ${guard.leaseId}`,
          sql`exists (
          select 1 from ${companySecrets}
          where ${companySecrets.id} = ${guard.refreshSecretId}
            and ${companySecrets.companyId} = ${connection.companyId}
            and ${companySecrets.latestVersion} = ${guard.refreshTokenVersion}
        )`,
        ),
      )
      .returning();
    if (updated) {
      await syncCredentialBindings(updated);
      emitConnectionUpdated(updated, connection, "credential_refresh");
    }
    return updated ?? null;
  }

  async function refreshOAuthCredentials(
    connection: typeof toolConnections.$inferSelect,
    leaseId: string,
    actor?: ActorInfo,
    accessContext?: {
      actorSource?:
        | "local_implicit"
        | "session"
        | "board_key"
        | "agent_key"
        | "agent_jwt"
        | "mcp_oauth"
        | "cloud_tenant";
      issueId?: string | null;
      heartbeatRunId?: string | null;
    },
  ): Promise<typeof toolConnections.$inferSelect> {
    const oauth = oauthConfig(connection);
    if (
      typeof oauth.tokenUrl !== "string" ||
      typeof oauth.provider !== "string"
    )
      return connection;
    const expiresAtMs = oauthExpiresAtMs(connection);
    if (expiresAtMs && expiresAtMs > Date.now() + 60_000) return connection;
    const grantType =
      oauth.grantType === "client_credentials" ||
      oauth.clientCredentials === true
        ? ("client_credentials" as const)
        : ("refresh_token" as const);
    const refreshRef = oauthSecretRef(connection, "oauth.refresh_token");
    if (grantType !== "client_credentials" && !refreshRef) {
      throw new HttpError(
        422,
        "OAuth credentials have expired and no refresh token is available",
        {
          code: "oauth_refresh_missing",
          setupUrl: connectionSetupUrl(connection),
          reconnectUrl: connectionReconnectUrl(connection),
        },
      );
    }
    const client = await oauthClientForConnection(
      connection,
      oauth.provider,
      actor,
    );
    if (!client.clientId)
      throw unprocessable(
        `OAuth client id is not configured for ${oauth.provider}`,
      );
    const [refreshSecret] = refreshRef
      ? await db
          .select({ latestVersion: companySecrets.latestVersion })
          .from(companySecrets)
          .where(
            and(
              eq(companySecrets.id, refreshRef.secretId),
              eq(companySecrets.companyId, connection.companyId),
            ),
          )
          .limit(1)
      : [undefined];
    const refreshTokenVersion = refreshSecret?.latestVersion ?? null;
    const refreshToken =
      refreshRef && refreshTokenVersion !== null
        ? await secrets.resolveSecretValue(
            connection.companyId,
            refreshRef.secretId,
            refreshTokenVersion,
            {
              consumerType: "tool_connection",
              consumerId: connection.id,
              configPath: "oauth.refresh_token",
              actorType: actor?.actorType ?? "system",
              actorId: actor?.actorId ?? null,
              actorSource: accessContext?.actorSource,
              issueId: accessContext?.issueId,
              heartbeatRunId: accessContext?.heartbeatRunId,
            },
          )
        : null;
    let token: Awaited<ReturnType<typeof exchangeOAuthToken>>;
    try {
      token = await exchangeOAuthToken({
        tokenUrl: oauth.tokenUrl,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        tokenEndpointAuthMethod: storedOAuthTokenEndpointAuthMethod(
          oauth,
          client.clientSecret,
        ),
        grantType,
        scopes:
          normalizeOauthScopes(oauth.scopes).length > 0
            ? normalizeOauthScopes(oauth.scopes)
            : normalizeOauthScopes(oauth.scope),
        refreshToken,
        // Refreshing must stay bound to the same MCP server the original grant
        // named, or the authorization server may widen the token's audience.
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
        const marked =
          refreshRef && refreshTokenVersion !== null
            ? await markOAuthReauthorizationRequired(connection, {
                leaseId,
                refreshSecretId: refreshRef.secretId,
                refreshTokenVersion,
              })
            : null;
        if (!marked) {
          const latest = await getConnectionRow(
            connection.id,
            connection.companyId,
          );
          const latestExpiresAtMs = oauthExpiresAtMs(latest);
          if (latestExpiresAtMs && latestExpiresAtMs > Date.now() + 60_000)
            return latest;
          throw conflict(
            "OAuth credentials changed while refresh was in progress. Retry the request.",
            {
              code: "oauth_refresh_superseded",
              retryable: true,
            },
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
    // Rotating providers invalidate the submitted refresh token immediately.
    // Persist its replacement before the new access token can be returned to a
    // caller, so a crash cannot leave the grant with only the consumed token.
    let nextRefreshRef: Awaited<
      ReturnType<typeof createOrRotateOAuthSecret>
    > | null = null;
    if (token.refreshToken) {
      nextRefreshRef = await createOrRotateOAuthSecret({
        companyId: connection.companyId,
        connection,
        configPath: "oauth.refresh_token",
        label: "OAuth refresh token",
        value: token.refreshToken,
        actor,
      });
    }
    const accessRef = await createOrRotateOAuthSecret({
      companyId: connection.companyId,
      connection,
      configPath: "oauth.access_token",
      label: "OAuth access token",
      value: token.accessToken,
      actor,
    });
    const nextCredentialSecretRefs = [
      ...connection.credentialSecretRefs.filter(
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
    const nextConfig = {
      ...connection.config,
      oauth: {
        ...withoutOAuthRefreshLease(oauth),
        grantType:
          grantType === "client_credentials"
            ? grantType
            : (oauth.grantType ?? "authorization_code"),
        expiresAt,
        scope: token.scope ?? oauth.scope ?? null,
        tokenType: token.tokenType,
        refreshedAt: new Date().toISOString(),
      },
      providerMetadata: {
        ...asRecord(connection.config.providerMetadata),
        oauth: {
          expiresAt,
          scope: token.scope ?? oauth.scope ?? null,
          tokenType: token.tokenType,
        },
      },
    };
    const [updated] = await db
      .update(toolConnections)
      .set({
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
      .where(
        and(
          eq(toolConnections.id, connection.id),
          eq(toolConnections.companyId, connection.companyId),
          sql`${toolConnections.config} -> 'oauth' -> 'refreshLease' ->> 'id' = ${leaseId}`,
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
    const previousBindingKeys = new Set(
      connection.credentialSecretRefs.map(
        (ref) => `${ref.secretId}:${ref.configPath}`,
      ),
    );
    const nextBindingKeys = new Set(
      nextCredentialSecretRefs.map(
        (ref) => `${ref.secretId}:${ref.configPath}`,
      ),
    );
    const bindingsChanged =
      previousBindingKeys.size !== nextBindingKeys.size ||
      [...previousBindingKeys].some((key) => !nextBindingKeys.has(key));
    if (bindingsChanged) await syncCredentialBindings(updated);
    return updated;
  }

  async function maybeRefreshOAuthCredentials(
    connection: typeof toolConnections.$inferSelect,
    actor?: ActorInfo,
    accessContext?: {
      actorSource?:
        | "local_implicit"
        | "session"
        | "board_key"
        | "agent_key"
        | "agent_jwt"
        | "mcp_oauth"
        | "cloud_tenant";
      issueId?: string | null;
      heartbeatRunId?: string | null;
    },
  ): Promise<typeof toolConnections.$inferSelect> {
    await actor?.managementContext?.reauthorize();
    const oauth = oauthConfig(connection);
    if (
      typeof oauth.tokenUrl !== "string" ||
      typeof oauth.provider !== "string"
    )
      return connection;
    const expiresAtMs = oauthExpiresAtMs(connection);
    if (expiresAtMs && expiresAtMs > Date.now() + 60_000) return connection;
    return singleFlight(oauthRefreshFlights, connection.id, async () => {
      const lease = await acquireOAuthRefreshLease(connection);
      if (!lease.leaseId) return lease.connection;
      try {
        return await refreshOAuthCredentials(
          lease.connection,
          lease.leaseId,
          actor,
          accessContext,
        );
      } finally {
        await clearOAuthRefreshLease(lease.connection, lease.leaseId).catch(
          () => undefined,
        );
      }
    });
  }
  return maybeRefreshOAuthCredentials;
}
