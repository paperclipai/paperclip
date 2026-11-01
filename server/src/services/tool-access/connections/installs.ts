import { connectionActorUserId } from "../actor.js";
import { toConnection, toConnectionInstall } from "./projection.js";
import { actorBinding } from "../actor.js";
import { lockToolAssignmentAgents, lockToolConnectionRuntimeInputs } from "../assignment-locks.js";
import type { ActorInfo } from "../types.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { toolAccessAuditEvents, toolConnectionInstalls, toolConnections, toolProfileBindings, toolProfileEntries, toolProfiles } from "@paperclipai/db";
import type { ToolConnection, ToolConnectionInstall, ToolConnectionInstallSnapshot, PutToolConnectionInstalls } from "@paperclipai/shared";
import { unprocessable } from "../../../errors.js";
import { logActivity } from "../../activity-log.js";

type InstallDependencies = {
  now: () => Date;
  getConnectionRow(idOrUid: string, companyId?: string): Promise<typeof toolConnections.$inferSelect>;
  assertOptionalAgent(companyId: string, agentId: string | null | undefined, label: string): Promise<void>;
};

export function createConnectionInstalls(db: Db, { now, getConnectionRow, assertOptionalAgent }: InstallDependencies) {
  async function appProfileForConnection(
    dbClient: Pick<Db, "select" | "insert" | "delete">,
    connection: typeof toolConnections.$inferSelect,
  ) {
    const profileKey = `app:${connection.id}`;
    let [profile] = await dbClient
      .select()
      .from(toolProfiles)
      .where(
        and(
          eq(toolProfiles.companyId, connection.companyId),
          eq(toolProfiles.profileKey, profileKey),
        ),
      )
      .limit(1);
    if (!profile) {
      const [sameName] = await dbClient
        .select({ id: toolProfiles.id })
        .from(toolProfiles)
        .where(
          and(
            eq(toolProfiles.companyId, connection.companyId),
            eq(toolProfiles.name, connection.name),
          ),
        )
        .limit(1);
      const profileName = sameName
        ? `${connection.name} (${connection.id.replace(/-/g, "").slice(0, 8)})`
        : connection.name;
      [profile] = await dbClient
        .insert(toolProfiles)
        .values({
          companyId: connection.companyId,
          profileKey,
          name: profileName,
          description: `Access profile for ${connection.name}.`,
          status: "active",
          defaultAction: "deny",
          metadata: {
            source: "tool_connection_install",
            connectionId: connection.id,
          },
        })
        .returning();
    }
    // Installation controls where a connection is exposed, not which actions
    // it grants. The app wizard's catalog-entry includes are the authority for
    // action selection, so remove the legacy connection-wide include that used
    // to silently turn every installed action on.
    await dbClient
      .delete(toolProfileEntries)
      .where(
        and(
          eq(toolProfileEntries.companyId, connection.companyId),
          eq(toolProfileEntries.profileId, profile.id),
          eq(toolProfileEntries.selectorType, "connection"),
          eq(toolProfileEntries.effect, "include"),
          eq(toolProfileEntries.connectionId, connection.id),
        ),
      );
    return profile;
  }

  async function listConnectionInstalls(
    connectionId: string,
    companyId?: string,
  ): Promise<ToolConnectionInstall[]> {
    const connection = await getConnectionRow(connectionId, companyId);
    const rows = await db
      .select()
      .from(toolConnectionInstalls)
      .where(
        and(
          eq(toolConnectionInstalls.companyId, connection.companyId),
          eq(toolConnectionInstalls.connectionId, connection.id),
        ),
      )
      .orderBy(
        asc(toolConnectionInstalls.targetType),
        asc(toolConnectionInstalls.targetId),
      );
    return rows.map(toConnectionInstall);
  }

  async function resolveInstalledConnectionsForAgent(
    companyId: string,
    agentId: string,
  ): Promise<ToolConnection[]> {
    await assertOptionalAgent(
      companyId,
      agentId,
      "Tool connection install agent",
    );
    const installRows = await db
      .select()
      .from(toolConnectionInstalls)
      .where(
        and(
          eq(toolConnectionInstalls.companyId, companyId),
          sql`((${toolConnectionInstalls.targetType} = 'company' and ${toolConnectionInstalls.targetId} = ${companyId}) or (${toolConnectionInstalls.targetType} = 'agent' and ${toolConnectionInstalls.targetId} = ${agentId}))`,
        ),
      );
    if (installRows.length === 0) return [];
    const connectionIds = [
      ...new Set(installRows.map((install) => install.connectionId)),
    ];
    const rows = await db
      .select()
      .from(toolConnections)
      .where(
        and(
          eq(toolConnections.companyId, companyId),
          inArray(toolConnections.id, connectionIds),
        ),
      )
      .orderBy(asc(toolConnections.name));
    return rows.map((row) => ({
      ...toConnection(row),
      installs: installRows
        .filter((install) => install.connectionId === row.id)
        .map(toConnectionInstall),
    }));
  }
  return {
    resolveInstalledConnectionsForAgent,
    listConnectionInstalls,
    putConnectionInstalls: async (
      connectionId: string,
      input: PutToolConnectionInstalls,
      actor?: ActorInfo,
    ): Promise<ToolConnectionInstallSnapshot> => {
      await actor?.managementContext?.reauthorize();
      const connection = await getConnectionRow(connectionId);
      const requested = new Map(
        input.installs.map((install) => [
          `${install.targetType}:${install.targetId}`,
          install,
        ]),
      );
      for (const install of requested.values()) {
        if (install.targetType === "company") {
          if (install.targetId !== connection.companyId)
            throw unprocessable(
              "Company installs must target the connection company",
            );
        } else {
          await assertOptionalAgent(
            connection.companyId,
            install.targetId,
            "Tool connection install agent",
          );
        }
      }
      const markMcpAccessConfigured = connection.transport === "mcp_remote"
        && connection.config.mcpAgentAccessConfigured !== true;
      const accessExtensions: Array<{
        targetType: "company" | "agent";
        targetId: string;
        profileId: string;
      }> = [];
      await db.transaction(async (tx) => {
        await lockToolConnectionRuntimeInputs(tx, connection.companyId, connection.id);
        if (markMcpAccessConfigured) {
          // Preserve an explicit zero-agent selection through OAuth. Merge the
          // marker in SQL so concurrent credential/config changes are retained.
          await tx.update(toolConnections).set({
            config: sql`${toolConnections.config} || '{"mcpAgentAccessConfigured":true}'::jsonb`,
            transportConfig: sql`${toolConnections.transportConfig} || '{"mcpAgentAccessConfigured":true}'::jsonb`,
            updatedAt: now(),
          }).where(and(
            eq(toolConnections.companyId, connection.companyId),
            eq(toolConnections.id, connection.id),
          ));
        }
        const existing = await tx
          .select()
          .from(toolConnectionInstalls)
          .where(
            and(
              eq(toolConnectionInstalls.companyId, connection.companyId),
              eq(toolConnectionInstalls.connectionId, connection.id),
            ),
          );
        const existingKeys = new Set(
          existing.map(
            (install) => `${install.targetType}:${install.targetId}`,
          ),
        );
        const bindings = await tx.select({ targetType: toolProfileBindings.targetType, targetId: toolProfileBindings.targetId })
          .from(toolProfileBindings).innerJoin(toolProfiles, eq(toolProfiles.id, toolProfileBindings.profileId))
          .where(and(eq(toolProfileBindings.companyId, connection.companyId), eq(toolProfiles.companyId, connection.companyId), eq(toolProfiles.profileKey, `app:${connection.id}`)));
        await lockToolAssignmentAgents(tx, connection.companyId, [...existing, ...requested.values(), ...bindings]);
        const removals = existing.filter(
          (install) =>
            !requested.has(`${install.targetType}:${install.targetId}`),
        );
        const removeIds = removals.map((install) => install.id);
        if (removeIds.length > 0) {
          await tx
            .delete(toolConnectionInstalls)
            .where(inArray(toolConnectionInstalls.id, removeIds));
          // Uninstalling must also drop the binding this path created. Installing
          // writes both an install row and a profile binding, so deleting only the
          // install row leaves a binding that no surface can see or remove. The
          // install row is the reach gate (`mintConnectionTokenForAgent` fails with
          // `installation_required`, and the heartbeat only hands over installed
          // connections), so a stale binding grants no reach on its own — but it
          // still makes `finishApp`, which rebuilds `access` from the bindings,
          // read a target the operator already removed.
          //
          // Only bindings tagged `source: "tool_connection_install"` are removed.
          // A binding the operator authored through the access model carries a
          // different source and must survive an uninstall.
          const [installProfile] = await tx
            .select({ id: toolProfiles.id })
            .from(toolProfiles)
            .where(
              and(
                eq(toolProfiles.companyId, connection.companyId),
                eq(toolProfiles.profileKey, `app:${connection.id}`),
              ),
            )
            .limit(1);
          if (installProfile) {
            for (const install of removals) {
              await tx
                .delete(toolProfileBindings)
                .where(
                  and(
                    eq(toolProfileBindings.companyId, connection.companyId),
                    eq(toolProfileBindings.profileId, installProfile.id),
                    eq(toolProfileBindings.targetType, install.targetType),
                    eq(toolProfileBindings.targetId, install.targetId),
                    sql`${toolProfileBindings.metadata}->>'source' = 'tool_connection_install'`,
                  ),
                );
            }
          }
        }
        const additions = [...requested.entries()]
          .filter(([key]) => !existingKeys.has(key))
          .map(([, install]) => install);
        if (additions.length > 0) {
          await tx.insert(toolConnectionInstalls).values(
            additions.map((install) => ({
              companyId: connection.companyId,
              connectionId: connection.id,
              targetType: install.targetType,
              targetId: install.targetId,
              createdByAgentId:
                actor?.actorType === "agent" ? (actor.actorId ?? null) : null,
              createdByUserId:
                connectionActorUserId(actor),
            })),
          );
        }
        if (requested.size > 0 && connection.connectionPurpose !== "ai") {
          const profile = await appProfileForConnection(tx, connection);
          for (const install of additions) {
            const [binding] = await tx
              .insert(toolProfileBindings)
              .values({
                companyId: connection.companyId,
                profileId: profile.id,
                targetType: install.targetType,
                targetId: install.targetId,
                priority: 100,
                metadata: {
                  source: "tool_connection_install",
                  connectionId: connection.id,
                },
                createdByAgentId:
                  actor?.actorType === "agent" ? (actor.actorId ?? null) : null,
                createdByUserId:
                  connectionActorUserId(actor),
              })
              .onConflictDoNothing()
              .returning({ id: toolProfileBindings.id });
            if (binding)
              accessExtensions.push({
                targetType: install.targetType,
                targetId: install.targetId,
                profileId: profile.id,
              });
          }
        }
        if (markMcpAccessConfigured || removeIds.length > 0 || additions.length > 0) {
          const binding = actorBinding(actor);
          await tx.insert(toolAccessAuditEvents).values({
            companyId: connection.companyId,
            connectionId: connection.id,
            actorType: binding.actorType ?? "system",
            actorId: binding.actorId,
            action: "connection_installs.changed",
            outcome: "success",
            reasonCode: "installs_changed",
            details: {
              ...(markMcpAccessConfigured ? { mcpAgentAccessConfigured: true } : {}),
              added: additions.map((install) => ({
                targetType: install.targetType,
                targetId: install.targetId,
              })),
              removed: existing
                .filter((install) => removeIds.includes(install.id))
                .map((install) => ({
                  targetType: install.targetType,
                  targetId: install.targetId,
                })),
            },
          });
        }
      });
      for (const extension of accessExtensions) {
        await logActivity(db, {
          companyId: connection.companyId,
          actorType: actor?.actorType ?? "system",
          actorId: actor?.actorId ?? "system",
          action: "tool_connection.install_access_extended",
          entityType: "tool_connection",
          entityId: connection.id,
          details: extension,
        });
      }
      return {
        connectionId: connection.id,
        installs: await listConnectionInstalls(
          connection.id,
          connection.companyId,
        ),
      };
    }
  };
}
