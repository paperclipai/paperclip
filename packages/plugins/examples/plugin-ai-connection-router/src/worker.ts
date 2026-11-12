import { definePlugin, runWorker, type AiConnectionRouterRequest, type PluginContext, type PluginEvent, type ScopeKey } from "@paperclipai/plugin-sdk";
import { accountKey, namedReset, nextCooldown, routeAiConnection, type Cooldown } from "./policy.js";

/** Plugin state never holds credentials: only opaque connection/grant IDs and timestamps. */
interface Selection { companyId: string; connectionId: string; grantId: string; memberId: string; at: string }

const HEARTBEAT_TASK_KEY = "__heartbeat__";
let context: PluginContext | null = null;

/**
 * A learned cool-down belongs to the agent whose run reported the quota failure. The failure code is derived
 * from run output, so it is not trusted to exclude a shared account for other agents: only the host's
 * authenticated usage read (candidate usage) does that.
 */
const cooldownKey = (agentId: string, account: string): ScopeKey => ({ scopeKind: "agent", scopeId: agentId, namespace: "cooldowns", stateKey: account });
const selectionKey = (agentId: string, taskKey: string): ScopeKey => ({ scopeKind: "agent", scopeId: agentId, namespace: "selections", stateKey: taskKey });
const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
const isCooldown = (value: unknown): value is Cooldown => !!value && typeof value === "object" && typeof (value as Cooldown).until === "string" && typeof (value as Cooldown).strikes === "number";
const isSelection = (value: unknown): value is Selection => !!value && typeof value === "object" && typeof (value as Selection).connectionId === "string" && typeof (value as Selection).grantId === "string";

/** Fail open: unreadable state routes without cool-downs instead of stalling the pool. */
async function readCooldowns(ctx: PluginContext | null, request: AiConnectionRouterRequest): Promise<Map<string, Cooldown>> {
  const cooldowns = new Map<string, Cooldown>();
  if (!ctx) return cooldowns;
  try {
    for (const candidate of request.candidates) {
      const account = accountKey(candidate.member.binding);
      const value = await ctx.state.get(cooldownKey(request.agentId, account));
      if (isCooldown(value)) cooldowns.set(account, value);
    }
    return cooldowns;
  } catch (error) {
    ctx.logger.warn("Plugin state is unreadable; routing without learned cool-downs", { error: String(error) });
    return new Map();
  }
}

/**
 * Finds the selection this run used. Task keys follow the host: issue, else timer heartbeat, else run ID.
 * The host routes before a run ends, so a selection made after this run finished belongs to a later run:
 * a redelivered or late event must not consume or learn from it.
 */
async function takeSelection(ctx: PluginContext, event: PluginEvent, agentId: string, runId: string) {
  const payload = event.payload as Record<string, unknown>;
  const issueId = text(payload.issueId);
  const endedAt = Date.parse(text(payload.finishedAt) ?? event.occurredAt);
  for (const taskKey of issueId ? [issueId, runId] : [runId, HEARTBEAT_TASK_KEY]) {
    const value = await ctx.state.get(selectionKey(agentId, taskKey));
    if (!isSelection(value) || value.companyId !== event.companyId) continue;
    if (Number.isFinite(endedAt) && Date.parse(value.at) > endedAt) return null;
    return { key: selectionKey(agentId, taskKey), selection: value };
  }
  return null;
}

async function onTerminalRun(event: PluginEvent, succeeded: boolean) {
  const ctx = context;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const agentId = text(payload.agentId);
  const runId = text(payload.runId) ?? text(event.entityId);
  if (!ctx || !agentId || !runId) return;
  const found = await takeSelection(ctx, event, agentId, runId);
  if (!found) return;
  const key = cooldownKey(agentId, accountKey(found.selection));
  if (succeeded) await ctx.state.delete(key);
  else if (payload.errorCode === "provider_quota") {
    const previous = await ctx.state.get(key);
    const now = Date.parse(event.occurredAt) || Date.now();
    await ctx.state.set(key, nextCooldown(isCooldown(previous) ? previous : null, runId, now, namedReset(payload, now)));
  }
  // Consume last, so a redelivery after a partial failure repeats an idempotent update.
  await ctx.state.delete(found.key);
}

const plugin = definePlugin({
  async setup(ctx) {
    context = ctx;
    ctx.events.on("agent.run.failed", event => onTerminalRun(event, false));
    ctx.events.on("agent.run.finished", event => onTerminalRun(event, true));
  },

  async onRouteAiConnection(request) {
    const ctx = context;
    const result = routeAiConnection(request, await readCooldowns(ctx, request));
    if (result.kind === "selected" && ctx) {
      const member = request.candidates.find(candidate => candidate.member.id === result.memberId)!.member;
      const selection: Selection = { companyId: request.companyId, connectionId: member.binding.connectionId, grantId: member.binding.grantId, memberId: member.id, at: request.now };
      await ctx.state.set(selectionKey(request.agentId, request.taskKey), selection)
        .catch(error => ctx.logger.warn("Could not record the pool selection; its quota failures will not be learned", { error: String(error) }));
    }
    return result;
  },

  async onHealth() {
    return { status: "ok", message: "Reference AI connection router is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
