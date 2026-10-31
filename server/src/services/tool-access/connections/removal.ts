import { notifyVoiceChange } from "../../voice/voice-recovery-notifications.js";
import { notifyChatEndpointWork } from "../../chat-work-notifications.js";
import { notifyToolConnectionHealth } from "../../tool-connection-health-notifications.js";
import { toConnection } from "./projection.js";
import { actorBinding } from "../actor.js";
import { vercelConnectResourcesFor } from "../vercel-credentials.js";
import type { ActorInfo } from "../types.js";
import { chatCredentialMutationLease } from "../../chat-credential-mutation-lease.js";
import { removeSlackRegistration } from "../../chat-slack-registration-cleanup.js";
import { chatEndpoints } from "@paperclipai/db";
import { isBrowserUseConnection } from "../../browser-use-client.js";
import { browserUseService } from "../../browser-use.js";
import { emitConnectionUpdated } from "../../connector-telemetry.js";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, connectionTokenIssuances, companySecretBindings, companySecrets, userSecretDefinitions, userSecretDeclarations, toolApplications, toolCatalogEntries, toolConnectionInstalls, toolConnections, toolOauthStates, toolGatewaySessions, toolMcpGateways, toolMcpGatewayTokens, toolProfileBindings, toolProfileEntries, toolProfiles, toolRuntimeSlots } from "@paperclipai/db";
import type { ToolConnectionRemovalResult, ToolConnectionRemovalSummary } from "@paperclipai/shared";
import { notFound } from "../../../errors.js";
import { logger } from "../../../middleware/logger.js";
import { forgetMcpHttpSessions } from "../../mcp-http.js";
import { secretService } from "../../secrets.js";
import { connectionSecretsUsedByOtherConsumers } from "../../connection-credentials.js";
import { createToolRuntimeSupervisor } from "../../tool-runtime-supervisor.js";
import { vercelConnectIntegrationStatus, vercelTokenRequest, type VercelConnectClient } from "../../vercel-connect.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

/**
 * The key namespace `connectGalleryApp`, `reconnectGalleryApp` and
 * `createOrRotateOAuthSecret` mint for credentials a connection owns outright.
 * Nothing else writes this prefix, which is what lets removal tell a dedicated
 * app credential apart from a secret the operator manages by hand — see
 * `classifyConnectionSecrets`. Matched as a prefix on purpose: `secrets.remove`
 * suffixes `__deleted__<id>` onto the key before it deletes the row, so a
 * removal that is retried after a provider failure must still recognise it.
 */
const CONNECTION_OWNED_SECRET_KEY_PREFIX = "tool_app.";

/** Token fields a legacy row may have inlined into `config.oauth`. */
const INLINE_OAUTH_TOKEN_FIELDS = [
  "access_token",
  "refresh_token",
  "accessToken",
  "refreshToken",
  "client_secret",
  "clientSecret",
];

/**
 * Drop inline OAuth token material from a connection config, keeping the
 * non-secret identity (client id, issuer, registration source) a later
 * reconnect reuses. Current code stores tokens as secret refs, never in the
 * config; this exists so a row written by an older build cannot keep a usable
 * token after the operator removed the app.
 */
function withoutInlineOAuthTokens(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const oauth = config.oauth;
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth))
    return config;
  const next = { ...(oauth as Record<string, unknown>) };
  let changed = false;
  for (const field of INLINE_OAUTH_TOKEN_FIELDS) {
    if (field in next) {
      delete next[field];
      changed = true;
    }
  }
  return changed ? { ...config, oauth: next } : config;
}

type RemovalDependencies = {
  options: { remoteHttpRequest?: (url: string, init: RequestInit) => Promise<Response> };
  secrets: ReturnType<typeof secretService>;
  runtimeSupervisor: Pick<ReturnType<typeof createToolRuntimeSupervisor>, "stopSlot">;
  vercelConnect: VercelConnectClient | null;
  getConnectionRow(idOrUid: string, companyId?: string): Promise<typeof toolConnections.$inferSelect>;
};

