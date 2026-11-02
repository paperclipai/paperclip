import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { toolProfileBindings, toolProfileEntries, toolProfiles, type Db } from "@paperclipai/db";
import type { ToolProfileConfiguration } from "@paperclipai/shared";
import { toProfile, toProfileBinding, toProfileEntry } from "./projection.js";

type ProfileRow = typeof toolProfiles.$inferSelect;

/** Saved profiles shown by connection Permissions; this is not effective access. */
export function createConnectionProfileConfigurationReader(db: Db) {
  return async (
    companyId: string,
    connectionId: string,
    visibleProfiles: (profiles: ProfileRow[]) => Promise<ProfileRow[]>,
  ): Promise<ToolProfileConfiguration[]> => {
    const candidates = await db.select().from(toolProfiles).where(and(
      eq(toolProfiles.companyId, companyId),
      or(
        eq(toolProfiles.profileKey, `app:${connectionId}`),
        and(
          eq(toolProfiles.status, "active"),
          sql`${toolProfiles.metadata}->>'source' = 'connection_intent'`,
          sql`${toolProfiles.metadata}->>'connectionId' = ${connectionId}`,
          sql`jsonb_typeof(${toolProfiles.metadata}->'agentId') = 'string'`,
          sql`${toolProfiles.profileKey} = 'connection-intent:' || ${connectionId} || ':' || (${toolProfiles.metadata}->>'agentId')`,
          sql`exists (select 1 from ${toolProfileBindings} where
            ${toolProfileBindings.companyId} = ${toolProfiles.companyId}
            and ${toolProfileBindings.profileId} = ${toolProfiles.id}
            and ${toolProfileBindings.targetType} = 'agent'
            and ${toolProfileBindings.targetId} = ${toolProfiles.metadata}->>'agentId')`,
        ),
      ),
    )).orderBy(desc(toolProfiles.updatedAt));
    // Preserve the full-list route's per-profile current-authority checks before
    // loading configuration. Connection access alone does not grant profile access.
    const profiles = await visibleProfiles(candidates);
    if (profiles.length === 0) return [];
    const ids = profiles.map(profile => profile.id);
    const [entries, bindings] = await Promise.all([
      db.select().from(toolProfileEntries).where(and(
        eq(toolProfileEntries.companyId, companyId), inArray(toolProfileEntries.profileId, ids),
      )).orderBy(asc(toolProfileEntries.createdAt), asc(toolProfileEntries.id)),
      db.select().from(toolProfileBindings).where(and(
        eq(toolProfileBindings.companyId, companyId), inArray(toolProfileBindings.profileId, ids),
      )).orderBy(asc(toolProfileBindings.priority), asc(toolProfileBindings.createdAt)),
    ]);
    const entriesByProfile = new Map<string, ToolProfileConfiguration["entries"]>();
    const bindingsByProfile = new Map<string, ToolProfileConfiguration["bindings"]>();
    for (const entry of entries) {
      const group = entriesByProfile.get(entry.profileId) ?? [];
      group.push(toProfileEntry(entry));
      entriesByProfile.set(entry.profileId, group);
    }
    for (const binding of bindings) {
      const group = bindingsByProfile.get(binding.profileId) ?? [];
      group.push(toProfileBinding(binding));
      bindingsByProfile.set(binding.profileId, group);
    }
    return profiles.map(profile => ({
      ...toProfile(profile),
      entries: entriesByProfile.get(profile.id) ?? [],
      bindings: bindingsByProfile.get(profile.id) ?? [],
    }));
  };
}
