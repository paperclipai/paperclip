import { connectionActorUserId } from "./actor.js";
import type { ActorInfo } from "./types.js";
import { oauthConfig } from "./oauth/metadata.js";
import { remoteEndpoint } from "./connection-methods.js";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, toolConnections } from "@paperclipai/db";
import { badRequest, HttpError, unprocessable } from "../../errors.js";
import { parseRemoteHttpEndpoint } from "../remote-http-endpoint-guard.js";
import { REMOTE_URL_SECRET_CONFIG_PATH, remoteUrlCredentialMatchesPublicUrl } from "../remote-url-credentials.js";
import { secretService } from "../secrets.js";
import { connectionCredentialConfigPath as credentialRefConfigPath, connectionGrantCredentialRef } from "../connection-credentials.js";

import type { ToolAccessAudit } from "./audit.js";
import type { VercelCredentialService } from "./vercel-credentials.js";
import type { OAuthCredentialStore } from "./oauth/credential-store.js";
import type { createLegacyOAuthRefresh } from "./oauth/connection-refresh.js";
import type { createOAuthGrantRefresh } from "./oauth/grant-refresh.js";
import { credentialScope } from "./oauth/client-settings.js";
import { connectionSetupUrl, connectionReconnectUrl } from "./identifiers.js";
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

type CredentialAccessDependencies = {
  secrets: ReturnType<typeof secretService>;
  audit: ToolAccessAudit;
  vercel: VercelCredentialService;
  resolveOAuthGrantSecret: OAuthCredentialStore["resolveOAuthGrantSecret"];
  maybeRefreshOAuthCredentials: ReturnType<typeof createLegacyOAuthRefresh>;
  refreshOAuthGrantCredentials: ReturnType<typeof createOAuthGrantRefresh>;
};

