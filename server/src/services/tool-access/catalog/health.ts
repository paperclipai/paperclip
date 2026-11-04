import { notifyChatConnectionObservation } from "../../chat-channels/configuration-work-notifications.js";
import { writeToolConnectionHealthChange } from "../../tool-connection-health-notifications.js";
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
import { and, asc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, toolApplications, toolConnections, toolRuntimeSlots } from "@paperclipai/db";
import type { ToolConnectionHealthCheckResult, ToolConnectionHealthStatus } from "@paperclipai/shared";
import { HttpError, unprocessable } from "../../../errors.js";

import type { ToolAccessAudit } from "../audit.js";
import type { ConnectionCredentialAccess } from "../credential-access.js";
import type { ConnectionSetupPolicy } from "../connections/setup-policy.js";
import { toConnection } from "../connections/projection.js";
import { isAgentMailConnection, type ToolCatalogDiscovery } from "./discovery.js";
import { healthFailureHttpStatus, sanitizeHttpFailure, unsupportedToolConnectionTransport } from "./failures.js";
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
  refreshManagedGitHubGrantAccess: ReturnType<typeof createGitHubGrantContinuity>["refreshManagedGitHubGrantAccess"];
  ensureRuntimeSlot: ReturnType<typeof createToolRuntimeSlots>["ensureRuntimeSlot"];
  stdioTemplateId(companyId: string, config: Record<string, unknown>): Promise<string>;
};

export function createConnectionHealth(db: Db, { now, audit, getConnectionRow, discovery, setupPolicy, resolveCredentialHeaders, refreshManagedGitHubGrantAccess, ensureRuntimeSlot, stdioTemplateId }: HealthDependencies) {
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
        const activeGrants = await db
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
      } else if (isBrowserUseConnection(connection) || nativeProviderCatalogFor(connection) || restConnectorFor(connection)) {
        await discoverTools(connection, undefined, actor);
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
        await remoteTools(connection, credentialHeaders, actor, undefined, unavailableServices);
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
      }));
    }
  }

  async function sweepConnectionHealth(
    input: { staleAfterMs?: number; limit?: number } = {},
  ) {
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
          eq(toolConnections.enabled, true),
          eq(toolConnections.status, "active"),
          ne(toolConnections.transport, "chat_sdk"),
          ne(toolConnections.transport, "runtime_auth"),
          ne(toolApplications.type, "paperclip_plugin"),
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
