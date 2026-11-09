import { connectorToolPolicy } from "../../connectors/tool-policy.js";
import { connectionSetupUrl, connectionReconnectUrl } from "../identifiers.js";
import { createToolRuntimeSlots } from "../runtime/slots.js";
import type { ActorInfo, ToolAccessMutationDb } from "../types.js";
import { connectionMethodForConnection } from "../connection-methods.js";
import { stableHash, descriptorHash } from "../../tool-catalog-hash.js";
import { nativeProviderCatalogFor } from "../../native-provider-catalogs.js";
import { googleWorkspaceToolTarget, googleWorkspaceGrantedScopes, isGoogleWorkspaceToolGranted } from "@paperclipai/shared";
import { retainMcpConnectionFailure } from "../../mcp-connection-failure.js";
import { isRemoteMcpConnectorMethod } from "@paperclipai/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, toolApplications, toolCatalogEntries, toolConnections, toolRuntimeSlots } from "@paperclipai/db";
import type { ToolCatalogRefreshResult } from "@paperclipai/shared";
import { getConnectableAppDefinition, isGoogleWorkspaceConnectorProfileId } from "@paperclipai/shared";
import { HttpError, unprocessable } from "../../../errors.js";
import { isRailwayEndpoint, isRailwayToolBlocked } from "../../railway.js";

import type { ToolAccessAudit } from "../audit.js";
import type { ConnectionCredentialAccess } from "../credential-access.js";
import type { ConnectionSetupPolicy } from "../connections/setup-policy.js";
import type { CatalogDefaultAccess } from "./default-access.js";
import type { ConnectionHealth } from "./health.js";
import { isAgentMailConnection, type ToolCatalogDiscovery } from "./discovery.js";
import { classifyRisk, shouldQuarantineNewEntries, isGoogleWorkspaceToolAllowed, type McpToolDescriptor } from "./descriptors.js";
import { toConnection } from "../connections/projection.js";
import { toCatalogEntry } from "./projection.js";
import { healthFailureHttpStatus, sanitizeHttpFailure } from "./failures.js";
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

type PublicationDependencies = {
  now: () => Date;
  audit: ToolAccessAudit;
  getConnectionRow(idOrUid: string, companyId?: string): Promise<typeof toolConnections.$inferSelect>;
  discoverTools: ToolCatalogDiscovery["discoverTools"];
  assertConnectorConnectionSetupEnabled: ConnectionSetupPolicy["assertConnectorConnectionSetupEnabled"];
  updateConnectionHealth: ConnectionHealth["updateConnectionHealth"];
  vaultGrantForConnection: ConnectionCredentialAccess["vaultGrantForConnection"];
  ensureRuntimeSlot: ReturnType<typeof createToolRuntimeSlots>["ensureRuntimeSlot"];
  enableCatalogEntriesByDefault: CatalogDefaultAccess["enableCatalogEntriesByDefault"];
};

