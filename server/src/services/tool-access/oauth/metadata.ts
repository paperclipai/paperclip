import type { OAuthConnectionSettings } from "./types.js";
import { remoteEndpoint } from "../connection-methods.js";

export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

/**
 * RFC 8414 §3.1 requires the well-known path to be *inserted between* the
 * issuer host and its path component, but a large amount of deployed software
 * only serves the naive suffix form. OpenID Connect Discovery 1.0 in turn
 * specifies the suffix form. Try all of them for an issuer that has a path, and
 * the plain origin form when it doesn't.
 */
export function wellKnownMetadataUrls(issuer: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    return [];
  }
  const suffixes = ["oauth-authorization-server", "openid-configuration"];
  const path = parsed.pathname.replace(/\/+$/, "");
  const urls: string[] = [];
  for (const suffix of suffixes) {
    if (path) {
      // RFC 8414: https://host/.well-known/<suffix><path>
      urls.push(
        new URL(`/.well-known/${suffix}${path}`, parsed.origin).toString(),
      );
      // OIDC Discovery / widely deployed: https://host<path>/.well-known/<suffix>
      urls.push(
        new URL(`${path}/.well-known/${suffix}`, parsed.origin).toString(),
      );
    }
    urls.push(new URL(`/.well-known/${suffix}`, parsed.origin).toString());
  }
  return [...new Set(urls)];
}

/**
 * Protected-resource metadata lives at `/.well-known/oauth-protected-resource`
 * with the resource's path appended (RFC 9728 §3.1). Probe the path-aware form
 * first so a multi-tenant host that serves several MCP servers resolves to the
 * right one, then fall back to the origin form.
 */
export function protectedResourceMetadataUrls(endpoint: URL): string[] {
  const path = endpoint.pathname.replace(/\/+$/, "");
  const urls: string[] = [];
  if (path)
    urls.push(
      new URL(
        `/.well-known/oauth-protected-resource${path}`,
        endpoint.origin,
      ).toString(),
    );
  urls.push(
    new URL(
      "/.well-known/oauth-protected-resource",
      endpoint.origin,
    ).toString(),
  );
  return [...new Set(urls)];
}

/**
 * Canonical RFC 8707 resource indicator for an MCP endpoint: origin + path, with
 * query, fragment and any trailing slash removed. Vendor query parameters belong
 * to the connection config, not to the token audience.
 */
