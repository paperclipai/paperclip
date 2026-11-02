import { toolApplications, toolCatalogEntries, toolConnections, toolProfileBindings, toolProfileEntries, toolProfiles } from "@paperclipai/db";
import type { ToolProfile, ToolProfileBinding, ToolProfileEntry, ToolProfileNewToolReviewItem, ToolProfileSummary, ToolProfileWithDetails } from "@paperclipai/shared";

export function toProfile(row: typeof toolProfiles.$inferSelect): ToolProfile {
  return {
    id: row.id,
    companyId: row.companyId,
    profileKey: row.profileKey,
    name: row.name,
    description: row.description,
    status: row.status,
    defaultAction: row.defaultAction,
    newToolsReviewedAt: row.newToolsReviewedAt,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toProfileEntry(
  row: typeof toolProfileEntries.$inferSelect,
): ToolProfileEntry {
  return {
    id: row.id,
    companyId: row.companyId,
    profileId: row.profileId,
    selectorType: row.selectorType,
    effect: row.effect,
    applicationId: row.applicationId,
    connectionId: row.connectionId,
    catalogEntryId: row.catalogEntryId,
    toolName: row.toolName,
    riskLevel: row.riskLevel,
    conditions: row.conditions ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toProfileBinding(
  row: typeof toolProfileBindings.$inferSelect,
): ToolProfileBinding {
  return {
    id: row.id,
    companyId: row.companyId,
    profileId: row.profileId,
    targetType: row.targetType,
    targetId: row.targetId,
    priority: row.priority,
    metadata: row.metadata ?? null,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Profile summaries and new-tool counts exclude schemas, annotations, and
// provider metadata from these repeated reads.
export const profileCatalogColumns = {
  id: toolCatalogEntries.id,
  applicationId: toolCatalogEntries.applicationId,
  connectionId: toolCatalogEntries.connectionId,
  toolName: toolCatalogEntries.toolName,
  riskLevel: toolCatalogEntries.riskLevel,
  status: toolCatalogEntries.status,
  firstSeenAt: toolCatalogEntries.firstSeenAt,
};

export const profileReviewCatalogColumns = {
  ...profileCatalogColumns,
  title: toolCatalogEntries.title,
  description: toolCatalogEntries.description,
};

export type ProfileCatalogEntry = Pick<typeof toolCatalogEntries.$inferSelect, keyof typeof profileCatalogColumns>
  & Partial<Pick<typeof toolCatalogEntries.$inferSelect, "title" | "description">>;

export type ProfileApplication = Pick<typeof toolApplications.$inferSelect, "id" | "name">;

export type ProfileConnection = Pick<typeof toolConnections.$inferSelect, "id" | "name">;

export type ProfileEntryMatch = Pick<typeof toolProfileEntries.$inferSelect,
  "selectorType" | "applicationId" | "connectionId" | "catalogEntryId" | "toolName" | "riskLevel">;

export type ProfileCatalogMatch = Pick<typeof toolCatalogEntries.$inferSelect,
  "id" | "applicationId" | "connectionId" | "toolName" | "riskLevel">;

export function profileEntryMatchesCatalog(
  entry: ProfileEntryMatch,
  catalogEntry: ProfileCatalogMatch,
): boolean {
  if (entry.selectorType === "application")
    return entry.applicationId === catalogEntry.applicationId;
  if (entry.selectorType === "connection")
    return entry.connectionId === catalogEntry.connectionId;
  if (entry.selectorType === "catalog_entry")
    return entry.catalogEntryId === catalogEntry.id;
  if (entry.selectorType === "tool_name")
    return entry.toolName === catalogEntry.toolName;
  if (entry.selectorType === "risk_level")
    return entry.riskLevel === catalogEntry.riskLevel;
  return false;
}

export function profileCatalogMatcher(entries: ProfileEntryMatch[]) {
  const applications = new Set<string | null>();
  const connections = new Set<string | null>();
  const catalogIds = new Set<string | null>();
  const toolNames = new Set<string | null>();
  const risks = new Set<string | null>();
  for (const entry of entries) {
    if (entry.selectorType === "application") applications.add(entry.applicationId);
    else if (entry.selectorType === "connection") connections.add(entry.connectionId);
    else if (entry.selectorType === "catalog_entry") catalogIds.add(entry.catalogEntryId);
    else if (entry.selectorType === "tool_name") toolNames.add(entry.toolName);
    else if (entry.selectorType === "risk_level") risks.add(entry.riskLevel);
  }
  return (entry: ProfileCatalogMatch) => applications.has(entry.applicationId)
    || connections.has(entry.connectionId) || catalogIds.has(entry.id)
    || toolNames.has(entry.toolName) || risks.has(entry.riskLevel);
}

export function summarizeProfile(input: {
  profile: typeof toolProfiles.$inferSelect;
  entries: Array<typeof toolProfileEntries.$inferSelect>;
  bindings: Array<typeof toolProfileBindings.$inferSelect>;
  catalog: ProfileCatalogEntry[];
  agentIds: string[];
}): ToolProfileSummary {
  const included = profileCatalogMatcher(input.entries.filter((entry) => entry.effect === "include"));
  const excluded = profileCatalogMatcher(input.entries.filter((entry) => entry.effect === "exclude"));
  const allowedCatalogIds = new Set<string>();
  const allowedApplicationIds = new Set<string>();
  const excludedCatalogIds = new Set<string>();

  for (const catalogEntry of input.catalog) {
    if (excluded(catalogEntry)) {
      excludedCatalogIds.add(catalogEntry.id);
      continue;
    }
    if (input.profile.defaultAction === "allow" || included(catalogEntry)) {
      allowedCatalogIds.add(catalogEntry.id);
      if (catalogEntry.applicationId)
        allowedApplicationIds.add(catalogEntry.applicationId);
    }
  }

  const isCompanyDefault = input.bindings.some(
    (binding) =>
      binding.targetType === "company" &&
      binding.targetId === input.profile.companyId,
  );
  const appliesToAgents = new Set<string>();
  if (isCompanyDefault) {
    for (const agentId of input.agentIds) appliesToAgents.add(agentId);
  } else {
    const companyAgentIds = new Set(input.agentIds);
    for (const binding of input.bindings) {
      if (
        binding.targetType === "agent" &&
        companyAgentIds.has(binding.targetId)
      ) {
        appliesToAgents.add(binding.targetId);
      }
    }
  }

  return {
    accessMode:
      input.profile.defaultAction === "allow" ? "all_except" : "selected",
    allowedToolCount: allowedCatalogIds.size,
    allowedApplicationCount: allowedApplicationIds.size,
    excludedToolCount: excludedCatalogIds.size,
    totalToolCount: input.catalog.length,
    assignmentCount: input.bindings.length,
    appliesToAgentCount: appliesToAgents.size,
    isCompanyDefault,
  };
}

export function profileCoversCatalogScope(input: {
  entry: typeof toolProfileEntries.$inferSelect;
  catalogEntry: ProfileCatalogEntry;
  catalogById: Map<string, ProfileCatalogEntry>;
}): boolean {
  if (input.entry.effect !== "include") return false;
  if (input.entry.selectorType === "application")
    return input.entry.applicationId === input.catalogEntry.applicationId;
  if (input.entry.selectorType === "connection")
    return input.entry.connectionId === input.catalogEntry.connectionId;
  if (
    input.entry.selectorType !== "catalog_entry" ||
    !input.entry.catalogEntryId
  )
    return false;
  const scopedEntry = input.catalogById.get(input.entry.catalogEntryId);
  if (!scopedEntry) return false;
  if (scopedEntry.connectionId === input.catalogEntry.connectionId) return true;
  return Boolean(
    scopedEntry.applicationId &&
    scopedEntry.applicationId === input.catalogEntry.applicationId,
  );
}

export function pendingNewToolsForProfile(input: {
  profile: typeof toolProfiles.$inferSelect;
  entries: Array<typeof toolProfileEntries.$inferSelect>;
  catalog: ProfileCatalogEntry[];
  applicationsById?: Map<string, ProfileApplication>;
  connectionsById?: Map<string, ProfileConnection>;
}): ToolProfileNewToolReviewItem[] {
  if (
    input.profile.status !== "active" ||
    input.profile.defaultAction !== "deny"
  )
    return [];
  const watermark = input.profile.newToolsReviewedAt ?? input.profile.createdAt;
  const catalogById = new Map(input.catalog.map((entry) => [entry.id, entry]));
  const coveredApplications = new Set<string | null>();
  const coveredConnections = new Set<string | null>();
  for (const entry of input.entries) {
    if (entry.effect !== "include") continue;
    if (entry.selectorType === "application") coveredApplications.add(entry.applicationId);
    else if (entry.selectorType === "connection") coveredConnections.add(entry.connectionId);
    else if (entry.selectorType === "catalog_entry" && entry.catalogEntryId) {
      const scopedEntry = catalogById.get(entry.catalogEntryId);
      if (!scopedEntry) continue;
      coveredConnections.add(scopedEntry.connectionId);
      if (scopedEntry.applicationId) coveredApplications.add(scopedEntry.applicationId);
    }
  }
  if (coveredApplications.size === 0 && coveredConnections.size === 0) return [];
  const explicitlyReviewed = profileCatalogMatcher(input.entries);

  return input.catalog
    .filter((catalogEntry) =>
      (catalogEntry.status === "active" || catalogEntry.status === "quarantined")
      && catalogEntry.firstSeenAt > watermark
      && (coveredApplications.has(catalogEntry.applicationId) || coveredConnections.has(catalogEntry.connectionId))
      && !explicitlyReviewed(catalogEntry),
    )
    .map((catalogEntry) => ({
      catalogEntryId: catalogEntry.id,
      applicationId: catalogEntry.applicationId,
      applicationName: catalogEntry.applicationId
        ? (input.applicationsById?.get(catalogEntry.applicationId)?.name ??
          null)
        : null,
      connectionId: catalogEntry.connectionId,
      connectionName:
        input.connectionsById?.get(catalogEntry.connectionId)?.name ?? null,
      toolName: catalogEntry.toolName,
      title: catalogEntry.title ?? null,
      description: catalogEntry.description ?? null,
      capability: catalogEntry.riskLevel,
      riskLevel: catalogEntry.riskLevel,
      addedAt: catalogEntry.firstSeenAt,
      firstSeenAt: catalogEntry.firstSeenAt,
    }));
}

export function buildProfileDetails(input: {
  profile: typeof toolProfiles.$inferSelect;
  entries: Array<typeof toolProfileEntries.$inferSelect>;
  bindings: Array<typeof toolProfileBindings.$inferSelect>;
  catalog: ProfileCatalogEntry[];
  agentIds: string[];
  applicationsById?: Map<string, ProfileApplication>;
  connectionsById?: Map<string, ProfileConnection>;
}): ToolProfileWithDetails {
  const pendingNewTools = pendingNewToolsForProfile({
    profile: input.profile,
    entries: input.entries,
    catalog: input.catalog,
    applicationsById: input.applicationsById,
    connectionsById: input.connectionsById,
  });
  return {
    ...toProfile(input.profile),
    newToolsPendingCount: pendingNewTools.length,
    entries: input.entries.map(toProfileEntry),
    bindings: input.bindings.map(toProfileBinding),
    summary: summarizeProfile(input),
  };
}
