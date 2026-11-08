import { inArray } from "drizzle-orm";
import { poolRunnerCooldownIdentity, type PoolRunnerScope } from "./ai-connection-pool-cooldown.js";
import type { ConnectionManagementContext } from "./connection-management.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { reopenNativeQuotaPoolWaits } from "./native-runtime/native-quota-wake.js";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, gt, ne, sql } from "drizzle-orm";
import { aiConnectionPools, aiConnectionQuotaCooldowns, aiConnectionRouterCursors, aiConnectionTaskPins, companySecrets, connectionGrants, instanceSettings, plugins, toolApplications, toolConnections, toolConnectionInstalls, type Db } from "@paperclipai/db";
import { BUILTIN_AI_FAILOVER_ROUTER_KEY, agentHarnessType, aiRoutingModel, aiConnectionMetadataSchema, aiConnectionRouterAppDefinition, aiConnectionRouterSlug, aiConnectionPoolConfigSchema, isAiConnectionCompatible, type AiConnectionPool, type AiConnectionPoolMember, type AiConnectionRouterRequest, type AiConnectionRouterSelection, type AiConnectionPoolSaveInput, type AiConnectionUsage } from "@paperclipai/shared";
import { isCodexLocalKnownModel, codexLocalReasoningEffortsForModel } from "@paperclipai/adapter-codex-local";
import { models as claudeModels, claudeLocalReasoningEffortsForModel } from "@paperclipai/adapter-claude-local";
import { models as grokModels, grokLocalReasoningEffortsForModel } from "@paperclipai/adapter-grok-local";
import { aiConnectionService } from "./ai-connections.js";
import { instanceSettingsService } from "./instance-settings.js";
import { logActivity } from "./activity-log.js";
import { HttpError, forbidden, notFound, conflict, unprocessable } from "../errors.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { resolvePaperclipRunnerProviderProfile, resolvePaperclipRunnerNativeProviderInput } from "./native-runtime/provider-profile.js";
import { findActiveServerAdapter } from "../adapters/index.js";
import { parseObject } from "../adapters/utils.js";
import { listOpenRouterModels } from "./openrouter-models.js";

const usageCache = new Map<string, { expires: number; value: AiConnectionUsage }>();
const usageInFlight = new Map<string, Promise<AiConnectionUsage | undefined>>();
const routedRuntimeKeys = new Set(["provider", "acpxAgent", "model", "modelReasoningEffort", "reasoningEffort", "effort", "variant"]);
const harnessCommandKeys = new Set(["command", "args", "extraArgs", "engine", "agentCommand", "acpAgentCommand"]);
function poolHarnessChanges(config: Record<string, unknown>, sourceAdapterType: string, targetAdapterType: string, targetConfig: Record<string, unknown>) {
  return agentHarnessType(sourceAdapterType, config) !== agentHarnessType(targetAdapterType, { ...config, ...targetConfig }) ||
    (sourceAdapterType === "paperclip_runner" && targetAdapterType === "paperclip_runner" && config.provider !== targetConfig.provider);
}
export function assertPoolAdapterPolicyCompatible(config: Record<string, unknown>, sourceAdapterType: string, targetAdapterType: string, targetRuntimeConfig: Record<string, unknown> = {}): void {
  if (!poolHarnessChanges(config, sourceAdapterType, targetAdapterType, targetRuntimeConfig)) return;
  const sourceHarness = agentHarnessType(sourceAdapterType, config);
  const targetConfig = { ...config, ...targetRuntimeConfig };
  const refuse = () => { throw unprocessable("Cannot preserve the configured execution policy across providers. Use accounts with the same harness or portable ACP permission settings.", { code: "pool_execution_policy_incompatible" }); };
  for (const key of ["args", "extraArgs"]) {
    const value = config[key];
    if ((Array.isArray(value) && value.some(item => typeof item === "string" && item.trim())) || (typeof value === "string" && value.trim())) refuse();
  }
  if (["dangerouslyBypassApprovalsAndSandbox", "dangerouslyBypassSandbox", "dangerouslySkipPermissions", "alwaysApprove"].some(key => config[key] === false)) refuse();
  if (["sandboxMode", "sandbox", "approvalPolicy", "approval_policy", "sandbox_mode"].some(key => config[key] != null)) refuse();
  const hasLocalSandbox = config.filesystemScope === "workspace" || ["deny", "allowlist"].includes(String(config.networkScope));
  if (sourceAdapterType !== "paperclip_runner" && hasLocalSandbox &&
      !(["claude_local", "codex_local"].includes(targetAdapterType) && String(config.engine).trim().toLowerCase() === "cli")) refuse();
  const canonicalCommands: Record<string, string> = { claude_local: "claude", codex_local: "codex", grok_local: "grok", opencode_local: "opencode" };
  const canonicalAcpCommands: Record<string, string> = { claude_local: "claude-agent-acp", codex_local: "codex-acp" };
  for (const key of ["command", "agentCommand", "acpAgentCommand"]) {
    const value = config[key];
    const command = typeof value === "string" ? value.trim() : "";
    const expected = key === "command" ? canonicalCommands[sourceHarness] : canonicalAcpCommands[sourceHarness];
    if (command && (!expected || ![expected, `${expected}.cmd`, `${expected}.exe`].includes(command))) refuse();
  }
  const sourceEngine = typeof config.engine === "string" ? config.engine.trim().toLowerCase() : "";
  const sourceAcp = sourceAdapterType !== "paperclip_runner" && ["claude_local", "codex_local"].includes(sourceHarness) && sourceEngine !== "cli";
  const targetEngine = typeof targetConfig.engine === "string" ? targetConfig.engine.trim().toLowerCase() : "";
  const targetAcp = targetAdapterType !== "paperclip_runner" && ["claude_local", "codex_local"].includes(targetAdapterType) && targetEngine !== "cli";
  for (const key of ["permissionMode", "acpPermissionMode"]) {
    const value = config[key];
    const mode = typeof value === "string" ? value.trim() : "";
    if (mode && !["default", "approve-all"].includes(mode) && !(sourceAcp && targetAcp && ["approve-reads", "deny-all"].includes(mode))) refuse();
  }
  if (!targetAcp && ["nonInteractivePermissions", "acpNonInteractivePermissions"].some(key => config[key] != null)) refuse();
  if (config.acpxPermissionMode != null && config.acpxPermissionMode !== "approve-all" &&
      !(sourceAdapterType === "paperclip_runner" && config.provider === "acpx" && targetAdapterType === "paperclip_runner" && targetConfig.provider === "acpx")) refuse();
  if (config.acpxSessionMode != null && config.acpxSessionMode !== "agent" &&
      !(sourceAdapterType === "paperclip_runner" && config.provider === "acpx" && targetAdapterType === "paperclip_runner" && targetConfig.provider === "acpx" && config.acpxAgent === targetConfig.acpxAgent)) refuse();
  if (config.opencodePermissionMode != null && config.opencodePermissionMode !== "allow") refuse();
  if (config.codexPermissionMode != null && config.codexPermissionMode !== "never") refuse();
}
export function applyAiConnectionRouterTaskSettings(config: Record<string, unknown>, selection: AiConnectionRouterSelection, configuredAdapterType?: string, sourcePolicyConfig = config): Record<string, unknown> {
  const targetAdapter = selection.adapterType ?? configuredAdapterType;
  if (!selection.adapterType && configuredAdapterType && LOCAL_POOL_ADAPTERS.includes(configuredAdapterType) &&
      poolExecutionAdapterType(selection.binding, configuredAdapterType) !== configuredAdapterType)
    throw unprocessable("Cannot preserve an older pool execution policy across providers; start a new task turn");
  const switchingHarness = configuredAdapterType && targetAdapter && poolHarnessChanges(sourcePolicyConfig, configuredAdapterType, targetAdapter, selection.runtimeConfig);
  if (switchingHarness) assertPoolAdapterPolicyCompatible(sourcePolicyConfig, configuredAdapterType, targetAdapter!, selection.runtimeConfig);
  const sourceEngine = typeof sourcePolicyConfig.engine === "string" ? sourcePolicyConfig.engine.trim().toLowerCase() : "";
  const retainedEngine = switchingHarness && ["claude_local", "codex_local"].includes(configuredAdapterType ?? "") &&
    ["claude_local", "codex_local"].includes(targetAdapter ?? "") && ["cli", "acp"].includes(sourceEngine) ? { engine: sourceEngine } : {};
  return { ...Object.fromEntries(Object.entries(config).filter(([key]) => !routedRuntimeKeys.has(key) && !(switchingHarness && harnessCommandKeys.has(key)))), ...retainedEngine, ...selection.runtimeConfig };
}
export class AiConnectionPoolExhausted extends Error {
  readonly code = "ai_connection_pool_exhausted";
  constructor(readonly retryAt: string, readonly poolId: string) { super("All eligible pool members are temporarily unavailable. Waiting for the earliest retry or an account update."); }
}

