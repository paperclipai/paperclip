import { randomUUID } from "node:crypto";
import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, toolApplications, toolConnections } from "@paperclipai/db";
import type {
  ConnectToolAppResult,
  ToolCatalogRefreshResult,
  ToolConnectionHealthCheckResult,
  CreateMachineSignIn,
  MachineSignInPublicKey,
  MachineSignInSetupResult,
  MachineSignInStatus,
  RotateMachineSignIn,
  TestMachineSignIn,
  ToolCredentialSecretRef,
} from "@paperclipai/shared";
import { badRequest, conflict, HttpError, unprocessable } from "../../../errors.js";
import { writeConnectionCredential } from "../../connection-credentials.js";
import { emitConnectionCreated, emitConnectionUpdated } from "../../connector-telemetry.js";
import { notifyToolConnectionHealth } from "../../tool-connection-health-notifications.js";
import type { secretService } from "../../secrets.js";
import { splitRemoteUrlCredential } from "../../remote-url-credentials.js";
import { connectionActorUserId } from "../actor.js";
import { toApplication } from "../applications/projection.js";
import { groupedActions } from "../catalog/action-summary.js";
import type { createOrganizationGrantStore } from "../connections/organization-grant.js";
import { toConnection } from "../connections/projection.js";
import { connectionUid } from "../identifiers.js";
import type { ActorInfo } from "../types.js";
import type { createOAuthClientProtocol } from "./client.js";
import {
  CLIENT_PRIVATE_KEY_NEXT_PATH,
  CLIENT_PRIVATE_KEY_PATH,
  CLIENT_SECRET_PATH,
  chooseAssertionAlgorithm,
  chooseSecretAuthMethod,
  clientCredentialsSettings,
  generateClientKeyPair,
  publicKeyForPrivateKey,
  signClientAssertion,
  type ClientCredentialsAuthMethod,
  type ClientCredentialsSettings,
  type ClientPublicKey,
} from "./client-credentials.js";
import { actorForSecret, type OAuthCredentialStore } from "./credential-store.js";
import {
  asRecord,
  canonicalResourceIndicator,
  challengeOAuthHints,
  normalizeOauthScopes,
  oauthConfig,
  protectedResourceMetadataUrls,
  sameOAuthIssuer,
  wellKnownMetadataUrls,
} from "./metadata.js";
import { normalizeOAuthProviderError } from "./provider-errors.js";
import type { OAuthTransport } from "./types.js";

type Dependencies = OAuthTransport & {
  now: () => Date;
  secrets: ReturnType<typeof secretService>;
  store: Pick<OAuthCredentialStore, "createOrRotateOAuthSecret" | "syncCredentialBindings">;
  exchangeOAuthToken: ReturnType<typeof createOAuthClientProtocol>["exchangeOAuthToken"];
  getConnectionRow(idOrUid: string, companyId?: string): Promise<typeof toolConnections.$inferSelect>;
  assertRemoteConnectionEndpointsAllowed(config: Record<string, unknown>): Promise<unknown>;
  ensureDefaultOrganizationGrant: ReturnType<typeof createOrganizationGrantStore>;
  checkConnectionHealth(connectionId: string, actor?: ActorInfo): Promise<ToolConnectionHealthCheckResult>;
  refreshCatalog(connectionId: string, actor?: ActorInfo, options?: { enableAllByDefault?: boolean }): Promise<ToolCatalogRefreshResult>;
  /** List the server's tools with exactly these credentials, never the stored ones. */
  probeServerWithToken(connection: typeof toolConnections.$inferSelect, authorization: string, actor?: ActorInfo): Promise<unknown>;
  nextAvailableConnectionName(requestedName: string, existingNames: readonly string[]): string;
};

type DiscoveredSignInService = {
  issuer: string | null;
  tokenUrl: string;
  authMethods: string[];
  signingAlgorithms: string[];
};

type TokenOverrides = {
  clientId?: string | null;
  clientSecret?: string | null;
  scopes?: string[];
  /** Sign with the staged replacement key instead of the current one. */
  usePendingKey?: boolean;
  /** Sign with exactly this key (already read from the vault), so the key tested is the key promoted. */
  signingKey?: { privateKeyPem: string; publicKey: ClientPublicKey };
  authMethod?: ClientCredentialsAuthMethod;
};

const PERSONAL_REFUSAL =
  "Machine sign-in is only for connections your organization shares. Personal connections sign in as you.";

function issuerChangedError(advertised: string[]) {
  const hosts = advertised.map((value) => {
    try { return new URL(value).host; } catch { return value; }
  });
  return unprocessable(
    `This server now sends sign-in to a different service${hosts.length ? ` (${hosts.join(", ")})` : ""}. Paperclip won't send this connection's credentials there. Set up machine sign-in again to trust the new service.`,
    { code: "client_credentials_issuer_changed" },
  );
}

