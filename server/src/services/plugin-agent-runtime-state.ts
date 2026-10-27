import { and, desc, eq } from "drizzle-orm";
import { agents, environments, plugins, pluginCompanySettings, resourceLifecycleEvents, type Db } from "@paperclipai/db";
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

async function readState(db: Db, pluginId: string, companyId: string, agentId: string, identityOnly: true): Promise<PluginAgentRuntimeIdentity | null>;
async function readState(db: Db, pluginId: string, companyId: string, agentId: string, identityOnly?: false): Promise<Omit<PluginAgentRuntimeState, "skills" | "connectionAssignments"> | null>;
async function readState(db: Db, pluginId: string, companyId: string, agentId: string, identityOnly = false): Promise<PluginAgentRuntimeIdentity | Omit<PluginAgentRuntimeState, "skills" | "connectionAssignments"> | null> {
  return db.transaction(async tx => {
    const [agent] = await tx.select().from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId))).for("share");
    if (!agent) return null;
    const [plugin] = await tx.select().from(plugins).where(eq(plugins.id, pluginId));
    const [settings] = await tx.select().from(pluginCompanySettings).where(and(eq(pluginCompanySettings.companyId, companyId), eq(pluginCompanySettings.pluginId, pluginId)));
    if (plugin?.status !== "ready" || settings?.enabled === false || !plugin?.manifestJson.capabilities?.includes("agents.lifecycle.manage")
      || !plugin.manifestJson.resourceLifecycle?.includes("agent_runtime") || !agent.lifecycleRequiredPluginIds?.includes(pluginId)) {
      throw forbidden("Agent runtime state requires the owning lifecycle plugin");
    }
    const [latest] = await tx.select({ id: resourceLifecycleEvents.id }).from(resourceLifecycleEvents)
      .where(and(eq(resourceLifecycleEvents.companyId, companyId), eq(resourceLifecycleEvents.resourceType, "agent_runtime"), eq(resourceLifecycleEvents.resourceId, agentId)))
      .orderBy(desc(resourceLifecycleEvents.id)).limit(1);
    if (identityOnly) return {
      revision: String(latest?.id ?? 0),
      agent: { id: agent.id, companyId: agent.companyId, status: agent.status as PluginAgentRuntimeIdentity["agent"]["status"],
        lifecycleState: agent.lifecycleState, lifecycleVersion: agent.lifecycleVersion },
      instanceSecrets: await agentInstanceSecretService(tx as unknown as Db).read({ companyId, agentId, pluginId }),
    };
    const instructions = await agentInstructionsService().getBundleLocation(agent);
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
  return readState(db, pluginId, companyId, agentId, true);
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
    const fallback = !state.instructionsRootPath ? await agentInstructionsService().exportFiles(state.agent, { rejectSymlinks: true }) : null;
    const entryFile = fallback?.entryFile ?? state.instructionsEntryFile;
    const entryContent = fallback?.files[entryFile];
    const current = await readState(db, pluginId, companyId, agentId);
    if (!current) return null;
    if (current.revision === state.revision) return { ...current, instructionsEntryFile: entryFile, ...(entryContent === undefined ? {} : { instructionsEntryContent: entryContent }), skills, connectionAssignments, ...(shadowedSkills?.length ? { shadowedSkills } : {}) };
  }
  throw conflict("Agent runtime changed while resolving synchronization inputs; retry");
}
