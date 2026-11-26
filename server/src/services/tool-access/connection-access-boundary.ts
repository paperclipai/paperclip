import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  toolConnectionInstalls,
  toolConnections,
  toolProfileBindings,
  toolProfiles,
} from "@paperclipai/db";
import { isConnectionAccessProfile } from "../tool-profile-binding-precedence.js";

type ReadDb = Pick<Db, "select">;

export type ConnectionAccessBoundary = {
  installedForAgent: boolean;
  hasAnyInstalls: boolean;
  agentAccessConfigured: boolean;
  hasManagedProfile: boolean;
  hasUnboundManagedProfile: boolean;
  requiresInstall: boolean;
};

export type KnownConnectionAccessMeta = {
  transport: string | null;
  agentAccessConfigured: boolean;
};

export function hasAgentAccessConfiguredMarker(config: unknown): boolean {
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  const record = config as Record<string, unknown>;
  return record.agentAccessConfigured === true || record.mcpAgentAccessConfigured === true;
}

export function agentAccessConfiguredSql() {
  return sql<boolean>`coalesce((${toolConnections.config} ->> 'agentAccessConfigured') = 'true' or (${toolConnections.config} ->> 'mcpAgentAccessConfigured') = 'true', false)`.as("agent_access_configured");
}

export function connectionRequiresInstall(state: {
  transport: string | null;
  hasAnyInstalls: boolean;
  agentAccessConfigured: boolean;
  hasUnboundManagedProfile: boolean;
}): boolean {
  return state.transport === "plugin"
    || state.hasAnyInstalls
    || state.agentAccessConfigured
    || state.hasUnboundManagedProfile;
}

