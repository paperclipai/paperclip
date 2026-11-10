import type { ActorInfo } from "../types.js";
import { oauthConfig, isSmokeLabOAuthFixture } from "./metadata.js";
import { connectionMethodForConnection } from "../connection-methods.js";
import { stableHash } from "../../tool-catalog-hash.js";
import { ASANA_CONNECTOR_SCOPES, isAsanaConnectorProfileId, type AsanaConnectorProfileId } from "@paperclipai/shared";
import { connectionGrants, toolConnections } from "@paperclipai/db";
import { GITHUB_CONNECTOR_PROFILES, GOOGLE_WORKSPACE_CONNECTOR_PROFILES, getConnectableAppDefinition, isGitHubConnectorProfileId, isGoogleWorkspaceConnectorProfileId, type GitHubConnectorProfileId, type GoogleWorkspaceConnectorProfileId } from "@paperclipai/shared";
import { unprocessable } from "../../../errors.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

export function oauthEnvName(
  provider: string,
  suffix: "CLIENT_ID" | "CLIENT_SECRET",
) {
  return `PAPERCLIP_TOOL_OAUTH_${provider.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_${suffix}`;
}

export function oauthClientConfig(provider: string) {
  const clientIdEnv = oauthEnvName(provider, "CLIENT_ID");
  const clientSecretEnv = oauthEnvName(provider, "CLIENT_SECRET");
  return {
    clientIdEnv,
    clientSecretEnv,
    clientId:
      process.env[clientIdEnv] ??
      process.env.PAPERCLIP_TOOL_OAUTH_CLIENT_ID ??
      null,
    clientSecret:
      process.env[clientSecretEnv] ??
      process.env.PAPERCLIP_TOOL_OAUTH_CLIENT_SECRET ??
      null,
  };
}

export function configuredOAuthClientForConnection(
  connection: typeof toolConnections.$inferSelect,
  provider: string,
) {
  if (isSmokeLabOAuthFixture(connection) && provider === "smoke_lab") {
    return {
      clientIdEnv: "SMOKE_LAB_FIXED_CLIENT_ID",
      clientSecretEnv: "SMOKE_LAB_FIXED_CLIENT_SECRET",
      clientId: "paperclip-smoke-lab",
      clientSecret: null,
    };
  }
  return oauthClientConfig(provider);
}

export function credentialScope(
  connection: typeof toolConnections.$inferSelect,
  actor?: ActorInfo,
) {
  const configured = asRecord(oauthConfig(connection).credentialScope);
  const type =
    typeof configured.type === "string"
      ? configured.type
      : typeof configured.targetType === "string"
        ? configured.targetType
        : actor?.actorType === "agent"
          ? "agent"
          : actor?.actorType === "user"
            ? "user"
            : "company";
  const id =
    typeof configured.id === "string"
      ? configured.id
      : typeof configured.targetId === "string"
        ? configured.targetId
        : (actor?.actorId ?? connection.companyId);
  return {
    type,
    id,
    hash: stableHash({
      companyId: connection.companyId,
      connectionId: connection.id,
      type,
      id,
    }),
  };
}

export function oauthSecretRef(
  connection: typeof toolConnections.$inferSelect,
  configPath:
    "oauth.access_token" | "oauth.refresh_token" | "oauth.client_secret" | "railway.ssh_private_key",
) {
  return (
    connection.credentialSecretRefs.find(
      (ref) => ref.configPath === configPath,
    ) ?? null
  );
}

export function oauthExpiresAtMs(
  connection: typeof toolConnections.$inferSelect,
): number | null {
  const expiresAt = oauthConfig(connection).expiresAt;
  if (typeof expiresAt !== "string") return null;
  const ms = Date.parse(expiresAt);
  return Number.isFinite(ms) ? ms : null;
}

export async function oauthGalleryEntryForConnection(
  connection: typeof toolConnections.$inferSelect,
) {
  const sourceTemplateKey =
    typeof connection.config.sourceTemplateKey === "string"
      ? connection.config.sourceTemplateKey
      : null;
  if (!sourceTemplateKey)
    throw unprocessable(
      "This app connection was not created from the app gallery",
    );
  const galleryEntry = getConnectableAppDefinition(sourceTemplateKey);
  if (
    !galleryEntry ||
    connectionMethodForConnection(galleryEntry, connection).auth !== "oauth"
  ) {
    throw unprocessable("This app connection does not use sign in");
  }
  return galleryEntry;
}

export type ManagedConnectorProfileId =
  GoogleWorkspaceConnectorProfileId | GitHubConnectorProfileId | AsanaConnectorProfileId;

export function managedConnectorProfile(value: string | undefined): {
  id: ManagedConnectorProfileId;
  provider: "google" | "github" | "asana";
  scopes: readonly string[];
} | null {
  if (value && isAsanaConnectorProfileId(value)) {
    return { id: value, provider: "asana", scopes: ASANA_CONNECTOR_SCOPES };
  }
  if (value && isGoogleWorkspaceConnectorProfileId(value)) {
    return {
      id: value,
      provider: "google",
      scopes: GOOGLE_WORKSPACE_CONNECTOR_PROFILES[value].scopes,
    };
  }
  if (value && isGitHubConnectorProfileId(value)) {
    return {
      id: value,
      provider: "github",
      scopes: GITHUB_CONNECTOR_PROFILES[value].scopes,
    };
  }
  return null;
}

export function oauthGrantConfig(grant: typeof connectionGrants.$inferSelect) {
  return asRecord(asRecord(grant.providerTenant).oauth);
}

export function oauthGrantExpiresAtMs(
  grant: typeof connectionGrants.$inferSelect,
  connection: typeof toolConnections.$inferSelect,
): number | null {
  const grantExpiresAt = oauthGrantConfig(grant).accessTokenExpiresAt;
  const value =
    typeof grantExpiresAt === "string"
      ? grantExpiresAt
      : oauthConfig(connection).expiresAt;
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
