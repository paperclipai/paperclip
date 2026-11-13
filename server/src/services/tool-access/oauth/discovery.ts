import { getConnectableAppDefinition, type AppDefinition, type ConnectionMethodDef, type ToolAppMetadataPreflightResult } from "@paperclipai/shared";
import { HttpError, unprocessable } from "../../../errors.js";
import { connectionMethodFor, connectionMethodForConnection, remoteEndpoint } from "../connection-methods.js";
import type { OAuthConnectionSettings, OAuthProviderEndpoints, OAuthTransport } from "./types.js";
import type { createOAuthEndpointPolicy } from "./endpoint-policy.js";
import { asRecord, oauthConfig, normalizeOauthScopes, isSmokeLabOAuthFixture, isSmokeLabOAuthUrl, originOf, oauthProviderForConnection, challengeOAuthHints, canonicalResourceIndicator, sameOAuthIssuer, protectedResourceMetadataUrls, wellKnownMetadataUrls, authServerMetadataUrls } from "./metadata.js";

type DiscoveryDependencies = OAuthTransport & Pick<ReturnType<typeof createOAuthEndpointPolicy>, "safeOAuthEndpointUrl"> & {
  assertRemoteEndpointAllowed: (config: Record<string, unknown>) => Promise<string>;
};

export function createOAuthDiscovery({ fetchRemoteHttpUrl, assertRemoteEndpointAllowed, assertOAuthEndpointUrl, safeOAuthEndpointUrl }: DiscoveryDependencies) {
  function smokeLabOAuthEndpoints(
    connection: OAuthConnectionSettings,
    redirectUri?: string,
  ): OAuthProviderEndpoints | null {
    if (!isSmokeLabOAuthFixture(connection) || !redirectUri) return null;
    let origin: string;
    try {
      origin = new URL(redirectUri).origin;
    } catch {
      return null;
    }
    const oauthBasePath = `/api/companies/${encodeURIComponent(connection.companyId)}/smoke-lab/oauth`;
    return {
      provider: "smoke_lab",
      scopes: normalizeOauthScopes(oauthConfig(connection).scopes),
      authorizationUrl: new URL(
        `${oauthBasePath}/authorize`,
        origin,
      ).toString(),
      tokenUrl: new URL(`${oauthBasePath}/token`, origin).toString(),
      metadataUrl: null,
      grantType: "authorization_code",
    };
  }

  function assertNotSmokeLabOAuthEndpoints(
    connection: OAuthConnectionSettings,
    endpoints: OAuthProviderEndpoints,
  ) {
    const blockedUrl = [
      endpoints.authorizationUrl,
      endpoints.tokenUrl,
      endpoints.metadataUrl,
    ].find(isSmokeLabOAuthUrl);
    if (blockedUrl && !isSmokeLabOAuthFixture(connection)) {
      throw unprocessable(
        "Smoke Lab OAuth provider cannot be used for tool app sign-in",
      );
    }
  }

  async function fetchJsonRecord(
    url: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetchRemoteHttpUrl(url);
      if (!response.ok) return null;
      return asRecord((await response.json()) as unknown) ?? null;
    } catch {
      return null;
    }
  }

  async function endpointsFromMetadataUrl(
    connection: OAuthConnectionSettings,
    metadataUrl: string,
    rejections: HttpError[] = [],
    firstPartyOrigin?: string | null,
  ): Promise<OAuthProviderEndpoints | null> {
    const metadata = await fetchJsonRecord(metadataUrl);
    if (!metadata) return null;
    // Every endpoint below is a string the remote server chose, so none of them
    // is adopted before `safeOAuthEndpointUrl` has vetted its scheme and host.
    let authorizationUrl = safeOAuthEndpointUrl(
      "authorization",
      metadata.authorization_endpoint,
      rejections,
      firstPartyOrigin,
    );
    let tokenUrl = safeOAuthEndpointUrl(
      "token",
      metadata.token_endpoint,
      rejections,
      firstPartyOrigin,
    );
    let registrationUrl = safeOAuthEndpointUrl(
      "registration",
      metadata.registration_endpoint,
      rejections,
      firstPartyOrigin,
    );
    let scopes = normalizeOauthScopes(metadata.scopes_supported);
    let offlineAccessSupported = Boolean(
      authorizationUrl && scopes.includes("offline_access"),
    );
    let codeChallengeMethodsSupported = normalizeOauthScopes(
      metadata.code_challenge_methods_supported,
    );
    let tokenEndpointAuthMethodsSupported = normalizeOauthScopes(
      metadata.token_endpoint_auth_methods_supported,
    );
    let grantTypesSupported = normalizeOauthScopes(
      metadata.grant_types_supported,
    );
    let clientIdMetadataDocumentSupported =
      metadata.client_id_metadata_document_supported === true;
    // A document that carries the authorization endpoint itself *is* the
    // authorization-server metadata, so its own `issuer` is the canonical one.
    // Otherwise this was protected-resource metadata and the issuer comes from
    // whichever advertised authorization server answered.
    let issuer =
      authorizationUrl &&
      typeof metadata.issuer === "string" &&
      metadata.issuer.trim()
        ? metadata.issuer.trim()
        : null;
    const resource =
      typeof metadata.resource === "string" && metadata.resource.trim()
        ? metadata.resource.trim()
        : null;
    for (const candidate of authServerMetadataUrls(metadata)) {
      const authMetadata = await fetchJsonRecord(candidate.metadataUrl);
      if (!authMetadata) continue;
      const candidateAuthorizationUrl = safeOAuthEndpointUrl(
        "authorization",
        authMetadata.authorization_endpoint,
        rejections,
        firstPartyOrigin,
      );
      const candidateTokenUrl = safeOAuthEndpointUrl(
        "token",
        authMetadata.token_endpoint,
        rejections,
        firstPartyOrigin,
      );
      if (!candidateAuthorizationUrl && !candidateTokenUrl) continue;
      // RFC 8414 §3.3: the metadata document's `issuer` must match the issuer we
      // used to build the discovery URL, or the document is not authoritative.
      const advertisedIssuer =
        typeof authMetadata.issuer === "string" && authMetadata.issuer.trim()
          ? authMetadata.issuer.trim()
          : null;
      if (
        advertisedIssuer &&
        !sameOAuthIssuer(advertisedIssuer, candidate.issuer)
      )
        continue;
      // A document can carry its own endpoints and also list other servers.
      // Adopt capabilities only from metadata bound to the selected endpoints
      // and issuer; otherwise offline access could break an unrelated sign-in.
      if (
        (authorizationUrl && candidateAuthorizationUrl !== authorizationUrl) ||
        (tokenUrl && candidateTokenUrl !== tokenUrl) ||
        (issuer && !sameOAuthIssuer(issuer, advertisedIssuer ?? candidate.issuer))
      )
        continue;
      authorizationUrl = authorizationUrl ?? candidateAuthorizationUrl;
      tokenUrl = tokenUrl ?? candidateTokenUrl;
      registrationUrl =
        registrationUrl ??
        safeOAuthEndpointUrl(
          "registration",
          authMetadata.registration_endpoint,
          rejections,
          firstPartyOrigin,
        );
      issuer = issuer ?? advertisedIssuer ?? candidate.issuer;
      offlineAccessSupported = offlineAccessSupported ||
        normalizeOauthScopes(authMetadata.scopes_supported).includes("offline_access");
      if (scopes.length === 0)
        scopes = normalizeOauthScopes(authMetadata.scopes_supported);
      if (codeChallengeMethodsSupported.length === 0) {
        codeChallengeMethodsSupported = normalizeOauthScopes(
          authMetadata.code_challenge_methods_supported,
        );
      }
      if (tokenEndpointAuthMethodsSupported.length === 0) {
        tokenEndpointAuthMethodsSupported = normalizeOauthScopes(
          authMetadata.token_endpoint_auth_methods_supported,
        );
      }
      if (grantTypesSupported.length === 0) {
        grantTypesSupported = normalizeOauthScopes(
          authMetadata.grant_types_supported,
        );
      }
      if (!clientIdMetadataDocumentSupported) {
        clientIdMetadataDocumentSupported =
          authMetadata.client_id_metadata_document_supported === true;
      }
      if (authorizationUrl && tokenUrl) break;
    }
    if (!authorizationUrl || !tokenUrl) return null;
    return {
      provider: oauthProviderForConnection(connection, metadataUrl),
      scopes,
      offlineAccessSupported,
      authorizationUrl,
      tokenUrl,
      registrationUrl,
      codeChallengeMethodsSupported,
      tokenEndpointAuthMethodsSupported,
      grantTypesSupported,
      metadataUrl,
      issuer,
      resource,
      clientIdMetadataDocumentSupported,
    };
  }

  async function discoverOAuthEndpoints(
    connection: OAuthConnectionSettings,
    challenge?: string | null,
    firstPartyOrigin?: string | null,
  ): Promise<OAuthProviderEndpoints | null> {
    const oauth = oauthConfig(connection);
    const hints = challenge ? challengeOAuthHints(challenge) : null;
    // A configured endpoint was pasted by an operator or persisted from an
    // earlier discovery, and a hint came straight out of the endpoint's
    // `WWW-Authenticate` header. Neither is more trusted than metadata, so both
    // go through the same gate; an unusable one is dropped so full metadata
    // discovery still runs below.
    const rejections: HttpError[] = [];
    const configuredAuthorizationUrl = safeOAuthEndpointUrl(
      "authorization",
      typeof oauth.authorizationUrl === "string"
        ? oauth.authorizationUrl
        : (hints?.authorizationUrl ?? null),
      rejections,
      firstPartyOrigin,
    );
    const configuredTokenUrl = safeOAuthEndpointUrl(
      "token",
      typeof oauth.tokenUrl === "string"
        ? oauth.tokenUrl
        : (hints?.tokenUrl ?? null),
      rejections,
      firstPartyOrigin,
    );
    const provider = oauthProviderForConnection(
      connection,
      typeof oauth.metadataUrl === "string"
        ? oauth.metadataUrl
        : hints?.metadataUrl,
    );
    const scopes =
      normalizeOauthScopes(oauth.scopes).length > 0
        ? normalizeOauthScopes(oauth.scopes)
        : normalizeOauthScopes(oauth.scope).length > 0
          ? normalizeOauthScopes(oauth.scope)
          : normalizeOauthScopes(hints?.scope);
    const grantType =
      oauth.grantType === "client_credentials" ||
      oauth.clientCredentials === true
        ? ("client_credentials" as const)
        : ("authorization_code" as const);
    // The resource indicator is the MCP endpoint itself, independent of which
    // authorization server ends up serving it.
    const configuredResource =
      typeof oauth.resource === "string" && oauth.resource.trim()
        ? oauth.resource.trim()
        : canonicalResourceIndicator(remoteEndpoint(connection.config));
    if (configuredAuthorizationUrl && configuredTokenUrl) {
      // Pre-existing generic connections cached endpoints before refresh-scope
      // support was recorded. Recover that capability from their bound metadata
      // without adopting a different issuer or changing their requested tool scopes.
      let refreshMetadata: OAuthProviderEndpoints | null = null;
      if (
        !connection.config.sourceTemplateKey &&
        typeof oauth.offlineAccessSupported !== "boolean" &&
        typeof oauth.metadataUrl === "string"
      ) {
        const discovered = await endpointsFromMetadataUrl(
          connection, oauth.metadataUrl, rejections, firstPartyOrigin,
        );
        if (
          discovered?.authorizationUrl === configuredAuthorizationUrl &&
          discovered.tokenUrl === configuredTokenUrl &&
          (typeof oauth.issuer !== "string" ||
            (discovered.issuer && sameOAuthIssuer(discovered.issuer, oauth.issuer)))
        ) refreshMetadata = discovered;
      }
      return {
        provider,
        scopes,
        offlineAccessSupported: typeof oauth.offlineAccessSupported === "boolean"
          ? oauth.offlineAccessSupported
          : refreshMetadata?.offlineAccessSupported,
        authorizationUrl: configuredAuthorizationUrl,
        tokenUrl: configuredTokenUrl,
        registrationUrl: safeOAuthEndpointUrl(
          "registration",
          oauth.registrationUrl,
          rejections,
          firstPartyOrigin,
        ),
        codeChallengeMethodsSupported: normalizeOauthScopes(
          oauth.codeChallengeMethodsSupported,
        ),
        tokenEndpointAuthMethodsSupported: normalizeOauthScopes(
          oauth.tokenEndpointAuthMethodsSupported,
        ),
        grantTypesSupported: Array.isArray(oauth.grantTypesSupported)
          ? normalizeOauthScopes(oauth.grantTypesSupported)
          : refreshMetadata?.grantTypesSupported,
        grantType,
        metadataUrl:
          typeof oauth.metadataUrl === "string"
            ? oauth.metadataUrl
            : (hints?.metadataUrl ?? null),
        issuer:
          typeof oauth.issuer === "string" && oauth.issuer.trim()
            ? oauth.issuer.trim()
            : null,
        resource: configuredResource,
        clientIdMetadataDocumentSupported:
          oauth.clientIdMetadataDocumentSupported === true,
      };
    }

    const metadataCandidates = [
      typeof oauth.metadataUrl === "string" ? oauth.metadataUrl : null,
      hints?.metadataUrl ?? null,
    ].filter((value): value is string => Boolean(value));
    if (metadataCandidates.length === 0) {
      const endpoint = new URL(
        await assertRemoteEndpointAllowed(connection.config),
      );
      metadataCandidates.push(...protectedResourceMetadataUrls(endpoint));
      // The MCP server may double as its own authorization server, in which case
      // it serves authorization-server metadata directly at (or under) its path.
      metadataCandidates.push(...wellKnownMetadataUrls(endpoint.toString()));
    }
    for (const metadataUrl of [...new Set(metadataCandidates)]) {
      const endpoints = await endpointsFromMetadataUrl(
        connection,
        metadataUrl,
        rejections,
        firstPartyOrigin,
      );
      if (endpoints) {
        return {
          ...endpoints,
          scopes: scopes.length > 0 ? scopes : endpoints.scopes,
          grantType,
          resource: endpoints.resource ?? configuredResource,
        };
      }
    }
    // Nothing usable was found *and* something was refused on the way: report the
    // refusal rather than the generic "does not advertise OAuth sign in", so the
    // operator learns the server offered an unsafe address.
    if (rejections.length > 0) throw rejections[0];
    return null;
  }

  async function oauthProviderEndpoints(
    app: AppDefinition,
    methodKey?: string | null,
  ): Promise<OAuthProviderEndpoints> {
    const method = connectionMethodFor(app, methodKey);
    if (method.auth !== "oauth")
      throw unprocessable("This app does not support sign in");
    let authorizationUrl = method.defaults?.authorizationEndpoint ?? null;
    let tokenUrl = method.defaults?.tokenEndpoint ?? null;
    const metadataUrl = method.defaults?.metadataUrl ?? null;
    if ((!authorizationUrl || !tokenUrl) && metadataUrl) {
      const response = await fetchRemoteHttpUrl(metadataUrl);
      if (!response.ok)
        throw new HttpError(
          502,
          "OAuth provider metadata could not be loaded",
          { code: "oauth_metadata_failed" },
        );
      const metadata = asRecord((await response.json()) as unknown);
      authorizationUrl =
        authorizationUrl ??
        (typeof metadata.authorization_endpoint === "string"
          ? metadata.authorization_endpoint
          : null);
      tokenUrl =
        tokenUrl ??
        (typeof metadata.token_endpoint === "string"
          ? metadata.token_endpoint
          : null);
    }
    if (!authorizationUrl || !tokenUrl) {
      throw unprocessable(
        "OAuth provider endpoints are not configured for this app",
      );
    }
    // A gallery default is Paperclip's own data, but it is still a URL that ends
    // up as a browser navigation, and the metadata branch above reads the same
    // untrusted document a generic connection does. Both go through the gate.
    return {
      provider: app.slug,
      scopes: method.defaults?.scopesHint ?? [],
      authorizationUrl: assertOAuthEndpointUrl(
        "authorization",
        authorizationUrl,
      ),
      tokenUrl: assertOAuthEndpointUrl("token", tokenUrl),
      grantType: "authorization_code",
      metadataUrl,
    };
  }

  async function oauthEndpointsForConnection(
    connection: OAuthConnectionSettings,
    challenge?: string | null,
    redirectUri?: string,
  ): Promise<OAuthProviderEndpoints> {
    const smokeLabEndpoints = smokeLabOAuthEndpoints(connection, redirectUri);
    const sourceTemplateKey =
      typeof connection.config.sourceTemplateKey === "string"
        ? connection.config.sourceTemplateKey
        : null;
    const galleryEntry = sourceTemplateKey
      ? getConnectableAppDefinition(sourceTemplateKey)
      : null;
    const galleryMethod = galleryEntry
      ? connectionMethodForConnection(galleryEntry, connection)
      : null;
    // Pinned endpoints describe the provider's console-registered OAuth app.
    // A method that also offers dynamic registration registers against the MCP
    // server's own authorization server (Linear: mcp.linear.app, not
    // linear.app), which only discovery finds. So the pins stand in for
    // discovery only when no registration is possible or the connection
    // already carries an operator-entered client.
    const storedOAuth = oauthConfig(connection);
    const usesOperatorClient =
      storedOAuth.clientRegistrationSource === "manual" &&
      connection.ownership !== "dcr" &&
      typeof storedOAuth.clientId === "string" &&
      storedOAuth.clientId.trim().length > 0;
    // A reviewed protected-resource document is authoritative for this method.
    // Some hosts still serve metadata for a retired MCP server at the root.
    // Resolve it before cached endpoints, including on existing draft reconnects.
    if (!smokeLabEndpoints && galleryMethod?.defaults?.discoveryUrl) {
      const endpoints = await endpointsFromMetadataUrl(
        connection, galleryMethod.defaults.discoveryUrl, [], originOf(redirectUri),
      );
      if (!endpoints) throw unprocessable("OAuth provider metadata could not be loaded");
      assertNotSmokeLabOAuthEndpoints(connection, endpoints);
      return endpoints;
    }
    const hasCompleteGalleryEndpointHints = Boolean(
      galleryMethod?.defaults?.authorizationEndpoint &&
      galleryMethod.defaults.tokenEndpoint &&
      (!galleryMethod.ownershipModes.includes("dcr") || usesOperatorClient),
    );
    // The smoke-lab fixture's endpoints are first-party and complete, so
    // discovery is not just unnecessary there, it must not run: an unreachable
    // fixture endpoint would fail the whole callback.
    const firstPartyOrigin = originOf(redirectUri);
    const discovered =
      !smokeLabEndpoints &&
      connection.transport === "mcp_remote" &&
      !hasCompleteGalleryEndpointHints
        ? await discoverOAuthEndpoints(connection, challenge, firstPartyOrigin)
        : null;
    const endpoints =
      smokeLabEndpoints ??
      discovered ??
      (galleryEntry && galleryMethod?.auth === "oauth"
        ? await oauthProviderEndpoints(galleryEntry, galleryMethod.key)
        : await discoverOAuthEndpoints(
            connection,
            challenge,
            firstPartyOrigin,
          ));
    if (!endpoints)
      throw unprocessable(
        "This app connection does not advertise OAuth sign in",
      );
    assertNotSmokeLabOAuthEndpoints(connection, endpoints);
    return endpoints;
  }

  async function preflightConnectionMetadata(
    app: Pick<AppDefinition, "slug">,
    method: Pick<ConnectionMethodDef, "auth" | "key">,
    defaults: NonNullable<ConnectionMethodDef["defaults"]>,
    serverUrl: string,
    now: () => Date,
  ): Promise<ToolAppMetadataPreflightResult> {
    const attempts: ToolAppMetadataPreflightResult["attempts"] = [];
    const endpointResponse = await fetchRemoteHttpUrl(serverUrl, {
      method: "GET",
      headers: { Accept: "application/json, text/event-stream" },
    });
    attempts.push({
      kind: "endpoint",
      url: serverUrl,
      status: endpointResponse.status,
      ok: endpointResponse.ok,
      contentType: endpointResponse.headers.get("content-type"),
    });

    if (method.auth !== "oauth") {
      return {
        galleryKey: app.slug,
        methodKey: method.key,
        serverUrl,
        endpointReachable: endpointResponse.status < 500,
        oauth: null,
        attempts,
        checkedAt: now().toISOString(),
      };
    }

    const endpoint = new URL(serverUrl);
    const metadataQueue = [
      defaults.discoveryUrl ?? null,
      defaults.metadataUrl ?? null,
      ...protectedResourceMetadataUrls(endpoint),
      ...wellKnownMetadataUrls(endpoint.toString()),
    ].filter((url): url is string => Boolean(url));
    const visited = new Set<string>();
    let metadataFound = false;
    let registrationAdvertised = false;
    let clientIdMetadataDocumentSupported = false;

    while (metadataQueue.length > 0 && visited.size < 16) {
      const metadataUrl = metadataQueue.shift()!;
      if (visited.has(metadataUrl)) continue;
      visited.add(metadataUrl);
      const response = await fetchRemoteHttpUrl(metadataUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      attempts.push({
        kind: "oauth_metadata",
        url: metadataUrl,
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type"),
      });
      if (!response.ok) continue;
      let metadata: Record<string, unknown>;
      try {
        metadata = asRecord((await response.json()) as unknown);
      } catch {
        continue;
      }
      const looksLikeOAuthMetadata = Boolean(
        metadata.authorization_endpoint ||
        metadata.token_endpoint ||
        metadata.authorization_servers ||
        metadata.resource,
      );
      if (!looksLikeOAuthMetadata) continue;
      metadataFound = true;
      registrationAdvertised ||=
        typeof metadata.registration_endpoint === "string";
      clientIdMetadataDocumentSupported ||=
        metadata.client_id_metadata_document_supported === true;
      for (const candidate of authServerMetadataUrls(metadata)) {
        if (!visited.has(candidate.metadataUrl))
          metadataQueue.push(candidate.metadataUrl);
      }
    }

    return {
      galleryKey: app.slug,
      methodKey: method.key,
      serverUrl,
      endpointReachable: endpointResponse.status < 500,
      oauth: {
        metadataFound,
        registrationAdvertised,
        clientIdMetadataDocumentSupported,
      },
      attempts,
      checkedAt: now().toISOString(),
    };
  }

  return { oauthEndpointsForConnection, discoverOAuthEndpoints, preflightConnectionMetadata };
}
