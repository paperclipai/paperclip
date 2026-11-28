import { notifyChatConnectionObservation } from "../../chat-channels/configuration-work-notifications.js";
import { assertPluginConnectionWorker, PLUGIN_CONNECTOR_UNAVAILABLE_CODE } from "../../plugin-connector-runtime.js";
import { findPluginWorkerUnavailableError } from "../../plugin-worker-unavailable-error.js";
import { notifyToolConnectionHealth, writeToolConnectionHealthChange } from "../../tool-connection-health-notifications.js";
import { connectionActorUserId } from "../actor.js";
import { assertSupportedConnection } from "../connections/setup-policy.js";
import { connectionSetupUrl, connectionReconnectUrl } from "../identifiers.js";
import { createGitHubGrantContinuity } from "../github-grant-continuity.js";
import { createToolRuntimeSlots } from "../runtime/slots.js";
import type { ActorInfo } from "../types.js";
import { nativeProviderCatalogFor } from "../../native-provider-catalogs.js";
import { restConnectorFor } from "../../connectors/rest-registry.js";
import { retainMcpConnectionFailure } from "../../mcp-connection-failure.js";
import { isBrowserUseConnection } from "../../browser-use-client.js";
import { and, asc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatEndpoints, connectionGrants, toolApplications, toolConnections, toolRuntimeSlots } from "@paperclipai/db";
import type { ToolConnectionHealthCheckResult, ToolConnectionHealthStatus, ToolConnectionTransport } from "@paperclipai/shared";
import { HttpError, unprocessable } from "../../../errors.js";

import type { ToolAccessAudit } from "../audit.js";
import type { ConnectionCredentialAccess } from "../credential-access.js";
import type { ConnectionSetupPolicy } from "../connections/setup-policy.js";
import { toConnection } from "../connections/projection.js";
import { isAgentMailConnection, type ToolCatalogDiscovery } from "./discovery.js";
import { healthFailureHttpStatus, isCallerAuthorizationFailure, sanitizeHttpFailure, unreachableServerRemediation, UNSUPPORTED_TOOL_CONNECTION_TRANSPORT_MESSAGE, unsupportedToolConnectionTransport } from "./failures.js";

export const HEALTH_SWEEP_TRANSPORTS: readonly ToolConnectionTransport[] = [
  "mcp_remote",
  "rest_api",
  "local_stdio",
  "plugin",
];

export function healthSweepConnectionWhere() {
  return and(
    eq(toolConnections.enabled, true),
    eq(toolConnections.status, "active"),
    inArray(toolConnections.transport, HEALTH_SWEEP_TRANSPORTS),
    ne(toolApplications.type, "paperclip_plugin"),
  );
}

/**
 * Repair active Speko voice connections previously marked error by the generic
 * tool health sweep before voice transport was excluded from sweeps.
 */
