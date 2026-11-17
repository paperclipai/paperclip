import { and, eq, inArray, or, sql } from "drizzle-orm";
import { companySkills, pluginCompanySettings, pluginManagedResources, plugins, type Db } from "@paperclipai/db";
import { readPaperclipSkillSyncPreference, resolvePaperclipDesiredSkillNames, writePaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { unprocessable } from "../errors.js";
import { buildSkillRuntimeName } from "./company-skills.js";
import { pluginManagedSkillService } from "./plugin-managed-skills.js";

/** Environment capabilities join the normal authorized, versioned skill selection. */
export async function environmentSkillConfig(db: Db, companyId: string,
  environment: { driver: string; config: Record<string, unknown> | null } | null | undefined,
  config: Record<string, unknown>, installMissing = true): Promise<{ config: Record<string, unknown>; skillKeys: string[]; shadowedSkills?: Array<{ key: string; shadowedBy: string }> }> {
  if (environment?.driver !== "plugin") return { config, skillKeys: [] };
  const { pluginKey, driverKey } = environment.config ?? {};
  if (typeof pluginKey !== "string" || typeof driverKey !== "string") return { config, skillKeys: [] };
  const [plugin] = await db.select().from(plugins).where(eq(plugins.pluginKey, pluginKey));
  const keys = plugin?.manifestJson.environmentDrivers?.find(driver => driver.driverKey === driverKey)?.skillKeys ?? [];
  if (!plugin || !keys.length) return { config, skillKeys: [] };
  const [settings] = await db.select().from(pluginCompanySettings).where(and(
    eq(pluginCompanySettings.companyId, companyId), eq(pluginCompanySettings.pluginId, plugin.id)));
  if (plugin.status !== "ready" || settings?.enabled === false || !plugin.manifestJson.capabilities.includes("skills.managed")) {
    throw unprocessable("Environment skills require an enabled plugin with skills.managed capability");
  }
  // Existing bindings need only a bounded metadata query, not a file-by-file drift scan.
  const installed = await db.select({ resourceKey: pluginManagedResources.resourceKey, key: companySkills.key })
    .from(pluginManagedResources).innerJoin(companySkills, and(
      eq(companySkills.id, pluginManagedResources.resourceId), eq(companySkills.companyId, companyId)))
    .where(and(eq(pluginManagedResources.companyId, companyId), eq(pluginManagedResources.pluginId, plugin.id),
      eq(pluginManagedResources.resourceKind, "skill"), inArray(pluginManagedResources.resourceKey, keys)));
  const selected = new Map(installed.map(skill => [skill.resourceKey, skill.key]));
  for (const key of keys) {
    if (selected.has(key) || !installMissing) continue;
    const result = await db.transaction(async tx => {
      // Serialize first installation across concurrent agents in this company.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`environment-skill:${companyId}:${plugin.id}:${key}`}, 0))`);
      return pluginManagedSkillService(tx as unknown as Db, { pluginId: plugin.id, pluginKey, manifest: plugin.manifestJson }).reconcile(key, companyId);
    });
    if (!result.skill) throw unprocessable("Environment skill is unavailable");
    selected.set(key, result.skill.key);
  }
  const preference = readPaperclipSkillSyncPreference(config);
  const explicit = new Set(preference.desiredSkillEntries.map(entry => entry.key));
  const skillKeys = keys.flatMap(key => selected.has(key) ? [selected.get(key)!] : []);
  const candidates = await db.select({ key: companySkills.key, slug: companySkills.slug, name: companySkills.name })
    .from(companySkills).where(and(eq(companySkills.companyId, companyId),
      or(inArray(sql<string>`lower(${companySkills.key})`, [...new Set([...explicit, ...skillKeys])].map(key => key.toLowerCase())),
        inArray(sql<string>`lower(${companySkills.slug})`, [...explicit].map(key => key.toLowerCase().split("/").at(-1)!.replace(/--[a-f0-9]{10}$/, ""))))));
  const names = candidates.map(skill => ({ key: skill.key, runtimeName: buildSkillRuntimeName(skill.key, skill.slug) }));
  const entries = preference.desiredSkillEntries.map(entry => ({ ...entry,
    key: resolvePaperclipDesiredSkillNames(writePaperclipSkillSyncPreference({}, [entry]), names)[0] ?? entry.key,
  }));
  const selectedKeys = new Set(entries.map(entry => entry.key));
  const required = candidates.filter(skill => skillKeys.includes(skill.key));
  const shadowedSkills = candidates.flatMap(skill => {
    if (skillKeys.includes(skill.key) || !selectedKeys.has(skill.key)) return [];
    const winner = required.find(candidate => candidate.slug === skill.slug || candidate.name === skill.name);
    return winner ? [{ key: skill.key, shadowedBy: winner.key }] : [];
  });
  const shadowed = new Set(shadowedSkills.map(skill => skill.key));
  return { config: writePaperclipSkillSyncPreference(config, [
    ...entries.filter(entry => !shadowed.has(entry.key)),
    ...skillKeys.filter(key => !selectedKeys.has(key))]), skillKeys,
    ...(shadowedSkills.length ? { shadowedSkills } : {}),
  };
}