export function createConnectionRemoval(db: Db, { options, secrets, runtimeSupervisor, vercelConnect, getConnectionRow }: RemovalDependencies) {
  /**
   * Split the secrets a connection points at into the ones it owns outright and
   * the ones another consumer still depends on.
   *
   * Removing an app is a credential revocation boundary (PAP-17119), but it must
   * never destroy a secret the operator manages by hand or shares with another
   * target. Two independent tests have to agree before a secret is destroyed:
   *
   * 1. Provenance — the key sits in the `tool_app.` namespace only the
   *    connect/reconnect/OAuth paths mint, or its user-secret definition does.
   *    Personal definitions must also have no declarations on other targets.
   * 2. Exclusivity — nothing outside this connection references it: no
   *    `company_secret_bindings` row from another target, and no other
   *    connection or connection grant naming the same secret id.
   *
   * A secret failing either test is reported as retained; removal still drops
   * this connection's binding and ref, so the connection loses the credential
   * either way. Retaining a secret nobody can reach is a leak of an unused row;
   * deleting one another target still resolves is an outage, so the ambiguous
   * case fails towards retention.
   */
async function classifyConnectionSecrets(
    connection: typeof toolConnections.$inferSelect,
    secretIds: string[],
  ): Promise<{ owned: string[]; retained: string[] }> {
    const unique = [
      ...new Set(
        secretIds.filter((id) => typeof id === "string" && id.length > 0),
      ),
    ];
    if (unique.length === 0) return { owned: [], retained: [] };

    const secretRows = await db
      .select({
        id: companySecrets.id,
        key: companySecrets.key,
        scope: companySecrets.scope,
        userSecretDefinitionId: companySecrets.userSecretDefinitionId,
      })
      .from(companySecrets)
      .where(
        and(
          eq(companySecrets.companyId, connection.companyId),
          inArray(companySecrets.id, unique),
        ),
      );
    const byId = new Map(secretRows.map((row) => [row.id, row]));

    const referencedElsewhere = await connectionSecretsUsedByOtherConsumers(db, unique);
    const foreignBindings = await db
      .select({ secretId: companySecretBindings.secretId })
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, connection.companyId),
          inArray(companySecretBindings.secretId, unique),
          sql`not (${companySecretBindings.targetType} = 'tool_connection' and ${companySecretBindings.targetId} = ${connection.id})`,
        ),
      );
    for (const row of foreignBindings) referencedElsewhere.add(row.secretId);

    // Bindings are the authority, but read the sibling refs too: a row written
    // before `syncCredentialBindings` existed — or by hand — can reference a
    // secret with no binding to prove it.
    const siblingConnections = await db
      .select({
        credentialRefs: toolConnections.credentialRefs,
        credentialSecretRefs: toolConnections.credentialSecretRefs,
      })
      .from(toolConnections)
      .where(
        and(
          eq(toolConnections.companyId, connection.companyId),
          ne(toolConnections.id, connection.id),
        ),
      );
    for (const row of siblingConnections) {
      for (const ref of row.credentialRefs ?? [])
        referencedElsewhere.add(ref.secretId);
      for (const ref of row.credentialSecretRefs ?? [])
        referencedElsewhere.add(ref.secretId);
    }
    const siblingGrants = await db
      .select({ credentialSecretRefs: connectionGrants.credentialSecretRefs })
      .from(connectionGrants)
      .where(
        and(
          eq(connectionGrants.companyId, connection.companyId),
          ne(connectionGrants.connectionId, connection.id),
        ),
      );
    for (const row of siblingGrants) {
      for (const ref of row.credentialSecretRefs ?? [])
        referencedElsewhere.add(ref.secretId);
    }

    const definitionIds = secretRows.flatMap((row) => row.userSecretDefinitionId ? [row.userSecretDefinitionId] : []);
    const definitions = definitionIds.length ? await db.select().from(userSecretDefinitions)
      .where(and(eq(userSecretDefinitions.companyId, connection.companyId), inArray(userSecretDefinitions.id, definitionIds))) : [];
    const dedicatedDefinitions = new Set(definitions.filter((row) => row.key.startsWith(CONNECTION_OWNED_SECRET_KEY_PREFIX) || row.key.startsWith(`tool_oauth.${connection.id}.`)).map((row) => row.id));
    const foreignDeclarations = definitionIds.length ? await db.select().from(userSecretDeclarations).where(and(
      inArray(userSecretDeclarations.userSecretDefinitionId, definitionIds),
      sql`not (${userSecretDeclarations.targetType} = 'tool_connection' and ${userSecretDeclarations.targetId} = ${connection.id})`,
    )) : [];
    const sharedDefinitions = new Set(foreignDeclarations.map((row) => row.userSecretDefinitionId));
    const owned: string[] = [];
    const retained: string[] = [];
    for (const secretId of unique) {
      const row = byId.get(secretId);
      // No row means an earlier pass of this same removal already deleted it.
      // Hand it back as owned so a retry re-runs the (idempotent) revocation
      // instead of reporting a credential this connection never shared.
      if (!row) {
        owned.push(secretId);
        continue;
      }
      const dedicated = row.scope === "user" && row.userSecretDefinitionId
        ? dedicatedDefinitions.has(row.userSecretDefinitionId) && !sharedDefinitions.has(row.userSecretDefinitionId)
        : row.scope === "company" && row.userSecretDefinitionId === null
          && row.key.startsWith(CONNECTION_OWNED_SECRET_KEY_PREFIX);
      if (dedicated && !referencedElsewhere.has(secretId)) owned.push(secretId);
      else retained.push(secretId);
    }
    return { owned, retained };
  }

  /**
   * Remove an app: a credential-revoking teardown, not a status flip (PAP-17119).
   *
   * Order is the security property. Every database-side access path closes
   * first — grants, installs, the app-managed profile, gateway tokens minted
   * against it, outstanding OAuth state, the catalog, and the connection itself
   * — so the app is already undispatchable before the first call out to a secret
   * provider. Secret revocation runs last, and each secret's ref survives until
   * that secret is gone, so a provider that errors leaves the operation failed
   * closed and resumable: the credential is already unresolvable (its row is
   * marked deleted first), and retrying the same removal finishes the job.
   *
   * What stays behind is deliberate: the connection and application rows, their
   * ids, names and activity keep working so a later reconnect reuses the same
   * identity — but with no credential, no install and no profile, so
   * reconnecting has to ask for fresh authentication and rebuild access.
   */
