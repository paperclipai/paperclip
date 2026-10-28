import type { ActorInfo } from "../types.js";
import { createOAuthClientProtocol } from "./client.js";
import { oauthConfig, sameOAuthIssuer } from "./metadata.js";
import { resolveOAuthClientIdMetadataDocumentUrl } from "./client-metadata.js";
import type { OAuthProviderEndpoints, OAuthClientRegistrationSource } from "./types.js";
import { connectionMethodForConnection } from "../connection-methods.js";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { toolConnections } from "@paperclipai/db";
import type { AppDefinition } from "@paperclipai/shared";
import { notFound, unprocessable } from "../../../errors.js";
import { type RemoteHttpEndpointLookup } from "../../remote-http-endpoint-guard.js";

import type { OAuthCredentialStore } from "./credential-store.js";
import { singleFlight } from "../single-flight.js";
import { configuredOAuthClientForConnection, oauthSecretRef } from "./client-settings.js";
const oauthRegistrationFlights = new Map<string, Promise<unknown>>();

type RegistrationDependencies = {
  now: () => Date;
  options: { oauthClientMetadataLookup?: RemoteHttpEndpointLookup };
  store: Pick<OAuthCredentialStore, "createOrRotateOAuthSecret" | "oauthClientForConnection" | "syncCredentialBindings">;
  getConnectionRow(idOrUid: string, companyId?: string): Promise<typeof toolConnections.$inferSelect>;
  requestOAuthClientRegistration: ReturnType<typeof createOAuthClientProtocol>["requestOAuthClientRegistration"];
};

