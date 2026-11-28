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

function httpsUrl(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function instanceClientTokenUrlAllowed(
  connection: typeof toolConnections.$inferSelect,
  provider: string,
  tokenUrl: string | null | undefined,
): boolean {
  const target = httpsUrl(tokenUrl);
  if (!target) return false;
  const sourceTemplateKey = connection.config.sourceTemplateKey;
  if (typeof sourceTemplateKey !== "string" || !sourceTemplateKey || provider !== sourceTemplateKey) return false;
  const app = getConnectableAppDefinition(sourceTemplateKey);
  if (!app) return false;
  let method: ReturnType<typeof connectionMethodForConnection>;
  try {
    method = connectionMethodForConnection(app, connection);
  } catch {
    return false;
  }
  if (method.auth !== "oauth" || !method.ownershipModes.includes("customer")) return false;
  const defaults = method.defaults ?? {};
  if (defaults.tokenEndpoint) {
    return httpsUrl(defaults.tokenEndpoint)?.href === target.href;
  }
  const fixedHosts = [defaults.serverUrl, defaults.discoveryUrl, defaults.metadataUrl, defaults.authorizationEndpoint]
    .map((value) => httpsUrl(value))
    .filter((url): url is URL => url !== null)
    .map((url) => url.host.toLowerCase());
  return fixedHosts.includes(target.host.toLowerCase());
}

const REFUSED_DEPLOYMENT_CLIENT_MESSAGE =
  "The sign-in app set up for this Paperclip server can only be used with the app it was set up for. Add a client ID and secret for this server to the connection, then sign in again.";

export function refusedDeploymentClientError(provider: string) {
  if (!oauthClientConfig(provider).clientId) return null;
  return unprocessable(REFUSED_DEPLOYMENT_CLIENT_MESSAGE, { code: "oauth_instance_client_endpoint_mismatch" });
}

export function manualOAuthClientRequiredError(provider: string, message: string) {
  const refused = Boolean(oauthClientConfig(provider).clientId);
  return unprocessable(refused ? REFUSED_DEPLOYMENT_CLIENT_MESSAGE : message, {
    code: "oauth_manual_client_required",
    ...(refused ? { reason: REFUSED_DEPLOYMENT_CLIENT_MESSAGE } : {}),
  });
}

export function configuredOAuthClientForConnection(
  connection: typeof toolConnections.$inferSelect,
  provider: string,
  tokenUrl: string | null | undefined,
) {
  if (isSmokeLabOAuthFixture(connection) && provider === "smoke_lab") {
    return {
      clientIdEnv: "SMOKE_LAB_FIXED_CLIENT_ID",
      clientSecretEnv: "SMOKE_LAB_FIXED_CLIENT_SECRET",
      clientId: "paperclip-smoke-lab",
      clientSecret: null,
    };
  }
  const configured = oauthClientConfig(provider);
  return instanceClientTokenUrlAllowed(connection, provider, tokenUrl)
    ? configured
    : { ...configured, clientId: null, clientSecret: null };
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

export function managedConnectorSubject(
  grant: { kind: string; subjectUserId: string | null; subjectAgentId: string | null },
  oauth: Record<string, unknown>,
): string | null {
  if (grant.kind === "agent" && grant.subjectAgentId) return `agent:${grant.subjectAgentId}`;
  if (grant.kind === "user" && grant.subjectUserId) return grant.subjectUserId;
  return typeof oauth.connectorSubjectUserId === "string" ? oauth.connectorSubjectUserId : null;
}

export function managedConnectorConsentSubject(
  grant: { kind: string; subjectUserId: string | null; subjectAgentId: string | null; providerTenant?: { externalId?: unknown } | null },
  oauth: Record<string, unknown>,
): string | null {
  const consentSubject = grant.providerTenant?.externalId;
  return typeof consentSubject === "string" && consentSubject ? consentSubject : managedConnectorSubject(grant, oauth);
}

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