export function createToolCatalogPublication(db: Db, { now, audit, getConnectionRow, discoverTools, assertConnectorConnectionSetupEnabled, updateConnectionHealth, vaultGrantForConnection, ensureRuntimeSlot, enableCatalogEntriesByDefault }: PublicationDependencies) {
  async function refreshCatalog(
    connectionId: string,
    actor?: ActorInfo,
    refreshOptions: {
      enableAllByDefault?: boolean;
      restoreDraftDefaults?: boolean;
      /** Keep first managed OAuth discovery quarantined without changing generic draft refresh semantics. */
      quarantineManagedOAuthDraft?: boolean;
      skipDefaultProfileSync?: boolean;
      credentialHeaders?: Record<string, string>;
    } = {},
  ): Promise<ToolCatalogRefreshResult> {
    const connection = await getConnectionRow(connectionId);
    if (connection.connectionPurpose === "ai") throw unprocessable("AI connections do not have a tool catalog");
    await assertConnectorConnectionSetupEnabled(connection);
    const refreshedAt = now();
    const unavailableServices: string[] = [];
    let descriptors: McpToolDescriptor[];
    try {
      descriptors = await discoverTools(
        connection,
        refreshOptions.credentialHeaders,
        actor,
        unavailableServices,
      );
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
      await audit({
        companyId: connection.companyId,
        connectionId: connection.id,
        action: "tool_connection.catalog_refresh",
        outcome: "failure",
        reasonCode: failure.code,
        details: { status: failure.status },
        actor,
      });
      throw retainMcpConnectionFailure(error, new HttpError(healthFailureHttpStatus(failure), failure.message, {
        code: failure.code,
        setupUrl: connectionSetupUrl(connection),
        reconnectUrl: connectionReconnectUrl(connection),
      }));
    }

    const publish = <T>(write: (client: ToolAccessMutationDb) => Promise<T>): Promise<T> => db.transaction(async tx => {
      await tx.select({ id: toolApplications.id }).from(toolApplications)
        .where(and(eq(toolApplications.id, connection.applicationId), eq(toolApplications.companyId, connection.companyId)))
        .for("update");
      await tx.select({ id: toolConnections.id }).from(toolConnections)
        .where(and(eq(toolConnections.id, connection.id), eq(toolConnections.companyId, connection.companyId)))
        .for("update");
      return write(tx);
    });
    descriptors = [...new Map(descriptors.map(descriptor => [descriptor.name, descriptor])).values()];
    const existingRows = await db
      .select()
      .from(toolCatalogEntries)
      .where(eq(toolCatalogEntries.connectionId, connection.id));
    const existingByName = new Map(
      existingRows.map((entry) => [entry.toolName, entry]),
    );
    const nativeProvider = Boolean(nativeProviderCatalogFor(connection));
    if (connection.config.sourceTemplateKey === "google-workspace"
      || nativeProvider || isRemoteMcpConnectorMethod(connection.config.sourceTemplateKey, connection.config.connectionMethodKey)) {
      const discoveredNames = new Set(descriptors.map((descriptor) => descriptor.name));
      // The catalog is shared, but discovery uses only the caller's grant. A
      // narrower personal consent must not remove actions another active grant
      // still supports. Never combine scopes from different grants into authority.
      let otherWorkspaceGrants: string[][] = [];
      let selectedWorkspaceScopes: string[] = [];
      if (connection.config.sourceTemplateKey === "google-workspace") {
        const selected = await vaultGrantForConnection(connection, actor);
        selectedWorkspaceScopes = googleWorkspaceGrantedScopes(selected);
        const grants = await db.select().from(connectionGrants).where(and(
          eq(connectionGrants.companyId, connection.companyId), eq(connectionGrants.connectionId, connection.id),
          eq(connectionGrants.status, "active"),
        ));
        otherWorkspaceGrants = grants.filter((grant) => grant.id !== selected?.id).map(googleWorkspaceGrantedScopes);
      }
      // Preserve only consent-filtered actions, not failed-service catalogs or
      // tools a successful, sufficiently authorized discovery actually removed.
      const removedStatus = nativeProvider ? "removed" : "disabled";
      const removedIds = existingRows.filter((entry) => !discoveredNames.has(entry.toolName) && entry.status !== removedStatus
        && !(otherWorkspaceGrants.some((scopes) => isGoogleWorkspaceToolGranted(entry.toolName, scopes))
          && !isGoogleWorkspaceToolGranted(entry.toolName, selectedWorkspaceScopes)
          && !unavailableServices.includes(googleWorkspaceToolTarget(entry.toolName)?.service ?? ""))).map((entry) => entry.id);
      if (removedIds.length) await publish(tx => tx.update(toolCatalogEntries)
        .set({ status: removedStatus, quarantineReason: nativeProvider ? "provider_tool_removed" : "mcp_tool_removed", updatedAt: refreshedAt })
        .where(and(eq(toolCatalogEntries.companyId, connection.companyId), eq(toolCatalogEntries.connectionId, connection.id), inArray(toolCatalogEntries.id, removedIds))));
    }
    // Retired native actions are absent from discovery, but old catalog rows
    // still need to show as disabled. Gateway denial also applies before refresh.
    const blockedRailwayEntryIds = isRailwayEndpoint(connection.config.url)
      ? existingRows.filter((entry) => isRailwayToolBlocked(entry.toolName)).map((entry) => entry.id)
      : [];
    if (blockedRailwayEntryIds.length > 0) {
      await publish(tx => tx.update(toolCatalogEntries).set({ status: "disabled", updatedAt: refreshedAt })
        .where(and(eq(toolCatalogEntries.connectionId, connection.id), inArray(toolCatalogEntries.id, blockedRailwayEntryIds))));
    }
    const catalogValues: Array<typeof toolCatalogEntries.$inferInsert> = [];
    let quarantinedCount = 0;
    const sourceTemplateKey =
      typeof asRecord(connection.config).sourceTemplateKey === "string"
        ? String(asRecord(connection.config).sourceTemplateKey)
        : null;
    const sourceApp = sourceTemplateKey
      ? getConnectableAppDefinition(sourceTemplateKey)
      : null;
    const sourceMethod = sourceApp
      ? connectionMethodForConnection(sourceApp, connection)
      : null;
    const sourceCapabilityKey = sourceMethod?.capabilityProfile?.key;
    const googleProfileValue =
      sourceMethod?.connectorProfile ??
      sourceApp?.methods.find(
        (candidate) =>
          candidate.connectorProfile &&
          candidate.capabilityProfile?.key === sourceCapabilityKey,
      )?.connectorProfile;
    const googleProfile =
      googleProfileValue &&
      isGoogleWorkspaceConnectorProfileId(googleProfileValue)
        ? googleProfileValue
        : null;
    const connectorPolicy = connectorToolPolicy(sourceTemplateKey, connection);
    const preserveReviewedCatalog = connectorPolicy.quarantineNewEntries && existingRows.length > 0;
    const quarantineOnRefresh =
      (!refreshOptions.enableAllByDefault || preserveReviewedCatalog) &&
      shouldQuarantineNewEntries(connection) &&
      (connection.status === "active" ||
        preserveReviewedCatalog ||
        sourceTemplateKey === "posthog" ||
        refreshOptions.quarantineManagedOAuthDraft === true);
    const safeDefault = asRecord(connection.config).safeDefault === true;
    for (const descriptor of descriptors) {
      const riskLevel = classifyRisk(descriptor, connectorPolicy.sourceTemplateKey);
      const hash = descriptorHash(descriptor, riskLevel);
      const schemaHash = stableHash(descriptor.inputSchema ?? {});
      const existing = existingByName.get(descriptor.name);
      const changed =
        existing &&
        (existing.versionHash !== hash || existing.schemaHash !== schemaHash);
      const shouldQuarantine =
        quarantineOnRefresh &&
        (!existing || changed) &&
        existing?.status !== "disabled" &&
        (!safeDefault || riskLevel !== "read" || nativeProvider);
      const providerPermanentlyBlocked = Boolean(
        googleProfile &&
        !isGoogleWorkspaceToolAllowed(googleProfile, descriptor),
      ) || (isRailwayEndpoint(connection.config.url) && isRailwayToolBlocked(descriptor.name));
      const status = providerPermanentlyBlocked
        ? "disabled"
        : shouldQuarantine
          ? "quarantined"
          : existing?.status === "disabled" && existing.quarantineReason !== "mcp_tool_removed"
            ? "disabled"
            : quarantineOnRefresh && existing?.status === "quarantined"
              ? "quarantined"
              : "active";
      if (shouldQuarantine && !providerPermanentlyBlocked) quarantinedCount += 1;

      catalogValues.push({
        id: existing?.id, companyId: connection.companyId, applicationId: connection.applicationId,
        connectionId: connection.id, name: existing?.name ?? descriptor.name, toolName: descriptor.name, entryKind: "tool",
        title: descriptor.title ?? null, description: descriptor.description ?? null,
        inputSchema: descriptor.inputSchema ?? {}, annotations: descriptor.annotations ?? {}, riskLevel,
        isReadOnly: riskLevel === "read", isWrite: riskLevel === "write", isDestructive: riskLevel === "destructive",
        status, versionHash: hash, schemaHash, firstSeenAt: existing?.firstSeenAt ?? refreshedAt, lastSeenAt: refreshedAt,
        quarantinedAt: existing
          ? status === "quarantined" ? shouldQuarantine ? refreshedAt : existing.quarantinedAt : null
          : shouldQuarantine ? refreshedAt : null,
        quarantineReason: existing
          ? status === "quarantined" ? shouldQuarantine ? "pending_review" : existing.quarantineReason : null
          : shouldQuarantine ? "pending_review" : null,
        updatedAt: existing ? refreshedAt : new Date(),
      });
    }
    const catalogRows: Array<typeof toolCatalogEntries.$inferSelect> = [];
    const newCatalogEntryIds = new Set<string>();
    for (let index = 0; index < catalogValues.length; index += 500) {
      const chunk = catalogValues.slice(index, index + 500);
      catalogRows.push(...await publish(async tx => {
        const current = await tx.select({ name: toolCatalogEntries.name, status: toolCatalogEntries.status })
          .from(toolCatalogEntries).where(and(eq(toolCatalogEntries.connectionId, connection.id), inArray(toolCatalogEntries.name, chunk.map(entry => entry.name))));
        const existingNonQuarantinedNames = new Set(current.filter(entry => entry.status !== "quarantined").map(entry => entry.name));
        const rows = await tx.insert(toolCatalogEntries).values(chunk)
          .onConflictDoUpdate({ target: [toolCatalogEntries.connectionId, toolCatalogEntries.name], set: {
            title: sql`excluded.title`, description: sql`excluded.description`, inputSchema: sql`excluded.input_schema`,
            annotations: sql`excluded.annotations`, riskLevel: sql`excluded.risk_level`, isReadOnly: sql`excluded.is_read_only`,
            isWrite: sql`excluded.is_write`, isDestructive: sql`excluded.is_destructive`,
            status: sql`CASE WHEN ${toolCatalogEntries.status} = 'disabled' AND ${toolCatalogEntries.quarantineReason} IS DISTINCT FROM 'mcp_tool_removed' THEN 'disabled' ELSE excluded.status END`,
            versionHash: sql`excluded.version_hash`, schemaHash: sql`excluded.schema_hash`, lastSeenAt: sql`excluded.last_seen_at`,
            quarantinedAt: sql`excluded.quarantined_at`, quarantineReason: sql`excluded.quarantine_reason`, updatedAt: sql`excluded.updated_at`,
          } }).returning();
        for (const row of rows) if (!existingNonQuarantinedNames.has(row.name)) newCatalogEntryIds.add(row.id);
        return rows;
      }));
    }
    const catalogByName = new Map(catalogRows.map(row => [row.toolName, row]));
    const updatedEntries = descriptors.map(descriptor => toCatalogEntry(catalogByName.get(descriptor.name)!));

    const preserveQuarantine = connectorPolicy.quarantineNewEntries;
    const normalizedConfig = preserveQuarantine
      ? { ...connection.config, quarantineNewEntries: true }
      : refreshOptions.enableAllByDefault
      ? { ...connection.config, quarantineNewEntries: false }
      : connection.config;
    const normalizedTransportConfig = preserveQuarantine
      ? { ...connection.transportConfig, quarantineNewEntries: true }
      : refreshOptions.enableAllByDefault
      ? { ...connection.transportConfig, quarantineNewEntries: false }
      : connection.transportConfig;
    const [updatedConnection] = await db
      .update(toolConnections)
      .set({
        config: normalizedConfig,
        transportConfig: normalizedTransportConfig,
        healthStatus: "ok",
        healthMessage: unavailableServices.length > 0
          ? `Actions refreshed. Google services unavailable: ${unavailableServices.join(", ")}. Other services remain available; retry refreshing actions.`
          : isAgentMailConnection(connection)
          ? "AgentMail API key is connected."
          : "Tool catalog refreshed.",
        healthCheckedAt: refreshedAt,
        lastHealthAt: refreshedAt,
        lastCatalogRefreshAt: refreshedAt,
        lastError: null,
        updatedAt: refreshedAt,
      })
      .where(eq(toolConnections.id, connection.id))
      .returning();

    if (connection.transport === "local_stdio") {
      await ensureRuntimeSlot(updatedConnection);
      await db
        .update(toolRuntimeSlots)
        .set({
          healthStatus: "ok",
          healthMessage: "Approved stdio template is ready.",
          lastHealthCheckAt: refreshedAt,
          updatedAt: refreshedAt,
        })
        .where(eq(toolRuntimeSlots.connectionId, connection.id));
    }

    const activeEntries = updatedEntries.filter(
      (entry) => entry.status === "active",
    );
    const preserveMcpAccess = connection.config.mcpPreserveAccess === true
      && isRemoteMcpConnectorMethod(connection.config.sourceTemplateKey, connection.config.connectionMethodKey);
    if (!refreshOptions.skipDefaultProfileSync || preserveMcpAccess) {
      await publish(tx => enableCatalogEntriesByDefault({
        connection: updatedConnection,
        // Discovery must not re-enable actions the operator turned Off,
        // including curated MCP connections during API-key replacement.
        newCatalogEntryIds: activeEntries
          .filter((entry) => newCatalogEntryIds.has(entry.id))
          .map((entry) => entry.id),
        activeCatalogEntryIds: activeEntries.map((entry) => entry.id),
        restoreDraftDefaults: refreshOptions.restoreDraftDefaults || preserveMcpAccess,
        actor,
      }, tx));
    }
    await audit({
      companyId: connection.companyId,
      connectionId: connection.id,
      action: "tool_connection.catalog_refresh",
      outcome: "success",
      details: { discoveredCount: descriptors.length, quarantinedCount },
      actor,
    });

    return {
      connection: toConnection(updatedConnection),
      catalog: updatedEntries,
      discoveredCount: descriptors.length,
      quarantinedCount,
    };
  }
  return refreshCatalog;
}