export function createOAuthClientRegistration(db: Db, { now, options, store, getConnectionRow, requestOAuthClientRegistration }: RegistrationDependencies) {
  const { createOrRotateOAuthSecret, oauthClientForConnection, syncCredentialBindings } = store;
  async function registerOAuthClient(input: {
    connection: typeof toolConnections.$inferSelect;
    endpoints: OAuthProviderEndpoints;
    redirectUri: string;
    actor?: ActorInfo;
  }) {
    const { clientId, clientSecret, tokenEndpointAuthMethod, clientIdIssuedAt, clientSecretExpiresAt } = await requestOAuthClientRegistration({
      endpoints: input.endpoints,
      redirectUri: input.redirectUri,
    });
    const existingClientSecretRef = oauthSecretRef(
      input.connection,
      "oauth.client_secret",
    );
    const nextCredentialSecretRefs =
      input.connection.credentialSecretRefs.filter(
        (ref) => ref.configPath !== "oauth.client_secret",
      );
    if (clientSecret) {
      const clientSecretRef = await createOrRotateOAuthSecret({
        companyId: input.connection.companyId,
        connection: input.connection,
        configPath: "oauth.client_secret",
        label: "OAuth client secret",
        value: clientSecret,
        actor: input.actor,
      });
      nextCredentialSecretRefs.push(clientSecretRef);
    } else if (
      existingClientSecretRef &&
      oauthConfig(input.connection).clientId === clientId
    ) {
      nextCredentialSecretRefs.push(existingClientSecretRef);
    }

    const oauth = oauthConfig(input.connection);
    const nextConfig = {
      ...input.connection.config,
      oauth: {
        ...oauth,
        provider: input.endpoints.provider,
        authorizationUrl: input.endpoints.authorizationUrl,
        tokenUrl: input.endpoints.tokenUrl,
        registrationUrl: input.endpoints.registrationUrl,
        metadataUrl: input.endpoints.metadataUrl ?? null,
        scopes: input.endpoints.scopes,
        offlineAccessSupported: input.endpoints.offlineAccessSupported,
        grantTypesSupported: input.endpoints.grantTypesSupported ?? [],
        codeChallengeMethodsSupported:
          input.endpoints.codeChallengeMethodsSupported ?? [],
        tokenEndpointAuthMethodsSupported:
          input.endpoints.tokenEndpointAuthMethodsSupported ?? [],
        issuer: input.endpoints.issuer ?? oauth.issuer ?? null,
        resource: input.endpoints.resource ?? oauth.resource ?? null,
        clientId,
        clientRegistrationSource: "dcr" satisfies OAuthClientRegistrationSource,
        clientTokenEndpointAuthMethod: tokenEndpointAuthMethod,
        clientRedirectUri: input.redirectUri,
        // Registered client material is only valid for the issuer/resource pair
        // it was minted against. `assertOAuthClientBinding` re-registers when any
        // of these move, so a re-pointed endpoint can never silently reuse a
        // client another authorization server issued.
        clientIssuer: input.endpoints.issuer ?? null,
        clientResource: input.endpoints.resource ?? null,
        clientCompanyId: input.connection.companyId,
        clientIdIssuedAt,
        clientSecretExpiresAt,
      },
    };
    const [updated] = await db
      .update(toolConnections)
      .set({
        ownership: "dcr",
        config: nextConfig,
        transportConfig: nextConfig,
        credentialSecretRefs: nextCredentialSecretRefs,
        updatedAt: now(),
      })
      .where(
        and(
          eq(toolConnections.id, input.connection.id),
          eq(toolConnections.companyId, input.connection.companyId),
        ),
      )
      .returning();
    if (!updated) throw notFound("Tool connection not found");
    await syncCredentialBindings(updated);
    return updated;
  }

  /**
   * Adopt a Client ID Metadata Document as this connection's client: the
   * `client_id` *is* the https URL of Paperclip's published client metadata, so
   * there is nothing to register with the authorization server. Still recorded on
   * the connection so the issuer/resource/callback binding is enforced on reuse
   * exactly like a dynamically registered client.
   */
async function adoptClientIdMetadataDocument(input: {
    connection: typeof toolConnections.$inferSelect;
    endpoints: OAuthProviderEndpoints;
    redirectUri: string;
    clientId: string;
  }) {
    const oauth = oauthConfig(input.connection);
    const nextConfig = {
      ...input.connection.config,
      oauth: {
        ...oauth,
        provider: input.endpoints.provider,
        authorizationUrl: input.endpoints.authorizationUrl,
        tokenUrl: input.endpoints.tokenUrl,
        registrationUrl: input.endpoints.registrationUrl ?? null,
        metadataUrl: input.endpoints.metadataUrl ?? null,
        scopes: input.endpoints.scopes,
        offlineAccessSupported: input.endpoints.offlineAccessSupported,
        grantTypesSupported: input.endpoints.grantTypesSupported ?? [],
        codeChallengeMethodsSupported:
          input.endpoints.codeChallengeMethodsSupported ?? [],
        tokenEndpointAuthMethodsSupported:
          input.endpoints.tokenEndpointAuthMethodsSupported ?? [],
        clientIdMetadataDocumentSupported: true,
        issuer: input.endpoints.issuer ?? oauth.issuer ?? null,
        resource: input.endpoints.resource ?? oauth.resource ?? null,
        clientId: input.clientId,
        clientRegistrationSource:
          "cimd" satisfies OAuthClientRegistrationSource,
        clientTokenEndpointAuthMethod: "none",
        clientRedirectUri: input.redirectUri,
        clientIssuer: input.endpoints.issuer ?? null,
        clientResource: input.endpoints.resource ?? null,
        clientCompanyId: input.connection.companyId,
      },
    };
    // A CIMD client has no secret. Drop any leftover one so a stale credential
    // from an earlier registration can never be replayed against a new issuer.
    const nextCredentialSecretRefs =
      input.connection.credentialSecretRefs.filter(
        (ref) => ref.configPath !== "oauth.client_secret",
      );
    const [updated] = await db
      .update(toolConnections)
      .set({
        authKind: "oauth",
        config: nextConfig,
        transportConfig: nextConfig,
        credentialSecretRefs: nextCredentialSecretRefs,
        updatedAt: now(),
      })
      .where(
        and(
          eq(toolConnections.id, input.connection.id),
          eq(toolConnections.companyId, input.connection.companyId),
        ),
      )
      .returning();
    if (!updated) throw notFound("Tool connection not found");
    await syncCredentialBindings(updated);
    return updated;
  }

  /**
   * How the client already stored on this connection was obtained. Anything
   * unrecognised (including connections written before this field existed) reads
   * as `manual`, which is the conservative answer: Paperclip will not silently
   * re-register over client material it cannot prove it minted.
   */
function storedOAuthClientRegistrationSource(
    connection: typeof toolConnections.$inferSelect,
  ): OAuthClientRegistrationSource {
    const source = oauthConfig(connection).clientRegistrationSource;
    return source === "cimd" || source === "dcr" || source === "preconfigured"
      ? source
      : "manual";
  }

  /**
   * Is the client material already stored on this connection still valid for the
   * authorization server, MCP resource, callback URI and company we are about to
   * use it with? Client credentials are minted against exactly one such tuple;
   * reusing them across a moved binding would let a re-pointed endpoint borrow
   * another server's registration.
   */
function reviewedOAuthClientBinding(connection: typeof toolConnections.$inferSelect, endpoints: OAuthProviderEndpoints) {
    const oauth = oauthConfig(connection);
    // Only repair the known Asana v1 discovery mistake. Retain company and
    // callback checks, and never carry a secret to an arbitrary new issuer.
    if (connection.config.sourceTemplateKey === "asana"
      && connection.config.connectionMethodKey === "mcp-own-oauth"
      && connection.config.url === "https://mcp.asana.com/v2/mcp"
      && oauth.clientRegistrationSource === "manual"
      && connection.ownership !== "dcr"
      && endpoints.issuer === "https://app.asana.com"
      && endpoints.authorizationUrl === "https://app.asana.com/-/oauth_authorize"
      && endpoints.tokenUrl === "https://app.asana.com/-/oauth_token"
      && endpoints.resource === "https://mcp.asana.com/v2/mcp"
      && [undefined, null, "https://mcp.asana.com", "https://app.asana.com"].includes(oauth.clientIssuer as string | null | undefined)
      && [undefined, null, "https://mcp.asana.com", "https://mcp.asana.com/v2/mcp"].includes(oauth.clientResource as string | null | undefined)
      && (oauth.clientIssuer === "https://mcp.asana.com" || oauth.clientResource === "https://mcp.asana.com")) {
      return { ...oauth, clientIssuer: endpoints.issuer, clientResource: endpoints.resource };
    }
    return oauth;
  }

  function oauthClientBindingMatches(
    connection: typeof toolConnections.$inferSelect,
    endpoints: OAuthProviderEndpoints,
    redirectUri: string,
    clientIdMetadataDocumentUrl: string | null,
  ): boolean {
    const oauth = reviewedOAuthClientBinding(connection, endpoints);
    if (typeof oauth.clientId !== "string" || !oauth.clientId.trim())
      return false;
    const source =
      typeof oauth.clientRegistrationSource === "string"
        ? oauth.clientRegistrationSource
        : null;
    // Older interrupted setup flows could accidentally round-trip a DCR client
    // through the customer-client form and relabel it `manual`. Ownership is the
    // durable proof that Paperclip minted that client. Force a fresh registration
    // instead of preserving the damaged binding forever.
    if (source === "manual" && connection.ownership === "dcr") return false;
    // A URL client id that now resolves only to a private network is unusable by
    // an external authorization server. Treat the stored binding as stale so a
    // retry can replace it with a dynamically registered client.
    if (source === "cimd" && oauth.clientId !== clientIdMetadataDocumentUrl)
      return false;
    // A manually preregistered client was registered by the operator against
    // Paperclip's callback, so it has no recorded callback until first use.
    const redirectMatches =
      source === "manual"
        ? oauth.clientRedirectUri === undefined ||
          oauth.clientRedirectUri === null ||
          oauth.clientRedirectUri === redirectUri
        : oauth.clientRedirectUri === redirectUri;
    if (!redirectMatches) return false;
    if (
      typeof oauth.clientCompanyId === "string" &&
      oauth.clientCompanyId !== connection.companyId
    )
      return false;
    if (
      endpoints.issuer &&
      typeof oauth.clientIssuer === "string" &&
      oauth.clientIssuer &&
      !sameOAuthIssuer(oauth.clientIssuer, endpoints.issuer)
    ) {
      return false;
    }
    if (
      endpoints.resource &&
      typeof oauth.clientResource === "string" &&
      oauth.clientResource &&
      oauth.clientResource !== endpoints.resource
    ) {
      return false;
    }
    return true;
  }

  /**
   * Record the issuer/resource/callback/company a client is bound to, the first
   * time that client is actually used.
   *
   * A dynamically registered or CIMD client is stamped at registration. A client
   * the operator pasted in has no binding until now — without this, its
   * `clientRedirectUri` would stay unset forever and `oauthClientBindingMatches`
   * would keep accepting it for *any* callback, which is exactly the drift the
   * binding check exists to catch.
   */
async function stampOAuthClientBinding(
    connection: typeof toolConnections.$inferSelect,
    endpoints: OAuthProviderEndpoints,
    redirectUri: string,
  ): Promise<typeof toolConnections.$inferSelect> {
    const originalOAuth = oauthConfig(connection);
    const oauth = reviewedOAuthClientBinding(connection, endpoints);
    const nextBinding = {
      clientRedirectUri: redirectUri,
      clientIssuer:
        typeof oauth.clientIssuer === "string" && oauth.clientIssuer
          ? oauth.clientIssuer
          : (endpoints.issuer ?? null),
      clientResource:
        typeof oauth.clientResource === "string" && oauth.clientResource
          ? oauth.clientResource
          : (endpoints.resource ?? null),
      clientCompanyId:
        typeof oauth.clientCompanyId === "string" && oauth.clientCompanyId
          ? oauth.clientCompanyId
          : connection.companyId,
    };
    const unchanged = Object.entries(nextBinding).every(
      ([key, value]) => originalOAuth[key] === value,
    );
    if (unchanged) return connection;
    const nextConfig = {
      ...connection.config,
      oauth: { ...oauth, ...nextBinding },
    };
    const [updated] = await db
      .update(toolConnections)
      .set({
        config: nextConfig,
        transportConfig: nextConfig,
        updatedAt: now(),
      })
      .where(
        and(
          eq(toolConnections.id, connection.id),
          eq(toolConnections.companyId, connection.companyId),
        ),
      )
      .returning();
    return updated ?? connection;
  }

  /**
   * May Paperclip mint client material for this connection without an operator
   * pasting client credentials?
   *
   * A curated app opts in through its `ownershipModes`. A generic remote MCP
   * connection may register once — and only once — protected-resource and
   * authorization-server discovery actually produced a metadata document; an
   * endpoint that merely returned a 401 does not earn a registration.
   *
   * A curated method pinned to customer-owned clients still earns a registration
   * when the provider's own metadata advertises one. `ownershipModes` is a
   * point-in-time research snapshot, and providers add dynamic registration
   * without telling us; live discovery is the better evidence of the two, so a
   * stale catalog entry costs the operator a console detour rather than silently
   * outranking what the server just said about itself.
   */
function canRegisterOAuthClientDynamically(
    connection: typeof toolConnections.$inferSelect,
    endpoints: OAuthProviderEndpoints,
    galleryEntry: AppDefinition | null,
  ): boolean {
    if (galleryEntry) {
      const method = connectionMethodForConnection(galleryEntry, connection);
      if (method.ownershipModes.includes("dcr")) return true;
      return method.auth === "oauth" && Boolean(endpoints.registrationUrl);
    }
    return (
      connection.transport === "mcp_remote" && Boolean(endpoints.metadataUrl)
    );
  }

  async function ensureOAuthClient(input: {
    connection: typeof toolConnections.$inferSelect;
    endpoints: OAuthProviderEndpoints;
    redirectUri: string;
    galleryEntry: AppDefinition | null;
    actor?: ActorInfo;
  }) {
    // 1. A client the deployment preconfigured for this issuer wins outright.
    const configured = configuredOAuthClientForConnection(
      input.connection,
      input.endpoints.provider,
    );
    if (configured.clientId) {
      return {
        connection: input.connection,
        client: configured,
        source: "preconfigured" as const,
      };
    }
    const method = input.galleryEntry
      ? connectionMethodForConnection(input.galleryEntry, input.connection)
      : null;
    const dcrRequired = method?.oauthClientRegistration === "dcr";
    // A reviewed provider compatibility choice may require DCR even when the
    // server also advertises CIMD. Do not resolve/adopt a metadata URL for that
    // method; the default for every other method remains CIMD-first.
    const metadataDocumentUrl = !dcrRequired && input.endpoints
      .clientIdMetadataDocumentSupported
      ? await resolveOAuthClientIdMetadataDocumentUrl(
          input.redirectUri,
          options.oauthClientMetadataLookup,
        )
      : null;
    // 2. Client material already bound to this issuer/resource/callback/company.
    if (
      oauthClientBindingMatches(
        input.connection,
        input.endpoints,
        input.redirectUri,
        metadataDocumentUrl,
      )
    ) {
      const bound = await stampOAuthClientBinding(
        input.connection,
        input.endpoints,
        input.redirectUri,
      );
      return {
        connection: bound,
        client: await oauthClientForConnection(
          bound,
          input.endpoints.provider,
          input.actor,
        ),
        source: storedOAuthClientRegistrationSource(bound),
      };
    }
    const oauth = oauthConfig(input.connection);
    if (
      oauth.clientRegistrationSource === "manual" &&
      input.connection.ownership !== "dcr" &&
      typeof oauth.clientId === "string" &&
      oauth.clientId.trim()
    ) {
      // Paperclip cannot re-register on the operator's behalf: the credentials
      // came from a console this deployment does not control.
      throw unprocessable(
        "This connection's sign-in details no longer match the server it points at. Re-enter the client ID and secret to continue.",
        { code: "oauth_manual_client_rebinding_required" },
      );
    }
    if (
      !canRegisterOAuthClientDynamically(
        input.connection,
        input.endpoints,
        input.galleryEntry,
      )
    ) {
      throw unprocessable(
        `OAuth client id is not configured for ${input.endpoints.provider}`,
        {
          code: "oauth_client_registration_unavailable",
        },
      );
    }
    if (dcrRequired && !input.endpoints.registrationUrl) {
      throw unprocessable(
        "This provider requires dynamic client registration, but its authorization server did not advertise a registration endpoint.",
        { code: "oauth_dcr_not_supported" },
      );
    }

    const key = `${input.connection.id}:${input.redirectUri}`;
    return singleFlight(oauthRegistrationFlights, key, async () => {
      const latest = await getConnectionRow(
        input.connection.id,
        input.connection.companyId,
      );
      const latestConfigured = configuredOAuthClientForConnection(
        latest,
        input.endpoints.provider,
      );
      if (latestConfigured.clientId) {
        return {
          connection: latest,
          client: latestConfigured,
          source: "preconfigured" as const,
        };
      }
      if (
        oauthClientBindingMatches(
          latest,
          input.endpoints,
          input.redirectUri,
          metadataDocumentUrl,
        )
      ) {
        const bound = await stampOAuthClientBinding(
          latest,
          input.endpoints,
          input.redirectUri,
        );
        return {
          connection: bound,
          client: await oauthClientForConnection(
            bound,
            input.endpoints.provider,
            input.actor,
          ),
          source: storedOAuthClientRegistrationSource(bound),
        };
      }
      // 3. By default, Client ID Metadata Documents need no registration call,
      //    so prefer them over DCR when the authorization server advertises
      //    support. Curated DCR opt-ins leave metadataDocumentUrl null above.
      if (metadataDocumentUrl) {
        const adopted = await adoptClientIdMetadataDocument({
          connection: latest,
          endpoints: input.endpoints,
          redirectUri: input.redirectUri,
          clientId: metadataDocumentUrl,
        });
        return {
          connection: adopted,
          client: await oauthClientForConnection(
            adopted,
            input.endpoints.provider,
            input.actor,
          ),
          source: "cimd" as const,
        };
      }
      // 4. Dynamic client registration.
      if (!input.endpoints.registrationUrl) {
        throw unprocessable(
          "This server needs sign-in details you create yourself. Add a client ID and secret under Advanced authentication.",
          { code: "oauth_manual_client_required" },
        );
      }
      const registered = await registerOAuthClient({
        connection: latest,
        endpoints: input.endpoints,
        redirectUri: input.redirectUri,
        actor: input.actor,
      });
      return {
        connection: registered,
        client: await oauthClientForConnection(
          registered,
          input.endpoints.provider,
          input.actor,
        ),
        source: "dcr" as const,
      };
    });
  }
  return ensureOAuthClient;
}
