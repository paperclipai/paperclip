import { notifyIssueReviewState } from "../../issue-review-state-notifications.js";
import { vercelConnectHttpError, vercelCredentialFor, vercelConnectResourcesFor } from "../vercel-credentials.js";
import { credentialScope, managedConnectorProfile } from "./client-settings.js";
import { createOAuthClientRegistration } from "./client-registration.js";
import type { ActorInfo } from "../types.js";
import { createOAuthEndpointPolicy } from "./endpoint-policy.js";
import { createOAuthDiscovery } from "./discovery.js";
import { oauthConfig, normalizeOauthScopes, originOf } from "./metadata.js";
import { connectionMethodForConnection } from "../connection-methods.js";
import { GOOGLE_WORKSPACE_DEFAULT_SELECTION, googleWorkspaceSelectedScopes, type GoogleWorkspaceServiceSelection, isGoogleWorkspaceScopeGrant } from "@paperclipai/shared";
import { and, eq, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, agents, connectionGrants, issueThreadInteractions, toolConnections, toolOauthStates } from "@paperclipai/db";
import type { ConnectionGrantKind, ToolOAuthStartResult } from "@paperclipai/shared";
import { getConnectableAppDefinition } from "@paperclipai/shared";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../../../errors.js";
import { isPaperclipCloudConnectorStrategy, type PaperclipCloudConnector } from "../../paperclip-cloud-connector.js";
import { deriveVercelConnectSubject, vercelConnectCallbackUrl, VercelConnectClientError, type VercelConnectClient } from "../../vercel-connect.js";

import type { ConnectionSetupPolicy } from "../connections/setup-policy.js";
import { assertSupportedConnection } from "../connections/setup-policy.js";

import { actorBinding } from "../actor.js";
import { assertOAuthRedirectConstraints, randomOauthToken, base64UrlSha256 } from "./authorization-constraints.js";
import type { createPersonalConnectionIdentity } from "../connections/personal-identity.js";

type Dependencies = {
  now: () => Date;
  getConnectionRow(idOrUid: string, companyId?: string): Promise<typeof toolConnections.$inferSelect>;
  setupPolicy: ConnectionSetupPolicy;
  fixedPersonalIdentityForReconnect: ReturnType<typeof createPersonalConnectionIdentity>;
  currentCloudConnector: () => PaperclipCloudConnector | null;
  vercelConnect: VercelConnectClient | null;
  ensureOAuthClient: ReturnType<typeof createOAuthClientRegistration>;
  oauthEndpointsForConnection: ReturnType<typeof createOAuthDiscovery>["oauthEndpointsForConnection"];
  assertOAuthEndpointUrl: ReturnType<typeof createOAuthEndpointPolicy>["assertOAuthEndpointUrl"];
};

