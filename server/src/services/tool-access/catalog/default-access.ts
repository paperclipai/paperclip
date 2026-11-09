import { lockManagedAppPolicies, lockToolAssignmentAgents } from "../assignment-locks.js";
import type { ActorInfo, ToolAccessMutationDb } from "../types.js";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { toolCatalogEntries, toolConnections, toolPolicies, toolProfileBindings, toolProfileEntries, toolProfiles } from "@paperclipai/db";
import type { ToolPolicy } from "@paperclipai/shared";

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

export function toPolicy(row: typeof toolPolicies.$inferSelect): ToolPolicy {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    description: row.description,
    policyType: row.policyType,
    priority: row.priority,
    enabled: row.enabled,
    selectors: row.selectors ?? {},
    conditions: row.conditions ?? null,
    config: row.config ?? null,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function policyNameForApp(
  connection: typeof toolConnections.$inferSelect,
  entry: typeof toolCatalogEntries.$inferSelect,
) {
  const base = `Ask first ${connection.id.slice(0, 8)} ${entry.toolName}`;
  return base.length <= 160 ? base : base.slice(0, 160);
}

export function createCatalogDefaultAccess(db: Db) {
  async function enableCatalogEntriesByDefault(input: {
    connection: typeof toolConnections.$inferSelect;
    newCatalogEntryIds: string[];
    activeCatalogEntryIds: string[];
    restoreDraftDefaults?: boolean;
    actor?: ActorInfo;
  }, dbClient: ToolAccessMutationDb = db) {
    // Catalog discovery also runs while the setup wizard is still a draft.
    // Access is not granted until the operator finishes that wizard, so a
    // draft refresh must never manufacture a profile or company-wide binding.
    // Active legacy connections may still need the managed profile created on
    // their first refresh. A reconnect is the one draft exception: removal
    // deliberately clears the old selections, so reconnecting restores the
    // documented defaults without activating the connection itself.
    if (input.connection.status !== "active" && !input.restoreDraftDefaults)
      return;
    const profileKey = `app:${input.connection.id}`;
    let [profile] = await dbClient
      .select()
      .from(toolProfiles)
      .where(
        and(
          eq(toolProfiles.companyId, input.connection.companyId),
          eq(toolProfiles.profileKey, profileKey),
        ),
      )
      .limit(1).for("no key update");
    await lockManagedAppPolicies(dbClient, input.connection.companyId, input.connection.id);
    const createdProfile = !profile;
    const resetToRecommendedDefaults = !profile || profile.status !== "active";
    if (resetToRecommendedDefaults) await lockToolAssignmentAgents(dbClient, input.connection.companyId, [{ targetType: "company", targetId: input.connection.companyId }]);
    if (!profile) {
      const [sameName] = await dbClient
        .select({ id: toolProfiles.id })
        .from(toolProfiles)
        .where(
          and(
            eq(toolProfiles.companyId, input.connection.companyId),
            eq(toolProfiles.name, input.connection.name),
          ),
        )
        .limit(1);
      const profileName = sameName
        ? `${input.connection.name} (${input.connection.id.replace(/-/g, "").slice(0, 8)})`
        : input.connection.name;
      [profile] = await dbClient
        .insert(toolProfiles)
        .values({
          companyId: input.connection.companyId,
          profileKey,
          name: profileName,
          description: `Access profile for ${input.connection.name}.`,
          status: "active",
          defaultAction: "deny",
          metadata: {
            source: "app_gallery_finish",
            connectionId: input.connection.id,
          },
        })
        .returning();
      await dbClient.insert(toolProfileBindings).values({
        companyId: input.connection.companyId,
        profileId: profile.id,
        targetType: "company",
        targetId: input.connection.companyId,
        priority: 100,
        metadata: { source: "app_gallery_finish" },
        createdByAgentId:
          input.actor?.actorType === "agent"
            ? (input.actor.actorId ?? null)
            : null,
        createdByUserId:
          input.actor?.actorType === "user"
            ? (input.actor.actorId ?? null)
            : null,
      });
    } else if (resetToRecommendedDefaults) {
      // Removing an app may retain its profile row when another record still
      // references it (for example, an MCP gateway). Reconnecting revives the
      // same connection id, so restore that retained profile as a fresh
      // all-agents assignment instead of leaving every read action Off.
      [profile] = await dbClient
        .update(toolProfiles)
        .set({
          name: input.connection.name,
          description: `Access profile for ${input.connection.name}.`,
          status: "active",
          defaultAction: "deny",
          metadata: {
            source: "app_gallery_finish",
            connectionId: input.connection.id,
          },
          updatedAt: new Date(),
        })
        .where(eq(toolProfiles.id, profile.id))
        .returning();
      await dbClient
        .delete(toolProfileBindings)
        .where(
          and(
            eq(toolProfileBindings.companyId, input.connection.companyId),
            eq(toolProfileBindings.profileId, profile.id),
          ),
        );
      await dbClient
        .delete(toolProfileEntries)
        .where(
          and(
            eq(toolProfileEntries.companyId, input.connection.companyId),
            eq(toolProfileEntries.profileId, profile.id),
          ),
        );
      await dbClient.insert(toolProfileBindings).values({
        companyId: input.connection.companyId,
        profileId: profile.id,
        targetType: "company",
        targetId: input.connection.companyId,
        priority: 100,
        metadata: { source: "app_gallery_finish" },
        createdByAgentId:
          input.actor?.actorType === "agent"
            ? (input.actor.actorId ?? null)
            : null,
        createdByUserId:
          input.actor?.actorType === "user"
            ? (input.actor.actorId ?? null)
            : null,
      });
    }

    if (resetToRecommendedDefaults) {
      // Old setup defaults created app-scoped Ask first policies for writes.
      // They outrank profile allows, so a revived connection must explicitly
      // retire them to make every action Allowed. Policies outside this app's
      // managed profile are intentionally untouched.
      await upsertAskFirstPolicies({
        companyId: input.connection.companyId,
        connection: input.connection,
        askFirstEntries: [],
        actor: input.actor,
      }, dbClient);
    }

    // A new or revived connection starts with every discovered action enabled.
    // Later refreshes extend an active managed profile only for genuinely new
    // actions, so an action the operator deliberately turned off remains off.
    const candidateIds = [
      ...new Set(
        createdProfile || resetToRecommendedDefaults
          ? input.activeCatalogEntryIds
          : input.newCatalogEntryIds,
      ),
    ];
    if (candidateIds.length === 0) return;
    const existingEntries = await dbClient
      .select({ catalogEntryId: toolProfileEntries.catalogEntryId })
      .from(toolProfileEntries)
      .where(
        and(
          eq(toolProfileEntries.companyId, input.connection.companyId),
          eq(toolProfileEntries.profileId, profile.id),
          inArray(toolProfileEntries.catalogEntryId, candidateIds),
        ),
      );
    const configuredIds = new Set(
      existingEntries.flatMap((entry) =>
        entry.catalogEntryId ? [entry.catalogEntryId] : [],
      ),
    );
    const entryIds = candidateIds.filter((id) => !configuredIds.has(id));
    if (entryIds.length === 0) return;
    await dbClient.insert(toolProfileEntries).values(
      entryIds.map((catalogEntryId) => ({
        companyId: input.connection.companyId,
        profileId: profile.id,
        selectorType: "catalog_entry" as const,
        effect: "include" as const,
        applicationId: input.connection.applicationId,
        connectionId: input.connection.id,
        catalogEntryId,
      })),
    );
  }

  async function upsertAskFirstPolicies(
    input: {
      companyId: string;
      connection: typeof toolConnections.$inferSelect;
      askFirstEntries: Array<typeof toolCatalogEntries.$inferSelect>;
      actor?: ActorInfo;
      disableStale?: boolean;
    },
    dbClient: ToolAccessMutationDb = db,
  ): Promise<ToolPolicy[]> {
    const existingPolicies = await dbClient
      .select()
      .from(toolPolicies)
      .where(
        and(
          eq(toolPolicies.companyId, input.companyId),
          eq(toolPolicies.policyType, "require_approval"),
        ),
      );
    const managedPolicies = existingPolicies.filter((policy) => {
      const config = asRecord(policy.config);
      return (
        config.source === "app_gallery_finish" &&
        config.connectionId === input.connection.id
      );
    });
    const policiesByCatalogEntryId = new Map<
      string,
      typeof toolPolicies.$inferSelect
    >();
    for (const policy of managedPolicies) {
      const config = asRecord(policy.config);
      if (typeof config.catalogEntryId === "string") {
        policiesByCatalogEntryId.set(config.catalogEntryId, policy);
      }
    }
    const askFirstIds = new Set(input.askFirstEntries.map((entry) => entry.id));
    const results: ToolPolicy[] = [];
    for (const entry of input.askFirstEntries) {
      const config = {
        source: "app_gallery_finish",
        connectionId: input.connection.id,
        catalogEntryId: entry.id,
      };
      const existing = policiesByCatalogEntryId.get(entry.id);
      if (existing) {
        const [updated] = await dbClient
          .update(toolPolicies)
          .set({
            name: policyNameForApp(input.connection, entry),
            description: `Ask first before running ${entry.toolName}.`,
            enabled: true,
            selectors: { catalogEntryId: entry.id },
            config,
            updatedAt: new Date(),
          })
          .where(eq(toolPolicies.id, existing.id))
          .returning();
        results.push(toPolicy(updated));
      } else {
        const [created] = await dbClient
          .insert(toolPolicies)
          .values({
            companyId: input.companyId,
            name: policyNameForApp(input.connection, entry),
            description: `Ask first before running ${entry.toolName}.`,
            policyType: "require_approval",
            priority: 50,
            enabled: true,
            selectors: { catalogEntryId: entry.id },
            config,
            createdByAgentId:
              input.actor?.actorType === "agent"
                ? (input.actor.actorId ?? null)
                : null,
            createdByUserId:
              input.actor?.actorType === "user"
                ? (input.actor.actorId ?? null)
                : null,
          })
          .returning();
        results.push(toPolicy(created));
      }
    }
    if (input.disableStale !== false) {
      const stalePolicies = managedPolicies.filter((policy) => {
        const config = asRecord(policy.config);
        return (
          typeof config.catalogEntryId === "string" &&
          !askFirstIds.has(config.catalogEntryId)
        );
      });
      for (const policy of stalePolicies) {
        await dbClient
          .update(toolPolicies)
          .set({ enabled: false, updatedAt: new Date() })
          .where(eq(toolPolicies.id, policy.id));
      }
    }
    return results;
  }
  return { enableCatalogEntriesByDefault, upsertAskFirstPolicies };
}
export type CatalogDefaultAccess = ReturnType<typeof createCatalogDefaultAccess>;