export const LOCAL_POOL_ADAPTERS = ["claude_local", "codex_local", "grok_local", "opencode_local"];

export function poolExecutionAdapterType(binding: { provider: string }, configuredAdapterType: string, allowHarnessSwitch = true): string {
  if (!allowHarnessSwitch) return configuredAdapterType;
  if (configuredAdapterType === "paperclip_runner") return configuredAdapterType;
  if (!LOCAL_POOL_ADAPTERS.includes(configuredAdapterType)) throw unprocessable("This harness cannot execute a connection pool");
  const adapters: Record<string, string> = { anthropic: "claude_local", openai: "codex_local", xai: "grok_local", openrouter: "opencode_local" };
  const adapter = adapters[binding.provider];
  if (!adapter || !findActiveServerAdapter(adapter)) throw unprocessable("The selected pool execution harness is unavailable");
  return adapter;
}

function samePoolSelection(left: AiConnectionRouterSelection, right: AiConnectionRouterSelection, configuredAdapterType: string) {
  const retainedAdapter = left.adapterType ?? right.adapterType ?? configuredAdapterType;
  const identity = (selection: AiConnectionRouterSelection) => ({
    poolId: selection.poolId,
    memberId: selection.memberId,
    binding: selection.binding,
    adapterType: selection.adapterType ?? retainedAdapter,
  });
  return isDeepStrictEqual(
    identity(left),
    identity(right),
  );
}

/** Routing can override provider/model only, never environment, permissions, or instructions. */
export function poolMemberRuntimeConfig(member: AiConnectionPoolMember, adapterType: string, overrides: Record<string, unknown> = {}, allowHarnessSwitch = true) {
  adapterType = poolExecutionAdapterType(member.binding, adapterType, allowHarnessSwitch);
  const notes: string[] = [];
  const provider = member.binding.provider;
  const profile = member.profile;
  const expected = provider === "openai" ? profile.provider === "codex"
    : provider === "anthropic" ? profile.provider === "acpx" && profile.acpxAgent === "claude"
    : provider === "xai" ? profile.provider === "acpx" && profile.acpxAgent === "grok"
    : profile.provider === "opencode";
  if (!expected) throw unprocessable("Pool member harness does not match its account");
  const supportsModel = (value: string) => provider === "openai" ? isCodexLocalKnownModel(value)
    : provider === "anthropic" ? claudeModels.some((m) => m.id === value)
    : provider === "xai" ? grokModels.some((m) => m.id === value) : value.startsWith("openrouter/");
  const config: Record<string, unknown> = { provider: profile.provider, ...(profile.acpxAgent ? { acpxAgent: profile.acpxAgent } : {}), model: profile.model };
  const validate = () => {
    if (!isAiConnectionCompatible(member.binding, adapterType, config.model, config.provider, config.acpxAgent)) throw unprocessable("Pool member is incompatible with this harness");
    if (adapterType === "paperclip_runner") {
      const resolved = resolvePaperclipRunnerProviderProfile(config);
      resolvePaperclipRunnerNativeProviderInput({ backend: resolved.backend, adapterConfig: config });
    }
  };
  validate();
  if (typeof overrides.model === "string" && overrides.model !== profile.model) {
    if (supportsModel(overrides.model)) {
      config.model = overrides.model;
      try { validate(); } catch { config.model = profile.model; notes.push("Model override is unavailable for this member; using its default."); }
    } else notes.push("Model override is unavailable for this member; using its default.");
  }
  const model = String(config.model);
  const efforts = provider === "openai" ? codexLocalReasoningEffortsForModel(model)
    : provider === "anthropic" ? claudeLocalReasoningEffortsForModel(model)
    : provider === "xai" ? grokLocalReasoningEffortsForModel(model) : [];
  const effortKey = adapterType === "paperclip_runner" ? profile.provider === "codex" || (profile.provider === "acpx" && profile.acpxAgent === "claude") ? "modelReasoningEffort" : profile.provider === "acpx" && profile.acpxAgent === "grok" ? "reasoningEffort" : null
    : provider === "anthropic" ? "effort" : provider === "xai" ? "reasoningEffort" : provider === "openai" ? "modelReasoningEffort" : "variant";
  const requested = overrides.modelReasoningEffort ?? overrides.reasoningEffort ?? overrides.effort ?? overrides.variant;
  const effort = typeof requested === "string" && efforts.includes(requested) && effortKey ? requested
    : profile.effort && efforts.includes(profile.effort) && effortKey ? profile.effort : null;
  if (requested && requested !== effort) notes.push("Effort override is unavailable for this member; using its default.");
  if (effort && effortKey) config[effortKey] = effort;
  validate();
  return { adapterType, config, notes };
}

// The snapshot comes from managed runtime preparation; the responsible user is
// deliberately omitted because one grant can be shared by several users.
export function quotaIdentityFromSessionSnapshot(grantId: string, snapshot: string): string | null {
  if (!snapshot.startsWith(`${grantId}:`)) return null;
  const suffix = snapshot.match(/:(no-auth|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]+)$/i)?.[1];
  return suffix ? suffix === "no-auth" ? `grant:${grantId}:no-auth` : `secret:${suffix.toLowerCase()}` : null;
}

