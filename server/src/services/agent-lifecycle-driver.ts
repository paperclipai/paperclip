import { and, eq, inArray } from "drizzle-orm";
import { agents, plugins, pluginCompanySettings, type Db } from "@paperclipai/db";
import { heartbeatService } from "./heartbeat.js";
import { listInvalidOrgChainDescendantIds } from "./agent-invokability.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { LifecycleDriver } from "../modules/agent-lifecycle/index.js";
import { agentHarnessVerificationService } from "./agent-harness-verification.js";

export function createLifecycleDriver(db: Db, manager: PluginWorkerManager): LifecycleDriver {
  const { verify } = agentHarnessVerificationService(db, manager);
  const heartbeat = heartbeatService(db, { pluginWorkerManager: manager });
  return {
    async requiredPluginIds(agent) {
      if (agent.lifecycleRequiredPluginIds !== null) return agent.lifecycleRequiredPluginIds;
      const installed = await db.select().from(plugins).where(inArray(plugins.status, ["ready", "error", "installed", "upgrade_pending"]));
      const disabled = await db.select({ pluginId: pluginCompanySettings.pluginId }).from(pluginCompanySettings)
        .where(and(eq(pluginCompanySettings.companyId, agent.companyId), eq(pluginCompanySettings.enabled, false)));
      return installed.filter(plugin => !disabled.some(row => row.pluginId === plugin.id) &&
        plugin.manifestJson.agentLifecycle && plugin.manifestJson.capabilities.includes("agents.lifecycle.manage")).map(plugin => plugin.id);
    },
    async runPlugin(agent, pluginId) {
      const [plugin] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
      const [settings] = await db.select().from(pluginCompanySettings).where(and(
        eq(pluginCompanySettings.pluginId, pluginId), eq(pluginCompanySettings.companyId, agent.companyId)));
      if (settings?.enabled === false || !plugin || plugin.status !== "ready" || !plugin.manifestJson.agentLifecycle || !plugin.manifestJson.capabilities.includes("agents.lifecycle.manage")) {
        throw Object.assign(new Error("A required lifecycle plugin is unavailable"), { code: "required_plugin_unavailable" });
      }
      const operationId = agent.lifecycleOperation!.id;
      const result = await manager.call(plugin.id, "agentLifecycle", { companyId: agent.companyId,
        agentId: agent.id, operationId, version: agent.lifecycleVersion, phase: agent.lifecycleState }, 30_000);
      if (!result || result.operationId !== operationId || result.version !== agent.lifecycleVersion || !["complete", "pending"].includes(result.status)) {
        throw Object.assign(new Error("Invalid lifecycle result"), { code: "invalid_lifecycle_result" });
      }
      return result.status;
    },
    async runHost(agent) {
      if (agent.lifecycleState === "verifying") return verify(agent);
      if (["pausing", "terminating", "cleaning_up"].includes(agent.lifecycleState)) {
        const companyAgents = await db.select().from(agents).where(eq(agents.companyId, agent.companyId));
        const ids = agent.lifecycleState === "pausing" ? [agent.id]
          : [agent.id, ...listInvalidOrgChainDescendantIds(agent.id, companyAgents)];
        if (!await heartbeat.stopInvocationsForAgents(ids, "Agent lifecycle stop requested")) return "pending";
      }
      return "complete";
    },
  };
}