function machineSignInChangedError() {
  return conflict("This connection's machine sign-in changed or was removed while this was running. Reload it and try again.", {
    code: "client_credentials_changed",
  });
}

function rotationChangedError() {
  return conflict("The new key changed while the rotation was finishing. Register the key shown now, then try again.", {
    code: "client_credentials_rotation_changed",
  });
}

function toPublicKey(key: ClientPublicKey | null): MachineSignInPublicKey | null {
  if (!key) return null;
  return {
    keyId: key.keyId,
    algorithm: key.algorithm,
    pem: key.publicKeyPem,
    jwk: key.publicJwk as Record<string, unknown>,
    createdAt: key.createdAt,
  };
}

export function machineSignInStatus(connection: typeof toolConnections.$inferSelect): MachineSignInStatus {
  const settings = clientCredentialsSettings(connection);
  if (!settings) throw unprocessable("This connection doesn't use machine sign-in", { code: "client_credentials_not_configured" });
  const oauth = oauthConfig(connection);
  return {
    connectionId: connection.id,
    method: settings.authMethod === "private_key_jwt" ? "paperclip_key" : "client_secret",
    clientId: settings.clientId,
    issuer: settings.issuer,
    tokenUrl: settings.tokenUrl,
    scopes: settings.scopes,
    publicKey: toPublicKey(settings.key),
    pendingPublicKey: toPublicKey(settings.pendingKey),
    hasClientSecret: connection.credentialSecretRefs.some((ref) => ref.configPath === CLIENT_SECRET_PATH),
    lastTokenAt: typeof oauth.refreshedAt === "string" ? oauth.refreshedAt
      : typeof oauth.connectedAt === "string" ? oauth.connectedAt : null,
  };
}

function scopesFrom(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : normalizeOauthScopes(value.split(/\s+/));
}

export function requireClientCredentials(
  request: ClientCredentialsService["requestClientCredentialsToken"] | undefined,
): ClientCredentialsService["requestClientCredentialsToken"] {
  if (!request) throw new Error("Machine sign-in token requests are not configured for this service");
  return request;
}