export async function repairUnsupportedVoiceConnectionHealth(
  db: Db,
  options: {
    companyId?: string;
    connectionId?: string;
    now?: () => Date;
    batchSize?: number;
    signal?: AbortSignal;
  } = {},
): Promise<number> {
  const batchSize = Math.max(1, options.batchSize ?? 100);
  const nowFn = options.now ?? (() => new Date());
  let totalRepaired = 0;
  let cursor: string | undefined;
  while (true) {
    options.signal?.throwIfAborted();
    const candidates = await db
      .selectDistinctOn([toolConnections.id], {
        id: toolConnections.id,
        companyId: toolConnections.companyId,
      })
      .from(toolConnections)
      .innerJoin(chatEndpoints, and(
        eq(chatEndpoints.connectionId, toolConnections.id),
        eq(chatEndpoints.companyId, toolConnections.companyId),
      ))
      .where(and(
        eq(toolConnections.transport, "voice"),
        eq(toolConnections.enabled, true),
        eq(toolConnections.status, "active"),
        eq(toolConnections.healthStatus, "error"),
        eq(toolConnections.healthMessage, UNSUPPORTED_TOOL_CONNECTION_TRANSPORT_MESSAGE),
        eq(chatEndpoints.provider, "speko"),
        eq(chatEndpoints.status, "active"),
        isNull(chatEndpoints.lastError),
        options.companyId === undefined ? undefined : eq(toolConnections.companyId, options.companyId),
        options.connectionId === undefined ? undefined : eq(toolConnections.id, options.connectionId),
        cursor === undefined ? undefined : sql`${toolConnections.id} > ${cursor}`,
      ))
      .orderBy(asc(toolConnections.id), asc(chatEndpoints.id))
      .limit(batchSize);
    if (candidates.length === 0) break;
    const candidateIds = candidates.map((row) => row.id);
    cursor = candidateIds[candidateIds.length - 1];
    const repairedAt = nowFn().toISOString();
    const repairedRows = await db.transaction(async (tx) => {
      // Register delivery work before the write so drain/sleep checks observe it.
      for (const candidate of candidates) {
        await notifyToolConnectionHealth(tx, { id: candidate.id, companyId: candidate.companyId });
        await notifyChatConnectionObservation(tx, candidate.id, "voice");
      }
      return tx.execute<{ id: string; company_id: string }>(sql`
        update ${toolConnections} as tc
        set
          health_status = 'healthy',
          health_message = coalesce(ce.health_message, 'Connected'),
          last_error = null,
          updated_at = ${repairedAt}::timestamptz
        from (
          select distinct on (connection_id)
            connection_id,
            company_id,
            health_message
          from ${chatEndpoints}
          where provider = 'speko' and status = 'active' and last_error is null
          order by connection_id, id
        ) as ce
        where tc.id in (${sql.join(candidateIds.map((id) => sql`${id}`), sql`, `)})
          and tc.id = ce.connection_id
          and tc.company_id = ce.company_id
          and tc.transport = 'voice'
          and tc.enabled = true
          and tc.status = 'active'
          and tc.health_status = 'error'
          and tc.health_message = ${UNSUPPORTED_TOOL_CONNECTION_TRANSPORT_MESSAGE}
        returning tc.id, tc.company_id
      `);
    });
    totalRepaired += repairedRows.length;
    if (candidates.length < batchSize) break;
  }
  return totalRepaired;
}
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

type HealthDependencies = {
  now: () => Date;
  audit: ToolAccessAudit;
  getConnectionRow(idOrUid: string, companyId?: string): Promise<typeof toolConnections.$inferSelect>;
  discovery: ToolCatalogDiscovery;
  setupPolicy: ConnectionSetupPolicy;
  resolveCredentialHeaders: ConnectionCredentialAccess["resolveCredentialHeaders"];
  vaultGrantForConnection: ConnectionCredentialAccess["vaultGrantForConnection"];
  refreshManagedGitHubGrantAccess: ReturnType<typeof createGitHubGrantContinuity>["refreshManagedGitHubGrantAccess"];
  ensureRuntimeSlot: ReturnType<typeof createToolRuntimeSlots>["ensureRuntimeSlot"];
  stdioTemplateId(companyId: string, config: Record<string, unknown>): Promise<string>;
};

