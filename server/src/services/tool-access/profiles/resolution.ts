import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, toolCatalogEntries, toolProfileBindings, toolProfileEntries, toolProfiles } from "@paperclipai/db";
import type { ToolCatalogEntry, ToolConnection, ToolProfileEffectiveSummary, ToolProfileWithDetails } from "@paperclipai/shared";
import { effectiveToolProfileBindings, profileIdsInBindingOrder } from "../../tool-profile-binding-precedence.js";
import { buildProfileDetails, profileCatalogColumns, profileEntryMatchesCatalog, toProfileBinding, toProfileEntry, type ProfileCatalogEntry } from "./projection.js";
type ProfileAssignmentDependencies = {
  assertOptionalAgent(companyId: string, agentId: string | null | undefined, label: string): Promise<void>;
  resolveInstalledConnectionsForAgent(companyId: string, agentId: string): Promise<ToolConnection[]>;
  toCatalogEntry(row: typeof toolCatalogEntries.$inferSelect): ToolCatalogEntry;
};

export function createToolProfileResolver(db: Db, { assertOptionalAgent, resolveInstalledConnectionsForAgent, toCatalogEntry }: ProfileAssignmentDependencies) {
  async function resolveEffectiveProfiles<TEntry extends ProfileCatalogEntry, TAllowedTool>(
    companyId: string,
    agentId: string,
    loadCatalog: () => PromiseLike<TEntry[]>,
    toAllowedTool: (entry: TEntry) => TAllowedTool,
  ): Promise<Omit<ToolProfileEffectiveSummary, "allowedTools"> & { allowedTools: TAllowedTool[] }> {
    await assertOptionalAgent(
      companyId,
      agentId,
      "Tool profile effective agent",
    );
    const allBindings = await db
      .select()
      .from(toolProfileBindings)
      .where(eq(toolProfileBindings.companyId, companyId))
      .orderBy(
        asc(toolProfileBindings.priority),
        asc(toolProfileBindings.createdAt),
      );
    const matchingBindings = allBindings.filter(
      (binding) =>
        (binding.targetType === "company" &&
          binding.targetId === companyId) ||
        (binding.targetType === "agent" && binding.targetId === agentId),
    );
    if (matchingBindings.length === 0) {
      return {
        agentId,
        profiles: [],
        entries: [],
        bindings: [],
        allowedTools: [],
        allowedToolNames: [],
        installedConnections: await resolveInstalledConnectionsForAgent(
          companyId,
          agentId,
        ),
      };
    }
    const candidateProfileIds = profileIdsInBindingOrder(matchingBindings);
    const candidateProfiles = await db
      .select()
      .from(toolProfiles)
      .where(
        and(
          eq(toolProfiles.companyId, companyId),
          inArray(toolProfiles.id, candidateProfileIds),
        ),
      );
    const bindings = effectiveToolProfileBindings(
      matchingBindings,
      candidateProfiles,
    );
    const profileIds = profileIdsInBindingOrder(bindings);
    const profilesById = new Map(
      candidateProfiles.map((profile) => [profile.id, profile]),
    );
    const activeProfiles = profileIds
      .map((profileId) => profilesById.get(profileId) ?? null)
      .filter((profile): profile is typeof toolProfiles.$inferSelect =>
        Boolean(profile && profile.status === "active"),
      );
    if (activeProfiles.length === 0) {
      return {
        agentId,
        profiles: [],
        entries: [],
        bindings: bindings.map(toProfileBinding),
        allowedTools: [],
        allowedToolNames: [],
        installedConnections: await resolveInstalledConnectionsForAgent(
          companyId,
          agentId,
        ),
      };
    }
    const activeProfileIds = activeProfiles.map((profile) => profile.id);
    const [entries, catalog, companyAgents] = await Promise.all([
      db
        .select()
        .from(toolProfileEntries)
        .where(
          and(
            eq(toolProfileEntries.companyId, companyId),
            inArray(toolProfileEntries.profileId, activeProfileIds),
          ),
        )
        .orderBy(asc(toolProfileEntries.createdAt)),
      loadCatalog(),
      db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.companyId, companyId)),
    ]);
    const entriesByProfile = new Map<
      string,
      Array<typeof toolProfileEntries.$inferSelect>
    >();
    for (const entry of entries) {
      const list = entriesByProfile.get(entry.profileId) ?? [];
      list.push(entry);
      entriesByProfile.set(entry.profileId, list);
    }
    const allowedCatalogIds = new Set<string>();
    const allowedToolNames = new Set<string>();
    for (const profile of activeProfiles) {
      const profileEntries = entriesByProfile.get(profile.id) ?? [];
      const includes = profileEntries.filter(
        (entry) => entry.effect === "include",
      );
      const excludes = profileEntries.filter(
        (entry) => entry.effect === "exclude",
      );
      for (const catalogEntry of catalog) {
        if (
          excludes.some((entry) =>
            profileEntryMatchesCatalog(entry, catalogEntry),
          )
        )
          continue;
        if (
          profile.defaultAction === "allow" ||
          includes.some((entry) =>
            profileEntryMatchesCatalog(entry, catalogEntry),
          )
        ) {
          allowedCatalogIds.add(catalogEntry.id);
          allowedToolNames.add(catalogEntry.toolName);
        }
      }
      for (const entry of includes.filter(
        (item) => item.selectorType === "tool_name" && item.toolName,
      )) {
        const matchingExclude = excludes.some(
          (item) =>
            item.selectorType === "tool_name" &&
            item.toolName === entry.toolName,
        );
        if (!matchingExclude) allowedToolNames.add(entry.toolName!);
      }
    }
    const agentIds = companyAgents.map((agent) => agent.id);
    const details: ToolProfileWithDetails[] = activeProfiles.map((profile) =>
      buildProfileDetails({
        profile,
        entries: entriesByProfile.get(profile.id) ?? [],
        bindings: bindings.filter(
          (binding) => binding.profileId === profile.id,
        ),
        catalog,
        agentIds,
      }),
    );
    const allowedTools = catalog
      .filter((entry) => allowedCatalogIds.has(entry.id))
      .map(toAllowedTool);
    return {
      agentId,
      profiles: details,
      entries: entries.map(toProfileEntry),
      bindings: bindings.map(toProfileBinding),
      allowedTools,
      allowedToolNames: [...allowedToolNames].sort((a, b) =>
        a.localeCompare(b),
      ),
      installedConnections: await resolveInstalledConnectionsForAgent(
        companyId,
        agentId,
      ),
    };
  }
  return {
    getEffectiveProfilesForAgent: (companyId: string, agentId: string) =>
      resolveEffectiveProfiles(
        companyId,
        agentId,
        () => db
          .select()
          .from(toolCatalogEntries)
          .where(and(
            eq(toolCatalogEntries.companyId, companyId),
            eq(toolCatalogEntries.status, "active"),
          ))
          .orderBy(asc(toolCatalogEntries.toolName)),
        toCatalogEntry,
      ),

    getEffectiveToolAssignmentsForAgent: (companyId: string, agentId: string) =>
      resolveEffectiveProfiles(
        companyId,
        agentId,
        () => db
          .select(profileCatalogColumns)
          .from(toolCatalogEntries)
          .where(and(
            eq(toolCatalogEntries.companyId, companyId),
            eq(toolCatalogEntries.status, "active"),
          ))
          .orderBy(asc(toolCatalogEntries.toolName)),
        ({ id, applicationId, connectionId, toolName }) => ({ id, applicationId, connectionId, toolName }),
      )
  };
}
