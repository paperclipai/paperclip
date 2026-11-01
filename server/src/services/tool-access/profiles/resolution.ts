import { and, asc, eq, inArray, or, sql, type AnyColumn } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, toolCatalogEntries, toolProfileBindings, toolProfileEntries, toolProfiles } from "@paperclipai/db";
import type { ToolCatalogEntry, ToolConnection, ToolProfileEffectiveSummary, ToolProfileWithDetails } from "@paperclipai/shared";
import { effectiveToolProfileBindings, profileIdsInBindingOrder } from "../../tool-profile-binding-precedence.js";
import { buildProfileDetails, profileCatalogColumns, profileEntryMatchesCatalog, toProfileBinding, toProfileEntry, type ProfileCatalogEntry, type ProfileEntryMatch, type ProfileCatalogMatch } from "./projection.js";
type ProfileAssignmentDependencies = {
  assertOptionalAgent(companyId: string, agentId: string | null | undefined, label: string): Promise<void>;
  resolveInstalledConnectionsForAgent(companyId: string, agentId: string): Promise<ToolConnection[]>;
  toCatalogEntry(row: typeof toolCatalogEntries.$inferSelect): ToolCatalogEntry;
};

function catalogValuesContain(column: AnyColumn, values: Array<string | null>) {
  const distinct = [...new Set(values)];
  return sql`(${JSON.stringify(distinct.filter(value => value !== null))}::jsonb ? ${column}::text
    or (${distinct.includes(null)} and ${column} is null))`;
}