export function aiConnectionRouterService(db: Db, workerManager?: PluginWorkerManager) {
  async function recordQuotaCooldown(companyId: string, connectionId: string, credentialIdentity: string, retryAt: Date, lockCredentialIdentity = credentialIdentity) {
    void connectionId;
    await db.transaction(async tx => {
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.executionReplacement);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${companyId + ":" + lockCredentialIdentity}, 0))`);
    await tx.insert(aiConnectionQuotaCooldowns).values({ companyId, credentialIdentity, retryAt }).onConflictDoUpdate({
      target: [aiConnectionQuotaCooldowns.companyId, aiConnectionQuotaCooldowns.credentialIdentity],
      set: { retryAt: sql`greatest(${aiConnectionQuotaCooldowns.retryAt}, excluded.retry_at)`, updatedAt: new Date() },
    });
    });
  }
  async function accountCooldown(companyId: string, connectionId: string, credentialIdentity: string, runner?: { config: Record<string, unknown>; scope: PoolRunnerScope }): Promise<Date | null> {
    void connectionId;
    const identities = [credentialIdentity, ...(runner ? [poolRunnerCooldownIdentity(credentialIdentity, runner.config, runner.scope.environmentId)] : [])];
    const rows = await db.select({ retryAt: aiConnectionQuotaCooldowns.retryAt }).from(aiConnectionQuotaCooldowns)
      .where(and(eq(aiConnectionQuotaCooldowns.companyId, companyId), inArray(aiConnectionQuotaCooldowns.credentialIdentity, identities)));
    const deadline = Math.max(...rows.map(row => row.retryAt.getTime()));
    return deadline > Date.now() ? new Date(deadline) : null;
  }
  async function owner(pluginKey: string) {
    const [plugin] = await db.select().from(plugins).where(eq(plugins.pluginKey, pluginKey));
    if (!plugin || plugin.status !== "ready" || !plugin.manifestJson.capabilities.includes("ai.connections.route")) throw unprocessable("Enable a compatible AI connection router plugin");
    return plugin;
  }
  async function enabled() {
    if (!(await instanceSettingsService(db).getExperimental()).enableAiConnectionRouters) throw unprocessable("Ask your instance operator to enable AI connection routing.", { code: "ai_connection_router_disabled" });
  }
  async function catalog() {
    const experimental = (await instanceSettingsService(db).getExperimental()).enableAiConnectionRouters;
    const installed = await db.select().from(plugins);
    return [...installed.filter(plugin => plugin.pluginKey !== BUILTIN_AI_FAILOVER_ROUTER_KEY && plugin.status !== "uninstalled" && plugin.manifestJson.aiConnectionRouter && plugin.manifestJson.capabilities.includes("ai.connections.route"))
      .map(plugin => aiConnectionRouterAppDefinition(plugin.pluginKey, plugin.manifestJson.aiConnectionRouter!, {
        available: experimental && plugin.status === "ready",
        ...(!experimental ? { reason: "Ask your instance operator to enable AI connection routing." }
          : plugin.status !== "ready" ? { reason: "Enable the connection pool plugin in Plugins." } : {}),
      })), aiConnectionRouterAppDefinition(BUILTIN_AI_FAILOVER_ROUTER_KEY, { name: "Ordered failover pool", description: "Use the first available account in your chosen order." })];
  }
  async function list(companyId: string) {
    const rows = await db.select({ pool: aiConnectionPools }).from(aiConnectionPools)
      .innerJoin(toolConnections, and(eq(toolConnections.id, aiConnectionPools.id), eq(toolConnections.companyId, aiConnectionPools.companyId)))
      .where(and(eq(aiConnectionPools.companyId, companyId), ne(toolConnections.status, "archived")));
    return rows.map(({ pool: row }): AiConnectionPool => ({ ...row.config, id: row.id, companyId, pluginKey: row.pluginKey, revision: row.revision }));
  }
  async function selectable(companyId: string, userId: string, includeDisabled = false) {
    const experimental = (await instanceSettingsService(db).getExperimental()).enableAiConnectionRouters;
    const accounts = await aiConnectionService(db).list(companyId, userId);
    const result: AiConnectionPool[] = [];
    for (const pool of await list(companyId)) {
      if (!pool.enabled && !includeDisabled) continue;
      if (pool.pluginKey !== BUILTIN_AI_FAILOVER_ROUTER_KEY) {
        if (!experimental) continue;
        try { await owner(pool.pluginKey); } catch { continue; }
      }
      const members = pool.members.filter(member => accounts.some(account => account.id === member.binding.connectionId && account.grantId === member.binding.grantId));
      if (members.length) result.push({ ...pool, members });
    }
    return result;
  }
  async function inspect(companyId: string, poolId: string, userId: string) {
    const pool = (await list(companyId)).find(pool => pool.id === poolId);
    if (!pool) throw notFound("Connection pool not found");
    const visible = await aiConnectionService(db).list(companyId, userId);
    const result: Record<string, { reason: string; checkedAt: string | null; retryAt?: string; usage?: AiConnectionUsage }> = {};
    const accountsByGrant = new Map(visible.map(account => [`${account.id}:${account.grantId}`, account]));
    for (const member of pool.members) {
      const account = accountsByGrant.get(`${member.binding.connectionId}:${member.binding.grantId}`);
      const key = account ? await usageCacheKey(member, companyId) : null;
      const cached = key ? usageCache.get(`${key}:${userId}`) : undefined;
      const observation = cached && cached.expires > Date.now() ? cached.value : undefined;
      const [credential] = account ? await db.select({ grant: connectionGrants, connection: toolConnections }).from(connectionGrants)
        .innerJoin(toolConnections, and(eq(toolConnections.companyId, connectionGrants.companyId), eq(toolConnections.id, connectionGrants.connectionId)))
        .where(and(eq(connectionGrants.companyId, companyId), eq(connectionGrants.id, member.binding.grantId), eq(toolConnections.id, member.binding.connectionId))) : [];
      const identity = credential ? await quotaIdentity(credential, companyId) : null;
      const retryAt = identity ? await accountCooldown(companyId, member.binding.connectionId, identity) : null;
      result[member.id] = { ...(retryAt ? { retryAt: retryAt.toISOString() } : {}), reason: retryAt ? "Account cooling down" : account?.status === "connected" ? "Eligible if agent access permits" : account?.status ?? "Not permitted", checkedAt: account && observation ? observation.checkedAt : null, ...(account && observation ? { usage: observation } : {}) };
    }
    return result;
  }
  async function save(pluginKey: string, input: AiConnectionPoolSaveInput, userId: string, managementContext?: ConnectionManagementContext) {
    const builtin = pluginKey === BUILTIN_AI_FAILOVER_ROUTER_KEY;
    if (!builtin) await enabled();
    const plugin = builtin ? null : await owner(pluginKey);
    const config = aiConnectionPoolConfigSchema.parse(input.config);
    if (builtin && config.mode !== "failover") throw unprocessable("The built-in pool supports ordered failover only");
    if (!builtin && config.mode === "failover") throw unprocessable("Ordered failover requires the built-in pool");
    const visible = await aiConnectionService(db).list(input.companyId, userId);
    for (const member of config.members) {
      const account = visible.find(v => v.id === member.binding.connectionId && v.grantId === member.binding.grantId);
      if (!account) throw forbidden("Choose an account you may use in this company");
      if (config.kind === "harness_pool" && (account.provider !== member.binding.provider || account.method !== member.binding.method ||
          member.binding.mode !== (account.ownership === "shared" ? "shared" : "delegated")))
        throw unprocessable("Pool member account settings do not match its saved grant");
      const effective = poolMemberRuntimeConfig(member, "paperclip_runner");
      if (config.kind === "harness_pool") {
        const model = member.profile.model;
        const catalogued = account.routing?.models.length
          ? account.routing.models.some(item => aiRoutingModel(account.routing!, agentHarnessType("paperclip_runner", effective.config), item.id) === model)
          : account.provider === "openai" ? isCodexLocalKnownModel(model)
            : account.provider === "anthropic" ? claudeModels.some(item => item.id === model)
              : account.provider === "xai" ? grokModels.some(item => item.id === model)
                : (await listOpenRouterModels()).some(item => item.id === model);
        if (!catalogued) throw unprocessable("Choose a model available in this account's model catalog");
      }
      if (config.kind === "harness_pool" && member.profile.effort && ![effective.config.modelReasoningEffort, effective.config.reasoningEffort].includes(member.profile.effort))
        throw unprocessable("Effort is unavailable for this harness and model; choose a supported effort or leave it empty");
    }
    const id = input.id ?? randomUUID();
    await managementContext?.reauthorize();
    await db.transaction(async (tx) => {
      await reopenNativeQuotaPoolWaits(tx as unknown as Db, { companyId: input.companyId, poolId: id });
      if (input.id) {
        const [row] = await tx.select().from(aiConnectionPools).where(and(eq(aiConnectionPools.id, id), eq(aiConnectionPools.companyId, input.companyId), eq(aiConnectionPools.pluginKey, pluginKey))).for("update");
        if (!row) throw notFound("Connection pool not found");
        const [connection] = await tx.select().from(toolConnections).where(and(eq(toolConnections.id, id), eq(toolConnections.companyId, input.companyId)));
        if (!connection || connection.status === "archived") throw notFound("Connection pool not found");
        if (input.expectedRevision !== row.revision) throw conflict("Pool changed; reload before saving");
        await tx.update(aiConnectionPools).set({ config, revision: row.revision + 1, updatedAt: new Date() }).where(eq(aiConnectionPools.id, id));
        await tx.update(toolConnections).set({ name: config.name, enabled: config.enabled, updatedAt: new Date() }).where(and(eq(toolConnections.id, id), eq(toolConnections.companyId, input.companyId)));
      } else {
        const key = builtin ? "builtin:ordered-failover:ai-router" : `plugin:${pluginKey}:ai-router`;
        await tx.insert(toolApplications).values({ companyId: input.companyId, applicationKey: key, name: builtin ? "Ordered failover pool" : plugin!.manifestJson.aiConnectionRouter?.name ?? plugin!.manifestJson.displayName, metadata: { sourceTemplateKey: aiConnectionRouterSlug(pluginKey) }, type: builtin ? "rest_api" : "paperclip_plugin", pluginId: plugin?.id ?? null }).onConflictDoNothing();
        const [application] = await tx.select().from(toolApplications).where(and(eq(toolApplications.companyId, input.companyId), eq(toolApplications.applicationKey, key)));
        if (!application) throw new Error("Router application could not be created");
        await tx.insert(toolConnections).values({ id, companyId: input.companyId, applicationId: application.id, name: config.name, uid: id, connectionPurpose: "ai", transport: "runtime_auth", enabled: config.enabled, status: "active", healthStatus: "ok", config: { aiRouter: { pluginKey }, sourceTemplateKey: aiConnectionRouterSlug(pluginKey) }, createdByUserId: userId });
        await tx.insert(aiConnectionPools).values({ id, companyId: input.companyId, pluginKey, config });
        await tx.insert(aiConnectionRouterCursors).values({ poolId: id, companyId: input.companyId });
        await tx.insert(toolConnectionInstalls).values({ companyId: input.companyId, connectionId: id, targetType: "company", targetId: input.companyId, createdByUserId: userId });
      }
      await logActivity(tx as unknown as Db, { companyId: input.companyId, ...(managementContext?.audit ?? { actorType: "user" as const, actorId: userId }), action: "ai_connection.pool_saved", entityType: "tool_connection", entityId: id, details: { enabled: config.enabled, memberCount: config.members.length, mode: config.mode } });
    });
    return (await list(input.companyId)).find((p) => p.id === id)!;
  }
  async function remove(companyId: string, poolId: string, expectedRevision: number, userId: string, managementContext?: ConnectionManagementContext) {
    // Archive the virtual connection; cascading deletion would erase task pins.
    // Cleanup remains available when the experimental flag or plugin is off.
    await managementContext?.reauthorize();
    await db.transaction(async tx => {
      await reopenNativeQuotaPoolWaits(tx as unknown as Db, { companyId, poolId });
      const [row] = await tx.select().from(aiConnectionPools).where(and(eq(aiConnectionPools.id, poolId), eq(aiConnectionPools.companyId, companyId))).for("update");
      if (!row) throw notFound("Connection pool not found");
      const [connection] = await tx.select().from(toolConnections).where(and(eq(toolConnections.id, poolId), eq(toolConnections.companyId, companyId)));
      if (!connection || connection.status === "archived") throw notFound("Connection pool not found");
      if (row.revision !== expectedRevision) throw conflict("Pool changed; reload before deleting");
      await tx.update(aiConnectionPools).set({ config: { ...row.config, enabled: false }, revision: row.revision + 1, updatedAt: new Date() }).where(eq(aiConnectionPools.id, poolId));
      await tx.update(toolConnections).set({ status: "archived", enabled: false, updatedAt: new Date() }).where(and(eq(toolConnections.id, poolId), eq(toolConnections.companyId, companyId)));
      await logActivity(tx as unknown as Db, { companyId, ...(managementContext?.audit ?? { actorType: "user" as const, actorId: userId }), action: "ai_connection.pool_deleted", entityType: "tool_connection", entityId: poolId, details: { retainedTaskPins: true } });
    });
    return { ok: true };
  }
  async function quotaIdentity(selection: { grant: Pick<typeof connectionGrants.$inferSelect, "id" | "credentialSecretRefs">; connection: Pick<typeof toolConnections.$inferSelect, "config"> }, companyId: string, client = db, lock = false): Promise<string | null> {
    const ref = selection.grant.credentialSecretRefs.find((r) => r.configPath === "ai.credential");
    if (!ref) {
      const metadata = aiConnectionMetadataSchema.safeParse(selection.connection.config.ai);
      return metadata.success && metadata.data.routing?.auth === "none" ? `grant:${selection.grant.id}:no-auth` : null;
    }
    const query = client.select({ epoch: companySecrets.aiSessionEpoch }).from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, ref.secretId)));
    const [secret] = await (lock ? query.for("share") : query);
    return secret ? `secret:${ref.secretId.toLowerCase()}:${secret.epoch}` : null;
  }
  async function usageCacheKey(member: AiConnectionPoolMember, companyId: string) {
    const [grant] = await db.select().from(connectionGrants).where(and(eq(connectionGrants.companyId, companyId), eq(connectionGrants.id, member.binding.grantId)));
    if (!grant) return null;
    const ref = grant.credentialSecretRefs.find((r) => r.configPath === "ai.credential");
    const [secret] = ref ? await db.select({ version: companySecrets.latestVersion }).from(companySecrets).where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, ref.secretId))) : [];
    return `${companyId}:${grant.id}:${ref?.secretId}:${secret?.version}:${grant.updatedAt.toISOString()}`;
  }
  async function probe(member: AiConnectionPoolMember, companyId: string, userId: string, deadline: number) {
    const accountKey = await usageCacheKey(member, companyId);
    if (!accountKey) return undefined;
    // A cached observation must not bypass the requesting user's grant check.
    const key = `${accountKey}:${userId}`;
    let cached = usageCache.get(key);
    if (cached || usageInFlight.has(key)) {
      const visible = await aiConnectionService(db).list(companyId, userId);
      if (!visible.some(account => account.id === member.binding.connectionId && account.grantId === member.binding.grantId)) return undefined;
      cached = usageCache.get(key);
    }
    if (cached && cached.expires > Date.now()) return cached.value;
    let pending = usageInFlight.get(key);
    if (!pending) {
      let probeTimer: ReturnType<typeof setTimeout> | undefined;
      pending = Promise.race([
        aiConnectionService(db).probeUsage(companyId, userId, member.binding.connectionId, member.binding.grantId).catch(() => undefined),
        new Promise<undefined>(resolve => { probeTimer = setTimeout(() => resolve(undefined), 15_000); }),
      ]).then(value => {
        if (value) {
          const resets = value.limits.map(v => Date.parse(v.resetsAt ?? "")).filter(v => Number.isFinite(v) && v > Date.now());
          if (usageCache.size > 1000) usageCache.clear();
          usageCache.set(key, { value, expires: Math.min(Date.now() + 60_000, ...resets) });
        }
        return value;
      }).finally(() => { if (probeTimer) clearTimeout(probeTimer); usageInFlight.delete(key); });
      usageInFlight.set(key, pending);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now())); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  async function resolve(input: { companyId: string; poolId: string; agentId: string; userId: string | null; adapterType: string; taskKey: string; overrides?: Record<string, unknown>; existingGrantId?: string; requireExisting?: boolean; persisted?: AiConnectionRouterSelection; skipUsageProbe?: boolean; environmentId?: string | null; sourceAdapterConfig?: Record<string, unknown> }) {
    const pinWhere = and(eq(aiConnectionTaskPins.companyId, input.companyId), eq(aiConnectionTaskPins.poolId, input.poolId), eq(aiConnectionTaskPins.agentId, input.agentId), eq(aiConnectionTaskPins.taskKey, input.taskKey));
    const validateSelection = async (selection: AiConnectionRouterSelection, client = db) => {
      const effectiveAdapter = selection.adapterType ?? input.adapterType;
      assertPoolAdapterPolicyCompatible(input.sourceAdapterConfig ?? {}, input.adapterType, effectiveAdapter, selection.runtimeConfig);
      return aiConnectionService(client).select({ companyId: input.companyId, agentId: input.agentId, userId: input.userId, adapterType: effectiveAdapter, binding: selection.binding, model: selection.runtimeConfig.model, runnerProvider: selection.runtimeConfig.provider, acpxAgent: selection.runtimeConfig.acpxAgent });
    };
    if (input.persisted) {
      if (input.persisted.poolId !== input.poolId) throw unprocessable("Persisted pool selection does not match this run");
      const [pool] = await db.select({ pluginKey: aiConnectionPools.pluginKey }).from(aiConnectionPools)
        .where(and(eq(aiConnectionPools.companyId, input.companyId), eq(aiConnectionPools.id, input.poolId)));
      if (input.adapterType !== "paperclip_runner" && !LOCAL_POOL_ADAPTERS.includes(input.adapterType)) {
        if (pool?.pluginKey === BUILTIN_AI_FAILOVER_ROUTER_KEY) throw unprocessable("The built-in failover pool requires the Paperclip runner; migrate this agent before using the pool");
      }
      const effectiveAdapter = poolExecutionAdapterType(input.persisted.binding, input.adapterType, pool?.pluginKey === BUILTIN_AI_FAILOVER_ROUTER_KEY);
      if (input.persisted.adapterType && input.persisted.adapterType !== effectiveAdapter)
        throw unprocessable("Persisted pool adapter is inconsistent");
      if (input.requireExisting && (input.persisted.binding.mode === "responsible_user" || input.persisted.binding.grantId !== input.existingGrantId)) throw unprocessable("Reset this task session before adopting the connection pool");
      const [pin] = await db.select().from(aiConnectionTaskPins).where(pinWhere);
      // Uninstall can remove the virtual connection. Server-owned native recovery
      // evidence still authorizes the original concrete selection, never a new one.
      if (pin && (pin.selection.memberId !== input.persisted.memberId || JSON.stringify(pin.selection.binding) !== JSON.stringify(input.persisted.binding))) throw unprocessable("Persisted pool allocation is inconsistent");
      const retained = { ...input.persisted, adapterType: effectiveAdapter };
      await validateSelection(retained);
      return retained;
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      const [record] = await db.select({ pool: aiConnectionPools, connectionStatus: toolConnections.status }).from(aiConnectionPools)
        .innerJoin(toolConnections, and(eq(toolConnections.id, aiConnectionPools.id), eq(toolConnections.companyId, aiConnectionPools.companyId)))
        .where(and(eq(aiConnectionPools.id, input.poolId), eq(aiConnectionPools.companyId, input.companyId)));
      if (!record || record.connectionStatus === "archived") throw unprocessable("This connection pool is unavailable; choose another AI connection");
      const row = record.pool;
      if (!row.config.enabled) throw unprocessable("Enable the selected connection pool");
      const builtin = row.pluginKey === BUILTIN_AI_FAILOVER_ROUTER_KEY;
      if (builtin && input.adapterType !== "paperclip_runner" && !LOCAL_POOL_ADAPTERS.includes(input.adapterType)) throw unprocessable("The built-in failover pool requires the Paperclip runner; migrate this agent before using the pool");
      if (!builtin) await enabled();
      if (builtin && row.config.mode !== "failover") throw unprocessable("Invalid built-in pool mode");
      const plugin = builtin ? null : await owner(row.pluginKey);
      if (plugin && !workerManager?.isRunning(plugin.id)) throw unprocessable("The connection router worker is unavailable; retry when it is ready");
      const [pin] = await db.select().from(aiConnectionTaskPins).where(pinWhere);
      if (pin && input.requireExisting && (pin.selection.binding.mode === "responsible_user" || pin.selection.binding.grantId !== input.existingGrantId)) throw unprocessable("Reset this task session before adopting the connection pool");
      const [cursor] = await db.select().from(aiConnectionRouterCursors).where(and(eq(aiConnectionRouterCursors.poolId, row.id), eq(aiConnectionRouterCursors.companyId, input.companyId)));
      if (!cursor) throw unprocessable("The connection pool cursor is unavailable");
      const pool: AiConnectionPool = { ...row.config, id: row.id, companyId: row.companyId, pluginKey: row.pluginKey, revision: row.revision };
      const deadline = Date.now() + 15_000;
      const candidates: AiConnectionRouterRequest["candidates"] = [];
      const identities = new Map<string, string>();
      let policyRefusal: HttpError | undefined;
      for (const member of pin ? [pin.member] : pool.members) {
        try {
          const effective = poolMemberRuntimeConfig(member, input.adapterType, input.overrides, builtin);
          const selection: AiConnectionRouterSelection = { poolId: row.id, memberId: member.id, binding: member.binding, adapterType: effective.adapterType, runtimeConfig: effective.config, notes: effective.notes, ...(row.config.kind === "harness_pool" && input.environmentId !== undefined ? { runnerScope: { environmentId: input.environmentId ?? null } } : {}) };
          const authorized = await validateSelection(selection);
          const identity = await quotaIdentity(authorized, input.companyId);
          if (!identity) continue;
          identities.set(member.id, identity);
          candidates.push({ member, runtimeConfig: effective.config, notes: effective.notes });
        } catch (error) {
          if (pin) throw error;
          if (error instanceof HttpError && parseObject(error.details).code === "pool_execution_policy_incompatible") policyRefusal = error;
        }
      }
      if (candidates.length === 0 && policyRefusal) throw policyRefusal;
      if (!pin && input.requireExisting) {
        const existing = candidates.find((candidate) => candidate.member.binding.grantId === input.existingGrantId);
        if (!existing) throw unprocessable("Reset this task session before adopting the connection pool");
        candidates.splice(0, candidates.length, existing);
      }
      if (pool.mode === "failover") {
        const cooling: Date[] = [];
        const available: typeof candidates = [];
        for (const candidate of candidates) {
          const retryAt = await accountCooldown(input.companyId, candidate.member.binding.connectionId, identities.get(candidate.member.id)!, row.config.kind === "harness_pool" && input.environmentId !== undefined ? { config: candidate.runtimeConfig, scope: { environmentId: input.environmentId ?? null } } : undefined);
          if (retryAt) { cooling.push(retryAt); continue; }
          // Existing task affinity is never moved on a usage observation: it
          // may have an active or recoverable provider session. This read-only
          // preflight applies only before the initial task selection.
          if (builtin && !pin && !input.skipUsageProbe && input.userId && Date.now() < deadline) {
            const usage = await probe(candidate.member, input.companyId, input.userId, deadline);
            const exhausted = usage?.status === "ok" && usage.source === "anthropic_oauth" && usage.overage?.enabled === false
              ? usage.limits.filter(limit => limit.scope === null && limit.limitReached === true)
              : [];
            const resets = exhausted.map(limit => Date.parse(limit.resetsAt ?? ""));
            if (exhausted.length > 0 && resets.every(reset => Number.isFinite(reset) && reset > Date.now())) {
              const deadline = new Date(Math.max(...resets));
              await recordQuotaCooldown(input.companyId, candidate.member.binding.connectionId, identities.get(candidate.member.id)!, deadline);
              cooling.push(deadline);
              continue;
            }
          }
          available.push(candidate);
          // Only the first available account is needed for ordered failover.
          break;
        }
        if (available.length === 0 && cooling.length > 0) {
          throw new AiConnectionPoolExhausted(new Date(Math.min(...cooling.map((date) => date.getTime()))).toISOString(), pool.id);
        }
        candidates.splice(0, candidates.length, ...available.slice(0, 1));
      }
      if (pool.mode === "usage_aware" && input.userId) {
        // At most four provider calls at once; the shared deadline bounds the whole pool.
        for (let i = 0; i < candidates.length && Date.now() < deadline; i += 4) await Promise.all(candidates.slice(i, i + 4).map(async (candidate) => { candidate.usage = await probe(candidate.member, input.companyId, input.userId!, deadline); }));
      }
      const authorizedPool = { ...pool, members: candidates.map((candidate) => candidate.member) };
      const result = builtin ? (candidates[0] ? { kind: "selected" as const, memberId: candidates[0].member.id } : { kind: "unavailable" as const }) : await workerManager!.call(plugin!.id, "routeAiConnection", { companyId: input.companyId, pool: authorizedPool, memberOrder: pool.members.map((member) => member.id), agentId: input.agentId, taskKey: input.taskKey, lastMemberId: cursor.lastMemberId, cursorVersion: cursor.version, ...(pin ? { pinnedMemberId: pin.member.id } : {}), candidates, now: new Date().toISOString() }, 5000);
      if (result.kind === "exhausted") {
        const retry = Date.parse(result.retryAt);
        throw new AiConnectionPoolExhausted(new Date(Number.isFinite(retry) ? Math.max(Date.now() + 1000, retry) : Date.now() + 60_000).toISOString(), pool.id);
      }
      if (result.kind !== "selected") throw unprocessable("No pool account is permitted and compatible for this task");
      const candidate = candidates.find((v) => v.member.id === result.memberId);
      if (!candidate || (pin && candidate.member.id !== pin.member.id)) throw unprocessable("The router returned an unauthorized member");
      const selected: AiConnectionRouterSelection = { poolId: row.id, memberId: candidate.member.id, binding: candidate.member.binding, adapterType: poolExecutionAdapterType(candidate.member.binding, input.adapterType, builtin), runtimeConfig: candidate.runtimeConfig, notes: candidate.notes, ...(row.config.kind === "harness_pool" && input.environmentId !== undefined ? { runnerScope: { environmentId: input.environmentId ?? null } } : {}) };
      if (pin) return selected;
      const committed = await db.transaction(async (tx) => {
        const [locked] = await tx.select().from(aiConnectionRouterCursors).where(and(eq(aiConnectionRouterCursors.poolId, row.id), eq(aiConnectionRouterCursors.companyId, input.companyId))).for("update");
        const [existing] = await tx.select().from(aiConnectionTaskPins).where(pinWhere);
        if (existing) return { retry: true };
        const [current] = await tx.select().from(aiConnectionPools).where(and(eq(aiConnectionPools.id, row.id), eq(aiConnectionPools.companyId, input.companyId))).for("share");
        if (!locked || locked.version !== cursor.version || !current || current.revision !== row.revision) return { retry: true };
        if (plugin) {
          const [currentPlugin] = await tx.select().from(plugins).where(eq(plugins.id, plugin.id)).for("share");
          if (currentPlugin?.status !== "ready") throw unprocessable("The router plugin was disabled during allocation");
          await tx.select({ id: instanceSettings.id }).from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")).for("share");
          if (!(await instanceSettingsService(tx as unknown as Db).getExperimental()).enableAiConnectionRouters) throw unprocessable("AI connection routers were disabled during allocation");
        }
        if (builtin) {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.companyId + ":" + identities.get(candidate.member.id)!}, 0))`);
          const [cooldown] = await tx.select().from(aiConnectionQuotaCooldowns).where(and(eq(aiConnectionQuotaCooldowns.companyId, input.companyId), inArray(aiConnectionQuotaCooldowns.credentialIdentity, [identities.get(candidate.member.id)!, ...(selected.runnerScope ? [poolRunnerCooldownIdentity(identities.get(candidate.member.id)!, selected.runtimeConfig, selected.runnerScope.environmentId)] : [])]), gt(aiConnectionQuotaCooldowns.retryAt, new Date())));
          if (cooldown) return { retry: true };
        }
        const authorized = await validateSelection(selected, tx as unknown as Db);
        if (await quotaIdentity(authorized, input.companyId, tx as unknown as Db, true) !== identities.get(candidate.member.id)) return { retry: true };
        await tx.insert(aiConnectionTaskPins).values({ companyId: input.companyId, poolId: row.id, agentId: input.agentId, taskKey: input.taskKey, selection: selected, member: candidate.member });
        await tx.update(aiConnectionRouterCursors).set({ lastMemberId: candidate.member.id, version: sql`${aiConnectionRouterCursors.version} + 1` }).where(eq(aiConnectionRouterCursors.poolId, row.id));
        await logActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "system", actorId: "system", agentId: input.agentId, action: "ai_connection.pool_selected", entityType: "tool_connection", entityId: row.id, details: { memberId: candidate.member.id, connectionId: candidate.member.binding.connectionId, taskKey: input.taskKey } });
        return { retry: false };
      });
      if (!committed.retry) return selected;
    }
    throw conflict("Concurrent pool selections changed the cursor; retry this task");
  }
  async function transitionQuotaPin(input: {
    companyId: string; poolId: string; agentId: string; taskKey: string;
    expectedSelection: AiConnectionRouterSelection; userId: string | null; adapterType: string;
    attemptedMemberIds: string[];
    failureKind?: "quota" | "auth" | "runner";
    allowCoolingSelection?: boolean;
    sourceAdapterConfig?: Record<string, unknown>;
    environmentId?: string | null;
  }): Promise<{ kind: "selected"; selection: AiConnectionRouterSelection; retryAt?: Date } | { kind: "cooldown"; retryAt: Date } | { kind: "unavailable" }> {
    // This operation must use the caller's transaction, which owns admission and stop evidence.
    const [cursor] = await db.select().from(aiConnectionRouterCursors).where(and(
      eq(aiConnectionRouterCursors.companyId, input.companyId), eq(aiConnectionRouterCursors.poolId, input.poolId),
    )).for("update");
    const [row] = await db.select({ pool: aiConnectionPools, connectionStatus: toolConnections.status }).from(aiConnectionPools)
      .innerJoin(toolConnections, and(eq(toolConnections.id, aiConnectionPools.id), eq(toolConnections.companyId, aiConnectionPools.companyId)))
      .where(and(eq(aiConnectionPools.companyId, input.companyId), eq(aiConnectionPools.id, input.poolId))).for("update");
    const [pin] = await db.select().from(aiConnectionTaskPins).where(and(
      eq(aiConnectionTaskPins.companyId, input.companyId), eq(aiConnectionTaskPins.poolId, input.poolId),
      eq(aiConnectionTaskPins.agentId, input.agentId), eq(aiConnectionTaskPins.taskKey, input.taskKey),
    )).for("update");
    if (!["paperclip_runner", ...LOCAL_POOL_ADAPTERS].includes(input.adapterType) || !cursor || !row || row.connectionStatus === "archived" || !row.pool.config.enabled ||
        row.pool.pluginKey !== BUILTIN_AI_FAILOVER_ROUTER_KEY || row.pool.config.mode !== "failover" ||
        !pin || !samePoolSelection(pin.selection, input.expectedSelection, input.adapterType) || pin.member.id !== pin.selection.memberId ||
        !isDeepStrictEqual(pin.member.binding, pin.selection.binding) || !row.pool.config.members.some(member => member.id === pin.member.id && isDeepStrictEqual(member.binding, pin.member.binding))) return { kind: "unavailable" };
    const members = row.pool.config.members.filter((member) => !input.attemptedMemberIds.includes(member.id));
    const memberIdentities = new Map<string, string>();
    let legacySourceIdentity: string | null = null;
    if (LOCAL_POOL_ADAPTERS.includes(input.adapterType) && (input.failureKind ?? "quota") === "quota") {
      try {
        const config = poolMemberRuntimeConfig(pin.member, input.adapterType);
        const selected = await aiConnectionService(db).select({ companyId: input.companyId, agentId: input.agentId, userId: input.userId,
          adapterType: config.adapterType, binding: pin.member.binding, model: config.config.model,
          runnerProvider: config.config.provider, acpxAgent: config.config.acpxAgent });
        legacySourceIdentity = await quotaIdentity(selected, input.companyId);
      } catch (error) {
        if (!(error instanceof HttpError && [400, 401, 403, 404, 409, 422].includes(error.status))) throw error;
      }
      if (!legacySourceIdentity) return { kind: "unavailable" };
    }
    for (const member of members) {
      try {
        const effective = poolMemberRuntimeConfig(member, input.adapterType);
        assertPoolAdapterPolicyCompatible(input.sourceAdapterConfig ?? {}, input.adapterType, effective.adapterType, effective.config);
        const authorized = await aiConnectionService(db).select({ companyId: input.companyId, agentId: input.agentId, userId: input.userId,
          adapterType: effective.adapterType, binding: member.binding, model: effective.config.model,
          runnerProvider: effective.config.provider, acpxAgent: effective.config.acpxAgent });
        const identity = await quotaIdentity(authorized, input.companyId);
        if (identity) memberIdentities.set(member.id, identity);
      } catch (error) {
        if (!(error instanceof HttpError && [400, 401, 403, 404, 409, 422].includes(error.status))) throw error;
      }
    }
    for (const identity of [...new Set([...memberIdentities.values(), ...(legacySourceIdentity ? [legacySourceIdentity] : [])])].sort()) {
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.companyId + ":" + identity}, 0))`);
    }
    if (legacySourceIdentity) {
      try {
        const config = poolMemberRuntimeConfig(pin.member, input.adapterType);
        const selected = await aiConnectionService(db).select({ companyId: input.companyId, agentId: input.agentId, userId: input.userId,
          adapterType: config.adapterType, binding: pin.member.binding, model: config.config.model,
          runnerProvider: config.config.provider, acpxAgent: config.config.acpxAgent });
        if (await quotaIdentity(selected, input.companyId, db, true) !== legacySourceIdentity ||
            !(await accountCooldown(input.companyId, pin.member.binding.connectionId, legacySourceIdentity))) return { kind: "unavailable" };
      } catch (error) {
        if (error instanceof HttpError && [400, 401, 403, 404, 409, 422].includes(error.status)) return { kind: "unavailable" };
        throw error;
      }
    }
    const cooling: Date[] = [];
    const coolingMembers: Array<{ member: AiConnectionPoolMember; effective: ReturnType<typeof poolMemberRuntimeConfig>; retryAt: Date }> = [];
    const commitSelection = async (member: AiConnectionPoolMember, effective: ReturnType<typeof poolMemberRuntimeConfig>, retryAt?: Date) => {
      const selection: AiConnectionRouterSelection = { poolId: input.poolId, memberId: member.id, binding: member.binding, adapterType: effective.adapterType, runtimeConfig: effective.config, notes: effective.notes, ...(row.pool.config.kind === "harness_pool" && (input.environmentId !== undefined || input.expectedSelection.runnerScope) ? { runnerScope: { environmentId: input.environmentId ?? input.expectedSelection.runnerScope?.environmentId ?? null } } : {}) };
      await db.update(aiConnectionTaskPins).set({ selection, member }).where(eq(aiConnectionTaskPins.id, pin.id));
      await db.update(aiConnectionRouterCursors).set({ lastMemberId: member.id, version: sql`${aiConnectionRouterCursors.version} + 1` }).where(eq(aiConnectionRouterCursors.poolId, input.poolId));
      await logActivity(db, { companyId: input.companyId, actorType: "system", actorId: "system", agentId: input.agentId,
        action: "ai_connection.pool_selected", entityType: "tool_connection", entityId: input.poolId,
        details: { memberId: member.id, connectionId: member.binding.connectionId, taskKey: input.taskKey, reason: `provider_${input.failureKind ?? "quota"}_failover`, ...(retryAt ? { retryAt: retryAt.toISOString() } : {}) } });
      return { kind: "selected" as const, selection, ...(retryAt ? { retryAt } : {}) };
    };
    for (const member of members) {
      let effective: ReturnType<typeof poolMemberRuntimeConfig>;
      try {
        effective = poolMemberRuntimeConfig(member, input.adapterType);
        assertPoolAdapterPolicyCompatible(input.sourceAdapterConfig ?? {}, input.adapterType, effective.adapterType, effective.config);
        const authorized = await aiConnectionService(db).select({ companyId: input.companyId, agentId: input.agentId, userId: input.userId,
          adapterType: effective.adapterType, binding: member.binding, model: effective.config.model,
          runnerProvider: effective.config.provider, acpxAgent: effective.config.acpxAgent });
        const identity = await quotaIdentity(authorized, input.companyId, db, true);
        if (!identity || identity !== memberIdentities.get(member.id)) continue;
        const cooldown = await accountCooldown(input.companyId, member.binding.connectionId, identity, row.pool.config.kind === "harness_pool" && (input.environmentId !== undefined || input.expectedSelection.runnerScope) ? { config: effective.config, scope: { environmentId: input.environmentId ?? input.expectedSelection.runnerScope?.environmentId ?? null } } : undefined);
        if (cooldown) { cooling.push(cooldown); coolingMembers.push({ member, effective, retryAt: cooldown }); continue; }
      } catch (error) {
        if (error instanceof HttpError && [400, 401, 403, 404, 409, 422].includes(error.status)) continue;
        throw error;
      }
      return commitSelection(member, effective);
    }
    if (input.allowCoolingSelection && coolingMembers.length) {
      const next = coolingMembers.sort((a, b) => a.retryAt.getTime() - b.retryAt.getTime())[0]!;
      return commitSelection(next.member, next.effective, next.retryAt);
    }
    if (cooling.length) return { kind: "cooldown", retryAt: new Date(Math.min(...cooling.map(date => date.getTime()))) };
    return { kind: "unavailable" };
  }
  async function currentMemberCooldown(input: { companyId: string; agentId: string; userId: string | null; adapterType: string;
    member: AiConnectionPoolMember; failureKind: "quota" | "auth" | "runner"; runnerScope?: PoolRunnerScope; sourceAdapterConfig?: Record<string, unknown> }) {
    try {
      const effective = poolMemberRuntimeConfig(input.member, input.adapterType);
      assertPoolAdapterPolicyCompatible(input.sourceAdapterConfig ?? {}, input.adapterType, effective.adapterType, effective.config);
      const authorized = await aiConnectionService(db).select({ companyId: input.companyId, agentId: input.agentId, userId: input.userId,
        adapterType: effective.adapterType, binding: input.member.binding, model: effective.config.model,
        runnerProvider: effective.config.provider, acpxAgent: effective.config.acpxAgent });
      const identity = await quotaIdentity(authorized, input.companyId);
      if (!identity) return null;
      const runner = input.failureKind === "runner" && input.runnerScope ? { config: effective.config, scope: input.runnerScope } : undefined;
      const failureIdentity = runner ? poolRunnerCooldownIdentity(identity, runner.config, runner.scope.environmentId) : identity;
      const [recorded] = await db.select({ retryAt: aiConnectionQuotaCooldowns.retryAt }).from(aiConnectionQuotaCooldowns).where(and(
        eq(aiConnectionQuotaCooldowns.companyId, input.companyId), eq(aiConnectionQuotaCooldowns.credentialIdentity, failureIdentity)));
      return { recorded: Boolean(recorded), identityHash: createHash("sha256").update(failureIdentity).digest("hex"),
        retryAt: await accountCooldown(input.companyId, input.member.binding.connectionId, identity, runner) };
    } catch (error) {
      if (error instanceof HttpError && [400, 401, 403, 404, 409, 422].includes(error.status)) return null;
      throw error;
    }
  }
  async function recheckPinnedPoolAccount(input: { companyId: string; agentId: string; userId: string | null; taskKey: string; selection: AiConnectionRouterSelection }) {
    const [row] = await db.select().from(aiConnectionPools).where(and(eq(aiConnectionPools.companyId, input.companyId), eq(aiConnectionPools.id, input.selection.poolId)));
    if (!row || row.pluginKey !== BUILTIN_AI_FAILOVER_ROUTER_KEY) return;
    const [pin] = await db.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.companyId, input.companyId),
      eq(aiConnectionTaskPins.poolId, input.selection.poolId), eq(aiConnectionTaskPins.agentId, input.agentId), eq(aiConnectionTaskPins.taskKey, input.taskKey)));
    const adapterType = input.selection.adapterType ?? "claude_local";
    if (!pin || !samePoolSelection(pin.selection, input.selection, adapterType)) throw conflict("The task pool selection changed before provider start");
    const selected = await aiConnectionService(db).select({ companyId: input.companyId, agentId: input.agentId, userId: input.userId,
      adapterType, binding: pin.selection.binding, model: pin.selection.runtimeConfig.model,
      runnerProvider: pin.selection.runtimeConfig.provider, acpxAgent: pin.selection.runtimeConfig.acpxAgent });
    const identity = await quotaIdentity(selected, input.companyId);
    if (!identity) throw unprocessable("The task account identity changed before provider start");
    const retryAt = await accountCooldown(input.companyId, pin.member.binding.connectionId, identity,
      pin.selection.runnerScope ? { config: pin.selection.runtimeConfig, scope: pin.selection.runnerScope } : undefined);
    if (retryAt) throw new AiConnectionPoolExhausted(retryAt.toISOString(), row.id);
  }
  return { catalog, list, selectable, inspect, save, remove, resolve, recordQuotaCooldown, accountCooldown, currentMemberCooldown, transitionQuotaPin, recheckPinnedPoolAccount };
}
