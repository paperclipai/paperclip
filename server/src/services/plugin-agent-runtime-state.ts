import { and, desc, eq, sql } from "drizzle-orm";
import { agents, environments, plugins, pluginCompanySettings, resourceLifecycleEvents, fileStorageDb, type Db } from "@paperclipai/db";
import type { PluginAgentRuntimeState, PluginAgentRuntimeIdentity } from "@paperclipai/plugin-sdk";
import { agentRecordQueries } from "../lib/agent-records.js";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { pluginAgentConnectionAssignments } from "./plugin-agent-connections.js";
import { companySkillService } from "./company-skills.js";
import { withSkillActor } from "./skill-access.js";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { skillVersionSelectionMap } from "./runtime-skill-selections.js";
import { instanceSettingsService } from "./instance-settings.js";
import { agentInstanceSecretService } from "./agent-instance-secrets.js";
import { environmentSkillConfig } from "./environment-skills.js";

function assertOwningLifecyclePlugin(plugin: Pick<typeof plugins.$inferSelect, "status" | "manifestJson"> | null | undefined,
  settings: Pick<typeof pluginCompanySettings.$inferSelect, "enabled"> | null | undefined, requiredPluginIds: string[] | null | undefined, pluginId: string) {
  if (plugin?.status !== "ready" || settings?.enabled === false || !plugin?.manifestJson.capabilities?.includes("agents.lifecycle.manage")
    || !plugin.manifestJson.resourceLifecycle?.includes("agent_runtime") || !requiredPluginIds?.includes(pluginId)) {
    throw forbidden("Agent runtime state requires the owning lifecycle plugin");
  }
}

async function readState(db: Db, pluginId: string, companyId: string, agentId: string): Promise<Omit<PluginAgentRuntimeState, "skills" | "connectionAssignments"> | null> {
  return fileStorageDb(db).transaction(async tx => {
    const [agent] = await tx.select().from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId))).for("update");
    if (!agent) return null;
    const [plugin] = await tx.select().from(plugins).where(eq(plugins.id, pluginId));
    const [settings] = await tx.select().from(pluginCompanySettings).where(and(eq(pluginCompanySettings.companyId, companyId), eq(pluginCompanySettings.pluginId, pluginId)));
    assertOwningLifecyclePlugin(plugin, settings, agent.lifecycleRequiredPluginIds, pluginId);
    const [latest] = await tx.select({ id: resourceLifecycleEvents.id }).from(resourceLifecycleEvents)
      .where(and(eq(resourceLifecycleEvents.companyId, companyId), eq(resourceLifecycleEvents.resourceType, "agent_runtime"), eq(resourceLifecycleEvents.resourceId, agentId)))
      .orderBy(desc(resourceLifecycleEvents.id)).limit(1);
    const instructions = await agentInstructionsService(tx as unknown as Db).getBundleLocation(agent);
    const records = agentRecordQueries(tx as unknown as Db);
    const companyAgents = await records.listCompanyAgentEligibilityRows(companyId);
    return {
      revision: String(latest?.id ?? 0), agent: records.normalizeAgentRow(agent, companyAgents) as PluginAgentRuntimeState["agent"],
      instructionsRootPath: instructions.rootPath, instructionsEntryFile: instructions.entryFile,
      instanceSecrets: await agentInstanceSecretService(tx as unknown as Db).read({ companyId, agentId, pluginId }),
    };
  });
}

