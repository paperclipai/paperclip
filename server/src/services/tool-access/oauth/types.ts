import type { ToolConnectionOwnership, ToolConnectionTransport, OAuthEndpointKind } from "@paperclipai/shared";

export type OAuthProviderEndpoints = {
  provider: string;
  scopes: string[];
  /** Refresh permission belongs to authorization-server metadata, not MCP tool scopes. */
  offlineAccessSupported?: boolean;
  authorizationUrl: string;
  tokenUrl: string;
  registrationUrl?: string | null;
  codeChallengeMethodsSupported?: string[];
  tokenEndpointAuthMethodsSupported?: string[];
  grantTypesSupported?: string[];
  grantType?: "authorization_code" | "client_credentials";
  metadataUrl?: string | null;
  /**
   * Canonical authorization-server issuer, when discovery found one. Registered
   * client material is bound to it, `iss` on the callback is validated against
   * it, and reconnect/refresh reuse it instead of re-deriving a provider key.
   */
  issuer?: string | null;
  /**
   * RFC 8707 resource indicator: the MCP endpoint the token is for. Sent on both
   * authorization and token requests so the authorization server can audience-
   * restrict the access token to this server rather than to everything Paperclip
   * has ever connected.
   */
  resource?: string | null;
  /** The authorization server advertised support for Client ID Metadata Documents. */
  clientIdMetadataDocumentSupported?: boolean;
};

/**
 * Where an OAuth client came from, in the preference order the current MCP
 * client-registration guidance recommends (PAP-17087).
 */
export type OAuthClientRegistrationSource =
  "preconfigured" | "cimd" | "dcr" | "manual";

export type OAuthTokenEndpointAuthMethod =
  "none" | "client_secret_basic" | "client_secret_post";

export type OAuthConnectionSettings = {
  config: Record<string, unknown>;
  companyId: string;
  transport: ToolConnectionTransport;
  ownership: ToolConnectionOwnership;
};

export type OAuthTransport = {
  fetchRemoteHttpUrl: (value: string, init?: RequestInit) => Promise<Response>;
  assertOAuthEndpointUrl: (kind: OAuthEndpointKind, value: unknown, options?: { firstPartyOrigin?: string | null }) => string;
};
