import { and, eq, inArray } from "drizzle-orm";
import { agents, companies, plugins, pluginCompanySettings, type Db } from "@paperclipai/db";
import { aiRuntimeConnectionBindingSchema } from "@paperclipai/shared";
import { isForbiddenConfigEnvKey, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { requireServerAdapter } from "../../../adapters/index.js";
import { agentEnvironmentTestService } from "../../../services/agent-environment-test.js";
import { aiConnectionRouterService } from "../../../services/ai-connection-router.js";
import { withManagedAiProbe, stripAiAuthBindings } from "../../../services/ai-connection-runtime.js";
import { environmentService } from "../../../services/environments.js";
import { secretService } from "../../../services/secrets.js";
import { dotRunnerBroker } from "../../../services/dot-runner-broker.js";
import { heartbeatService } from "../../../services/heartbeat.js";
import { listInvalidOrgChainDescendantIds } from "../../../services/agent-invokability.js";
import type { PluginWorkerManager } from "../../../services/plugin-worker-manager.js";
import type { LifecycleDriver, LifecycleAgent } from "../application/ports.js";

export function createLifecycleDriver(db: Db, manager: PluginWorkerManager): LifecycleDriver {
  const tests = agentEnvironmentTestService(db, manager);
  const secrets = secretService(db);
  const environments = environmentService(db);
  const heartbeat = heartbeatService(db, { pluginWorkerManager: manager });
  async function verify(snapshot: LifecycleAgent): Promise<"complete" | "pending"> {
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, snapshot.id), eq(agents.lifecycleVersion, snapshot.lifecycleVersion)));
    if (!agent) return "pending";
    if (agent.adapterType === "paperclip_runner" && agent.adapterConfig.provider === "openai_dot") {
      const binding = await dotRunnerBroker(db).bindingForAgent(agent.companyId, agent.id);
      return binding?.status === "ready" && binding.subscriptionVerified && binding.id === agent.adapterConfig.dotBindingId ? "complete" : "pending";
    }
    const [company] = await db.select().from(companies).where(eq(companies.id, agent.companyId));
    const responsibleUserId = agent.lifecycleOperation?.responsibleUserId ?? company.defaultResponsibleUserId;
    const context = { consumerType: "agent" as const, consumerId: agent.id, actorType: "system" as const,
      actorId: "agent-lifecycle", responsibleUserId };
    let binding = agent.runtimeConfig.aiConnection ? aiRuntimeConnectionBindingSchema.parse(agent.runtimeConfig.aiConnection) : undefined;
    let config = agent.adapterConfig;
    if (binding?.mode === "router") {
      const selected = await aiConnectionRouterService(db, manager).resolve({ companyId: agent.companyId,
        poolId: binding.connectionId, agentId: agent.id, userId: responsibleUserId,
        adapterType: agent.adapterType, taskKey: `lifecycle:${agent.lifecycleOperation!.id}` });
      binding = selected.binding;
      config = { ...config, ...selected.runtimeConfig };
    }
    if (binding) config = { ...config, env: stripAiAuthBindings(config.env) };
    config = (await secrets.resolveAdapterConfigForRuntime(agent.companyId, config, context, { adapterType: agent.adapterType })).config;
    const environmentId = await tests.resolveAdapterTestEnvironmentId(agent.companyId, agent.defaultEnvironmentId);
    if (environmentId) {
      await tests.assertAdapterTestEnvironmentForCompany(agent.companyId, environmentId);
      const environment = await environments.getById(environmentId);
      const env = Object.fromEntries(Object.entries(binding ? stripAiAuthBindings(environment?.envVars) : parseObject(environment?.envVars))
        .filter(([key]) => !isForbiddenConfigEnvKey(key)));
      const resolved = await secrets.resolveEnvBindings(agent.companyId, env,
        { ...context, consumerType: "environment", consumerId: environmentId });
      config = { ...config, env: { ...resolved.env, ...parseObject(config.env) } };
    }
    const target = await tests.resolveAdapterTestExecutionContext({ agentId: agent.id, companyId: agent.companyId, adapterType: agent.adapterType, environmentId });
    let status: "released" | "failed" = "failed";
    try {
      if (target.fallbackChecks.length) throw new Error("The test environment is unavailable");
      const input = { companyId: agent.companyId, adapterType: agent.adapterType, config,
        executionTarget: target.executionTarget, environmentName: target.environmentName };
      const result = binding ? await withManagedAiProbe(db, { ...input, agentId: agent.id, responsibleUserId, binding },
        managed => tests.testManagedEnvironment(agent.adapterType, { ...input, config: managed.config }, binding!, managed, agent.id))
        : await requireServerAdapter(agent.adapterType).testEnvironment(input);
      if (result.status === "fail") throw new Error("The harness test failed");
      status = "released";
      return "complete";
    } finally { await target.release(status); }
  }
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
        throw new Error("A required lifecycle plugin is unavailable");
      }
      const operationId = agent.lifecycleOperation!.id;
      const result = await manager.call(plugin.id, "agentLifecycle", { companyId: agent.companyId,
        agentId: agent.id, operationId, version: agent.lifecycleVersion, phase: agent.lifecycleState }, 30_000);
      if (!result || result.operationId !== operationId || result.version !== agent.lifecycleVersion || !["complete", "pending"].includes(result.status)) {
        throw new Error("Invalid lifecycle result");
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