export function createClientCredentialsService(db: Db, deps: Dependencies) {
  const { now, secrets, store, exchangeOAuthToken, getConnectionRow, fetchRemoteHttpUrl, assertOAuthEndpointUrl } = deps;

  async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetchRemoteHttpUrl(assertOAuthEndpointUrl("metadata", url), { headers: { accept: "application/json" } });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const parsed = asRecord(await response.json().catch(() => null));
      return Object.keys(parsed).length ? parsed : null;
    } catch {
      return null;
    }
  }

  /** RFC 8414 / OIDC metadata for one issuer, accepted only when it names that same issuer. */
  async function signInServiceMetadata(issuer: string): Promise<DiscoveredSignInService | null> {
    for (const url of wellKnownMetadataUrls(issuer)) {
      const metadata = await fetchJson(url);
      if (!metadata || typeof metadata.token_endpoint !== "string") continue;
      if (typeof metadata.issuer !== "string" || !sameOAuthIssuer(metadata.issuer, issuer)) continue;
      const grants = normalizeOauthScopes(metadata.grant_types_supported);
      if (grants.length > 0 && !grants.includes("client_credentials")) {
        throw unprocessable("This sign-in service doesn't offer machine sign-in. Check the provider's docs for a service account option.", {
          code: "client_credentials_unsupported",
        });
      }
      return {
        issuer: metadata.issuer.trim(),
        tokenUrl: assertOAuthEndpointUrl("token", metadata.token_endpoint),
        authMethods: normalizeOauthScopes(metadata.token_endpoint_auth_methods_supported),
        signingAlgorithms: normalizeOauthScopes(metadata.token_endpoint_auth_signing_alg_values_supported),
      };
    }
    return null;
  }

  /** The `resource_metadata` address from the server's answer to an unauthenticated request, if any. */
  async function challengedMetadataUrl(serverUrl: string): Promise<string | null> {
    try {
      const response = await fetchRemoteHttpUrl(serverUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "paperclip-sign-in-probe", method: "server/discover", params: {} }),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status !== 401) return null;
      return challengeOAuthHints(response.headers.get("www-authenticate") ?? "").metadataUrl;
    } catch {
      return null;
    }
  }

  /** The sign-in services an MCP server's protected-resource metadata lists, or null when it publishes none. */
  async function advertisedSignInServices(serverUrl: string): Promise<string[] | null> {
    let endpoint: URL;
    try { endpoint = new URL(serverUrl); } catch { return null; }
    // The server's own challenge may name where its metadata lives; follow
    // that (through the same URL checks) before the well-known locations.
    const hinted = await challengedMetadataUrl(serverUrl);
    for (const url of [...new Set([...(hinted ? [hinted] : []), ...protectedResourceMetadataUrls(endpoint)])]) {
      const metadata = await fetchJson(url);
      if (!metadata) continue;
      const servers = Array.isArray(metadata.authorization_servers)
        ? metadata.authorization_servers.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
      if (servers.length > 0) return servers.map((value) => value.trim());
    }
    return null;
  }

  async function discoverSignInService(serverUrl: string, authorizationServer?: string): Promise<DiscoveredSignInService> {
    if (authorizationServer) {
      const asIssuer = await signInServiceMetadata(authorizationServer);
      if (asIssuer) return asIssuer;
      // No metadata at that address: the admin gave the token URL itself.
      return { issuer: null, tokenUrl: assertOAuthEndpointUrl("token", authorizationServer), authMethods: [], signingAlgorithms: [] };
    }
    for (const issuer of (await advertisedSignInServices(serverUrl)) ?? []) {
      const found = await signInServiceMetadata(issuer);
      if (found) return found;
    }
    // A server may be its own sign-in service.
    const self = await signInServiceMetadata(new URL(serverUrl).origin);
    if (self) return self;
    throw unprocessable(
      "Paperclip couldn't find this server's sign-in service. Enter the sign-in service address or token URL from the provider's docs.",
      { code: "client_credentials_server_not_found" },
    );
  }

  /**
   * The issuer pin. A connection's credentials are bound to the sign-in service
   * recorded at setup. If the MCP server now advertises other services and not
   * that one, refuse rather than follow it.
   */
  /**
   * The signing algorithms the pinned sign-in service accepts. Connections set
   * up before this was saved reload it from that same issuer's metadata.
   */
  async function acceptedSigningAlgorithms(oauth: Record<string, unknown>, settings: ClientCredentialsSettings): Promise<string[]> {
    if (Array.isArray(oauth.tokenEndpointAuthSigningAlgValuesSupported)) {
      return normalizeOauthScopes(oauth.tokenEndpointAuthSigningAlgValuesSupported);
    }
    if (!settings.issuer) return [];
    const reloaded = await signInServiceMetadata(settings.issuer).catch(() => null);
    return reloaded?.signingAlgorithms ?? [];
  }

  async function assertPinnedSignInService(connection: typeof toolConnections.$inferSelect, settings: ClientCredentialsSettings) {
    if (!settings.issuer) return;
    const serverUrl = typeof connection.config.url === "string" ? connection.config.url : null;
    if (!serverUrl) return;
    const advertised = await advertisedSignInServices(serverUrl);
    if (advertised && !advertised.some((issuer) => sameOAuthIssuer(issuer, settings.issuer))) {
      throw issuerChangedError(advertised);
    }
  }

  async function vaultValue(connection: typeof toolConnections.$inferSelect, configPath: string, actor?: ActorInfo) {
    const ref = connection.credentialSecretRefs.find((candidate) => candidate.configPath === configPath);
    if (!ref) return null;
    return secrets.resolveSecretValue(connection.companyId, ref.secretId, ref.versionSelector ?? "latest", {
      consumerType: "tool_connection",
      consumerId: connection.id,
      configPath,
      actorType: actor?.actorType ?? "system",
      actorId: actor?.actorId ?? null,
    });
  }

  /**
   * One token request with `grant_type=client_credentials`, authenticated the
   * way this connection was set up. Credentials go only to the pinned token
   * endpoint; there is no fallback to deployment-wide OAuth clients.
   */
  async function requestClientCredentialsToken(
    connection: typeof toolConnections.$inferSelect,
    actor?: ActorInfo,
    overrides: TokenOverrides = {},
  ) {
    const settings = clientCredentialsSettings(connection);
    if (!settings) throw unprocessable("This connection doesn't use machine sign-in", { code: "client_credentials_not_configured" });
    const clientId = overrides.clientId ?? settings.clientId;
    if (!clientId) {
      throw unprocessable("Enter the client ID the provider gave you for Paperclip.", { code: "client_credentials_client_id_missing" });
    }
    const authMethod = overrides.authMethod ?? settings.authMethod;
    const scopes = overrides.scopes ?? settings.scopes;
    let clientAssertion: string | null = null;
    let clientSecret: string | null = null;
    if (authMethod === "private_key_jwt") {
      const key = overrides.signingKey?.publicKey ?? (overrides.usePendingKey ? settings.pendingKey : settings.key);
      const privateKeyPem = overrides.signingKey?.privateKeyPem
        ?? await vaultValue(connection, overrides.usePendingKey ? CLIENT_PRIVATE_KEY_NEXT_PATH : CLIENT_PRIVATE_KEY_PATH, actor);
      if (!key || !privateKeyPem) {
        throw unprocessable("This connection's Paperclip key is missing. Set up machine sign-in again.", { code: "client_credentials_key_missing" });
      }
      // The key ID comes from the private key actually read, never from config
      // alone: a refresh that overlaps a rotation may read the new key while
      // holding the old settings, and its signature and kid must still agree.
      const signing = publicKeyForPrivateKey(privateKeyPem, key.algorithm, new Date(key.createdAt));
      clientAssertion = signClientAssertion({
        privateKeyPem,
        algorithm: key.algorithm,
        keyId: signing.keyId,
        clientId,
        audience: settings.tokenUrl,
        now: now(),
      });
    } else {
      clientSecret = overrides.clientSecret ?? await vaultValue(connection, CLIENT_SECRET_PATH, actor);
      if (!clientSecret) {
        throw unprocessable("Enter the client secret the provider gave you for Paperclip.", { code: "client_credentials_secret_missing" });
      }
    }
    try {
      return await exchangeOAuthToken({
        tokenUrl: settings.tokenUrl,
        clientId,
        clientSecret,
        tokenEndpointAuthMethod: authMethod === "private_key_jwt" ? "none" : authMethod,
        clientAssertion,
        grantType: "client_credentials",
        scopes,
        resource: settings.resource,
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      const providerError = normalizeOAuthProviderError(asRecord(error.details).providerError);
      if (providerError === "invalid_client" || providerError === "unauthorized_client") {
        throw unprocessable(
          authMethod === "private_key_jwt"
            ? "The provider didn't accept Paperclip's key. Check the client ID and that the public key shown here is registered for it."
            : "The provider didn't accept the client ID and secret. Check both and try again.",
          { code: "client_credentials_rejected", providerError },
        );
      }
      if (providerError === "invalid_scope") {
        throw unprocessable("The provider refused the requested scopes. Check the scopes in the provider's docs.", {
          code: "client_credentials_scope_rejected",
          providerError,
        });
      }
      throw error;
    }
  }

  function assertOrganizationConnection(connection: typeof toolConnections.$inferSelect) {
    if (connection.credentialPolicy !== "shared") throw unprocessable(PERSONAL_REFUSAL, { code: "client_credentials_personal_refused" });
  }

  async function machineSignInConnection(companyId: string, connectionId: string) {
    const connection = await getConnectionRow(connectionId, companyId);
    if (connection.status === "archived") {
      throw unprocessable("This connection was removed. Set up machine sign-in again to reconnect.", {
        code: "client_credentials_connection_removed",
      });
    }
    assertOrganizationConnection(connection);
    if (!clientCredentialsSettings(connection)) {
      throw unprocessable("This connection doesn't use machine sign-in", { code: "client_credentials_not_configured" });
    }
    return connection;
  }

  async function writeVaultCredential(
    connection: { companyId: string; name: string },
    configPath: string,
    label: string,
    value: string,
    actor: ActorInfo | undefined,
    existingRef?: ToolCredentialSecretRef,
  ): Promise<ToolCredentialSecretRef> {
    const { secret } = await db.transaction((tx) => writeConnectionCredential(tx, {
      companyId: connection.companyId,
      connectionName: connection.name,
      configPath,
      label,
      value,
      existingRef,
      actor: actorForSecret(actor),
    }));
    return { secretId: secret.id, versionSelector: "latest", configPath, required: false, label };
  }

  type ConnectionPatch = Partial<typeof toolConnections.$inferInsert>;

  /**
   * One locked commit: the connection must still sign in the way `previous`
   * did (same method, key and credential references) and not be removed. Any
   * new credential is written in the same transaction, so a client ID and its
   * secret always land together or not at all.
   */
  async function saveConnection(
    previous: typeof toolConnections.$inferSelect,
    patch: ConnectionPatch | ((written: Record<string, ToolCredentialSecretRef>) => ConnectionPatch),
    credentials: Array<{ configPath: string; label: string; value: string; required?: boolean }> = [],
    actor?: ActorInfo,
  ) {
    // Everything that decides who this connection signs in as. Writes rotate
    // vault entries in place (same secret ID), so a revision counter, bumped by
    // every commit, catches a concurrent change the references alone would miss.
    const signInState = (row: typeof toolConnections.$inferSelect) => {
      const oauth = oauthConfig(row);
      return JSON.stringify([asRecord(oauth.clientAuth), oauth.clientId ?? null, oauth.credentialRevision ?? 0, row.credentialSecretRefs]);
    };
    // Take the company's secret-write lock before any database lock and hold it
    // through commit. Each vault write takes it too (re-entrantly here); taking
    // it per write inside this transaction could deadlock with a token refresh
    // that holds it while waiting on a row this transaction has locked.
    const updated = await withAccountHomeSecretMutationLock(undefined, previous.companyId, () => db.transaction(async (tx) => {
      const [locked] = await tx.select().from(toolConnections)
        .where(and(eq(toolConnections.id, previous.id), eq(toolConnections.companyId, previous.companyId)))
        .for("update");
      if (!locked || locked.status === "archived" || signInState(locked) !== signInState(previous)) {
        throw machineSignInChangedError();
      }
      const written: Record<string, ToolCredentialSecretRef> = {};
      for (const credential of credentials) {
        const existing = locked.credentialSecretRefs.find((ref) => ref.configPath === credential.configPath);
        const { secret } = await writeConnectionCredential(tx, {
          companyId: locked.companyId, connectionName: locked.name, configPath: credential.configPath,
          label: credential.label, value: credential.value, existingRef: existing, actor: actorForSecret(actor),
        });
        written[credential.configPath] = {
          secretId: secret.id, versionSelector: "latest", configPath: credential.configPath,
          required: credential.required ?? false, label: credential.label,
        };
      }
      const resolved = typeof patch === "function" ? patch(written) : patch;
      const baseConfig = resolved.config ?? locked.config;
      const revision = Number(oauthConfig(locked).credentialRevision ?? 0) + 1;
      const config = { ...baseConfig, oauth: { ...asRecord(asRecord(baseConfig).oauth), credentialRevision: revision } };
      const [row] = await tx.update(toolConnections)
        .set({ ...resolved, config, transportConfig: config, updatedAt: now() })
        .where(eq(toolConnections.id, locked.id))
        .returning();
      return row!;
    }));
    await store.syncCredentialBindings(updated);
    if (updated.status === "active") await deps.ensureDefaultOrganizationGrant(updated);
    emitConnectionUpdated(updated, previous, "gallery");
    return updated;
  }

  async function createMachineSignIn(companyId: string, input: CreateMachineSignIn, actor?: ActorInfo): Promise<MachineSignInSetupResult> {
    await actor?.managementContext?.reauthorize();
    const split = splitRemoteUrlCredential(input.link);
    if (split?.secretUrl) {
      throw badRequest("Remove the key from the server address. Machine sign-in sends credentials only to the sign-in service.");
    }
    const serverUrl = split?.publicUrl ?? input.link;
    const config: Record<string, unknown> = { url: serverUrl, quarantineNewEntries: false, unverifiedServer: true };
    await deps.assertRemoteConnectionEndpointsAllowed(config);
    const service = await discoverSignInService(serverUrl, input.authorizationServer);
    const createdAt = now();
    let authMethod: ClientCredentialsAuthMethod;
    let generated: Awaited<ReturnType<typeof generateClientKeyPair>> | null = null;
    if (input.method === "paperclip_key") {
      if (service.authMethods.length > 0 && !service.authMethods.includes("private_key_jwt")) {
        throw unprocessable("This provider doesn't accept Paperclip keys. Choose Client secret instead.", {
          code: "client_credentials_key_unsupported",
        });
      }
      authMethod = "private_key_jwt";
      generated = await generateClientKeyPair(chooseAssertionAlgorithm(service.signingAlgorithms), createdAt);
    } else {
      if (service.authMethods.length > 0 && !service.authMethods.some((method) => method === "client_secret_basic" || method === "client_secret_post")) {
        throw unprocessable("This provider doesn't accept client secrets. Choose Paperclip key instead.", {
          code: "client_credentials_secret_unsupported",
        });
      }
      authMethod = chooseSecretAuthMethod(service.authMethods);
    }
    config.oauth = {
      provider: "client_credentials",
      grantType: "client_credentials",
      tokenUrl: service.tokenUrl,
      issuer: service.issuer,
      resource: canonicalResourceIndicator(serverUrl),
      scopes: scopesFrom(input.scopes) ?? [],
      clientId: input.clientId ?? null,
      tokenEndpointAuthMethodsSupported: service.authMethods,
      tokenEndpointAuthSigningAlgValuesSupported: service.signingAlgorithms,
      clientAuth: { method: authMethod, ...(generated ? { key: generated.publicKey } : {}), configuredAt: createdAt.toISOString() },
    };

    const [applicationNames, connectionNames] = await Promise.all([
      db.select({ name: toolApplications.name }).from(toolApplications).where(eq(toolApplications.companyId, companyId)),
      db.select({ name: toolConnections.name }).from(toolConnections).where(eq(toolConnections.companyId, companyId)),
    ]);
    const requestedName = input.name ?? new URL(serverUrl).host.replace(/^www\./, "");
    const name = deps.nextAvailableConnectionName(requestedName, [...applicationNames, ...connectionNames].map((row) => row.name));

    const credentialSecretRefs: ToolCredentialSecretRef[] = [];
    try {
      if (generated) {
        credentialSecretRefs.push(await writeVaultCredential({ companyId, name }, CLIENT_PRIVATE_KEY_PATH, "Machine sign-in key", generated.privateKeyPem, actor));
      } else if (input.clientSecret) {
        credentialSecretRefs.push(await writeVaultCredential({ companyId, name }, CLIENT_SECRET_PATH, "Machine sign-in client secret", input.clientSecret, actor));
      }
      const connection = await db.transaction(async (tx) => {
        let application: typeof toolApplications.$inferSelect | undefined;
        if (input.applicationId) {
          [application] = await tx.select().from(toolApplications)
            .where(and(eq(toolApplications.id, input.applicationId), eq(toolApplications.companyId, companyId)));
          if (!application) throw badRequest("The app for this connection was not found");
        } else {
          [application] = await tx.insert(toolApplications).values({
            companyId,
            applicationKey: `app-gallery:link:${randomUUID()}`,
            name,
            description: `Connected app at ${serverUrl}`,
            type: "mcp_http",
            status: "draft",
            metadata: { source: "link" },
          }).returning();
        }
        const connectionId = randomUUID();
        const [row] = await tx.insert(toolConnections).values({
          id: connectionId,
          companyId,
          applicationId: application!.id,
          name,
          uid: connectionUid(application!.applicationKey ?? application!.name, name, connectionId),
          connectionKind: "managed",
          ownership: "customer",
          authKind: "oauth",
          credentialSource: "paperclip_vault",
          transport: "mcp_remote",
          status: "draft",
          enabled: false,
          config,
          transportConfig: config,
          credentialRefs: [],
          credentialSecretRefs,
          credentialPolicy: "shared",
          createdByAgentId: actor?.actorType === "agent" ? (actor.actorId ?? null) : null,
          createdByUserId: connectionActorUserId(actor),
        }).returning();
        return row!;
      });
      await store.syncCredentialBindings(connection);
      emitConnectionCreated(connection, "gallery");
      return { connectionId: connection.id, connection: toConnection(connection), machineSignIn: machineSignInStatus(connection) };
    } catch (error) {
      // Nothing references these yet; never leave an orphaned key or secret behind.
      for (const ref of credentialSecretRefs) await secrets.remove(ref.secretId).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Test the settings against the real sign-in service and server, then turn
   * the connection on. A failed test leaves the draft (and its key) in place so
   * the admin can fix the provider side and try again.
   */
  async function testMachineSignIn(
    companyId: string,
    connectionId: string,
    input: TestMachineSignIn,
    actor?: ActorInfo,
  ): Promise<ConnectToolAppResult> {
    await actor?.managementContext?.reauthorize();
    let connection = await machineSignInConnection(companyId, connectionId);
    const settings = clientCredentialsSettings(connection)!;
    await assertPinnedSignInService(connection, settings);
    const scopes = scopesFrom(input.scopes);
    const token = await requestClientCredentialsToken(connection, actor, {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      scopes,
    });
    // Prove the server accepts the new client before anything is saved: a client
    // the sign-in service accepts may still lack access to this server, and a
    // failed retest must leave a working connection's credentials untouched.
    await deps.probeServerWithToken(connection, `Bearer ${token.accessToken}`, actor);
    // The settings worked: keep them.
    const at = now();
    const expiresAt = token.expiresIn ? new Date(at.getTime() + token.expiresIn * 1000).toISOString() : null;
    const oauth = oauthConfig(connection);
    const nextConfig = {
      ...connection.config,
      oauth: {
        ...oauth,
        clientId: input.clientId ?? settings.clientId,
        scopes: scopes ?? settings.scopes,
        expiresAt,
        scope: token.scope,
        tokenType: token.tokenType,
        connectedAt: oauth.connectedAt ?? at.toISOString(),
        refreshedAt: at.toISOString(),
      },
    };
    // The new token, any replacement secret and the settings commit together,
    // after the check that nothing changed: a refused test changes nothing.
    connection = await saveConnection(connection, (written) => {
      const accessRef = written["oauth.access_token"]!;
      const secretRef = written[CLIENT_SECRET_PATH];
      return {
        config: nextConfig,
        credentialSecretRefs: [
          ...connection.credentialSecretRefs.filter((ref) =>
            ref.configPath !== "oauth.access_token" && (!secretRef || ref.configPath !== CLIENT_SECRET_PATH)),
          ...(secretRef ? [secretRef] : []),
          accessRef,
        ],
        credentialRefs: [
          ...connection.credentialRefs.filter((ref) => ref.name !== "oauth.access_token"),
          { name: "oauth.access_token", secretId: accessRef.secretId, version: "latest", placement: "header", key: "Authorization", prefix: "Bearer " },
        ],
      };
    }, [
      { configPath: "oauth.access_token", label: "OAuth access token", value: token.accessToken, required: true },
      ...(input.clientSecret ? [{ configPath: CLIENT_SECRET_PATH, label: "Machine sign-in client secret", value: input.clientSecret }] : []),
    ], actor);
    // The organization grant is what tool calls run on; give it the token now,
    // with this token's expiry (the grant's own expiry wins over the connection's).
    await deps.ensureDefaultOrganizationGrant(connection);
    await db.update(connectionGrants).set({
      providerTenant: sql`jsonb_set(coalesce(${connectionGrants.providerTenant}, '{}'::jsonb), '{oauth}', (coalesce(${connectionGrants.providerTenant}->'oauth', '{}'::jsonb) || ${JSON.stringify({ accessTokenExpiresAt: expiresAt, tokenType: token.tokenType, refreshedAt: at.toISOString() })}::jsonb)
        -- A live refresh keeps its lease; one abandoned by a stopped server is cleared with the tested credentials.
        - (case when (${connectionGrants.providerTenant} #>> '{oauth,refreshLease,expiresAt}')::timestamptz <= ${at.toISOString()}::timestamptz then 'refreshLease' else '' end))`,
      updatedAt: now(),
    }).where(and(
      eq(connectionGrants.companyId, companyId),
      eq(connectionGrants.connectionId, connection.id),
      eq(connectionGrants.kind, "organization"),
      eq(connectionGrants.isDefault, true),
    ));
    await deps.checkConnectionHealth(connection.id, actor);
    const before = connection;
    connection = await db.transaction(async (tx) => {
      await notifyToolConnectionHealth(tx, before);
      const [active] = await tx.update(toolConnections)
        .set({ status: "active", enabled: true, updatedAt: now() })
        .where(and(eq(toolConnections.id, before.id), eq(toolConnections.companyId, companyId), ne(toolConnections.status, "archived")))
        .returning();
      // Removed while the test ran: never bring it back.
      if (!active) throw machineSignInChangedError();
      await tx.update(toolApplications)
        .set({ status: "active", updatedAt: now() })
        .where(and(eq(toolApplications.id, before.applicationId), eq(toolApplications.companyId, companyId)));
      return active!;
    });
    emitConnectionUpdated(connection, before, "gallery");
    const refresh = await deps.refreshCatalog(connection.id, actor, { enableAllByDefault: false });
    const [application] = await db.select().from(toolApplications).where(eq(toolApplications.id, connection.applicationId));
    return {
      connectionId: refresh.connection.id,
      application: toApplication(application!),
      connection: refresh.connection,
      catalog: refresh.catalog,
      actions: groupedActions(refresh.catalog),
      suggestedDefaults: { access: "all_agents", askFirstRiskLevels: [] },
      auth: null,
    };
  }

  /**
   * Replace the key or secret without downtime. A new secret is tried before it
   * replaces the old one. A new key is staged: the current key keeps working
   * until the admin registers the new public key and completes the rotation.
   */
  async function rotateMachineSignIn(
    companyId: string,
    connectionId: string,
    input: RotateMachineSignIn,
    actor?: ActorInfo,
  ): Promise<MachineSignInSetupResult & { completed: boolean }> {
    await actor?.managementContext?.reauthorize();
    const connection = await machineSignInConnection(companyId, connectionId);
    const settings = clientCredentialsSettings(connection)!;
    const oauth = oauthConfig(connection);
    const clientAuth = asRecord(oauth.clientAuth);
    if (input.method === "client_secret") {
      const authMethod = settings.authMethod === "private_key_jwt"
        ? chooseSecretAuthMethod(normalizeOauthScopes(oauth.tokenEndpointAuthMethodsSupported))
        : settings.authMethod;
      await assertPinnedSignInService(connection, settings);
      await requestClientCredentialsToken(connection, actor, { clientSecret: input.clientSecret, authMethod });
      const retired = connection.credentialSecretRefs.filter((candidate) =>
        candidate.configPath === CLIENT_PRIVATE_KEY_PATH || candidate.configPath === CLIENT_PRIVATE_KEY_NEXT_PATH);
      const updated = await saveConnection(connection, (written) => ({
        config: { ...connection.config, oauth: { ...oauth, clientAuth: { method: authMethod, configuredAt: now().toISOString() } } },
        credentialSecretRefs: [
          ...connection.credentialSecretRefs.filter((candidate) => candidate.configPath !== CLIENT_SECRET_PATH && !retired.includes(candidate)),
          written[CLIENT_SECRET_PATH]!,
        ],
      }), [{ configPath: CLIENT_SECRET_PATH, label: "Machine sign-in client secret", value: input.clientSecret }], actor);
      for (const old of retired) await secrets.remove(old.secretId).catch(() => undefined);
      return { connectionId, connection: toConnection(updated), machineSignIn: machineSignInStatus(updated), completed: true };
    }
    // Keep the current key's algorithm; switching from a secret uses what the sign-in service accepts.
    const algorithm = settings.key?.algorithm ?? chooseAssertionAlgorithm(await acceptedSigningAlgorithms(oauth, settings));
    const generated = await generateClientKeyPair(algorithm, now());
    const updated = await saveConnection(connection, (written) => ({
      config: { ...connection.config, oauth: { ...oauth, clientAuth: { ...clientAuth, pendingKey: generated.publicKey } } },
      credentialSecretRefs: [...connection.credentialSecretRefs.filter((candidate) => candidate.configPath !== CLIENT_PRIVATE_KEY_NEXT_PATH), written[CLIENT_PRIVATE_KEY_NEXT_PATH]!],
    }), [{ configPath: CLIENT_PRIVATE_KEY_NEXT_PATH, label: "Machine sign-in replacement key", value: generated.privateKeyPem }], actor);
    return { connectionId, connection: toConnection(updated), machineSignIn: machineSignInStatus(updated), completed: false };
  }

  /** Switch to the staged key once the provider accepts it. */
  async function completeMachineSignInRotation(
    companyId: string,
    connectionId: string,
    actor?: ActorInfo,
  ): Promise<MachineSignInSetupResult> {
    await actor?.managementContext?.reauthorize();
    const connection = await machineSignInConnection(companyId, connectionId);
    const settings = clientCredentialsSettings(connection)!;
    if (!settings.pendingKey) throw unprocessable("There's no new key waiting. Start a key rotation first.", { code: "client_credentials_no_pending_key" });
    await assertPinnedSignInService(connection, settings);
    // Read the staged key once and derive its public half from that exact value:
    // the key that passes the test is the key that gets promoted, even if
    // another rotation replaces the staged key meanwhile.
    const pendingValue = await vaultValue(connection, CLIENT_PRIVATE_KEY_NEXT_PATH, actor);
    if (!pendingValue) throw unprocessable("The new key is missing. Start the rotation again.", { code: "client_credentials_key_missing" });
    const promoted = publicKeyForPrivateKey(pendingValue, settings.pendingKey.algorithm, new Date(settings.pendingKey.createdAt));
    if (promoted.keyId !== settings.pendingKey.keyId) throw rotationChangedError();
    await requestClientCredentialsToken(connection, actor, {
      authMethod: "private_key_jwt",
      signingKey: { privateKeyPem: pendingValue, publicKey: promoted },
    });
    const pendingRef = connection.credentialSecretRefs.find((ref) => ref.configPath === CLIENT_PRIVATE_KEY_NEXT_PATH);
    // One locked step: the row still stages this key, then the vault and config change together.
    const updated = await withAccountHomeSecretMutationLock(undefined, companyId, () => db.transaction(async (tx) => {
      const [locked] = await tx.select().from(toolConnections)
        .where(and(eq(toolConnections.id, connection.id), eq(toolConnections.companyId, companyId)))
        .for("update");
      const lockedSettings = locked ? clientCredentialsSettings(locked) : null;
      if (!locked || lockedSettings?.pendingKey?.keyId !== promoted.keyId) throw rotationChangedError();
      const current = locked.credentialSecretRefs.find((ref) => ref.configPath === CLIENT_PRIVATE_KEY_PATH);
      const { secret } = await writeConnectionCredential(tx, {
        companyId, connectionName: locked.name, configPath: CLIENT_PRIVATE_KEY_PATH, label: "Machine sign-in key",
        value: pendingValue, existingRef: current, actor: actorForSecret(actor),
      });
      const keyRef: ToolCredentialSecretRef = {
        secretId: secret.id, versionSelector: "latest", configPath: CLIENT_PRIVATE_KEY_PATH, required: false, label: "Machine sign-in key",
      };
      const lockedOauth = oauthConfig(locked);
      const nextConfig = {
        ...locked.config,
        oauth: {
          ...lockedOauth,
          clientAuth: { method: "private_key_jwt", key: promoted, configuredAt: now().toISOString() },
          credentialRevision: Number(lockedOauth.credentialRevision ?? 0) + 1,
        },
      };
      const [row] = await tx.update(toolConnections).set({
        config: nextConfig,
        transportConfig: nextConfig,
        credentialSecretRefs: [
          ...locked.credentialSecretRefs.filter((ref) =>
            ref.configPath !== CLIENT_PRIVATE_KEY_PATH && ref.configPath !== CLIENT_PRIVATE_KEY_NEXT_PATH && ref.configPath !== CLIENT_SECRET_PATH),
          keyRef,
        ],
        updatedAt: now(),
      }).where(eq(toolConnections.id, locked.id)).returning();
      return row!;
    }));
    await store.syncCredentialBindings(updated);
    if (updated.status === "active") await deps.ensureDefaultOrganizationGrant(updated);
    emitConnectionUpdated(updated, connection, "gallery");
    const retired = connection.credentialSecretRefs.filter((ref) =>
      (ref === pendingRef) || (ref.configPath === CLIENT_SECRET_PATH));
    for (const old of retired) await secrets.remove(old.secretId).catch(() => undefined);
    return { connectionId, connection: toConnection(updated), machineSignIn: machineSignInStatus(updated) };
  }

  async function getMachineSignIn(companyId: string, connectionId: string): Promise<MachineSignInStatus> {
    return machineSignInStatus(await machineSignInConnection(companyId, connectionId));
  }

  return {
    requestClientCredentialsToken,
    assertPinnedSignInService,
    createMachineSignIn,
    testMachineSignIn,
    rotateMachineSignIn,
    completeMachineSignInRotation,
    getMachineSignIn,
  };
}

export type ClientCredentialsService = ReturnType<typeof createClientCredentialsService>;
