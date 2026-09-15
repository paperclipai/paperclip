import { createHash } from "node:crypto";
import {
  ConnectError,
  ConnectorInstallationRequiredError,
  NoValidTokenError,
  UserAuthorizationRequiredError,
  deleteTokenCacheEntry,
  getConnectorMetadata,
  getTokenResponse,
  revokeToken,
  startAuthorization,
  type ConnectAuthorizationResponse,
  type ConnectorMetadata,
  type ConnectTokenParams,
  type ConnectTokenResponse,
  type ConnectTokenSubject,
} from "@vercel/connect";
import type {
  ConnectionGrantKind,
  VercelConnectCredentialReference,
  VercelConnectGrantReference,
} from "@paperclipai/shared";

export type VercelConnectFailureCode =
  | "vercel_connect_unavailable"
  | "vercel_connect_auth_failed"
  | "vercel_connect_connector_not_found"
  | "vercel_connect_authorization_required"
  | "vercel_connect_installation_required"
  | "vercel_connect_request_failed";

export class VercelConnectClientError extends Error {
  constructor(
    readonly code: VercelConnectFailureCode,
    readonly status: number,
  ) {
    super(vercelConnectFailureMessage(code));
    this.name = "VercelConnectClientError";
  }
}

export function vercelConnectFailureMessage(code: VercelConnectFailureCode): string {
  switch (code) {
    case "vercel_connect_unavailable":
      return "Vercel Connect is not configured on this Paperclip instance.";
    case "vercel_connect_auth_failed":
      return "Paperclip could not authenticate to Vercel Connect. Repair or refresh the instance's Vercel authority.";
    case "vercel_connect_connector_not_found":
      return "Vercel Connect could not find an attached connector with that UID.";
    case "vercel_connect_authorization_required":
      return "This Vercel Connect identity needs authorization.";
    case "vercel_connect_installation_required":
      return "This connector must be installed or attached in Vercel before Paperclip can use it.";
    default:
      return "Vercel Connect could not complete the credential request.";
  }
}

export type VercelConnectTokenRequest = {
  connector: string;
  subject: ConnectTokenSubject;
  scopes: string[];
  resources?: string[];
  installationId?: string;
};

export interface VercelConnectClient {
  getConnectorMetadata(connector: string): Promise<ConnectorMetadata>;
  getToken(input: VercelConnectTokenRequest, options?: { forceRefresh?: boolean }): Promise<ConnectTokenResponse>;
  startAuthorization(input: VercelConnectTokenRequest, callbackUrl: string): Promise<ConnectAuthorizationResponse>;
  revoke(input: VercelConnectTokenRequest): Promise<void>;
  evict(input: VercelConnectTokenRequest): void;
}

function enabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

export function vercelConnectIntegrationStatus(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  configured: boolean;
  authentication: "workload_oidc" | "access_token" | null;
  manageUrl: string;
} {
  const integrationEnabled = enabled(env.PAPERCLIP_VERCEL_CONNECT_ENABLED);
  const hasAccessToken = Boolean(env.PAPERCLIP_VERCEL_CONNECT_ACCESS_TOKEN?.trim());
  const hasWorkloadOidc = Boolean(env.VERCEL_OIDC_TOKEN?.trim());
  return {
    enabled: integrationEnabled,
    // Resolution stays available for existing connections when new setup is
    // disabled. The feature flag gates creation, not already-authorized calls.
    configured: hasWorkloadOidc || hasAccessToken,
    authentication: hasWorkloadOidc ? "workload_oidc" : hasAccessToken ? "access_token" : null,
    manageUrl: "https://vercel.com/connect",
  };
}

/**
 * Vercel permits plaintext callbacks only on the literal `localhost` host.
 * Paperclip's local board commonly runs on 127.0.0.1, which is the same
 * loopback boundary but Vercel rejects it before authorization starts.
 */
export function vercelConnectCallbackUrl(redirectUri: string, state: string): string {
  const callbackUrl = new URL(redirectUri);
  if (
    callbackUrl.protocol === "http:"
    && (callbackUrl.hostname === "127.0.0.1" || callbackUrl.hostname === "[::1]")
  ) {
    callbackUrl.hostname = "localhost";
  }
  callbackUrl.pathname = "/api/tools/vercel-connect/callback";
  callbackUrl.search = new URLSearchParams({ state }).toString();
  callbackUrl.hash = "";
  return callbackUrl.toString();
}

export function vercelConnectSdkOptions(
  env: NodeJS.ProcessEnv = process.env,
  forceRefresh?: boolean,
): { vercelToken?: string; forceRefresh?: boolean } {
  // Passing `vercelToken` makes the SDK use that token instead of workload
  // OIDC. Keep the configured access token strictly as a fallback so a stale
  // bootstrap token cannot shadow a healthy Vercel-injected identity.
  const hasWorkloadOidc = Boolean(env.VERCEL_OIDC_TOKEN?.trim());
  const vercelToken = hasWorkloadOidc
    ? undefined
    : env.PAPERCLIP_VERCEL_CONNECT_ACCESS_TOKEN?.trim();
  return {
    ...(vercelToken ? { vercelToken } : {}),
    ...(forceRefresh ? { forceRefresh: true } : {}),
  };
}

function tokenParams(input: VercelConnectTokenRequest): ConnectTokenParams {
  return {
    subject: input.subject,
    scopes: input.scopes,
    ...(input.resources?.length ? { resources: input.resources } : {}),
    ...(input.installationId ? { installationId: input.installationId } : {}),
  };
}

