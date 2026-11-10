import { and, eq, inArray, sql } from "drizzle-orm";
import { CANCELLABLE_HEARTBEAT_RUN_STATUSES } from "./heartbeat/recovery.js";
import { promoteDeferredWorkIntents } from "./work-intent-outbox.js";
import { agents, companies, environments, heartbeatRuns, plugins, pluginCompanySettings, type Db } from "@paperclipai/db";
import { instanceSettingsService } from "./instance-settings.js";
import { pluginHasAgentEnvironments, pluginServesAgentEnvironment } from "./plugin-environment-driver.js";
import { heartbeatService } from "./heartbeat.js";
import { listInvalidOrgChainDescendantIds } from "./agent-invokability.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { LifecycleDriver } from "../modules/agent-lifecycle/index.js";
import { agentHarnessVerificationService } from "./agent-harness-verification.js";
import { agentInstanceSecretService } from "./agent-instance-secrets.js";

export function createLifecycleDriver(db: Db, manager: PluginWorkerManager): LifecycleDriver {
  const { verify } = agentHarnessVerificationService(db, manager);
  const heartbeat = heartbeatService(db, { pluginWorkerManager: manager });
  return {
    async onReady(agent) {
      await db.transaction(tx => promoteDeferredWorkIntents(tx, { companyId: agent.companyId, trigger: "pause_lifted" }));
      await heartbeat.resumeQueuedRunsForAgent(agent.companyId, agent.id);
    },
    async requiredPluginIds(agent) {
      const selected = agent.lifecycleRequiredPluginIds;
      const installed = await db.select().from(plugins).where(inArray(plugins.status, ["ready", "error", "installed", "upgrade_pending"]));
      const disabled = await db.select({ pluginId: pluginCompanySettings.pluginId }).from(pluginCompanySettings)
        .where(and(eq(pluginCompanySettings.companyId, agent.companyId), eq(pluginCompanySettings.enabled, false)));
      const candidates = installed.filter(plugin => !disabled.some(row => row.pluginId === plugin.id) &&
        plugin.manifestJson.agentLifecycle && plugin.manifestJson.capabilities.includes("agents.lifecycle.manage"));
      const [row] = await db.select({ environmentId: agents.defaultEnvironmentId }).from(agents).where(eq(agents.id, agent.id));
      const environmentId = row?.environmentId ?? (await instanceSettingsService(db).get()).defaultEnvironmentId;
      const [environment] = environmentId ? await db.select().from(environments).where(eq(environments.id, environmentId)) : [];
      if (selected !== null) {
        const added = candidates.filter(plugin => pluginServesAgentEnvironment(plugin, environment) && !selected.includes(plugin.id));
        return [...selected, ...added.map(plugin => plugin.id)];
      }
      return candidates.filter(plugin => !pluginHasAgentEnvironments(plugin) || pluginServesAgentEnvironment(plugin, environment)).map(plugin => plugin.id);
    },
    async runPlugin(agent, pluginId) {
      const [plugin] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
      const [settings] = await db.select().from(pluginCompanySettings).where(and(
        eq(pluginCompanySettings.pluginId, pluginId), eq(pluginCompanySettings.companyId, agent.companyId)));
      if (settings?.enabled === false || !plugin || plugin.status !== "ready" || !plugin.manifestJson.agentLifecycle || !plugin.manifestJson.capabilities.includes("agents.lifecycle.manage")) {
        throw Object.assign(new Error("A required lifecycle plugin is unavailable"), { code: "required_plugin_unavailable" });
      }
      const operationId = agent.lifecycleOperation!.id;
      const secrets = agentInstanceSecretService(db);
      const instanceSecrets = ["preparing", "resuming"].includes(agent.lifecycleState)
        ? await secrets.read({ companyId: agent.companyId, agentId: agent.id, pluginId }) : {};
      const request = { companyId: agent.companyId, agentId: agent.id, operationId, version: agent.lifecycleVersion, phase: agent.lifecycleState,
        instanceSecrets };
      const result = await manager.call(plugin.id, "agentLifecycle", request, 30_000);
      if (!result || result.operationId !== operationId || result.version !== agent.lifecycleVersion || !["complete", "pending"].includes(result.status)) {
        throw Object.assign(new Error("Invalid lifecycle result"), { code: "invalid_lifecycle_result" });
      }
      if (result.instanceSecrets !== undefined) await secrets.apply(request, pluginId, result.instanceSecrets, agent.lifecycleOperation?.leaseOwner);
      return result.status;
    },
    async runHost(agent) {
      if (agent.lifecycleState === "verifying") return verify(agent);
      if (["pausing", "terminating", "cleaning_up"].includes(agent.lifecycleState)) {
        const ids = agent.lifecycleState === "pausing" ? [agent.id]
          : [agent.id, ...listInvalidOrgChainDescendantIds(agent.id,
            await db.select().from(agents).where(eq(agents.companyId, agent.companyId)))];
        const reason = agent.lifecycleHolds?.includes("company_archived")
          ? "Cancelled because the company was archived" : "Agent lifecycle stop requested";
        // Record what this pause stopped the runs for, so a budget resume
        // continues only the work its own budget stopped, never a manual pause.
        if (agent.lifecycleState === "pausing") {
          // The cause recorded when the pause started survives a resume that
          // already removed the holds before this Stop ran.
          const cause = agent.lifecycleOperation?.pauseCause;
          const pauseStop = sql`jsonb_build_object('pauseStop', jsonb_build_object(
            'holds', ${JSON.stringify(cause?.holds ?? agent.lifecycleHolds ?? [])}::jsonb,
            'companyPauseReason', ${cause ? sql`${cause.companyPauseReason}::text`
              : sql`(select ${companies.pauseReason} from ${companies} where ${companies.id} = ${agent.companyId})`}))`;
          await db.update(heartbeatRuns).set({
            resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${pauseStop}`,
          }).where(and(eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id),
            inArray(heartbeatRuns.status, [...CANCELLABLE_HEARTBEAT_RUN_STATUSES]),
            sql`not (coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ? 'pauseStop')`));
        }
        if (!await heartbeat.stopInvocationsForAgents(ids, reason,
          { preservePauseDeferred: agent.lifecycleState === "pausing" })) return "pending";
      }
      return "complete";
    },
  };
}