export function canonicalResourceIndicator(endpoint: string): string | null {
  try {
    const parsed = new URL(endpoint);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${path}`;
  } catch {
    return null;
  }
}

/**
 * Two issuers are the same authorization server only when scheme, host, port and
 * path match exactly (a trailing slash is not significant). Used for `iss`
 * validation on the callback and for detecting that a stored registration is
 * bound to a different server than the one we just discovered.
 */
export function sameOAuthIssuer(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  try {
    const left = new URL(a);
    const right = new URL(b);
    return (
      left.protocol === right.protocol &&
      left.host === right.host &&
      left.pathname.replace(/\/+$/, "") === right.pathname.replace(/\/+$/, "")
    );
  } catch {
    return false;
  }
}

export function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function oauthConfig(connection: Pick<OAuthConnectionSettings, "config">) {
  const oauth = asRecord(connection.config).oauth
    ? asRecord(asRecord(connection.config).oauth)
    : {};
  const {
    access_token: _accessToken,
    refresh_token: _refreshToken,
    accessToken: _camelAccessToken,
    refreshToken: _camelRefreshToken,
    ...metadata
  } = oauth;
  return metadata;
}

export function normalizeOauthScopes(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    );
  if (typeof value === "string")
    return value
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
  return [];
}

/**
 * Decide what a token grant actually carries, keeping the provider's assertion separate from
 * our own request.
 *
 * RFC 6749 §5.1 permits a provider to omit `scope` only when the grant is identical to the
 * request, so reading the request as the grant is the specified fallback. A provider that
 * over-grants *and* omits `scope` breaks that contract, and recording the request unmarked
 * turns what we asked for into a confident-looking record of what we got. `scopeSource` keeps
 * the two readable apart so nothing downstream can mistake an inference for an assertion.
 *
 * `unrequestedScopes` is only meaningful when we asked for something specific; with no
 * requested scopes there is no baseline to compare against, so it stays empty rather than
 * flagging every scope on connections that keep their scopes in provider-side app config.
 *
 * `previous` is the provenance already recorded for this grant. A refresh response that omits
 * `scope` asserts nothing at all — least of all that a permission was taken away — so the
 * earlier record is carried forward verbatim instead of being overwritten with a clean-looking
 * inference. Only a fresh provider assertion replaces a recorded over-grant.
 */
export function resolveGrantedOauthScopes(input: {
  tokenScope: unknown;
  requestedScopes: unknown;
  previous?: {
    scopes?: unknown;
    scopeSource?: unknown;
    unrequestedScopes?: unknown;
  };
}): {
  scopes: string[];
  scopeSource: "provider" | "requested_fallback";
  unrequestedScopes: string[];
} {
  const requested = normalizeOauthScopes(input.requestedScopes);
  const asserted =
    input.tokenScope === undefined || input.tokenScope === null
      ? []
      : normalizeOauthScopes(input.tokenScope);
  if (asserted.length === 0) {
    const previousScopes = normalizeOauthScopes(input.previous?.scopes);
    const previousUnrequested = normalizeOauthScopes(
      input.previous?.unrequestedScopes,
    );
    if (previousScopes.length > 0) {
      return {
        scopes: previousScopes,
        scopeSource:
          input.previous?.scopeSource === "provider"
            ? "provider"
            : "requested_fallback",
        unrequestedScopes: previousUnrequested,
      };
    }
    return {
      scopes: requested,
      scopeSource: "requested_fallback",
      unrequestedScopes: previousUnrequested,
    };
  }
  return {
    scopes: asserted,
    scopeSource: "provider",
    unrequestedScopes:
      requested.length === 0
        ? []
        : asserted.filter((scope) => !requested.includes(scope)),
  };
}

export function isSmokeLabOAuthFixture(
  connection: Pick<OAuthConnectionSettings, "config">,
) {
  const config = asRecord(connection.config);
  const oauth = oauthConfig(connection);
  return (
    config.smokeLabFixture === "oauth-http" && oauth.smokeLabFixture === true
  );
}

export function isSmokeLabOAuthUrl(value: string | null | undefined) {
  if (!value) return false;
  try {
    return /\/smoke-lab\/oauth(?:\/|$)/.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

export function oauthProviderForConnection(
  connection: Pick<OAuthConnectionSettings, "config">,
  metadataUrl?: string | null,
): string {
  const oauth = oauthConfig(connection);
  if (typeof oauth.provider === "string" && oauth.provider.trim())
    return oauth.provider.trim();
  const sourceTemplateKey =
    typeof connection.config.sourceTemplateKey === "string"
      ? connection.config.sourceTemplateKey.trim()
      : "";
  if (sourceTemplateKey) return sourceTemplateKey;
  const url = metadataUrl ?? remoteEndpoint(connection.config);
  try {
    return (
      new URL(url).hostname
        .replace(/[^a-z0-9]+/gi, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase() || "generic"
    );
  } catch {
    return "generic";
  }
}

export function parseWwwAuthenticateParams(value: string): Record<string, string> {
  const params: Record<string, string> = {};
  const input = value.replace(/^\s*Bearer\s+/i, "");
  const re = /([a-zA-Z_][a-zA-Z0-9_-]*)=(?:"([^"]*)"|([^,\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input))) {
    params[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? "";
  }
  return params;
}

export function challengeOAuthHints(wwwAuthenticate: string) {
  const params = parseWwwAuthenticateParams(wwwAuthenticate);
  return {
    metadataUrl:
      params.resource_metadata ??
      params.resource_metadata_url ??
      params.metadata_url ??
      null,
    authorizationUrl:
      params.authorization_uri ?? params.authorization_url ?? null,
    tokenUrl: params.token_uri ?? params.token_url ?? null,
    scope: params.scope ?? null,
  };
}

/**
 * Candidate authorization-server metadata URLs advertised by protected-resource
 * metadata, paired with the issuer that advertised them so the caller can bind
 * the resulting client material to a canonical issuer.
 */
export function authServerMetadataUrls(
  metadata: Record<string, unknown>,
): Array<{ issuer: string; metadataUrl: string }> {
  const candidates: Array<{ issuer: string; metadataUrl: string }> = [];
  const issuers: string[] = [];
  if (Array.isArray(metadata.authorization_servers)) {
    for (const server of metadata.authorization_servers) {
      if (typeof server === "string" && server.trim())
        issuers.push(server.trim());
    }
  }
  if (typeof metadata.issuer === "string" && metadata.issuer.trim())
    issuers.push(metadata.issuer.trim());
  for (const issuer of [...new Set(issuers)]) {
    for (const metadataUrl of wellKnownMetadataUrls(issuer)) {
      candidates.push({ issuer, metadataUrl });
    }
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.metadataUrl)) return false;
    seen.add(candidate.metadataUrl);
    return true;
  });
}

/**
 * Microsoft Entra ID (Azure AD v2.0) requires resources to match the scope prefix
 * and rejects requests containing an RFC 8707 `resource` parameter with AADSTS9010010
 * (error=invalid_target) when scopes are provided.
 *
 * Microsoft v1 endpoints (`/oauth2/authorize`, `/oauth2/token`) use `resource` to select
 * the target API rather than v2-style scopes, so only v2.0 endpoints omit `resource`.
 */
export function isMicrosoftV2OAuthUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isMicrosoftHost =
      host === "login.microsoftonline.com" ||
      host === "login.microsoft.com" ||
      host === "login.windows.net" ||
      host.endsWith(".login.microsoftonline.com");
    if (!isMicrosoftHost) return false;

    return /\/v2\.0(\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Backward compatibility alias for `isMicrosoftV2OAuthUrl`.
 */
export const isMicrosoftOAuthUrl = isMicrosoftV2OAuthUrl;

/**
 * Checks if a target resource belongs to a Microsoft-owned domain.
 */
export function isMicrosoftResourceUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "azure.com" ||
      host.endsWith(".azure.com") ||
      host === "microsoft.com" ||
      host.endsWith(".microsoft.com") ||
      host === "visualstudio.com" ||
      host.endsWith(".visualstudio.com") ||
      host === "office.com" ||
      host.endsWith(".office.com") ||
      host === "windows.net" ||
      host.endsWith(".windows.net") ||
      host === "microsoftonline.com" ||
      host.endsWith(".microsoftonline.com")
    );
  } catch {
    return false;
  }
}

/**
 * Determines whether the RFC 8707 `resource` parameter should be omitted.
 *
 * Microsoft Entra ID v2.0 requires target resources to match the scope prefix
 * and rejects requests containing an RFC 8707 `resource` parameter with AADSTS9010010
 * (error=invalid_target) when scopes are provided.
 *
 * Security guard: We only omit `resource` when the authorization/token endpoint is a
 * Microsoft v2 endpoint AND the target resource is a verified Microsoft-owned resource,
 * and any full-URI scopes align with the resource host. This prevents an attacker-controlled
 * MCP server from advertising a Microsoft authorization server to capture tokens for
 * Microsoft APIs without RFC 8707 audience restriction.
 */
export function shouldOmitMicrosoftResourceIndicator(params: {
  oauthUrl: string | null | undefined;
  resource: string | null | undefined;
  scopes?: string[] | null;
}): boolean {
  if (!params.oauthUrl || !params.resource) return false;
  if (!isMicrosoftV2OAuthUrl(params.oauthUrl)) return false;
  if (!isMicrosoftResourceUrl(params.resource)) return false;

  if (params.scopes && params.scopes.length > 0) {
    let resourceHost: string;
    try {
      resourceHost = new URL(params.resource).hostname.toLowerCase();
    } catch {
      return false;
    }

    for (const scope of params.scopes) {
      if (scope.startsWith("http://") || scope.startsWith("https://")) {
        try {
          const scopeHost = new URL(scope).hostname.toLowerCase();
          if (
            scopeHost !== resourceHost &&
            !resourceHost.endsWith(`.${scopeHost}`) &&
            !scopeHost.endsWith(`.${resourceHost}`)
          ) {
            return false;
          }
        } catch {
          // ignore unparseable scope string
        }
      }
    }
  }

  return true;
}