export function createConnectionHealth(db: Db, { now, audit, getConnectionRow, discovery, setupPolicy, resolveCredentialHeaders, vaultGrantForConnection, refreshManagedGitHubGrantAccess, ensureRuntimeSlot, stdioTemplateId }: HealthDependencies) {
  const { discoverTools, remoteTools, validateAgentMailConnection, validateCogneeConnection } = discovery;
  const { assertConnectorConnectionSetupEnabled } = setupPolicy;
  async function updateConnectionHealth(
    connection: typeof toolConnections.$inferSelect,
    status: ToolConnectionHealthStatus,
    message: string | null,
  ) {
    const now = new Date();
    const [updated] = await writeToolConnectionHealthChange(db, connection, async tx => {
      await notifyChatConnectionObservation(tx, connection.id, connection.transport);
      return tx.update(toolConnections)
      .set({
        healthStatus: status,
        healthMessage: message,
        healthCheckedAt: now,
        lastHealthAt: now,
        lastError: status === "ok" ? null : message,
        updatedAt: now,
      })
      .where(eq(toolConnections.id, connection.id))
      .returning();
    });
    if (connection.transport === "local_stdio") {
      await db
        .update(toolRuntimeSlots)
        .set({
          healthStatus: status,
          healthMessage: message,
          lastHealthCheckAt: now,
          updatedAt: now,
        })
        .where(eq(toolRuntimeSlots.connectionId, connection.id));
    }
    return updated;
  }

  async function checkConnectionHealth(
    connectionId: string,
    actor?: ActorInfo,
    options: { allowUnauthenticatedProbe?: boolean } = {},
  ): Promise<ToolConnectionHealthCheckResult> {
    const connection = await getConnectionRow(connectionId);
    if (connection.connectionPurpose === "ai") return { connection: toConnection(connection), runtimeSlot: null };
    if (connection.transport === "voice") {
      const repaired = await repairUnsupportedVoiceConnectionHealth(db, {
        companyId: connection.companyId,
        connectionId: connection.id,
        now,
      });
      const current = repaired > 0 ? await getConnectionRow(connectionId) : connection;
      return { connection: toConnection(current), runtimeSlot: null };
    }
    await assertConnectorConnectionSetupEnabled(connection);
    const unavailableServices: string[] = [];
    try {
      assertSupportedConnection(connection);
      const config = asRecord(connection.config);
      const oauth = asRecord(config.oauth);
      if (
        config.sourceTemplateKey === "github" &&
        oauth.connectorProfile === "github.code"
      ) {
        const activeGrants = connection.credentialPolicy === "per_agent"
          ? [await vaultGrantForConnection(connection, actor)].filter(grant => grant !== null)
          : await db
          .select()
          .from(connectionGrants)
          .where(
            and(
              eq(connectionGrants.companyId, connection.companyId),
              eq(connectionGrants.connectionId, connection.id),
              eq(connectionGrants.status, "active"),
            ),
          );
        const actorGrant =
          connectionActorUserId(actor)
            ? activeGrants.find(
                (grant) =>
                  grant.kind === "user" &&
                  grant.subjectUserId === connectionActorUserId(actor),
              )
            : null;
        const grantsToCheck =
          connection.credentialPolicy === "per_user" &&
          Boolean(connectionActorUserId(actor))
            ? actorGrant
              ? [actorGrant]
              : []
            : actorGrant
              ? [actorGrant]
              : activeGrants;
        if (grantsToCheck.length === 0)
          throw unprocessable("GitHub authorization must be connected", {
            code: "oauth_reauthorization_required",
          });
        for (const grant of grantsToCheck)
          await refreshManagedGitHubGrantAccess(connection, grant, actor);
      } else if (isBrowserUseConnection(connection) || nativeProviderCatalogFor(connection) || restConnectorFor(connection)
        || connection.transport === "plugin") {
        // A plugin-served connector is healthy when its tools can be listed
        // and its plugin's worker is running to serve them.
        await discoverTools(connection, undefined, actor);
        if (connection.transport === "plugin") {
          try {
            await assertPluginConnectionWorker(db, connection);
          } catch (error) {
            if (!findPluginWorkerUnavailableError(error)) throw error;
            throw unprocessable(error instanceof Error ? error.message : "This connector's plugin is not running right now.", { code: PLUGIN_CONNECTOR_UNAVAILABLE_CODE, retryable: true });
          }
        }
      } else if (isAgentMailConnection(connection)) {
        await validateAgentMailConnection(connection);
      } else if (connection.transport === "mcp_remote") {
        const canProbeWithoutAuthorization =
          options.allowUnauthenticatedProbe === true &&
          connection.status === "draft" &&
          connection.authKind === "none" &&
          connection.credentialPolicy === "per_user" &&
          Boolean(connectionActorUserId(actor)) &&
          connectionActorUserId(actor) === connection.createdByUserId;
        const credentialHeaders =
          connection.credentialSource === "vercel_connect"
            ? await resolveCredentialHeaders(connection, actor, {
                forceRefresh: true,
              })
            : canProbeWithoutAuthorization
              ? {}
              : undefined;
        // A health check must reach the server, never a cached tool list.
        await remoteTools(connection, credentialHeaders, actor, undefined, unavailableServices, { live: true });
      } else if (connection.transport === "local_stdio") {
        await resolveCredentialHeaders(connection);
        await stdioTemplateId(connection.companyId, connection.config);
        await validateCogneeConnection(connection, actor, false);
      } else {
        throw unsupportedToolConnectionTransport();
      }
      const updated = await updateConnectionHealth(
        connection,
        "ok",
        unavailableServices.length > 0
          ? `Connected. Google services unavailable: ${unavailableServices.join(", ")}. Other services remain available; retry refreshing actions.`
          : config.sourceTemplateKey === "github" &&
          oauth.connectorProfile === "github.code"
          ? "GitHub account, installation, and repository access are available."
          : restConnectorFor(connection)
            ? `${restConnectorFor(connection)!.name} API access is connected.`
          : nativeProviderCatalogFor(connection)
            ? `${nativeProviderCatalogFor(connection)!.name} API access is connected.`
          : isBrowserUseConnection(connection)
            ? "Browser Use API key is connected."
          : isAgentMailConnection(connection)
            ? "AgentMail API key is connected."
            : connection.transport === "local_stdio"
              ? "Approved stdio template is ready."
              : "Remote MCP server responded to tools/list.",
      );
      const runtimeSlot = await ensureRuntimeSlot(updated);
      await audit({
        companyId: connection.companyId,
        connectionId: connection.id,
        action: "tool_connection.health_check",
        outcome: "success",
        actor,
        details: { transport: connection.transport },
      });
      return { connection: toConnection(updated), runtimeSlot };
    } catch (error) {
      if (isCallerAuthorizationFailure(error, actor)) throw error;
      if (
        error instanceof HttpError &&
        asRecord(error.details).code === "github_access_changed"
      )
        throw error;
      const failure = sanitizeHttpFailure(error);
      const updated = await updateConnectionHealth(
        connection,
        failure.status,
        failure.message,
      );
      const runtimeSlot =
        connection.transport === "local_stdio"
          ? await ensureRuntimeSlot(updated)
          : null;
      await audit({
        companyId: connection.companyId,
        connectionId: connection.id,
        action: "tool_connection.health_check",
        outcome: "failure",
        reasonCode: failure.code,
        actor,
        details: { status: failure.status, transport: connection.transport },
      });
      // Keep GitHub's recovery links so Refresh access can point at the exact
      // installation page, such as the one with the Unsuspend button.
      const githubRecovery =
        failure.code === "github_installation_required" && error instanceof HttpError
          ? {
              installationUrl: asRecord(error.details).installationUrl,
              managementUrl: asRecord(error.details).managementUrl,
            }
          : {};
      throw retainMcpConnectionFailure(error, new HttpError(healthFailureHttpStatus(failure), failure.message, {
        code: failure.code,
        connection: toConnection(updated),
        runtimeSlot,
        setupUrl: connectionSetupUrl(connection),
        reconnectUrl: connectionReconnectUrl(connection),
        ...githubRecovery,
        ...unreachableServerRemediation(error, actor),
      }));
    }
  }

  async function sweepConnectionHealth(
    input: { staleAfterMs?: number; limit?: number } = {},
  ) {
    await repairUnsupportedVoiceConnectionHealth(db, { now });
    const generatedAt = now();
    const staleAfterMs = input.staleAfterMs ?? 15 * 60 * 1000;
    const limit = input.limit ?? 25;
    const cutoff = new Date(generatedAt.getTime() - staleAfterMs);
    // Legacy plugin backfills use a remote transport as a placeholder, but
    // their tools run in the plugin worker and have no remote MCP endpoint.
    // Select only due IDs in SQL so each scheduler tick does not decode every
    // active connection's config and credential metadata.
    const due = await db
      .select({ id: toolConnections.id })
      .from(toolConnections)
      .innerJoin(toolApplications, and(
        eq(toolApplications.id, toolConnections.applicationId),
        eq(toolApplications.companyId, toolConnections.companyId),
      ))
      .where(
        and(
          healthSweepConnectionWhere(),
          or(isNull(toolConnections.healthCheckedAt), lte(toolConnections.healthCheckedAt, cutoff)),
        ),
      )
      .orderBy(
        sql`${toolConnections.healthCheckedAt} asc nulls first`,
        asc(toolConnections.createdAt),
        asc(toolConnections.id),
      )
      .limit(limit);
    let healthy = 0;
    let failed = 0;
    const failedConnectionIds: string[] = [];
    for (const connection of due) {
      try {
        await checkConnectionHealth(connection.id, {
          actorType: "system",
          actorId: "tool_health_sweep",
        });
        healthy += 1;
      } catch {
        failed += 1;
        failedConnectionIds.push(connection.id);
      }
    }
    return {
      checked: due.length,
      healthy,
      failed,
      failedConnectionIds,
    };
  }
  return { updateConnectionHealth, checkConnectionHealth, sweepConnectionHealth };
}
export type ConnectionHealth = ReturnType<typeof createConnectionHealth>;
