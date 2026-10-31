import { pendingNewToolsForProfile, profileCatalogColumns } from "../profiles/projection.js";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { toolActionRequests, toolCatalogEntries, toolConnections, toolInvocations, toolProfileEntries, toolProfiles } from "@paperclipai/db";
import type { ToolConnectionHealthStatus, ToolAppsAttentionResponse } from "@paperclipai/shared";
import { isToolConnectionAttentionHealth } from "@paperclipai/shared";
import { toConnection } from "../connections/projection.js";
function isAttentionHealthStatus(
  status: ToolConnectionHealthStatus,
): boolean {
  return isToolConnectionAttentionHealth(status);
}

export function createToolAppAttention(db: Db, now: () => Date) {
  async function listAppsNeedingAttention(
    companyId: string,
  ): Promise<ToolAppsAttentionResponse> {
    const generatedAt = now();
    const [
      connections,
      quarantinedEntries,
      pendingActionRequests,
      invocations,
      profiles,
      profileEntries,
      activeCatalog,
    ] = await Promise.all([
      db
        .select()
        .from(toolConnections)
        .where(
          and(
            eq(toolConnections.companyId, companyId),
            ne(toolConnections.status, "archived"),
          ),
        ),
      db
        .select({ connectionId: toolCatalogEntries.connectionId })
        .from(toolCatalogEntries)
        .where(
          and(
            eq(toolCatalogEntries.companyId, companyId),
            eq(toolCatalogEntries.status, "quarantined"),
          ),
        ),
      db
        .select({ invocationId: toolActionRequests.invocationId })
        .from(toolActionRequests)
        .where(
          and(
            eq(toolActionRequests.companyId, companyId),
            eq(toolActionRequests.status, "pending"),
            isNotNull(toolActionRequests.signedArguments),
          ),
        ),
      db
        .select({ id: toolInvocations.id, connectionId: toolInvocations.connectionId })
        .from(toolInvocations)
        .where(eq(toolInvocations.companyId, companyId)),
      db
        .select()
        .from(toolProfiles)
        .where(eq(toolProfiles.companyId, companyId)),
      db
        .select()
        .from(toolProfileEntries)
        .where(eq(toolProfileEntries.companyId, companyId)),
      db
        .select(profileCatalogColumns)
        .from(toolCatalogEntries)
        .where(
          and(
            eq(toolCatalogEntries.companyId, companyId),
            eq(toolCatalogEntries.status, "active"),
          ),
        ),
    ]);
    const quarantinedCountByConnection = new Map<string, number>();
    for (const entry of quarantinedEntries) {
      quarantinedCountByConnection.set(
        entry.connectionId,
        (quarantinedCountByConnection.get(entry.connectionId) ?? 0) + 1,
      );
    }
    const invocationConnectionById = new Map(
      invocations.map((invocation) => [invocation.id, invocation.connectionId]),
    );
    const pendingActionRequestCountByConnection = new Map<string, number>();
    for (const request of pendingActionRequests) {
      const connectionId = invocationConnectionById.get(request.invocationId);
      if (!connectionId) continue;
      pendingActionRequestCountByConnection.set(
        connectionId,
        (pendingActionRequestCountByConnection.get(connectionId) ?? 0) + 1,
      );
    }
    const entriesByProfile = new Map<
      string,
      Array<typeof toolProfileEntries.$inferSelect>
    >();
    for (const entry of profileEntries) {
      const list = entriesByProfile.get(entry.profileId) ?? [];
      list.push(entry);
      entriesByProfile.set(entry.profileId, list);
    }
    const connectionsById = new Map(
      connections.map((connection) => [connection.id, connection]),
    );
    const pendingProfilesByConnection = new Map<
      string,
      Map<
        string,
        { profileId: string; profileName: string; pendingCount: number }
      >
    >();
    for (const profile of profiles) {
      const tools = pendingNewToolsForProfile({
        profile,
        entries: entriesByProfile.get(profile.id) ?? [],
        catalog: activeCatalog,
        connectionsById,
      });
      for (const tool of tools) {
        const profileCounts =
          pendingProfilesByConnection.get(tool.connectionId) ?? new Map();
        const existing = profileCounts.get(profile.id) ?? {
          profileId: profile.id,
          profileName: profile.name,
          pendingCount: 0,
        };
        existing.pendingCount += 1;
        profileCounts.set(profile.id, existing);
        pendingProfilesByConnection.set(tool.connectionId, profileCounts);
      }
    }
    const apps = connections.flatMap((connection) => {
      const healthNeedsAttention = isAttentionHealthStatus(
        connection.healthStatus,
      );
      const quarantinedCatalogEntryCount =
        quarantinedCountByConnection.get(connection.id) ?? 0;
      const pendingActionRequestCount =
        pendingActionRequestCountByConnection.get(connection.id) ?? 0;
      const newToolsPendingProfiles = [
        ...(pendingProfilesByConnection.get(connection.id)?.values() ?? []),
      ].sort(
        (a, b) =>
          b.pendingCount - a.pendingCount ||
          a.profileName.localeCompare(b.profileName),
      );
      const newToolsPendingReviewCount = newToolsPendingProfiles.reduce(
        (sum, profile) => sum + profile.pendingCount,
        0,
      );
      const reasons = [
        ...(healthNeedsAttention ? ["health" as const] : []),
        ...(quarantinedCatalogEntryCount > 0
          ? ["quarantined_catalog_entries" as const]
          : []),
        ...(pendingActionRequestCount > 0
          ? ["pending_action_requests" as const]
          : []),
        ...(newToolsPendingReviewCount > 0
          ? ["profile_new_tools" as const]
          : []),
      ];
      return reasons.length > 0
        ? [
            {
              connection: toConnection(connection),
              healthNeedsAttention,
              quarantinedCatalogEntryCount,
              pendingActionRequestCount,
              newToolsPendingReviewCount,
              newToolsPendingProfiles,
              reasons,
            },
          ]
        : [];
    });
    return {
      generatedAt,
      apps,
      totals: {
        connections: apps.length,
        health: apps.filter((app) => app.healthNeedsAttention).length,
        quarantinedCatalogEntries: apps.reduce(
          (sum, app) => sum + app.quarantinedCatalogEntryCount,
          0,
        ),
        pendingActionRequests: apps.reduce(
          (sum, app) => sum + app.pendingActionRequestCount,
          0,
        ),
        newToolsPendingReview: apps.reduce(
          (sum, app) => sum + app.newToolsPendingReviewCount,
          0,
        ),
        newToolsPendingProfiles: apps.reduce(
          (sum, app) => sum + app.newToolsPendingProfiles.length,
          0,
        ),
      },
    };
  }
  return listAppsNeedingAttention;
}
