import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, toolApplications, toolCatalogEntries, toolConnections, toolPolicies, toolProfiles } from "@paperclipai/db";
import type { CreateToolProfileEntryForProfile } from "@paperclipai/shared";
import type { ToolAccessMutationDb } from "./types.js";
export async function lockManagedAppPolicies(client: ToolAccessMutationDb, companyId: string, connectionId: string) {
  await client.select({ id: toolPolicies.id }).from(toolPolicies).where(and(
    eq(toolPolicies.companyId, companyId), eq(toolPolicies.policyType, "require_approval"),
    sql`${toolPolicies.config}->>'source' = 'app_gallery_finish'`,
    sql`${toolPolicies.config}->>'connectionId' = ${connectionId}`,
  )).orderBy(toolPolicies.id).for("no key update");
}

export async function lockToolAssignmentAgents(client: ToolAccessMutationDb, companyId: string, targets: ReadonlyArray<{ targetType: string; targetId: string }>) {
  const allAgents = targets.some(target => target.targetType === "company" && target.targetId === companyId);
  const ids = targets.filter(target => target.targetType === "agent").map(target => target.targetId);
  if (!allAgents && !ids.length) return;
  await client.select({ id: agents.id }).from(agents)
    .where(and(eq(agents.companyId, companyId), sql`${agents.status} NOT IN ('pending_approval', 'terminated')`,
      allAgents ? undefined : inArray(agents.id, ids)))
    .orderBy(agents.id).for("no key update");
}

export async function lockToolConnectionRuntimeInputs(client: ToolAccessMutationDb, companyId: string, connectionId: string) {
  await client.select({ id: toolApplications.id }).from(toolApplications)
    .innerJoin(toolConnections, and(eq(toolConnections.applicationId, toolApplications.id), eq(toolConnections.companyId, toolApplications.companyId)))
    .where(and(eq(toolConnections.id, connectionId), eq(toolConnections.companyId, companyId)))
    .for("update", { of: toolApplications });
  await client.select({ id: toolConnections.id }).from(toolConnections)
    .where(and(eq(toolConnections.id, connectionId), eq(toolConnections.companyId, companyId))).for("update");
  await client.select({ id: toolProfiles.id }).from(toolProfiles)
    .where(and(eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, `app:${connectionId}`)))
    .for("no key update");
  await lockManagedAppPolicies(client, companyId, connectionId);
}

export async function lockProfileEntryReferences(client: ToolAccessMutationDb, companyId: string, entries: Pick<CreateToolProfileEntryForProfile, "applicationId" | "connectionId" | "catalogEntryId">[]) {
  const applicationIds = [...new Set(entries.flatMap(entry => entry.applicationId ? [entry.applicationId] : []))];
  const connectionIds = [...new Set(entries.flatMap(entry => entry.connectionId ? [entry.connectionId] : []))];
  const catalogIds = [...new Set(entries.flatMap(entry => entry.catalogEntryId ? [entry.catalogEntryId] : []))];
  if (applicationIds.length) await client.select({ id: toolApplications.id }).from(toolApplications)
    .where(and(eq(toolApplications.companyId, companyId), inArray(toolApplications.id, applicationIds))).orderBy(toolApplications.id).for("key share");
  if (connectionIds.length) await client.select({ id: toolConnections.id }).from(toolConnections)
    .where(and(eq(toolConnections.companyId, companyId), inArray(toolConnections.id, connectionIds))).orderBy(toolConnections.id).for("key share");
  if (catalogIds.length) await client.select({ id: toolCatalogEntries.id }).from(toolCatalogEntries)
    .where(and(eq(toolCatalogEntries.companyId, companyId), inArray(toolCatalogEntries.id, catalogIds))).orderBy(toolCatalogEntries.id).for("key share");
}