export function createConnectionCredentialAccess(db: Db, { secrets, audit, vercel, resolveOAuthGrantSecret, maybeRefreshOAuthCredentials, refreshOAuthGrantCredentials }: CredentialAccessDependencies) {
  const { resolveVercelCredentialHeaders, vercelGrantForConnection } = vercel;
  async function vaultGrantForConnection(
    connection: typeof toolConnections.$inferSelect,
    actor?: ActorInfo,
  ): Promise<typeof connectionGrants.$inferSelect | null> {
    const actorUserId =
      connectionActorUserId(actor);
    if (actorUserId) {
      const [personal] = await db
        .select()
        .from(connectionGrants)
        .where(
          and(
            eq(connectionGrants.companyId, connection.companyId),
            eq(connectionGrants.connectionId, connection.id),
            eq(connectionGrants.kind, "user"),
            eq(connectionGrants.subjectUserId, actorUserId),
          ),
        )
        .limit(1);
      if (personal) {
        if (personal.status !== "active") {
          throw unprocessable("OAuth authorization must be reconnected", {
            code: "oauth_reauthorization_required",
            setupUrl: connectionSetupUrl(connection),
            reconnectUrl: connectionReconnectUrl(connection),
          });
        }
        return personal;
      }
    }
    if (!actorUserId && connection.credentialPolicy === "per_user") {
      // A personal-only connection is intentionally fixed to one identity.
      // Background health/catalog checks have no acting user, but may safely
      // exercise that sole owner-bound grant without turning it into a shared
      // credential or making it available to a different caller.
      const personalGrants = await db
        .select()
        .from(connectionGrants)
        .where(
          and(
            eq(connectionGrants.companyId, connection.companyId),
            eq(connectionGrants.connectionId, connection.id),
            eq(connectionGrants.kind, "user"),
            eq(connectionGrants.status, "active"),
          ),
        )
        .limit(2);
      if (personalGrants.length === 1) return personalGrants[0]!;
    }
    if (connection.credentialPolicy === "per_user") {
      throw unprocessable(
        "This connection needs the current user's authorization",
        {
          code: "user_authorization_required",
          setupUrl: connectionSetupUrl(connection),
          reconnectUrl: connectionReconnectUrl(connection),
        },
      );
    }
    const [organization] = await db
      .select()
      .from(connectionGrants)
      .where(
        and(
          eq(connectionGrants.companyId, connection.companyId),
          eq(connectionGrants.connectionId, connection.id),
          eq(connectionGrants.kind, "organization"),
          eq(connectionGrants.isDefault, true),
        ),
      )
      .limit(1);
    if (organization?.status === "active") return organization;
    return null;
  }

  async function resolveCredentialHeaders(
    connection: typeof toolConnections.$inferSelect,
    actor?: ActorInfo,
    options: { forceRefresh?: boolean } = {},
  ): Promise<Record<string, string>> {
    if (connection.credentialSource === "vercel_connect") {
      const grant = await vercelGrantForConnection(connection, actor);
      return resolveVercelCredentialHeaders(connection, grant, options);
    }
    let grant: typeof connectionGrants.$inferSelect | null = null;
    try {
      if (
        connection.authKind === "oauth" ||
        connection.credentialPolicy !== "shared"
      ) {
        grant = await vaultGrantForConnection(connection, actor);
      }
      if (connection.authKind === "oauth" && grant) {
        grant = await refreshOAuthGrantCredentials({
          companyId: connection.companyId,
          connectionId: connection.id,
          grantId: grant.id,
          forceRefresh: options.forceRefresh,
          actor,
        });
      } else {
        connection = await maybeRefreshOAuthCredentials(connection, actor);
      }
    } catch (error) {
      const scope = credentialScope(connection);
      await audit({
        companyId: connection.companyId,
        connectionId: connection.id,
        action: "tool_connection.credential_resolution",
        outcome: "failure",
        reasonCode:
          error instanceof HttpError
            ? String(asRecord(error.details).code ?? "oauth_refresh_failed")
            : "oauth_refresh_failed",
        details: {
          credentialCount: connection.credentialRefs.length,
          credentialSecretRefCount: connection.credentialSecretRefs.length,
          credentialScopeType: scope.type,
          credentialScopeHash: scope.hash,
          setupUrl: connectionSetupUrl(connection),
          reconnectUrl: connectionReconnectUrl(connection),
        },
      });
      throw error;
    }
    const headers: Record<string, string> = {};
    const scope = credentialScope(connection);
    for (const ref of connection.credentialRefs) {
      if (ref.placement !== "header") continue;
      let value: string;
      const configPath = credentialRefConfigPath(ref);
      try {
        const grantRef = grant ? connectionGrantCredentialRef(grant, ref) : undefined;
        if (grant && !grantRef) throw unprocessable("Your credential is missing. Reconnect this connection.", {
          code: "grant_credential_invalid", connectionId: connection.id, grantId: grant.id, credential: configPath,
        });
        value =
          grantRef && grant
            ? (
                await resolveOAuthGrantSecret(
                  connection,
                  grant,
                  grantRef,
                  actor,
                  undefined,
                )
              ).value
            : await secrets.resolveSecretValue(
                connection.companyId,
                ref.secretId,
                ref.version ?? "latest",
                {
                  consumerType: "tool_connection",
                  consumerId: connection.id,
                  configPath,
                  actorType: "system",
                },
              );
      } catch (error) {
        await audit({
          companyId: connection.companyId,
          connectionId: connection.id,
          action: "tool_connection.credential_resolution",
          outcome: "failure",
          reasonCode:
            error instanceof HttpError
              ? String(
                  asRecord(error.details).code ?? "secret_resolution_failed",
                )
              : "secret_resolution_failed",
          details: {
            credentialCount: connection.credentialRefs.length,
            credentialScopeType: scope.type,
            credentialScopeHash: scope.hash,
          },
        });
        throw error;
      }
      if (ref.placement === "header") {
        headers[ref.key] = `${ref.prefix ?? ""}${value}`;
      }
    }
    const oauthAccessRef = grant?.credentialSecretRefs.find(
      (ref) => ref.configPath === "oauth.access_token",
    );
    if (oauthAccessRef && headers.Authorization === undefined) {
      headers.Authorization = `Bearer ${
        (
          await resolveOAuthGrantSecret(
            connection,
            grant!,
            oauthAccessRef,
            actor,
            undefined,
          )
        ).value
      }`;
    }
    if (
      connection.credentialRefs.length > 0 ||
      connection.credentialSecretRefs.length > 0 ||
      Object.keys(oauthConfig(connection)).length > 0
    ) {
      await audit({
        companyId: connection.companyId,
        connectionId: connection.id,
        action: "tool_connection.credential_resolution",
        outcome: "success",
        details: {
          credentialCount: connection.credentialRefs.length,
          credentialSecretRefCount: connection.credentialSecretRefs.length,
          credentialScopeType: scope.type,
          credentialScopeHash: scope.hash,
        },
      });
    }
    return headers;
  }

  async function resolvedRemoteEndpoint(
    connection: typeof toolConnections.$inferSelect,
    actor?: ActorInfo,
  ): Promise<string> {
    const publicEndpoint = remoteEndpoint(connection.config);
    const ref = connection.credentialRefs.find(
      (candidate) => candidate.placement === "url",
    );
    if (!ref) return publicEndpoint;
    let value: string;
    try {
      const grant = await vaultGrantForConnection(connection, actor);
      const grantRef = grant ? connectionGrantCredentialRef(grant, ref) : undefined;
      if (grant && !grantRef) throw unprocessable("Your MCP URL credential is missing. Reconnect this connection.", {
        code: "grant_credential_invalid", connectionId: connection.id, grantId: grant.id,
      });
      value = grant && grantRef
        ? (await resolveOAuthGrantSecret(connection, grant, grantRef, actor, undefined)).value
        : await secrets.resolveSecretValue(connection.companyId, ref.secretId, ref.version ?? "latest", {
            consumerType: "tool_connection", consumerId: connection.id,
            configPath: REMOTE_URL_SECRET_CONFIG_PATH,
            actorType: actor?.actorType ?? "system", actorId: actor?.actorId ?? null,
          });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw unprocessable("Your MCP URL credential could not be resolved. Reconnect this connection.", {
        code: "mcp_remote_missing_secret", connectionId: connection.id, credential: REMOTE_URL_SECRET_CONFIG_PATH,
      });
    }
    if (!remoteUrlCredentialMatchesPublicUrl(publicEndpoint, value)) {
      throw unprocessable(
        "The stored MCP URL credential no longer matches this connection.",
        {
          code: "mcp_remote_url_credential_mismatch",
          connectionId: connection.id,
        },
      );
    }
    return parseRemoteHttpEndpoint(value, (message, code) =>
      badRequest(message, { code }),
    ).toString();
  }
  return { vaultGrantForConnection, resolveCredentialHeaders, resolvedRemoteEndpoint };
}

export type ConnectionCredentialAccess = ReturnType<typeof createConnectionCredentialAccess>;
