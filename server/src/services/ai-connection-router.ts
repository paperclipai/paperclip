import type { ConnectionManagementContext } from "./connection-management.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { reopenNativeQuotaPoolWaits } from "./native-runtime/native-quota-wake.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, gt, ne, sql } from "drizzle-orm";
import { aiConnectionPools, aiConnectionQuotaCooldowns, aiConnectionRouterCursors, aiConnectionTaskPins, companySecrets, connectionGrants, instanceSettings, plugins, toolApplications, toolConnections, toolConnectionInstalls, type Db } from "@paperclipai/db";
import { BUILTIN_AI_FAILOVER_ROUTER_KEY, aiConnectionMetadataSchema, aiConnectionRouterAppDefinition, aiConnectionRouterSlug, aiConnectionPoolConfigSchema, isAiConnectionCompatible, type AiConnectionPool, type AiConnectionPoolMember, type AiConnectionRouterRequest, type AiConnectionRouterSelection, type AiConnectionPoolSaveInput, type AiConnectionUsage } from "@paperclipai/shared";
import { isCodexLocalKnownModel, codexLocalReasoningEffortsForModel } from "@paperclipai/adapter-codex-local";
import { models as claudeModels, claudeLocalReasoningEffortsForModel } from "@paperclipai/adapter-claude-local";
import { models as grokModels, grokLocalReasoningEffortsForModel } from "@paperclipai/adapter-grok-local";
import { aiConnectionService } from "./ai-connections.js";
import { instanceSettingsService } from "./instance-settings.js";
import { logActivity } from "./activity-log.js";
import { HttpError, forbidden, notFound, conflict, unprocessable } from "../errors.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { resolvePaperclipRunnerProviderProfile, resolvePaperclipRunnerNativeProviderInput } from "./native-runtime/provider-profile.js";

const usageCache = new Map<string, { expires: number; value: AiConnectionUsage }>();
const usageInFlight = new Map<string, Promise<AiConnectionUsage | undefined>>();
const routedRuntimeKeys = new Set(["provider", "acpxAgent", "model", "modelReasoningEffort", "reasoningEffort", "effort", "variant"]);
export function applyAiConnectionRouterTaskSettings(config: Record<string, unknown>, selection: AiConnectionRouterSelection) {
  return { ...Object.fromEntries(Object.entries(config).filter(([key]) => !routedRuntimeKeys.has(key))), ...selection.runtimeConfig };
}
export class AiConnectionPoolExhausted extends Error {
  readonly code = "ai_connection_pool_exhausted";
  constructor(readonly retryAt: string, readonly poolId: string) { super("All eligible pool accounts are over their usage limit. Waiting for usage to reset."); }
}

/** Routing can override provider/model only, never environment, permissions, or instructions. */
export function poolMemberRuntimeConfig(member: AiConnectionPoolMember, adapterType: string, overrides: Record<string, unknown> = {}) {
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
  const effortKey = adapterType === "paperclip_runner" ? profile.provider === "codex" || (profile.provider === "acpx" && profile.acpxAgent === "claude") ? "modelReasoningEffort" : null
    : provider === "anthropic" ? "effort" : provider === "xai" ? "reasoningEffort" : provider === "openai" ? "modelReasoningEffort" : "variant";
  const requested = overrides.modelReasoningEffort ?? overrides.reasoningEffort ?? overrides.effort ?? overrides.variant;
  const effort = typeof requested === "string" && efforts.includes(requested) && effortKey ? requested
    : profile.effort && efforts.includes(profile.effort) && effortKey ? profile.effort : null;
  if (requested && requested !== effort) notes.push("Effort override is unavailable for this member; using its default.");
  if (effort && effortKey) config[effortKey] = effort;
  validate();
  return { config, notes };
}

// The snapshot comes from managed runtime preparation; the responsible user is
// deliberately omitted because one grant can be shared by several users.
export function quotaIdentityFromSessionSnapshot(grantId: string, snapshot: string): string | null {
  if (!snapshot.startsWith(`${grantId}:`)) return null;
  const suffix = snapshot.match(/:(no-auth|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]+)$/i)?.[1];
  return suffix ? suffix === "no-auth" ? `grant:${grantId}:no-auth` : `secret:${suffix.toLowerCase()}` : null;
}