function mapSdkError(error: unknown): VercelConnectClientError {
  if (error instanceof UserAuthorizationRequiredError || error instanceof NoValidTokenError) {
    return new VercelConnectClientError("vercel_connect_authorization_required", 409);
  }
  if (error instanceof ConnectorInstallationRequiredError) {
    return new VercelConnectClientError("vercel_connect_installation_required", 409);
  }
  if (error instanceof ConnectError) {
    if (error.status === 401 || error.status === 403) {
      return new VercelConnectClientError("vercel_connect_auth_failed", 503);
    }
    if (error.status === 404) {
      return new VercelConnectClientError("vercel_connect_connector_not_found", 422);
    }
  }
  return new VercelConnectClientError("vercel_connect_request_failed", 502);
}

export function createVercelConnectClient(): VercelConnectClient {
  const flights = new Map<string, Promise<ConnectTokenResponse>>();
  const assertConfigured = () => {
    if (!vercelConnectIntegrationStatus().configured) {
      throw new VercelConnectClientError("vercel_connect_unavailable", 503);
    }
  };
  return {
    async getConnectorMetadata(connector) {
      assertConfigured();
      try {
        return await getConnectorMetadata(connector, vercelConnectSdkOptions());
      } catch (error) {
        throw mapSdkError(error);
      }
    },
    async getToken(input, options = {}) {
      assertConfigured();
      const params = tokenParams(input);
      const key = JSON.stringify([input.connector, params, options.forceRefresh === true]);
      const existing = flights.get(key);
      if (existing) return existing;
      const request = getTokenResponse(
        input.connector,
        params,
        vercelConnectSdkOptions(process.env, options.forceRefresh),
      ).catch((error: unknown) => {
        throw mapSdkError(error);
      });
      flights.set(key, request);
      try {
        return await request;
      } finally {
        if (flights.get(key) === request) flights.delete(key);
      }
    },
    async startAuthorization(input, callbackUrl) {
      assertConfigured();
      try {
        return await startAuthorization(input.connector, tokenParams(input), {
          ...vercelConnectSdkOptions(),
          callbackUrl,
        });
      } catch (error) {
        throw mapSdkError(error);
      }
    },
    async revoke(input) {
      assertConfigured();
      try {
        await revokeToken(input.connector, {
          subject: input.subject,
          ...(input.installationId ? { installationId: input.installationId } : {}),
        }, vercelConnectSdkOptions());
      } catch (error) {
        throw mapSdkError(error);
      }
    },
    evict(input) {
      deleteTokenCacheEntry(input.connector, tokenParams(input));
    },
  };
}

function subjectHash(parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("base64url").slice(0, 43);
}

/** Subjects are deterministic, company-bound and never accepted from clients. */
export function deriveVercelConnectSubject(input: {
  credential: VercelConnectCredentialReference;
  connectionId: string;
  companyId: string;
  grantKind: ConnectionGrantKind;
  subjectUserId?: string | null;
}): { subject: ConnectTokenSubject; subjectId?: string } {
  if (input.credential.principalMode === "app") return { subject: { type: "app" } };
  const instanceId = process.env.PAPERCLIP_INSTANCE_ID
    ?? process.env.PAPERCLIP_DEPLOYMENT_ID
    ?? "paperclip-instance";
  const subjectId = `pc_${subjectHash([
    instanceId,
    input.companyId,
    input.connectionId,
    input.grantKind,
    input.grantKind === "user" ? input.subjectUserId ?? "missing-user" : "organization",
  ])}`;
  return { subject: { type: "user", id: subjectId }, subjectId };
}

export function vercelTokenRequest(input: {
  credential: VercelConnectCredentialReference;
  grant: { kind: ConnectionGrantKind; subjectUserId: string | null; externalCredential?: VercelConnectGrantReference | null };
  connectionId: string;
  companyId: string;
  resources?: string[];
}): VercelConnectTokenRequest {
  const derived = deriveVercelConnectSubject({
    credential: input.credential,
    connectionId: input.connectionId,
    companyId: input.companyId,
    grantKind: input.grant.kind,
    subjectUserId: input.grant.subjectUserId,
  });
  return {
    connector: input.credential.connectorUid,
    subject: derived.subject,
    scopes: input.credential.scopes,
    ...(input.resources?.length ? { resources: input.resources } : {}),
    ...(input.grant.externalCredential?.installationId
      ? { installationId: input.grant.externalCredential.installationId }
      : {}),
  };
}

export function vercelGrantReference(input: {
  credential: VercelConnectCredentialReference;
  token: ConnectTokenResponse;
  subjectId?: string;
  verifiedAt?: Date;
}): VercelConnectGrantReference {
  return {
    provider: "vercel_connect",
    subjectType: input.credential.principalMode,
    ...(input.subjectId ? { subjectId: input.subjectId } : {}),
    ...(input.token.installationId ? { installationId: input.token.installationId } : {}),
    ...(input.token.tenantId ? { tenantId: input.token.tenantId } : {}),
    ...(input.token.tokenId ? { tokenId: input.token.tokenId } : {}),
    expiresAt: new Date(input.token.expiresAt).toISOString(),
    lastVerifiedAt: (input.verifiedAt ?? new Date()).toISOString(),
  };
}
