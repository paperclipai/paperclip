import { HttpError, unprocessable } from "../../../errors.js";
import { asRecord, originOf } from "./metadata.js";
import { normalizeOAuthProviderError, oauthProviderErrorMessage } from "./provider-errors.js";
import type { OAuthProviderEndpoints, OAuthTokenEndpointAuthMethod, OAuthTransport } from "./types.js";

const MAX_OAUTH_DCR_CLIENT_ID_LENGTH = 4_096;

const MAX_OAUTH_DCR_CLIENT_SECRET_LENGTH = 16_384;

function invalidOAuthDcrResponse(field: string, reason: string): HttpError {
  return new HttpError(
    502,
    "OAuth provider returned incompatible dynamic client metadata",
    {
      code: "oauth_dcr_response_invalid",
      field,
      reason,
    },
  );
}

function parseOAuthDcrString(
  record: Record<string, unknown>,
  field: "client_id" | "client_secret",
  input: { required: boolean; maxLength: number },
): string | null {
  const value = record[field];
  if (value === undefined || value === null) {
    if (input.required) throw invalidOAuthDcrResponse(field, "missing");
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > input.maxLength
  ) {
    throw invalidOAuthDcrResponse(field, "invalid_string");
  }
  if (field === "client_id" && value.trim() !== value) {
    throw invalidOAuthDcrResponse(field, "invalid_string");
  }
  return value;
}

function assertOAuthDcrArray(
  record: Record<string, unknown>,
  field: "redirect_uris" | "grant_types" | "response_types",
  expected: string[],
  options: { allowAdditional?: boolean; allowOmitted?: boolean } = {},
) {
  if (record[field] === undefined) {
    if (options.allowOmitted) return;
    throw invalidOAuthDcrResponse(field, "missing");
  }
  const value = record[field];
  if (
    !Array.isArray(value) ||
    value.length < expected.length ||
    value.length > 32 ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.length > 2_048,
    )
  ) {
    throw invalidOAuthDcrResponse(field, "invalid_array");
  }
  const actual = new Set(value);
  if (
    expected.some((entry) => !actual.has(entry)) ||
    (!options.allowAdditional && actual.size !== expected.length)
  ) {
    throw invalidOAuthDcrResponse(field, "registered_value_mismatch");
  }
}

function parseOAuthDcrTimestamp(
  record: Record<string, unknown>,
  field: string,
): number | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw invalidOAuthDcrResponse(field, "invalid_timestamp");
  }
  return value;
}

function selectOAuthDcrTokenEndpointAuthMethod(
  supported: string[] | undefined,
): OAuthTokenEndpointAuthMethod {
  if (!supported?.length || supported.includes("none")) return "none";
  // When a confidential client is required, preserve the provider's advertised
  // ordering. Miro advertises both methods but only completes its MCP exchange
  // for the first one (`client_secret_post`), while Supabase and Hugging Face
  // advertise `client_secret_basic` first. Treating Basic as a global preference
  // creates a valid-looking registration that fails only after user consent.
  for (const method of supported) {
    if (method === "client_secret_basic" || method === "client_secret_post")
      return method;
  }
  throw unprocessable(
    "OAuth provider does not support a compatible dynamic client authentication method",
    {
      code: "oauth_dcr_client_auth_unsupported",
      supportedMethods: supported,
    },
  );
}

export function storedOAuthTokenEndpointAuthMethod(
  oauth: Record<string, unknown>,
  clientSecret: string | null | undefined,
): OAuthTokenEndpointAuthMethod {
  const method = oauth.clientTokenEndpointAuthMethod;
  if (
    method === "none" ||
    method === "client_secret_basic" ||
    method === "client_secret_post"
  ) {
    return method;
  }
  const advertised = Array.isArray(oauth.tokenEndpointAuthMethodsSupported)
    ? oauth.tokenEndpointAuthMethodsSupported.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  // Manual OAuth clients do not carry a DCR-selected method. Follow the
  // authorization server's advertised preference when it offers a
  // confidential-client method; Xero, for example, documents Basic auth and
  // rejects an otherwise valid code when the secret is posted in the body.
  if (clientSecret && advertised.includes("client_secret_basic"))
    return "client_secret_basic";
  if (clientSecret && advertised.includes("client_secret_post"))
    return "client_secret_post";
  // Existing manually configured and preconfigured clients predate the
  // persisted method field and already use client_secret_post successfully.
  return clientSecret ? "client_secret_post" : "none";
}