export function aiConnectionRouterService(db: Db, workerManager?: PluginWorkerManager) {
  async function recordQuotaCooldown(companyId: string, connectionId: string, credentialIdentity: string, retryAt: Date) {
    void connectionId;
    await db.transaction(async tx => {
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.executionReplacement);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${companyId + ":" + credentialIdentity}, 0))`);
    await tx.insert(aiConnectionQuotaCooldowns).values({ companyId, credentialIdentity, retryAt }).onConflictDoUpdate({
      target: [aiConnectionQuotaCooldowns.companyId, aiConnectionQuotaCooldowns.credentialIdentity],
      set: { retryAt: sql`greatest(${aiConnectionQuotaCooldowns.retryAt}, excluded.retry_at)`, updatedAt: new Date() },
    });
    });
  }
  async function accountCooldown(companyId: string, connectionId: string, credentialIdentity: string): Promise<Date | null> {
    void connectionId;
    const [row] = await db.select({ retryAt: aiConnectionQuotaCooldowns.retryAt }).from(aiConnectionQuotaCooldowns)
      .where(and(eq(aiConnectionQuotaCooldowns.companyId, companyId), eq(aiConnectionQuotaCooldowns.credentialIdentity, credentialIdentity)));
    return row && row.retryAt.getTime() > Date.now() ? row.retryAt : null;
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
  async function selectable(companyId: string, userId: string) {
    const experimental = (await instanceSettingsService(db).getExperimental()).enableAiConnectionRouters;
    const accounts = await aiConnectionService(db).list(companyId, userId);
    const result: AiConnectionPool[] = [];
    for (const pool of await list(companyId)) {
      if (!pool.enabled) continue;
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
    const result: Record<string, { reason: string; checkedAt: string | null; usage?: AiConnectionUsage }> = {};
    for (const member of pool.members) {
      const account = visible.find(account => account.id === member.binding.connectionId && account.grantId === member.binding.grantId);
      const key = account ? await usageCacheKey(member, companyId) : null;
      const cached = key ? usageCache.get(`${key}:${userId}`) : undefined;
      const observation = cached && cached.expires > Date.now() ? cached.value : undefined;
      result[member.id] = { reason: account?.status === "connected" ? "Eligible if agent access permits" : account?.status ?? "Not permitted", checkedAt: account && observation ? observation.checkedAt : null, ...(account && observation ? { usage: observation } : {}) };
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
      if (!visible.some((v) => v.id === member.binding.connectionId && v.grantId === member.binding.grantId)) throw forbidden("Choose an account you may use in this company");
      poolMemberRuntimeConfig(member, "paperclip_runner");
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
  async function quotaIdentity(selection: Awaited<ReturnType<ReturnType<typeof aiConnectionService>["select"]>>, companyId: string, client = db): Promise<string | null> {
    const ref = selection.grant.credentialSecretRefs.find((r) => r.configPath === "ai.credential");
    if (!ref) {
      const metadata = aiConnectionMetadataSchema.safeParse(selection.connection.config.ai);
      return metadata.success && metadata.data.routing?.auth === "none" ? `grant:${selection.grant.id}:no-auth` : null;
    }
    const [secret] = await client.select({ epoch: companySecrets.aiSessionEpoch }).from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, ref.secretId)));
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
    const cached = usageCache.get(key);
    if (cached || usageInFlight.has(key)) {
      const visible = await aiConnectionService(db).list(companyId, userId);
      if (!visible.some(account => account.id === member.binding.connectionId && account.grantId === member.binding.grantId)) return undefined;
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

  async function resolve(input: { companyId: string; poolId: string; agentId: string; userId: string | null; adapterType: string; taskKey: string; overrides?: Record<string, unknown>; existingGrantId?: string; requireExisting?: boolean; persisted?: AiConnectionRouterSelection }) {
    const pinWhere = and(eq(aiConnectionTaskPins.companyId, input.companyId), eq(aiConnectionTaskPins.poolId, input.poolId), eq(aiConnectionTaskPins.agentId, input.agentId), eq(aiConnectionTaskPins.taskKey, input.taskKey));
    const validateSelection = async (selection: AiConnectionRouterSelection, client = db) => aiConnectionService(client).select({ companyId: input.companyId, agentId: input.agentId, userId: input.userId, adapterType: input.adapterType, binding: selection.binding, model: selection.runtimeConfig.model, runnerProvider: selection.runtimeConfig.provider, acpxAgent: selection.runtimeConfig.acpxAgent });
    if (input.persisted) {
      if (input.persisted.poolId !== input.poolId) throw unprocessable("Persisted pool selection does not match this run");
      if (input.adapterType !== "paperclip_runner") {
        const [pool] = await db.select({ pluginKey: aiConnectionPools.pluginKey }).from(aiConnectionPools)
          .where(and(eq(aiConnectionPools.companyId, input.companyId), eq(aiConnectionPools.id, input.poolId)));
        if (pool?.pluginKey === BUILTIN_AI_FAILOVER_ROUTER_KEY) throw unprocessable("The built-in failover pool requires the Paperclip runner; migrate this agent before using the pool");
      }
      if (input.requireExisting && (input.persisted.binding.mode === "responsible_user" || input.persisted.binding.grantId !== input.existingGrantId)) throw unprocessable("Reset this task session before adopting the connection pool");
      const [pin] = await db.select().from(aiConnectionTaskPins).where(pinWhere);
      // Uninstall can remove the virtual connection. Server-owned native recovery
      // evidence still authorizes the original concrete selection, never a new one.
      if (pin && (pin.selection.memberId !== input.persisted.memberId || JSON.stringify(pin.selection.binding) !== JSON.stringify(input.persisted.binding))) throw unprocessable("Persisted pool allocation is inconsistent");
      await validateSelection(input.persisted);
      return input.persisted;
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      const [record] = await db.select({ pool: aiConnectionPools, connectionStatus: toolConnections.status }).from(aiConnectionPools)
        .innerJoin(toolConnections, and(eq(toolConnections.id, aiConnectionPools.id), eq(toolConnections.companyId, aiConnectionPools.companyId)))
        .where(and(eq(aiConnectionPools.id, input.poolId), eq(aiConnectionPools.companyId, input.companyId)));
      if (!record || record.connectionStatus === "archived") throw unprocessable("This connection pool is unavailable; choose another AI connection");
      const row = record.pool;
      if (!row.config.enabled) throw unprocessable("Enable the selected connection pool");
      const builtin = row.pluginKey === BUILTIN_AI_FAILOVER_ROUTER_KEY;
      if (builtin && input.adapterType !== "paperclip_runner") throw unprocessable("The built-in failover pool requires the Paperclip runner; migrate this agent before using the pool");
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
      for (const member of pin ? [pin.member] : pool.members) {
        try {
          const effective = poolMemberRuntimeConfig(member, input.adapterType, input.overrides);
          const selection: AiConnectionRouterSelection = { poolId: row.id, memberId: member.id, binding: member.binding, runtimeConfig: effective.config, notes: effective.notes };
          const authorized = await validateSelection(selection);
          const identity = await quotaIdentity(authorized, input.companyId);
          if (!identity) continue;
          identities.set(member.id, identity);
          candidates.push({ member, runtimeConfig: effective.config, notes: effective.notes });
        } catch (error) { if (pin) throw error; }
      }
      if (!pin && input.requireExisting) {
        const existing = candidates.find((candidate) => candidate.member.binding.grantId === input.existingGrantId);
        if (!existing) throw unprocessable("Reset this task session before adopting the connection pool");
        candidates.splice(0, candidates.length, existing);
      }
      if (pool.mode === "failover") {
        const cooling: Date[] = [];
        const available: typeof candidates = [];
        for (const candidate of candidates) {
          const retryAt = await accountCooldown(input.companyId, candidate.member.binding.connectionId, identities.get(candidate.member.id)!);
          if (retryAt) { cooling.push(retryAt); continue; }
          // Existing task affinity is never moved on a usage observation: it
          // may have an active or recoverable provider session. This read-only
          // preflight applies only before the initial task selection.
          if (builtin && !pin && input.userId && Date.now() < deadline) {
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
      const selected: AiConnectionRouterSelection = { poolId: row.id, memberId: candidate.member.id, binding: candidate.member.binding, runtimeConfig: candidate.runtimeConfig, notes: candidate.notes };
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
          const [cooldown] = await tx.select().from(aiConnectionQuotaCooldowns).where(and(eq(aiConnectionQuotaCooldowns.companyId, input.companyId), eq(aiConnectionQuotaCooldowns.credentialIdentity, identities.get(candidate.member.id)!), gt(aiConnectionQuotaCooldowns.retryAt, new Date())));
          if (cooldown) return { retry: true };
        }
        const authorized = await validateSelection(selected, tx as unknown as Db);
        if (await quotaIdentity(authorized, input.companyId, tx as unknown as Db) !== identities.get(candidate.member.id)) return { retry: true };
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
  }): Promise<{ kind: "selected"; selection: AiConnectionRouterSelection } | { kind: "cooldown"; retryAt: Date } | { kind: "unavailable" }> {
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
    if (input.adapterType !== "paperclip_runner" || !cursor || !row || row.connectionStatus === "archived" || !row.pool.config.enabled ||
        row.pool.pluginKey !== BUILTIN_AI_FAILOVER_ROUTER_KEY || row.pool.config.mode !== "failover" ||
        !pin || !isDeepStrictEqual(pin.selection, input.expectedSelection)) return { kind: "unavailable" };
    const members = row.pool.config.members.filter((member) => !input.attemptedMemberIds.includes(member.id));
    const memberIdentities = new Map<string, string>();
    for (const member of members) {
      try {
        const effective = poolMemberRuntimeConfig(member, input.adapterType);
        const authorized = await aiConnectionService(db).select({ companyId: input.companyId, agentId: input.agentId, userId: input.userId,
          adapterType: input.adapterType, binding: member.binding, model: effective.config.model,
          runnerProvider: effective.config.provider, acpxAgent: effective.config.acpxAgent });
        const identity = await quotaIdentity(authorized, input.companyId);
        if (identity) memberIdentities.set(member.id, identity);
      } catch (error) {
        if (!(error instanceof HttpError && [400, 401, 403, 404, 409, 422].includes(error.status))) throw error;
      }
    }
    for (const identity of [...new Set(memberIdentities.values())].sort()) {
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.companyId + ":" + identity}, 0))`);
    }
    const cooling: Date[] = [];
    for (const member of members) {
      let effective: ReturnType<typeof poolMemberRuntimeConfig>;
      try {
        effective = poolMemberRuntimeConfig(member, input.adapterType);
        const authorized = await aiConnectionService(db).select({ companyId: input.companyId, agentId: input.agentId, userId: input.userId,
          adapterType: input.adapterType, binding: member.binding, model: effective.config.model,
          runnerProvider: effective.config.provider, acpxAgent: effective.config.acpxAgent });
        const identity = await quotaIdentity(authorized, input.companyId);
        if (!identity || identity !== memberIdentities.get(member.id)) continue;
        const cooldown = await accountCooldown(input.companyId, member.binding.connectionId, identity);
        if (cooldown) { cooling.push(cooldown); continue; }
      } catch (error) {
        if (error instanceof HttpError && [400, 401, 403, 404, 409, 422].includes(error.status)) continue;
        throw error;
      }
      const selection: AiConnectionRouterSelection = { poolId: input.poolId, memberId: member.id, binding: member.binding, runtimeConfig: effective.config, notes: effective.notes };
      await db.update(aiConnectionTaskPins).set({ selection, member }).where(eq(aiConnectionTaskPins.id, pin.id));
      await db.update(aiConnectionRouterCursors).set({ lastMemberId: member.id, version: sql`${aiConnectionRouterCursors.version} + 1` }).where(eq(aiConnectionRouterCursors.poolId, input.poolId));
      await logActivity(db, { companyId: input.companyId, actorType: "system", actorId: "system", agentId: input.agentId,
        action: "ai_connection.pool_selected", entityType: "tool_connection", entityId: input.poolId,
        details: { memberId: member.id, connectionId: member.binding.connectionId, taskKey: input.taskKey, reason: "provider_quota_failover" } });
      return { kind: "selected", selection };
    }
    if (cooling.length) return { kind: "cooldown", retryAt: new Date(Math.min(...cooling.map(date => date.getTime()))) };
    return { kind: "unavailable" };
  }
  return { catalog, list, selectable, inspect, save, remove, resolve, recordQuotaCooldown, accountCooldown, transitionQuotaPin };
}