async function removeConnection(
    connectionId: string,
    companyId?: string,
    actor?: ActorInfo,
  ): Promise<ToolConnectionRemovalResult> {
    await actor?.managementContext?.reauthorize();
    const connection = await getConnectionRow(connectionId, companyId);
    const [endpoint] = await db.select().from(chatEndpoints).where(and(eq(chatEndpoints.connectionId, connection.id), eq(chatEndpoints.companyId, connection.companyId), eq(chatEndpoints.provider, "slack")));
    if (!endpoint) return removeConnectionUnlocked(connectionId, companyId, actor);
    return chatCredentialMutationLease(db)(endpoint, async lease => {
      await db.transaction(async tx => {
        await lease.assertOwned(tx);
        await tx.update(chatEndpoints).set({ status: "archived", updatedAt: new Date() }).where(eq(chatEndpoints.id, endpoint.id));
        await tx.update(toolConnections).set({ status: "archived", enabled: false, updatedAt: new Date() }).where(eq(toolConnections.id, connection.id));
      });
      await removeSlackRegistration(db, endpoint.id, lease);
      return removeConnectionUnlocked(connectionId, companyId, actor);
    });
  }

  async function removeConnectionUnlocked(connectionId: string, companyId?: string, actor?: ActorInfo): Promise<ToolConnectionRemovalResult> {
    await actor?.managementContext?.reauthorize();
    const connection = await getConnectionRow(connectionId, companyId);
    forgetMcpHttpSessions(connection.id);
    const now = new Date();
    const binding = actorBinding(actor);

    // Grants are read before they are revoked: a retried removal must still see
    // the credential refs of a grant an earlier pass already marked revoked.
    const grantRows = await db
      .select({
        id: connectionGrants.id,
        status: connectionGrants.status,
        kind: connectionGrants.kind,
        subjectUserId: connectionGrants.subjectUserId,
        credentialSecretRefs: connectionGrants.credentialSecretRefs,
        externalCredential: connectionGrants.externalCredential,
      })
      .from(connectionGrants)
      .where(
        and(
          eq(connectionGrants.companyId, connection.companyId),
          eq(connectionGrants.connectionId, connection.id),
        ),
      );
    const grantsToRevoke = grantRows.filter((row) => row.status !== "revoked");
    if (grantsToRevoke.length > 0) {
      await db
        .update(connectionGrants)
        .set({
          status: "revoked",
          isDefault: false,
          revokedAt: now,
          revokedByAgentId:
            binding.actorType === "agent" ? binding.actorId : null,
          revokedByUserId:
            binding.actorType === "user" ? binding.actorId : null,
          updatedAt: now,
        })
        .where(
          inArray(
            connectionGrants.id,
            grantsToRevoke.map((row) => row.id),
          ),
        );
    }
    let externalCredentialCleanup: ToolConnectionRemovalSummary["externalCredentialCleanup"] =
      null;
    if (
      connection.credentialSource === "vercel_connect" &&
      connection.externalCredential
    ) {
      let attempted = 0;
      let revoked = 0;
      let failures = 0;
      let appSubjectCleanup: "not_applicable" | "manage_in_vercel" =
        "not_applicable";
      for (const grant of grantRows) {
        const request = vercelTokenRequest({
          credential: connection.externalCredential,
          grant,
          connectionId: connection.id,
          companyId: connection.companyId,
          resources: vercelConnectResourcesFor(connection),
        });
        vercelConnect?.evict(request);
        if (grant.externalCredential?.subjectType === "app") {
          appSubjectCleanup = "manage_in_vercel";
          continue;
        }
        if (grant.externalCredential?.subjectType !== "user") continue;
        attempted += 1;
        try {
          if (!vercelConnect) throw new Error("Vercel Connect unavailable");
          await vercelConnect.revoke(request);
          revoked += 1;
        } catch {
          failures += 1;
        }
      }
      externalCredentialCleanup = {
        provider: "vercel_connect",
        userSubjectsAttempted: attempted,
        userSubjectsRevoked: revoked,
        userSubjectFailures: failures,
        appSubjectCleanup,
        manageUrl: vercelConnectIntegrationStatus().manageUrl,
      };
    }

    // Bindings are how a credential reaches a runtime, so they go before the
    // provider round-trip rather than after it. They are also not needed to
    // finish the job: the refs on the connection row are what a resumed removal
    // reads to find the secrets it still owes a revocation.
    const removedSecretBindings = await db
      .delete(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, connection.companyId),
          eq(companySecretBindings.targetType, "tool_connection"),
          eq(companySecretBindings.targetId, connection.id),
        ),
      )
      .returning({ id: companySecretBindings.id });

    const removedInstalls = await db
      .delete(toolConnectionInstalls)
      .where(
        and(
          eq(toolConnectionInstalls.companyId, connection.companyId),
          eq(toolConnectionInstalls.connectionId, connection.id),
        ),
      )
      .returning({ id: toolConnectionInstalls.id });

    // The app-managed profile exists only to carry this connection's action
    // selection, so it goes with the connection. Operator-authored profiles that
    // happen to mention the connection are left alone — the archived connection
    // is denied by the policy engine regardless.
    const [appProfile] = await db
      .select({ id: toolProfiles.id })
      .from(toolProfiles)
      .where(
        and(
          eq(toolProfiles.companyId, connection.companyId),
          eq(toolProfiles.profileKey, `app:${connection.id}`),
        ),
      )
      .limit(1);
    let appProfileOutcome: ToolConnectionRemovalSummary["appProfile"] =
      "absent";
    let appProfileEntriesRemoved = 0;
    let appProfileBindingsRemoved = 0;
    let gatewayTokensRevoked = 0;
    let gatewaySessionsRevoked = 0;
    if (appProfile) {
      appProfileEntriesRemoved = await db.transaction(async tx => {
        await tx.select({ id: toolProfiles.id }).from(toolProfiles)
          .where(and(eq(toolProfiles.companyId, connection.companyId), eq(toolProfiles.id, appProfile.id)))
          .for("no key update");
        return (await tx.delete(toolProfileEntries)
          .where(and(eq(toolProfileEntries.companyId, connection.companyId), eq(toolProfileEntries.profileId, appProfile.id)))
          .returning({ id: toolProfileEntries.id })).length;
      });
      appProfileBindingsRemoved = (
        await db
          .delete(toolProfileBindings)
          .where(
            and(
              eq(toolProfileBindings.companyId, connection.companyId),
              eq(toolProfileBindings.profileId, appProfile.id),
            ),
          )
          .returning({ id: toolProfileBindings.id })
      ).length;

      const gatewayRows = await db
        .select({ id: toolMcpGateways.id })
        .from(toolMcpGateways)
        .where(
          and(
            eq(toolMcpGateways.companyId, connection.companyId),
            eq(toolMcpGateways.profileId, appProfile.id),
          ),
        );
      if (gatewayRows.length === 0) {
        await db.delete(toolProfiles).where(eq(toolProfiles.id, appProfile.id));
        appProfileOutcome = "deleted";
      } else {
        // `tool_mcp_gateways.profile_id` is ON DELETE RESTRICT, so a gateway
        // pointing here keeps the row alive. Archive it instead — the policy
        // engine only consults `active` profiles, and it has no entries left —
        // and revoke the tokens those gateways already handed out, which are the
        // one credential a caller could still present.
        await db
          .update(toolProfiles)
          .set({ status: "archived", defaultAction: "deny", updatedAt: now })
          .where(eq(toolProfiles.id, appProfile.id));
        appProfileOutcome = "archived";
        const revokedTokens = await db
          .update(toolMcpGatewayTokens)
          .set({ revokedAt: now, updatedAt: now })
          .where(
            and(
              eq(toolMcpGatewayTokens.companyId, connection.companyId),
              inArray(
                toolMcpGatewayTokens.gatewayId,
                gatewayRows.map((row) => row.id),
              ),
              isNull(toolMcpGatewayTokens.revokedAt),
            ),
          )
          .returning({ id: toolMcpGatewayTokens.id });
        gatewayTokensRevoked = revokedTokens.length;
        if (revokedTokens.length > 0) {
          gatewaySessionsRevoked = (
            await db
              .update(toolGatewaySessions)
              .set({ revokedAt: now, updatedAt: now })
              .where(
                and(
                  eq(toolGatewaySessions.companyId, connection.companyId),
                  inArray(
                    toolGatewaySessions.gatewayTokenId,
                    revokedTokens.map((row) => row.id),
                  ),
                  isNull(toolGatewaySessions.revokedAt),
                ),
              )
              .returning({ id: toolGatewaySessions.id })
          ).length;
        }
      }
    }

    // A local runtime already holds the injected credential inside a live child
    // process, so archiving rows is not enough — the process itself is an access
    // path. Stopping is best effort on purpose: if the supervisor cannot be
    // reached, revoking the credential anyway (so nothing can start again) beats
    // abandoning the teardown, and the warning says which slot was left running.
    let runtimeSlotsStopped = 0;
    const runtimeSlotRows = await db
      .select({ id: toolRuntimeSlots.id, status: toolRuntimeSlots.status })
      .from(toolRuntimeSlots)
      .where(
        and(
          eq(toolRuntimeSlots.companyId, connection.companyId),
          eq(toolRuntimeSlots.connectionId, connection.id),
        ),
      );
    for (const slot of runtimeSlotRows) {
      if (slot.status === "stopped") continue;
      try {
        await runtimeSupervisor.stopSlot({
          companyId: connection.companyId,
          slotId: slot.id,
          reason: "connection_removed",
        });
        runtimeSlotsStopped += 1;
      } catch (error) {
        logger.warn(
          {
            err: error,
            companyId: connection.companyId,
            connectionId: connection.id,
            slotId: slot.id,
          },
          "tool connection removal could not stop a runtime slot",
        );
      }
    }

    // The catalog stays as history, but `removed` is the status that stops a
    // standing trust rule from auto-allowing one of these actions again.
    const removedCatalogEntries = await db
      .update(toolCatalogEntries)
      .set({ status: "removed", updatedAt: now })
      .where(
        and(
          eq(toolCatalogEntries.companyId, connection.companyId),
          eq(toolCatalogEntries.connectionId, connection.id),
          ne(toolCatalogEntries.status, "removed"),
        ),
      )
      .returning({ id: toolCatalogEntries.id });

    // An authorization already in flight would otherwise come back and mint a
    // fresh token for an app the operator just removed.
    const discardedOAuthStates = await db
      .delete(toolOauthStates)
      .where(
        and(
          eq(toolOauthStates.companyId, connection.companyId),
          eq(toolOauthStates.connectionId, connection.id),
        ),
      )
      .returning({ state: toolOauthStates.state });

    // Token-derived material in the issuance ledger is not an access path —
    // nothing validates against it — but there is no reason to keep a hash of a
    // credential the operator asked us to revoke. Path, outcome, actor and time
    // stay, so the usage history survives.
    const clearedIssuanceHashes = await db
      .update(connectionTokenIssuances)
      .set({ tokenHash: null })
      .where(
        and(
          eq(connectionTokenIssuances.companyId, connection.companyId),
          eq(connectionTokenIssuances.connectionId, connection.id),
          sql`${connectionTokenIssuances.tokenHash} is not null`,
        ),
      )
      .returning({ id: connectionTokenIssuances.id });

    const archived = await db.transaction(async (tx) => {
      if (connection.transport === "chat_sdk") await notifyChatEndpointWork(tx, connection.id, connection.companyId);
          if (connection.transport === "voice") await notifyVoiceChange(tx, { kind: "connection", id: connection.id });
      await notifyToolConnectionHealth(tx, connection);
      await tx.select({ id: toolApplications.id }).from(toolApplications)
        .where(and(eq(toolApplications.id, connection.applicationId), eq(toolApplications.companyId, connection.companyId)))
        .for("update");
      const [updatedConnection] = await tx
        .update(toolConnections)
        .set({ status: "archived", enabled: false, updatedAt: now })
        .where(eq(toolConnections.id, connection.id))
        .returning();
      if (!updatedConnection) throw notFound("Tool connection not found");

      const remainingConnections = await tx
        .select({ id: toolConnections.id })
        .from(toolConnections)
        .where(
          and(
            eq(toolConnections.applicationId, updatedConnection.applicationId),
            ne(toolConnections.status, "archived"),
          ),
        )
        .limit(1);

      let applicationArchived = false;
      if (remainingConnections.length === 0) {
        const [application] = await tx
          .update(toolApplications)
          .set({ status: "archived", archivedAt: now, updatedAt: now })
          .where(
            and(
              eq(toolApplications.id, updatedConnection.applicationId),
              ne(toolApplications.status, "archived"),
            ),
          )
          .returning({ id: toolApplications.id });
        applicationArchived = Boolean(application);
      }

      return { connection: updatedConnection, applicationArchived };
    });
    emitConnectionUpdated(archived.connection, connection, "archive");

    // Hosted work needs its credential to stop. Agent/viewer access is already
    // revoked above; retain cleanup authority until provider shutdown confirms.
    if (isBrowserUseConnection(connection)) {
      await browserUseService(db, options.remoteHttpRequest).stopBeforeCredentialRemoval(connection.companyId, connection.id);
    }

    // Only now, with every access path closed, revoke the credentials. Each
    // `secrets.remove` marks the row deleted before it calls the provider, so a
    // provider error leaves an unresolvable secret and a resumable removal
    // rather than a half-open app.
    const candidateSecretIds = [
      ...Object.values(asRecord(connection.config.aggregatorDiscovery)).flatMap(value => typeof asRecord(value).secretId === "string" ? [asRecord(value).secretId as string] : []),
      ...connection.credentialRefs.map((ref) => ref.secretId),
      ...connection.credentialSecretRefs.map((ref) => ref.secretId),
      ...grantRows.flatMap((grant) =>
        (grant.credentialSecretRefs ?? []).map((ref) => ref.secretId),
      ),
    ];
    const { owned, retained } = await classifyConnectionSecrets(
      connection,
      candidateSecretIds,
    );
    let secretsRevoked = 0;
    for (const secretId of owned) {
      const removed = await secrets.remove(secretId);
      if (removed) secretsRevoked += 1;
    }

    const credentialRefsCleared =
      connection.credentialRefs.length + connection.credentialSecretRefs.length;
    const [cleared] = await db
      .update(toolConnections)
      .set({
        credentialRefs: [],
        credentialSecretRefs: [],
        config: withoutInlineOAuthTokens(connection.config),
        transportConfig: withoutInlineOAuthTokens(connection.transportConfig),
        updatedAt: now,
      })
      .where(eq(toolConnections.id, connection.id))
      .returning();
    if (
      grantRows.some((grant) => (grant.credentialSecretRefs ?? []).length > 0)
    ) {
      await db
        .update(connectionGrants)
        .set({ credentialSecretRefs: [], updatedAt: now })
        .where(
          and(
            eq(connectionGrants.companyId, connection.companyId),
            eq(connectionGrants.connectionId, connection.id),
          ),
        );
    }

    return {
      connection: toConnection(cleared ?? archived.connection),
      removal: {
        secretsRevoked,
        secretsRetainedShared: retained.length,
        credentialRefsCleared,
        secretBindingsRemoved: removedSecretBindings.length,
        grantsRevoked: grantsToRevoke.length,
        installsRemoved: removedInstalls.length,
        appProfile: appProfileOutcome,
        appProfileEntriesRemoved,
        appProfileBindingsRemoved,
        catalogEntriesMarkedRemoved: removedCatalogEntries.length,
        oauthStatesDiscarded: discardedOAuthStates.length,
        tokenIssuanceHashesCleared: clearedIssuanceHashes.length,
        runtimeSlotsStopped,
        gatewayTokensRevoked,
        gatewaySessionsRevoked,
        applicationArchived: archived.applicationArchived,
        externalCredentialCleanup,
      },
    };
  }
  return removeConnection;
}