export async function readConnectionAccessBoundaries(
  db: ReadDb,
  input: {
    companyId: string;
    agentId: string | null;
    connectionIds: readonly string[];
    knownConnections?: ReadonlyMap<string, KnownConnectionAccessMeta>;
  },
): Promise<Map<string, ConnectionAccessBoundary>> {
  const uniqueIds = [...new Set(input.connectionIds)];
  const result = new Map<string, ConnectionAccessBoundary>();
  if (uniqueIds.length === 0) return result;

  const missingConnectionIds = uniqueIds.filter((id) => !input.knownConnections?.has(id));
  const [connectionRows, installRows, managedProfileRows] = await Promise.all([
    missingConnectionIds.length > 0
      ? db
          .select({
            id: toolConnections.id,
            transport: toolConnections.transport,
            agentAccessConfigured: agentAccessConfiguredSql(),
          })
          .from(toolConnections)
          .where(and(
            eq(toolConnections.companyId, input.companyId),
            inArray(toolConnections.id, missingConnectionIds),
          ))
      : Promise.resolve([]),
    db
      .select({
        connectionId: toolConnectionInstalls.connectionId,
        targetType: toolConnectionInstalls.targetType,
        targetId: toolConnectionInstalls.targetId,
      })
      .from(toolConnectionInstalls)
      .where(and(
        eq(toolConnectionInstalls.companyId, input.companyId),
        inArray(toolConnectionInstalls.connectionId, uniqueIds),
      )),
    db
      .select({
        id: toolProfiles.id,
        profileKey: toolProfiles.profileKey,
        metadata: toolProfiles.metadata,
      })
      .from(toolProfiles)
      .where(and(
        eq(toolProfiles.companyId, input.companyId),
        eq(toolProfiles.status, "active"),
        or(
          inArray(toolProfiles.profileKey, uniqueIds.map((id) => `app:${id}`)),
          sql`${toolProfiles.metadata}->>'source' = 'connection_intent' and (${toolProfiles.metadata}->>'connectionId') = any(${sql.param(uniqueIds)}::text[])`,
        ),
      )),
  ]);

  const metaByConnectionId = new Map<string, KnownConnectionAccessMeta>();
  if (input.knownConnections) {
    for (const [id, meta] of input.knownConnections.entries()) {
      metaByConnectionId.set(id, meta);
    }
  }
  for (const row of connectionRows) {
    metaByConnectionId.set(row.id, {
      transport: row.transport,
      agentAccessConfigured: Boolean(row.agentAccessConfigured),
    });
  }

  const installsByConnectionId = new Map<string, Array<{ targetType: string; targetId: string }>>();
  for (const row of installRows) {
    const list = installsByConnectionId.get(row.connectionId) ?? [];
    list.push({ targetType: row.targetType, targetId: row.targetId });
    installsByConnectionId.set(row.connectionId, list);
  }

  const managedCandidates = managedProfileRows.flatMap((row) => {
    const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : null;
    const connectionId = typeof metadata?.connectionId === "string" ? metadata.connectionId : null;
    return connectionId && isConnectionAccessProfile(row, connectionId)
      ? [{ id: row.id, connectionId }]
      : [];
  });

  const boundManagedProfileIds = managedCandidates.length > 0
    ? new Set(
        (await db
          .select({ profileId: toolProfileBindings.profileId })
          .from(toolProfileBindings)
          .where(and(
            eq(toolProfileBindings.companyId, input.companyId),
            inArray(toolProfileBindings.profileId, managedCandidates.map((profile) => profile.id)),
          ))
          .groupBy(toolProfileBindings.profileId)
        ).map((row) => row.profileId),
      )
    : new Set<string>();

  const managedByConnectionId = new Map<string, Array<{ hasBinding: boolean }>>();
  for (const profile of managedCandidates) {
    const list = managedByConnectionId.get(profile.connectionId) ?? [];
    list.push({ hasBinding: boundManagedProfileIds.has(profile.id) });
    managedByConnectionId.set(profile.connectionId, list);
  }

  for (const connectionId of uniqueIds) {
    const meta = metaByConnectionId.get(connectionId);
    const installs = installsByConnectionId.get(connectionId) ?? [];
    const hasAnyInstalls = installs.length > 0;
    const installedForAgent = Boolean(
      input.agentId && installs.some((install) =>
        (install.targetType === "company" && install.targetId === input.companyId)
        || (install.targetType === "agent" && install.targetId === input.agentId),
      ),
    );
    const agentAccessConfigured = Boolean(meta?.agentAccessConfigured);
    const managed = managedByConnectionId.get(connectionId) ?? [];
    const hasManagedProfile = managed.length > 0;
    const hasUnboundManagedProfile = hasManagedProfile && managed.every((profile) => !profile.hasBinding);
    const requiresInstall = connectionRequiresInstall({
      transport: meta?.transport ?? null,
      hasAnyInstalls,
      agentAccessConfigured,
      hasUnboundManagedProfile,
    });
    result.set(connectionId, {
      installedForAgent,
      hasAnyInstalls,
      agentAccessConfigured,
      hasManagedProfile,
      hasUnboundManagedProfile,
      requiresInstall,
    });
  }

  return result;
}

export async function defaultConnectionProfileBindingTargets(
  db: ReadDb,
  connection: Pick<typeof toolConnections.$inferSelect, "id" | "companyId" | "config">,
): Promise<Array<{ targetType: "company" | "agent"; targetId: string }>> {
  const existingInstalls = await db
    .select({ targetType: toolConnectionInstalls.targetType, targetId: toolConnectionInstalls.targetId })
    .from(toolConnectionInstalls)
    .where(and(
      eq(toolConnectionInstalls.companyId, connection.companyId),
      eq(toolConnectionInstalls.connectionId, connection.id),
    ));
  if (existingInstalls.length > 0) {
    if (existingInstalls.some((install) => install.targetType === "company" && install.targetId === connection.companyId)) {
      return [{ targetType: "company", targetId: connection.companyId }];
    }
    return existingInstalls
      .filter((install) => install.targetType === "agent")
      .map((install) => ({ targetType: "agent", targetId: install.targetId }));
  }
  if (hasAgentAccessConfiguredMarker(connection.config)) {
    return [];
  }
  return [{ targetType: "company", targetId: connection.companyId }];
}