export async function pluginAgentRuntimeIdentity(db: Db, pluginId: string, companyId: string, agentId: string): Promise<PluginAgentRuntimeIdentity | null> {
  const [row] = await db.select({
    id: agents.id, companyId: agents.companyId, status: agents.status, lifecycleState: agents.lifecycleState,
    lifecycleVersion: agents.lifecycleVersion, requiredPluginIds: agents.lifecycleRequiredPluginIds,
    plugin: { status: plugins.status, manifestJson: plugins.manifestJson }, settings: { enabled: pluginCompanySettings.enabled },
    revision: sql`(${db.select({ id: resourceLifecycleEvents.id }).from(resourceLifecycleEvents)
      .where(and(eq(resourceLifecycleEvents.companyId, companyId), eq(resourceLifecycleEvents.resourceType, "agent_runtime"), eq(resourceLifecycleEvents.resourceId, agentId)))
      .orderBy(desc(resourceLifecycleEvents.id)).limit(1)})`.mapWith(resourceLifecycleEvents.id),
  }).from(agents)
    .leftJoin(plugins, eq(plugins.id, pluginId))
    .leftJoin(pluginCompanySettings, and(eq(pluginCompanySettings.companyId, companyId), eq(pluginCompanySettings.pluginId, pluginId)))
    .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
  if (!row) return null;
  assertOwningLifecyclePlugin(row.plugin, row.settings, row.requiredPluginIds, pluginId);
  return {
    revision: String(row.revision ?? 0),
    agent: { id: row.id, companyId: row.companyId, status: row.status as PluginAgentRuntimeIdentity["agent"]["status"],
      lifecycleState: row.lifecycleState, lifecycleVersion: row.lifecycleVersion },
    instanceSecrets: await agentInstanceSecretService(db).read({ companyId, agentId, pluginId }),
  };
}

export async function pluginAgentRuntimeState(db: Db, pluginId: string, companyId: string, agentId: string, environmentId?: string, installEnvironmentSkills = false): Promise<PluginAgentRuntimeState | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await readState(db, pluginId, companyId, agentId);
    if (!state) return null;
    const instance = await instanceSettingsService(db).get();
    const effectiveEnvironmentId = environmentId ?? state.agent.defaultEnvironmentId ?? instance.defaultEnvironmentId;
    const [environment] = effectiveEnvironmentId
      ? await db.select().from(environments).where(eq(environments.id, effectiveEnvironmentId)) : [];
    if (environmentId && !environment) throw unprocessable("The selected environment is unavailable");
    const { config: selectionConfig, skillKeys: environmentSkills, shadowedSkills } = await environmentSkillConfig(db, companyId, environment, state.agent.adapterConfig, installEnvironmentSkills);
    const preference = readPaperclipSkillSyncPreference(selectionConfig);
    const settings = instance.experimental;
    const skills = await withSkillActor({ type: "agent", agentId, companyId, source: "agent_key" }, () =>
      companySkillService(db).listRuntimeSkillEntries(companyId, {
        selectionConfig, includeLegacy: state.agent.adapterType !== "paperclip_runner", snapshotLatest: true,
        versionSelections: skillVersionSelectionMap(preference.desiredSkillEntries, { versionPinsEnabled: settings.enableBetaSkills }),
      }));
    if (environmentSkills.some(key => !skills.some(skill => skill.key === key && skill.sourceStatus !== "missing"))) {
      throw unprocessable("An environment skill is unavailable to this agent");
    }
    const connectionAssignments = await pluginAgentConnectionAssignments(db, companyId, agentId, { publicMcp: settings.enablePublicMcp, chatConnectors: settings.enableChatConnectors });
    const fallback = !state.instructionsRootPath ? await agentInstructionsService(db).exportFiles(state.agent, { rejectSymlinks: true }) : null;
    const entryFile = fallback?.entryFile ?? state.instructionsEntryFile;
    const entryContent = fallback?.files[entryFile];
    const current = await readState(db, pluginId, companyId, agentId);
    if (!current) return null;
    if (current.revision === state.revision) return { ...current, instructionsEntryFile: entryFile, ...(entryContent === undefined ? {} : { instructionsEntryContent: entryContent }), skills, connectionAssignments, ...(shadowedSkills?.length ? { shadowedSkills } : {}) };
  }
  throw conflict("Agent runtime changed while resolving synchronization inputs; retry");
}