function resolveCatalogAccess(
  profiles: Array<Pick<typeof toolProfiles.$inferSelect, "id" | "defaultAction">>,
  entries: Array<ProfileEntryMatch & { profileId: string; effect: string }>,
  catalog: ProfileCatalogMatch[],
) {
  const allowedCatalogIds = new Set<string>();
  const allowedToolNames = new Set<string>();
  const entriesByProfile = new Map<string, typeof entries>();
  for (const entry of entries) {
    const group = entriesByProfile.get(entry.profileId) ?? [];
    group.push(entry);
    entriesByProfile.set(entry.profileId, group);
  }
  for (const profile of profiles) {
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
  return { allowedCatalogIds, allowedToolNames };
}

export function createToolProfileResolver(db: Db, { assertOptionalAgent, resolveInstalledConnectionsForAgent, toCatalogEntry }: ProfileAssignmentDependencies) {
  async function readEffectiveProfileState(companyId: string, agentId: string) {
    await assertOptionalAgent(
      companyId,
      agentId,
      "Tool profile effective agent",
    );
    const matchingBindings = await db
      .select()
      .from(toolProfileBindings)
      .where(and(eq(toolProfileBindings.companyId, companyId), or(
        and(eq(toolProfileBindings.targetType, "company"), eq(toolProfileBindings.targetId, companyId)),
        and(eq(toolProfileBindings.targetType, "agent"), eq(toolProfileBindings.targetId, agentId)),
      )))
      .orderBy(
        asc(toolProfileBindings.priority),
        asc(toolProfileBindings.createdAt),
      );
    const candidateProfileIds = profileIdsInBindingOrder(matchingBindings);
    if (candidateProfileIds.length === 0) return { bindings: [], activeProfiles: [] };
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
    return { bindings, activeProfiles };
  }

  async function loadEffectiveAssignments<TEntry extends ProfileCatalogEntry>(
    companyId: string,
    agentId: string,
    loadCatalog: () => PromiseLike<TEntry[]>,
  ) {
    const { bindings, activeProfiles } = await readEffectiveProfileState(companyId, agentId);
    const activeProfileIds = activeProfiles.map((profile) => profile.id);
    const [entries, catalog, installedConnections] = await Promise.all([
      activeProfileIds.length ? db.select().from(toolProfileEntries).where(and(
        eq(toolProfileEntries.companyId, companyId),
        inArray(toolProfileEntries.profileId, activeProfileIds),
      )).orderBy(asc(toolProfileEntries.createdAt)) : [],
      activeProfileIds.length ? loadCatalog() : [],
      resolveInstalledConnectionsForAgent(companyId, agentId),
    ]);
    const { allowedCatalogIds, allowedToolNames } = resolveCatalogAccess(activeProfiles, entries, catalog);
    return { bindings, activeProfiles, entries, catalog, allowedCatalogIds,
      allowedToolNames: [...allowedToolNames].sort((a, b) => a.localeCompare(b)), installedConnections };
  }

  async function getEffectiveProfilesForAgent(companyId: string, agentId: string): Promise<ToolProfileEffectiveSummary> {
    const state = await loadEffectiveAssignments(companyId, agentId, () => db.select().from(toolCatalogEntries)
      .where(and(eq(toolCatalogEntries.companyId, companyId), eq(toolCatalogEntries.status, "active")))
      .orderBy(asc(toolCatalogEntries.toolName)));
    const companyAgents = state.activeProfiles.length ? await db.select({ id: agents.id }).from(agents)
      .where(eq(agents.companyId, companyId)) : [];
    const entriesByProfile = new Map<string, typeof state.entries>();
    for (const entry of state.entries) {
      const list = entriesByProfile.get(entry.profileId) ?? [];
      list.push(entry);
      entriesByProfile.set(entry.profileId, list);
    }
    const agentIds = companyAgents.map((agent) => agent.id);
    const profiles: ToolProfileWithDetails[] = state.activeProfiles.map((profile) => buildProfileDetails({
      profile,
      entries: entriesByProfile.get(profile.id) ?? [],
      bindings: state.bindings.filter((binding) => binding.profileId === profile.id),
      catalog: state.catalog,
      agentIds,
    }));
    return {
      agentId, profiles,
      entries: state.entries.map(toProfileEntry),
      bindings: state.bindings.map(toProfileBinding),
      allowedTools: state.catalog.filter((entry) => state.allowedCatalogIds.has(entry.id)).map(toCatalogEntry),
      allowedToolNames: state.allowedToolNames,
      installedConnections: state.installedConnections,
    };
  }

  async function getEffectiveToolAssignmentsForAgent(companyId: string, agentId: string) {
    const state = await loadEffectiveAssignments(companyId, agentId, () => db.select(profileCatalogColumns).from(toolCatalogEntries)
      .where(and(eq(toolCatalogEntries.companyId, companyId), eq(toolCatalogEntries.status, "active")))
      .orderBy(asc(toolCatalogEntries.toolName)));
    return {
      agentId,
      entries: state.entries.map(toProfileEntry),
      bindings: state.bindings.map(toProfileBinding),
      allowedTools: state.catalog.filter((entry) => state.allowedCatalogIds.has(entry.id))
        .map(({ id, applicationId, connectionId, toolName }) => ({ id, applicationId, connectionId, toolName })),
      allowedToolNames: state.allowedToolNames,
      installedConnections: state.installedConnections,
    };
  }
  async function getConnectionAssignmentsForAgent(companyId: string, agentId: string, connectionIds: string[]) {
    const { activeProfiles } = await readEffectiveProfileState(companyId, agentId);
    if (activeProfiles.length === 0 || connectionIds.length === 0) {
      return { allowedConnectionIds: [], installedConnections: await resolveInstalledConnectionsForAgent(companyId, agentId) };
    }
    const catalog = await db.select({
      id: toolCatalogEntries.id,
      applicationId: toolCatalogEntries.applicationId,
      connectionId: toolCatalogEntries.connectionId,
      toolName: toolCatalogEntries.toolName,
      riskLevel: toolCatalogEntries.riskLevel,
    }).from(toolCatalogEntries).where(and(
      eq(toolCatalogEntries.companyId, companyId), eq(toolCatalogEntries.status, "active"), inArray(toolCatalogEntries.connectionId, connectionIds),
    ));
    const entries = catalog.length === 0 ? [] : await db.select({
      profileId: toolProfileEntries.profileId,
      effect: toolProfileEntries.effect,
      selectorType: toolProfileEntries.selectorType,
      applicationId: toolProfileEntries.applicationId,
      connectionId: toolProfileEntries.connectionId,
      catalogEntryId: toolProfileEntries.catalogEntryId,
      toolName: toolProfileEntries.toolName,
      riskLevel: toolProfileEntries.riskLevel,
    }).from(toolProfileEntries).where(and(
      eq(toolProfileEntries.companyId, companyId), inArray(toolProfileEntries.profileId, activeProfiles.map(profile => profile.id)),
      or(
        and(eq(toolProfileEntries.selectorType, "application"), catalogValuesContain(toolProfileEntries.applicationId, catalog.map(entry => entry.applicationId))),
        and(eq(toolProfileEntries.selectorType, "connection"), catalogValuesContain(toolProfileEntries.connectionId, catalog.map(entry => entry.connectionId))),
        and(eq(toolProfileEntries.selectorType, "catalog_entry"), catalogValuesContain(toolProfileEntries.catalogEntryId, catalog.map(entry => entry.id))),
        and(eq(toolProfileEntries.selectorType, "tool_name"), catalogValuesContain(toolProfileEntries.toolName, catalog.map(entry => entry.toolName))),
        and(eq(toolProfileEntries.selectorType, "risk_level"), catalogValuesContain(toolProfileEntries.riskLevel, catalog.map(entry => entry.riskLevel))),
      ),
    ));
    const { allowedCatalogIds } = resolveCatalogAccess(activeProfiles, entries, catalog);
    return {
      allowedConnectionIds: [...new Set(catalog.filter(entry => allowedCatalogIds.has(entry.id)).map(entry => entry.connectionId))],
      installedConnections: await resolveInstalledConnectionsForAgent(companyId, agentId),
    };
  }

  return {
    getConnectionAssignmentsForAgent,
    getEffectiveProfilesForAgent,
    getEffectiveToolAssignmentsForAgent,
  };
}