export function createOAuthAuthorizationStart(db: Db, dependencies: Dependencies) {
  const { now, getConnectionRow, setupPolicy, fixedPersonalIdentityForReconnect, currentCloudConnector, vercelConnect, ensureOAuthClient, oauthEndpointsForConnection, assertOAuthEndpointUrl } = dependencies;
  const { assertConnectorConnectionSetupEnabled, assertExperimentalConnectorSetupEnabled } = setupPolicy;
  async function startOAuth(
    companyId: string,
    connectionId: string,
    input: {
      redirectUri: string;
      actor: ActorInfo;
      subjectUserId?: string;
      subjectAgentId?: string;
      scopes?: string[];
      workspaceServices?: GoogleWorkspaceServiceSelection;
      returnTo?: string;
      issueId?: string;
      interactionId?: string;
    },
  ): Promise<ToolOAuthStartResult> {
    await input.actor.managementContext?.reauthorize();
    let connection = await getConnectionRow(connectionId, companyId);
    assertSupportedConnection(connection);
    await assertConnectorConnectionSetupEnabled(connection);
    await assertExperimentalConnectorSetupEnabled(connection.config.sourceTemplateKey, connection.status !== "draft");
    if (connection.status === "archived")
      throw conflict("Archived app connections cannot start sign in");
    const sourceTemplateKey =
      typeof connection.config.sourceTemplateKey === "string"
        ? connection.config.sourceTemplateKey
        : null;
    const galleryEntry = sourceTemplateKey
      ? getConnectableAppDefinition(sourceTemplateKey)
      : null;
    assertOAuthRedirectConstraints(galleryEntry, input.redirectUri);
    const galleryMethod = galleryEntry
      ? connectionMethodForConnection(galleryEntry, connection)
      : null;
    const requestedScopes = await (async () => {
      if (input.workspaceServices && sourceTemplateKey !== "google-workspace") throw badRequest("Service selection requires Google Workspace");
      if (sourceTemplateKey === "google-workspace") {
        if (input.workspaceServices && input.scopes) throw badRequest("Choose services or scopes, not both");
        const allowed = normalizeOauthScopes(galleryMethod?.defaults?.scopesHint);
        let scopes = input.scopes ?? (input.workspaceServices ? googleWorkspaceSelectedScopes(input.workspaceServices) : undefined);
        if (!scopes && connection.status !== "draft") {
          // Account-page reconnect has no new service choice. Never replace its
          // subject's saved request with the new-account write defaults.
          const binding = actorBinding(input.actor);
          const subjectUserId = input.subjectUserId ?? (binding.actorType === "user" ? binding.actorId : null);
          const kind = connection.credentialPolicy === "per_user" ? "user"
            : connection.credentialPolicy === "per_agent" ? "agent" : "organization";
          const [grant] = await db.select().from(connectionGrants).where(and(
            eq(connectionGrants.companyId, companyId),
            eq(connectionGrants.connectionId, connection.id),
            eq(connectionGrants.kind, kind),
            kind === "user" ? eq(connectionGrants.subjectUserId, subjectUserId ?? "")
              : kind === "agent" ? eq(connectionGrants.subjectAgentId, input.subjectAgentId ?? "")
                : eq(connectionGrants.isDefault, true),
          )).limit(1);
          const saved = grant?.providerTenant?.oauth;
          scopes = normalizeOauthScopes(saved?.requestedScopes ?? saved?.scopes)
            .filter(scope => allowed.includes(scope));
          if (scopes.length === 0) throw badRequest("Choose your Google Workspace services before reconnecting");
        }
        scopes ??= googleWorkspaceSelectedScopes(GOOGLE_WORKSPACE_DEFAULT_SELECTION);
        if (!isGoogleWorkspaceScopeGrant(scopes) || scopes.some(scope => !allowed.includes(scope))) throw badRequest("Select at least one supported Google service");
        return scopes;
      }
      if (!galleryMethod) return input.scopes ?? null;
      const allowed = normalizeOauthScopes(galleryMethod.defaults?.scopesHint);
      if (!input.scopes) return allowed;
      const requested = normalizeOauthScopes(input.scopes);
      const widened = requested.filter((scope) => !allowed.includes(scope));
      if (widened.length > 0) {
        throw badRequest(
          `Requested OAuth scopes are not allowed for ${galleryEntry?.name ?? "this app"}`,
          {
            code: "oauth_scope_widening_rejected",
            scopes: widened,
          },
        );
      }
      return requested;
    })();
    const starterBinding = actorBinding(input.actor);
    const fixedPersonalIdentity = await fixedPersonalIdentityForReconnect(
      connection,
      input.subjectUserId,
      input.actor,
    );
    const authorizationSubjectUserId =
      fixedPersonalIdentity?.subjectUserId ?? input.subjectUserId;
    const authorizationSubjectAgentId = input.subjectAgentId;
    if (authorizationSubjectAgentId) {
      const [subjectAgent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.id, authorizationSubjectAgentId),
            eq(agents.companyId, companyId),
          ),
        )
        .limit(1);
      if (!subjectAgent)
        throw badRequest(
          "Dedicated identity requires an agent in this company",
        );
      if (connection.credentialPolicy !== "per_agent") {
        throw badRequest(
          "This connection is not configured for a dedicated agent identity",
        );
      }
    }
    const intentLink = input.interactionId
      ? await db
          .select({
            id: issueThreadInteractions.id,
            issueId: issueThreadInteractions.issueId,
            addresseeUserId: issueThreadInteractions.addresseeUserId,
            kind: issueThreadInteractions.kind,
            status: issueThreadInteractions.status,
          })
          .from(issueThreadInteractions)
          .where(
            and(
              eq(issueThreadInteractions.id, input.interactionId),
              eq(issueThreadInteractions.companyId, companyId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;
    if (
      input.interactionId &&
      (!intentLink ||
        intentLink.kind !== "connection_intent" ||
        intentLink.status !== "pending" ||
        (input.actor.managementContext?.responsibleUserId ?? (starterBinding.actorType === "user" ? starterBinding.actorId : null)) !== intentLink.addresseeUserId)
    ) {
      throw forbidden(
        "Only the addressed user can authorize this connection request",
      );
    }
    if (input.actor.managementContext?.actor.type === "agent") {
      // An agent has no browser session. Reuse the saved setup; the addressed
      // human starts provider authorization in their own authenticated session.
      // No provider state or credentials are issued by this handoff.
      if (sourceTemplateKey === "google-workspace" && (input.workspaceServices || input.scopes)) {
        await input.actor.managementContext.reauthorize();
        const userId = input.actor.managementContext.responsibleUserId!;
        await db.transaction(async tx => {
          const [saved] = await tx.select().from(toolConnections).where(and(eq(toolConnections.id, connection.id), eq(toolConnections.companyId, companyId))).for("no key update");
          if (!saved) throw notFound("Connection not found");
          const rawOauth = saved.config.oauth;
          const oauth = rawOauth && typeof rawOauth === "object" && !Array.isArray(rawOauth) ? rawOauth as Record<string, unknown> : {};
          const prior = oauth.pendingWorkspaceServiceRequests;
          const pending = prior && typeof prior === "object" && !Array.isArray(prior) ? prior as Record<string, unknown> : {};
          const requested = { ...pending, [userId]: { requestedScopes, requestedAt: now().toISOString() } };
          const config = { ...saved.config, oauth: { ...oauth, pendingWorkspaceServiceRequests: requested } };
          const transportOauth = saved.transportConfig.oauth;
          const transportConfig = { ...saved.transportConfig, oauth: { ...(transportOauth && typeof transportOauth === "object" && !Array.isArray(transportOauth) ? transportOauth : {}), pendingWorkspaceServiceRequests: requested } };
          await tx.update(toolConnections).set({ config, transportConfig, updatedAt: now() }).where(eq(toolConnections.id, saved.id));
        });
      }
      const [company] = await db.select({ prefix: companies.issuePrefix }).from(companies).where(eq(companies.id, companyId));
      if (!company) throw notFound("Company not found");
      const destination = new URL(input.redirectUri);
      destination.pathname = `/${encodeURIComponent(company.prefix)}/apps/${connection.credentialSource === "vercel_connect" ? "vercel-connect" : "connect"}`;
      destination.search = new URLSearchParams({ [connection.status === "draft" ? "resume" : "reconnect"]: connection.id,
        ...(sourceTemplateKey ? { source: sourceTemplateKey } : {}), ...(intentLink ? { intent: intentLink.id } : {}) }).toString();
      destination.hash = "";
      return { connectionId: connection.id, provider: sourceTemplateKey ?? "oauth",
        authorizationUrl: destination.toString(), expiresAt: null };
    }
    if (connection.credentialSource === "vercel_connect") {
      if (!vercelConnect)
        throw vercelConnectHttpError(
          new VercelConnectClientError("vercel_connect_unavailable", 503),
        );
      const credential = vercelCredentialFor(connection);
      if (
        connection.authKind !== "oauth" ||
        credential.principalMode !== "user"
      ) {
        throw badRequest(
          "This Vercel connector does not use browser authorization",
        );
      }
      const binding = starterBinding;
      if (!binding.actorType || !binding.actorId) {
        throw forbidden(
          "Vercel Connect authorization requires an authenticated actor",
        );
      }
      const grantKind: ConnectionGrantKind = authorizationSubjectUserId
        ? "user"
        : "organization";
      const derived = deriveVercelConnectSubject({
        credential,
        connectionId: connection.id,
        companyId,
        grantKind,
        subjectUserId: authorizationSubjectUserId,
      });
      const state = randomOauthToken();
      let authorization;
      try {
        authorization = await vercelConnect.startAuthorization(
          {
            connector: credential.connectorUid,
            subject: derived.subject,
            scopes: credential.scopes,
            resources: vercelConnectResourcesFor(connection),
          },
          vercelConnectCallbackUrl(input.redirectUri, state),
        );
      } catch (error) {
        throw vercelConnectHttpError(error);
      }
      const remoteExpiry = authorization.expiresAt
        ? new Date(authorization.expiresAt)
        : null;
      const expiresAt =
        remoteExpiry && Number.isFinite(remoteExpiry.getTime())
          ? new Date(
              Math.min(
                remoteExpiry.getTime(),
                now().getTime() + 10 * 60 * 1000,
              ),
            )
          : new Date(now().getTime() + 10 * 60 * 1000);
      await db
        .delete(toolOauthStates)
        .where(lt(toolOauthStates.expiresAt, now()));
      await db.insert(toolOauthStates).values({
        state,
        companyId,
        connectionId: connection.id,
        // Vercel owns its verifier. This marker only dispatches the consumed
        // one-time state to the Vercel callback completion path.
        codeVerifier: "vercel-connect",
        createdByActorType: binding.actorType,
        createdByActorId: binding.actorId,
        createdBySessionId: binding.sessionId,
        subjectUserId: authorizationSubjectUserId,
        requestedScopes: [...credential.scopes],
        returnTo: input.returnTo,
        issueId: intentLink?.issueId ?? input.issueId,
        interactionId: intentLink?.id,
        expiresAt,
      });
      return {
        connectionId: connection.id,
        provider: `vercel-connect:${credential.service}`,
        authorizationUrl: authorization.url,
        expiresAt: expiresAt.toISOString(),
        issuer: "https://vercel.com/connect",
        resource: galleryMethod?.defaults?.serverUrl ?? null,
        registrationSource: null,
      };
    }
    if (
      galleryMethod &&
      isPaperclipCloudConnectorStrategy(galleryMethod.oauthStrategy)
    ) {
      const connectorProfile = galleryMethod.connectorProfile;
      const managedProfile = managedConnectorProfile(connectorProfile);
      if (!managedProfile)
        throw badRequest("This app has an invalid managed connector profile");
      const providerName = galleryEntry?.name ?? "Google Workspace";
      const cloudConnector = currentCloudConnector();
      if (!cloudConnector) {
        throw unprocessable(
          `${providerName} connections through Paperclip are not available on this instance yet`,
          {
            code: "paperclip_cloud_connector_unavailable",
          },
        );
      }
      const binding = starterBinding;
      if (!binding.actorType || !binding.actorId) {
        throw forbidden(
          `${providerName} sign-in requires an authenticated actor`,
        );
      }
      const subjectUserId = authorizationSubjectAgentId
        ? null
        : (authorizationSubjectUserId ??
          (binding.actorType === "user" ? binding.actorId : null));
      if (!subjectUserId && !authorizationSubjectAgentId) {
        throw forbidden(
          `Agent-started ${providerName} sign-in requires an authorized identity`,
        );
      }
      if (
        !authorizationSubjectAgentId &&
        binding.actorType === "user" &&
        subjectUserId !== binding.actorId
      ) {
        throw forbidden(
          `Board users may only authorize their own ${providerName} identity`,
        );
      }
      await db
        .delete(toolOauthStates)
        .where(lt(toolOauthStates.expiresAt, now()));
      const state = randomOauthToken();
      const returnUri = new URL(input.redirectUri);
      returnUri.pathname = "/api/tools/oauth/cloud-connector/callback";
      returnUri.search = "";
      returnUri.hash = "";
      const session = await cloudConnector.startAuthorization({
        subject: authorizationSubjectAgentId
          ? `agent:${authorizationSubjectAgentId}`
          : subjectUserId!,
        companyId,
        profile: managedProfile.id,
        ...(managedProfile.id === "workspace.all" ? { scopes: requestedScopes! } : {}),
        returnUri: returnUri.toString(),
        returnState: state,
      });
      const remoteExpiry = new Date(session.expiresAt);
      const expiresAt = Number.isFinite(remoteExpiry.getTime())
        ? new Date(
            Math.min(remoteExpiry.getTime(), now().getTime() + 10 * 60 * 1000),
          )
        : new Date(now().getTime() + 10 * 60 * 1000);
      await db.insert(toolOauthStates).values({
        state,
        companyId,
        connectionId: connection.id,
        // Paperclip Cloud owns PKCE for this flow. The local state row remains the
        // single-use browser correlator and never stores broker token material.
        codeVerifier: "paperclip-cloud-connector",
        createdByActorType: binding.actorType,
        createdByActorId: binding.actorId,
        createdBySessionId: binding.sessionId,
        subjectUserId,
        subjectAgentId: authorizationSubjectAgentId,
        requestedScopes: managedProfile.id === "workspace.all" ? requestedScopes! : [...managedProfile.scopes],
        returnTo: input.returnTo,
        issueId: intentLink?.issueId ?? input.issueId,
        interactionId: intentLink?.id,
        expiresAt,
      });
      return {
        connectionId: connection.id,
        provider: managedProfile.provider,
        authorizationUrl: session.authorizationUrl,
        expiresAt: expiresAt.toISOString(),
        ...(session.handoff ? { handoff: session.handoff } : {}),
        issuer:
          managedProfile.provider === "github"
            ? "https://github.com"
            : managedProfile.provider === "asana"
              ? "https://app.asana.com"
              : "https://accounts.google.com",
        resource: galleryMethod.defaults?.serverUrl ?? null,
        registrationSource: null,
      };
    }
    const endpoints = await oauthEndpointsForConnection(
      connection,
      null,
      input.redirectUri,
    );
    if (endpoints.grantType === "client_credentials") {
      throw unprocessable(
        "This app uses shared machine credentials and does not need browser sign in",
      );
    }
    const resolvedClient = await ensureOAuthClient({
      connection,
      endpoints,
      redirectUri: input.redirectUri,
      galleryEntry,
      actor: input.actor,
    });
    connection = resolvedClient.connection;
    const client = resolvedClient.client;
    if (galleryMethod?.oauthClientSecretRequired && !client.clientSecret) {
      throw unprocessable("This app requires an OAuth client secret. Add it in the app setup before signing in.");
    }
    if (!client.clientId)
      throw unprocessable(
        `OAuth client id is not configured for ${endpoints.provider}`,
      );

    const authorizationScopes = normalizeOauthScopes(
      galleryMethod ? (requestedScopes ?? []) : (input.scopes ?? endpoints.scopes),
    );
    if (
      !galleryMethod &&
      endpoints.offlineAccessSupported &&
      (!endpoints.grantTypesSupported?.length ||
        endpoints.grantTypesSupported.includes("refresh_token")) &&
      !authorizationScopes.includes("offline_access")
    ) authorizationScopes.push("offline_access");

    await db
      .delete(toolOauthStates)
      .where(lt(toolOauthStates.expiresAt, new Date()));

    const state = randomOauthToken();
    const codeVerifier = randomOauthToken(48);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const binding = starterBinding;
    if (!binding.actorType || !binding.actorId) {
      throw forbidden("OAuth sign-in requires an authenticated board session");
    }
    await db.insert(toolOauthStates).values({
      state,
      companyId,
      connectionId: connection.id,
      codeVerifier,
      createdByActorType: binding.actorType,
      createdByActorId: binding.actorId,
      createdBySessionId: binding.sessionId,
      subjectUserId: authorizationSubjectUserId,
      requestedScopes: authorizationScopes,
      returnTo: input.returnTo,
      issueId: intentLink?.issueId ?? input.issueId,
      interactionId: intentLink?.id,
      expiresAt,
    });

    // Last gate before this URL becomes a top-level browser navigation. Every
    // producer above already validates, so reaching a rejection here means a new
    // path was added without one — fail closed rather than hand the board an
    // unvetted target.
    const authorizationUrl = new URL(
      assertOAuthEndpointUrl("authorization", endpoints.authorizationUrl, {
        // Paperclip's own callback origin: a first-party authorization endpoint is
        // served however this deployment is served, plaintext LAN host included.
        firstPartyOrigin: originOf(input.redirectUri),
      }),
    );
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", client.clientId);
    authorizationUrl.searchParams.set("redirect_uri", input.redirectUri);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set(
      "code_challenge",
      base64UrlSha256(codeVerifier),
    );
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    // RFC 8707: name the MCP server the resulting token is for, so an
    // authorization server that serves several resources can audience-restrict it.
    if (endpoints.resource)
      authorizationUrl.searchParams.set("resource", endpoints.resource);
    // Curated definitions are an allowlist, not a suggestion. Never copy every
    // scope advertised by discovery into a provider consent screen: a curated
    // method either sends its reviewed hint or omits scope entirely. Generic
    // MCP URLs retain discovery-first behavior because Paperclip has no manifest
    // against which it could safely judge the caller's requested scope.
    if (authorizationScopes.length > 0)
      authorizationUrl.searchParams.set("scope", authorizationScopes.join(" "));
    if (galleryMethod && connection.config.sourceTemplateKey === "google-workspace")
      authorizationUrl.searchParams.set("enable_granular_consent", "true");
    const reviewedAuthorizationParams =
      galleryMethod?.defaults?.oauthAuthorizationParams;
    if (reviewedAuthorizationParams?.access_type)
      authorizationUrl.searchParams.set(
        "access_type",
        reviewedAuthorizationParams.access_type,
      );
    if (reviewedAuthorizationParams?.prompt)
      authorizationUrl.searchParams.set(
        "prompt",
        reviewedAuthorizationParams.prompt,
      );
    else if (!galleryMethod && authorizationScopes.includes("offline_access"))
      // OIDC offline access requires consent unless the provider has another
      // established basis for granting it. A generic server has no reviewed override.
      authorizationUrl.searchParams.set("prompt", "consent");

    if (
      authorizationSubjectUserId &&
      input.issueId &&
      binding.actorType === "agent"
    ) {
      const idempotencyKey = `connection-authorization:${connection.id}:${authorizationSubjectUserId}`;
      // Provider label for the card's copy. The gallery definition's name when we
      // have one, else the connection's own name — never a secret name or ref.
      const sourceTemplateKey =
        typeof connection.config.sourceTemplateKey === "string"
          ? connection.config.sourceTemplateKey
          : null;
      const providerName =
        (sourceTemplateKey
          ? getConnectableAppDefinition(sourceTemplateKey)?.name
          : null) ?? connection.name;
      const [requestingAgent] = binding.actorId
        ? await db
            .select({ name: agents.name })
            .from(agents)
            .where(
              and(
                eq(agents.id, binding.actorId),
                eq(agents.companyId, companyId),
              ),
            )
            .limit(1)
        : [undefined];
      const payload = {
        version: 1 as const,
        prompt: `Connect your ${providerName} to continue`,
        acceptLabel: `Connect ${providerName}`,
        rejectLabel: "Not now",
        detailsMarkdown:
          "Authorization is required before this agent can act on your behalf.",
        // Presentation metadata so the card can compose its own copy instead of
        // parsing the title string (PAP-17835 seam #6). The interaction kind and
        // the server-addressed audience are unchanged.
        connectionAuthorization: {
          version: 1 as const,
          providerName,
          connectionName:
            connection.name === providerName ? null : connection.name,
          requestingAgentName: requestingAgent?.name ?? null,
        },
        target: {
          type: "custom" as const,
          key: `connection:${connection.uid}:user:${authorizationSubjectUserId}`,
          revisionId: state,
          label: `Connect ${providerName}`,
          href: authorizationUrl.toString(),
        },
      };
      const issueId = input.issueId;
      await db.transaction(async tx => {
        await notifyIssueReviewState(tx, { companyId, issueId });
        const [existingInteraction] = await tx
          .select()
          .from(issueThreadInteractions)
          .where(
            and(
              eq(issueThreadInteractions.companyId, companyId),
              eq(issueThreadInteractions.issueId, issueId),
              eq(issueThreadInteractions.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1);
        const [interaction] = existingInteraction
          ? await tx
              .update(issueThreadInteractions)
              .set({
                status: "pending",
                requestedResolverPolicy: "human_only",
                effectiveResolverPolicy: "human_only",
                resolverPolicyProvenance: "explicit",
                effectiveResolverPolicySource: "requested",
                addresseeUserId: authorizationSubjectUserId,
                payload,
                result: null,
                resolvedAt: null,
                updatedAt: new Date(),
              })
              .where(eq(issueThreadInteractions.id, existingInteraction.id))
              .returning()
          : await tx
              .insert(issueThreadInteractions)
              .values({
                companyId,
                issueId: issueId,
                kind: "request_confirmation",
                status: "pending",
                continuationPolicy: "none",
                requestedResolverPolicy: "human_only",
                effectiveResolverPolicy: "human_only",
                resolverPolicyProvenance: "explicit",
                effectiveResolverPolicySource: "requested",
                addresseeUserId: authorizationSubjectUserId,
                idempotencyKey,
                sourceRunId:
                  binding.actorType === "agent"
                    ? (input.actor.sessionId ?? null)
                    : null,
                title: `Connect your ${providerName} to continue`,
                summary: `${requestingAgent?.name ?? "An agent"} needs your ${providerName} identity for work running as you.`,
                createdByAgentId:
                  binding.actorType === "agent" ? binding.actorId : null,
                payload,
              })
              .returning();
        if (interaction) {
          await tx
            .update(toolOauthStates)
            .set({ interactionId: interaction.id })
            .where(eq(toolOauthStates.state, state));
        }
      });
    }

    const nextConfig = {
      ...connection.config,
      oauth: {
        ...oauthConfig(connection),
        provider: endpoints.provider,
        authorizationUrl: endpoints.authorizationUrl,
        tokenUrl: endpoints.tokenUrl,
        registrationUrl: endpoints.registrationUrl ?? null,
        metadataUrl: endpoints.metadataUrl ?? null,
        // Curated apps persist only the reviewed scopes attached to this OAuth
        // state. Discovery metadata can advertise a provider's entire scope
        // universe and must never silently become Paperclip's requested set.
        scopes: authorizationScopes,
        offlineAccessSupported: endpoints.offlineAccessSupported,
        grantTypesSupported: endpoints.grantTypesSupported ?? [],
        codeChallengeMethodsSupported:
          endpoints.codeChallengeMethodsSupported ?? [],
        tokenEndpointAuthMethodsSupported:
          endpoints.tokenEndpointAuthMethodsSupported ?? [],
        grantType: "authorization_code",
        clientIdEnv: client.clientIdEnv,
        clientSecretEnv: client.clientSecret ? client.clientSecretEnv : null,
        credentialScope: credentialScope(connection, input.actor),
        // Persist the issuer and resource this authorization run is bound to.
        // `iss` on the callback is validated against `expectedIssuer`, and
        // refresh/reconnect/revoke reuse the same pair rather than re-deriving it.
        issuer: endpoints.issuer ?? oauthConfig(connection).issuer ?? null,
        expectedIssuer: endpoints.issuer ?? null,
        resource:
          endpoints.resource ?? oauthConfig(connection).resource ?? null,
        clientIdMetadataDocumentSupported:
          endpoints.clientIdMetadataDocumentSupported === true,
      },
    };
    await db
      .update(toolConnections)
      .set({
        // A generic URL connection starts life as `authKind: none`. Once it has
        // completed OAuth discovery and client resolution it is an OAuth
        // connection, and refresh, reconnect, revoke and diagnostics must all
        // treat it as one.
        authKind: "oauth",
        config: nextConfig,
        transportConfig: nextConfig,
        updatedAt: new Date(),
      })
      .where(eq(toolConnections.id, connection.id));

    return {
      connectionId: connection.id,
      provider: endpoints.provider,
      authorizationUrl: authorizationUrl.toString(),
      expiresAt: expiresAt.toISOString(),
      issuer: endpoints.issuer ?? null,
      resource: endpoints.resource ?? null,
      registrationSource: resolvedClient.source,
    };
  }
  return startOAuth;
}