export function createOAuthClientProtocol({ fetchRemoteHttpUrl, assertOAuthEndpointUrl }: OAuthTransport) {
  async function requestOAuthClientRegistration(input: { endpoints: OAuthProviderEndpoints; redirectUri: string }) {
    if (!input.endpoints.registrationUrl) {
      throw unprocessable(
        "OAuth provider does not advertise dynamic client registration",
        {
          code: "oauth_dcr_not_supported",
        },
      );
    }
    if (
      input.endpoints.codeChallengeMethodsSupported?.length &&
      !input.endpoints.codeChallengeMethodsSupported.includes("S256")
    ) {
      throw unprocessable(
        "OAuth provider does not support the required PKCE S256 method",
        {
          code: "oauth_pkce_s256_required",
        },
      );
    }
    const tokenEndpointAuthMethod = selectOAuthDcrTokenEndpointAuthMethod(
      input.endpoints.tokenEndpointAuthMethodsSupported,
    );

    const host = new URL(input.redirectUri).host;
    const clientNameHost = host
      .replace(/[^A-Za-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const requestedMetadata = {
      // Some DCR servers restrict client_name to alphanumeric characters,
      // hyphens and spaces. Keep the deployment host recognizable without
      // sending punctuation such as dots, colons or parentheses.
      client_name: `Paperclip ${clientNameHost}`,
      redirect_uris: [input.redirectUri],
      grant_types: [
        "authorization_code",
        ...(!input.endpoints.grantTypesSupported?.length ||
        input.endpoints.grantTypesSupported.includes("refresh_token")
          ? ["refresh_token"]
          : []),
      ],
      response_types: ["code"],
      token_endpoint_auth_method: tokenEndpointAuthMethod,
      // RFC 7591: Paperclip's callback is a server-side HTTPS endpoint, so this
      // is a `web` client, not a `native` one. Some authorization servers reject
      // an https redirect URI when the default (`web`) is left implicit, and
      // others apply native-client redirect rules without it.
      application_type: "web",
    };
    const response = await fetchRemoteHttpUrl(
      assertOAuthEndpointUrl("registration", input.endpoints.registrationUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestedMetadata),
      },
    );
    const record = asRecord(
      (await response.json().catch(() => ({}))) as unknown,
    );
    if (!response.ok) {
      const providerError = normalizeOAuthProviderError(record.error);
      throw new HttpError(
        502,
        oauthProviderErrorMessage(
          providerError,
          "OAuth dynamic client registration failed",
        ),
        {
          code: "oauth_dynamic_client_registration_failed",
          providerError,
          status: response.status,
        },
      );
    }
    const clientId = parseOAuthDcrString(record, "client_id", {
      required: true,
      maxLength: MAX_OAUTH_DCR_CLIENT_ID_LENGTH,
    })!;
    const clientSecret = parseOAuthDcrString(record, "client_secret", {
      required: tokenEndpointAuthMethod !== "none",
      maxLength: MAX_OAUTH_DCR_CLIENT_SECRET_LENGTH,
    });
    // Some authorization servers add provider-owned metadata to the registered
    // client. Paperclip still uses only the exact redirect, grant and response
    // types it requested, so accept bounded supersets while requiring every
    // requested value to remain present. Hugging Face, for example, adds the
    // device-code grant to an otherwise valid authorization-code registration.
    assertOAuthDcrArray(
      record,
      "redirect_uris",
      requestedMetadata.redirect_uris,
      { allowAdditional: true },
    );
    // RFC 7591 registration responses do not consistently echo every accepted
    // request field. Supabase, for example, returns only the client material and
    // redirect URIs. Redirect binding remains mandatory; omitted grant/response
    // metadata inherits the values Paperclip requested. Additional provider-owned
    // values do not widen Paperclip's behavior because they are never persisted as
    // a flow choice or sent in authorization/token requests.
    assertOAuthDcrArray(record, "grant_types", requestedMetadata.grant_types, {
      allowAdditional: true,
      allowOmitted: true,
    });
    assertOAuthDcrArray(
      record,
      "response_types",
      requestedMetadata.response_types,
      {
        allowAdditional: true,
        allowOmitted: true,
      },
    );
    if (
      record.token_endpoint_auth_method !== undefined &&
      record.token_endpoint_auth_method !==
        requestedMetadata.token_endpoint_auth_method
    ) {
      throw invalidOAuthDcrResponse(
        "token_endpoint_auth_method",
        "registered_value_mismatch",
      );
    }
    const clientIdIssuedAt = parseOAuthDcrTimestamp(
      record,
      "client_id_issued_at",
    );
    const returnedClientSecretExpiresAt = parseOAuthDcrTimestamp(
      record,
      "client_secret_expires_at",
    );
    // A few public-client registrars (including Mixpanel) return the RFC 7591
    // `0` sentinel even though they issued no secret. It carries no credential
    // lifetime in that case, so normalize it away. A positive expiry without a
    // secret is still contradictory and remains a hard failure.
    if (
      returnedClientSecretExpiresAt !== null &&
      returnedClientSecretExpiresAt > 0 &&
      clientSecret === null
    ) {
      throw invalidOAuthDcrResponse(
        "client_secret_expires_at",
        "client_secret_missing",
      );
    }
    const clientSecretExpiresAt = clientSecret
      ? returnedClientSecretExpiresAt
      : null;
    return { clientId, clientSecret, tokenEndpointAuthMethod, clientIdIssuedAt, clientSecretExpiresAt };
  }

  async function exchangeOAuthToken(input: {
    tokenUrl: string;
    clientId: string;
    clientSecret?: string | null;
    tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod;
    grantType?: "authorization_code" | "refresh_token" | "client_credentials";
    scopes?: string[];
    redirectUri?: string | null;
    codeVerifier?: string | null;
    code?: string | null;
    refreshToken?: string | null;
    /** RFC 8707 resource indicator: the MCP server this token is for. */
    resource?: string | null;
  }) {
    const body = new URLSearchParams();
    if (input.grantType === "client_credentials") {
      body.set("grant_type", "client_credentials");
      if (input.scopes && input.scopes.length > 0)
        body.set("scope", input.scopes.join(" "));
    } else if (input.refreshToken) {
      body.set("grant_type", "refresh_token");
      body.set("refresh_token", input.refreshToken);
    } else {
      body.set("grant_type", "authorization_code");
      body.set("code", input.code ?? "");
      body.set("redirect_uri", input.redirectUri ?? "");
      body.set("code_verifier", input.codeVerifier ?? "");
    }
    const tokenEndpointAuthMethod =
      input.tokenEndpointAuthMethod ??
      (input.clientSecret ? "client_secret_post" : "none");
    if (tokenEndpointAuthMethod !== "client_secret_basic")
      body.set("client_id", input.clientId);
    if (tokenEndpointAuthMethod === "client_secret_post") {
      if (!input.clientSecret) {
        throw unprocessable(
          "OAuth client secret is missing for client_secret_post authentication",
          {
            code: "oauth_client_secret_missing",
          },
        );
      }
      body.set("client_secret", input.clientSecret);
    }
    // RFC 8707: repeat the resource indicator on the token request so the
    // authorization server audience-restricts the access token (and any refresh
    // exchange) to this MCP server.
    if (input.resource) body.set("resource", input.resource);

    // The token URL can come from a connection row written before the endpoint
    // gate existed, so a client secret / authorization code never leaves
    // Paperclip without re-checking the transport it would leave over.
    const tokenUrl = assertOAuthEndpointUrl("token", input.tokenUrl, {
      // Paperclip's own callback origin, so a first-party token endpoint keeps
      // working on a deployment that is itself served over plaintext HTTP.
      firstPartyOrigin: originOf(input.redirectUri),
    });
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      // Some providers otherwise return a legacy form-encoded token response.
      accept: "application/json",
    };
    if (tokenEndpointAuthMethod === "client_secret_basic") {
      if (!input.clientSecret) {
        throw unprocessable(
          "OAuth client secret is missing for client_secret_basic authentication",
          {
            code: "oauth_client_secret_missing",
          },
        );
      }
      const formEncode = (value: string) =>
        new URLSearchParams({ value }).toString().slice("value=".length);
      headers.Authorization = `Basic ${Buffer.from(
        `${formEncode(input.clientId)}:${formEncode(input.clientSecret)}`,
        "utf8",
      ).toString("base64")}`;
    }
    const response = await fetchRemoteHttpUrl(tokenUrl, {
      method: "POST",
      headers,
      body,
    });
    const payload = (await response.json().catch(() => ({}))) as unknown;
    const record = asRecord(payload);
    if (!response.ok || record.ok === false) {
      const providerError = normalizeOAuthProviderError(record.error);
      const message = oauthProviderErrorMessage(
        providerError,
        "OAuth token exchange failed",
      );
      if (
        input.grantType === "refresh_token" &&
        providerError === "invalid_grant"
      ) {
        throw new HttpError(
          422,
          "OAuth authorization has expired. Reconnect this app to continue.",
          {
            code: "oauth_reauthorization_required",
            providerError,
            status: response.status,
          },
        );
      }
      throw new HttpError(502, message, {
        code: "oauth_token_exchange_failed",
        providerError,
        status: response.status,
      });
    }
    const accessToken =
      typeof record.access_token === "string" ? record.access_token : null;
    if (!accessToken)
      throw new HttpError(
        502,
        "OAuth provider did not return an access token",
        { code: "oauth_access_token_missing" },
      );
    const expiresIn =
      typeof record.expires_in === "number"
        ? record.expires_in
        : Number(record.expires_in);
    return {
      accessToken,
      refreshToken:
        typeof record.refresh_token === "string" ? record.refresh_token : null,
      expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null,
      scope: typeof record.scope === "string" ? record.scope : null,
      tokenType:
        typeof record.token_type === "string" ? record.token_type : "Bearer",
    };
  }

  return { requestOAuthClientRegistration, exchangeOAuthToken };
}
