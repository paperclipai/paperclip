import { definePlugin, runWorker, type PluginContext, type PluginEvent } from "@paperclipai/plugin-sdk";
import {
  type AgentCircuitState,
  type CircuitBreakerConfig,
  type TripReason,
  DEFAULT_AGENT_STATE,
  DEFAULT_CONFIG,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers — safe casts from untyped payloads
// ---------------------------------------------------------------------------

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

// ---------------------------------------------------------------------------
// State helpers — per-agent circuit state stored in ctx.state
// ---------------------------------------------------------------------------

const CIRCUIT_STATE_KEY = "circuit";
const TRACKED_AGENTS_KEY = "tracked_agents";

async function getAgentState(ctx: PluginContext, agentId: string): Promise<AgentCircuitState> {
  const raw = await ctx.state.get({
    scopeKind: "agent",
    scopeId: agentId,
    stateKey: CIRCUIT_STATE_KEY,
  });
  const base = raw
    ? { ...DEFAULT_AGENT_STATE, ...(raw as Partial<AgentCircuitState>) }
    : { ...DEFAULT_AGENT_STATE };
  // Deep clone arrays to prevent mutating the shared DEFAULT_AGENT_STATE reference
  base.tokenCostHistory = [...base.tokenCostHistory];
  base.tripReasons = [...base.tripReasons];
  return base;
}

async function saveAgentState(ctx: PluginContext, agentId: string, state: AgentCircuitState): Promise<void> {
  await ctx.state.set(
    { scopeKind: "agent", scopeId: agentId, stateKey: CIRCUIT_STATE_KEY },
    state,
  );
}

/**
 * Maintain a registry of agent IDs the plugin has seen, for cron job scanning.
 *
 * Note: this uses a shared instance-level map with a read-modify-write pattern.
 * The race (two events overwriting each other) is mitigated by the single-threaded
 * worker model — the host dispatches events sequentially via JSON-RPC. A missed
 * agent would be re-added on its next event.
 */
async function trackAgent(ctx: PluginContext, agentId: string, companyId: string): Promise<void> {
  const key = { scopeKind: "instance" as const, stateKey: TRACKED_AGENTS_KEY };
  const existing = (asRecord(await ctx.state.get(key)) ?? {}) as Record<string, string>;
  if (existing[agentId]) return;
  existing[agentId] = companyId;
  await ctx.state.set(key, existing);
}

async function untrackAgent(ctx: PluginContext, agentId: string): Promise<void> {
  const key = { scopeKind: "instance" as const, stateKey: TRACKED_AGENTS_KEY };
  const existing = (asRecord(await ctx.state.get(key)) ?? {}) as Record<string, string>;
  delete existing[agentId];
  await ctx.state.set(key, existing);
}

async function getTrackedAgents(ctx: PluginContext): Promise<Record<string, string>> {
  const key = { scopeKind: "instance" as const, stateKey: TRACKED_AGENTS_KEY };
  return (asRecord(await ctx.state.get(key)) ?? {}) as Record<string, string>;
}

// ---------------------------------------------------------------------------
// Config helpers — merge instance defaults with per-agent overrides
// ---------------------------------------------------------------------------

function parseConfig(raw: Record<string, unknown>): CircuitBreakerConfig {
  const recovery = asRecord(raw.recovery);
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    maxConsecutiveFailures: validInt(raw.maxConsecutiveFailures, 1) ?? DEFAULT_CONFIG.maxConsecutiveFailures,
    maxConsecutiveNoProgress: validInt(raw.maxConsecutiveNoProgress, 1) ?? DEFAULT_CONFIG.maxConsecutiveNoProgress,
    tokenVelocityMultiplier: validFloat(raw.tokenVelocityMultiplier, 1.1) ?? DEFAULT_CONFIG.tokenVelocityMultiplier,
    tokenVelocityWindowSize: validInt(raw.tokenVelocityWindowSize, 4) ?? DEFAULT_CONFIG.tokenVelocityWindowSize,
    recovery: {
      mode: recovery?.mode === "half-open" ? "half-open" : DEFAULT_CONFIG.recovery.mode,
      cooldownMinutes: validInt(recovery?.cooldownMinutes, 5) ?? DEFAULT_CONFIG.recovery.cooldownMinutes,
    },
  };
}

function validInt(v: unknown, min: number): number | undefined {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) return undefined;
  return v;
}

function validFloat(v: unknown, min: number): number | undefined {
  if (typeof v !== "number" || v < min) return undefined;
  return v;
}

async function getMergedConfig(
  ctx: PluginContext,
  agentId: string,
  companyId: string,
): Promise<CircuitBreakerConfig> {
  const instanceRaw = await ctx.config.get();
  const base = parseConfig(instanceRaw);

  // Per-agent override from runtimeConfig.circuitBreaker
  try {
    const agent = await ctx.agents.get(agentId, companyId);
    const override = asRecord(asRecord(agent?.runtimeConfig)?.circuitBreaker);
    if (!override) return base;

    // Merge override fields on top of base
    return {
      enabled: typeof override.enabled === "boolean" ? override.enabled : base.enabled,
      maxConsecutiveFailures: validInt(override.maxConsecutiveFailures, 1) ?? base.maxConsecutiveFailures,
      maxConsecutiveNoProgress: validInt(override.maxConsecutiveNoProgress, 1) ?? base.maxConsecutiveNoProgress,
      tokenVelocityMultiplier: validFloat(override.tokenVelocityMultiplier, 1.1) ?? base.tokenVelocityMultiplier,
      tokenVelocityWindowSize: validInt(override.tokenVelocityWindowSize, 4) ?? base.tokenVelocityWindowSize,
      recovery: {
        mode: override.recovery
          ? (asRecord(override.recovery)?.mode === "half-open" ? "half-open" : "manual")
          : base.recovery.mode,
        cooldownMinutes: override.recovery
          ? (validInt(asRecord(override.recovery)?.cooldownMinutes, 5) ?? base.recovery.cooldownMinutes)
          : base.recovery.cooldownMinutes,
      },
    };
  } catch {
    // Agent may have been deleted between event and config read
    ctx.logger.warn(`Could not read agent ${agentId} for config merge — using instance defaults`);
    return base;
  }
}

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

/**
 * Check if a run made progress by inspecting resultJson in the event payload.
 * Conservatively returns true (progress assumed) when resultJson is absent,
 * so the plugin gracefully degrades before the upstream payload enrichment PR lands.
 */
function checkProgress(payload: Record<string, unknown>): boolean {
  const result = asRecord(payload.resultJson);
  if (!result) return true; // Upstream PR not yet merged — assume progress

  const modified = asNumber(result.issuesModified) ?? 0;
  const created = asNumber(result.issuesCreated) ?? 0;
  const comments = asNumber(result.commentsPosted) ?? 0;
  return modified > 0 || created > 0 || comments > 0;
}

/**
 * Extract a numeric token cost from the event's usage payload.
 * Prefers totalTokens, falls back to inputTokens + outputTokens.
 */
function extractTokenCost(payload: Record<string, unknown>): number | null {
  const usage = asRecord(payload.usage);
  if (!usage) return null;

  const total = asNumber(usage.totalTokens);
  if (total !== undefined) return total;

  const input = asNumber(usage.inputTokens) ?? 0;
  const output = asNumber(usage.outputTokens) ?? 0;
  return input + output > 0 ? input + output : null;
}

/**
 * Check whether the latest run's token cost exceeds the velocity threshold.
 * Skips the check during cold start (< half the window size has been recorded).
 */
function shouldTripVelocity(
  history: number[],
  config: CircuitBreakerConfig,
  latestCost: number,
): boolean {
  const minSamples = Math.ceil(config.tokenVelocityWindowSize / 2);
  if (history.length < minSamples) return false;

  const avg = history.reduce((a, b) => a + b, 0) / history.length;
  if (avg === 0) return false;

  return latestCost > avg * config.tokenVelocityMultiplier;
}

// ---------------------------------------------------------------------------
// Circuit actions — trip and reset
// ---------------------------------------------------------------------------

async function tripCircuit(
  ctx: PluginContext,
  agentId: string,
  companyId: string,
  state: AgentCircuitState,
  reasons: TripReason[],
): Promise<void> {
  state.circuitState = "open";
  state.tripReasons = reasons;
  state.trippedAt = new Date().toISOString();
  await saveAgentState(ctx, agentId, state);

  // Check if the agent needs pausing (may already be paused by budget or operator)
  let agentName = agentId;
  try {
    const agent = await ctx.agents.get(agentId, companyId);
    agentName = agent?.name ?? agentId;
    if (agent && agent.status !== "paused" && agent.status !== "terminated") {
      await ctx.agents.pause(agentId, companyId);
    }
  } catch {
    ctx.logger.warn(`Could not pause agent ${agentId} — it may have been deleted`);
  }

  await ctx.activity.log({
    companyId,
    message: `Circuit breaker tripped for agent ${agentName}: ${reasons.join(", ")}`,
    entityType: "agent",
    entityId: agentId,
    metadata: {
      reasons,
      consecutiveFailures: state.consecutiveFailures,
      consecutiveNoProgress: state.consecutiveNoProgress,
    },
  });

  for (const reason of reasons) {
    await ctx.metrics.write(`circuit_breaker.tripped.${reason}`, 1);
  }
  await ctx.metrics.write("circuit_breaker.tripped", 1);

  await ctx.events.emit("circuit_breaker.tripped", companyId, {
    agentId,
    agentName,
    reasons,
    consecutiveFailures: state.consecutiveFailures,
    consecutiveNoProgress: state.consecutiveNoProgress,
    circuitState: "open",
  });
}

async function resetCircuit(
  ctx: PluginContext,
  agentId: string,
  companyId: string,
  state: AgentCircuitState,
  resetBy: string,
): Promise<void> {
  const previousState = state.circuitState;
  state.circuitState = "closed";
  state.consecutiveFailures = 0;
  state.consecutiveNoProgress = 0;
  state.tripReasons = [];
  state.trippedAt = null;
  await saveAgentState(ctx, agentId, state);

  let agentName = agentId;
  try {
    const agent = await ctx.agents.get(agentId, companyId);
    agentName = agent?.name ?? agentId;
  } catch { /* agent may be deleted */ }

  await ctx.activity.log({
    companyId,
    message: `Circuit breaker reset for agent ${agentName} (${resetBy})`,
    entityType: "agent",
    entityId: agentId,
    metadata: { previousState, resetBy },
  });

  await ctx.metrics.write("circuit_breaker.reset", 1);

  await ctx.events.emit("circuit_breaker.reset", companyId, {
    agentId,
    agentName,
    previousState,
    resetBy,
    circuitState: "closed",
  });
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    // ------------------------------------------------------------------
    // Event: agent.run.finished (succeeded)
    // ------------------------------------------------------------------
    ctx.events.on("agent.run.finished", async (event: PluginEvent) => {
      const payload = asRecord(event.payload) ?? {};
      const agentId = String(payload.agentId ?? event.actorId ?? "");
      const companyId = event.companyId;
      if (!agentId) return;

      const config = await getMergedConfig(ctx, agentId, companyId);
      if (!config.enabled) return;

      await trackAgent(ctx, agentId, companyId);
      const state = await getAgentState(ctx, agentId);

      // If circuit was open but the agent is running, operator must have
      // manually resumed — close the circuit.
      if (state.circuitState === "open") {
        await resetCircuit(ctx, agentId, companyId, state, "manual_resume");
        return;
      }

      // Half-open trial run succeeded — close the circuit
      if (state.circuitState === "half-open") {
        await resetCircuit(ctx, agentId, companyId, state, "half_open_trial");
        return;
      }

      // --- Closed circuit: evaluate detectors ---

      // Reset failure counter (successful run)
      state.consecutiveFailures = 0;

      // No-progress detector
      const hasProgress = checkProgress(payload);
      if (hasProgress) {
        state.consecutiveNoProgress = 0;
      } else {
        state.consecutiveNoProgress += 1;
      }

      // Token velocity detector — evaluate BEFORE appending so the spike
      // does not dilute the rolling average it is compared against.
      const tokenCost = extractTokenCost(payload);

      // Evaluate thresholds
      const tripReasons: TripReason[] = [];

      if (state.consecutiveNoProgress >= config.maxConsecutiveNoProgress) {
        tripReasons.push("no_progress");
      }

      if (tokenCost !== null && shouldTripVelocity(state.tokenCostHistory, config, tokenCost)) {
        tripReasons.push("token_velocity");
      }

      if (tokenCost !== null) {
        state.tokenCostHistory.push(tokenCost);
        if (state.tokenCostHistory.length > config.tokenVelocityWindowSize) {
          state.tokenCostHistory = state.tokenCostHistory.slice(-config.tokenVelocityWindowSize);
        }
      }

      state.lastEventAt = event.occurredAt;

      if (tripReasons.length > 0) {
        await tripCircuit(ctx, agentId, companyId, state, tripReasons);
      } else {
        await saveAgentState(ctx, agentId, state);
      }
    });

    // ------------------------------------------------------------------
    // Event: agent.run.failed
    // ------------------------------------------------------------------
    ctx.events.on("agent.run.failed", async (event: PluginEvent) => {
      const payload = asRecord(event.payload) ?? {};
      const agentId = String(payload.agentId ?? event.actorId ?? "");
      const companyId = event.companyId;
      if (!agentId) return;

      const config = await getMergedConfig(ctx, agentId, companyId);
      if (!config.enabled) return;

      await trackAgent(ctx, agentId, companyId);
      const state = await getAgentState(ctx, agentId);

      // Half-open trial run failed — re-trip immediately
      if (state.circuitState === "half-open") {
        state.consecutiveFailures += 1;
        await tripCircuit(ctx, agentId, companyId, state, ["consecutive_failures"]);
        return;
      }

      // If circuit was open but agent somehow ran, close first then track failure
      if (state.circuitState === "open") {
        state.circuitState = "closed";
        state.consecutiveFailures = 0;
        state.consecutiveNoProgress = 0;
        state.tripReasons = [];
        state.trippedAt = null;
      }

      // --- Closed circuit: evaluate detectors ---

      state.consecutiveFailures += 1;
      // Do NOT reset no-progress counter — failed runs don't prove progress

      // Token velocity detector — evaluate BEFORE appending (same fix as run.finished)
      const tokenCost = extractTokenCost(payload);

      // Evaluate thresholds
      const tripReasons: TripReason[] = [];

      if (state.consecutiveFailures >= config.maxConsecutiveFailures) {
        tripReasons.push("consecutive_failures");
      }

      if (tokenCost !== null && shouldTripVelocity(state.tokenCostHistory, config, tokenCost)) {
        tripReasons.push("token_velocity");
      }

      if (tokenCost !== null) {
        state.tokenCostHistory.push(tokenCost);
        if (state.tokenCostHistory.length > config.tokenVelocityWindowSize) {
          state.tokenCostHistory = state.tokenCostHistory.slice(-config.tokenVelocityWindowSize);
        }
      }

      state.lastEventAt = event.occurredAt;

      if (tripReasons.length > 0) {
        await tripCircuit(ctx, agentId, companyId, state, tripReasons);
      } else {
        await saveAgentState(ctx, agentId, state);
      }
    });

    // ------------------------------------------------------------------
    // Job: half-open-recovery (polls every 5 minutes)
    // ------------------------------------------------------------------
    ctx.jobs.register("half-open-recovery", async () => {
      const instanceConfig = parseConfig(await ctx.config.get());
      if (instanceConfig.recovery.mode !== "half-open") return;

      const tracked = await getTrackedAgents(ctx);

      for (const [agentId, companyId] of Object.entries(tracked)) {
        const state = await getAgentState(ctx, agentId);
        if (state.circuitState !== "open" || !state.trippedAt) continue;

        // Use per-agent merged config for cooldown, not just instance config
        const agentConfig = await getMergedConfig(ctx, agentId, companyId);
        const elapsed = Date.now() - new Date(state.trippedAt).getTime();
        const cooldownMs = agentConfig.recovery.cooldownMinutes * 60 * 1000;
        if (elapsed < cooldownMs) continue;

        try {
          const agent = await ctx.agents.get(agentId, companyId);
          if (!agent) {
            // Agent deleted — clean up state and tracking registry
            await ctx.state.delete({ scopeKind: "agent", scopeId: agentId, stateKey: CIRCUIT_STATE_KEY });
            await untrackAgent(ctx, agentId);
            continue;
          }

          if (agent.status !== "paused") {
            // Agent manually resumed or terminated — close circuit
            await resetCircuit(ctx, agentId, companyId, state, "manual_resume");
            continue;
          }

          // Persist half-open state BEFORE resuming — if resume fails, state
          // is still consistent and the next tick will retry.
          state.circuitState = "half-open";
          await saveAgentState(ctx, agentId, state);
          await ctx.agents.resume(agentId, companyId);

          await ctx.activity.log({
            companyId,
            message: `Circuit breaker entering half-open state for agent ${agent.name} — trial run allowed`,
            entityType: "agent",
            entityId: agentId,
          });

          await ctx.metrics.write("circuit_breaker.half_open", 1);
        } catch (err) {
          ctx.logger.warn(`Half-open recovery failed for agent ${agentId}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });

    // ------------------------------------------------------------------
    // Job: state-cleanup (weekly)
    // ------------------------------------------------------------------
    ctx.jobs.register("state-cleanup", async () => {
      const tracked = await getTrackedAgents(ctx);
      const updated = { ...tracked };
      let removed = 0;

      for (const [agentId, companyId] of Object.entries(tracked)) {
        try {
          const agent = await ctx.agents.get(agentId, companyId);
          if (!agent) {
            await ctx.state.delete({ scopeKind: "agent", scopeId: agentId, stateKey: CIRCUIT_STATE_KEY });
            delete updated[agentId];
            removed++;
          }
        } catch {
          // Agent lookup failed — likely deleted
          await ctx.state.delete({ scopeKind: "agent", scopeId: agentId, stateKey: CIRCUIT_STATE_KEY });
          delete updated[agentId];
          removed++;
        }
      }

      if (removed > 0) {
        await ctx.state.set({ scopeKind: "instance", stateKey: TRACKED_AGENTS_KEY }, updated);
        ctx.logger.info(`State cleanup: removed ${removed} orphaned agent entries`);
      }
    });
  },

  async onValidateConfig(config) {
    const errors: string[] = [];

    if (config.maxConsecutiveFailures !== undefined) {
      const v = config.maxConsecutiveFailures as number;
      if (!Number.isInteger(v) || v < 1) {
        errors.push("maxConsecutiveFailures must be an integer >= 1");
      }
    }

    if (config.maxConsecutiveNoProgress !== undefined) {
      const v = config.maxConsecutiveNoProgress as number;
      if (!Number.isInteger(v) || v < 1) {
        errors.push("maxConsecutiveNoProgress must be an integer >= 1");
      }
    }

    if (config.tokenVelocityMultiplier !== undefined) {
      const v = config.tokenVelocityMultiplier as number;
      if (typeof v !== "number" || v < 1.1) {
        errors.push("tokenVelocityMultiplier must be a number >= 1.1");
      }
    }

    if (config.tokenVelocityWindowSize !== undefined) {
      const v = config.tokenVelocityWindowSize as number;
      if (!Number.isInteger(v) || v < 4) {
        errors.push("tokenVelocityWindowSize must be an integer >= 4");
      }
    }

    const recovery = asRecord(config.recovery);
    if (recovery?.mode && !["manual", "half-open"].includes(recovery.mode as string)) {
      errors.push('recovery.mode must be "manual" or "half-open"');
    }

    if (recovery?.cooldownMinutes !== undefined) {
      const v = recovery.cooldownMinutes as number;
      if (!Number.isInteger(v) || v < 5) {
        errors.push("recovery.cooldownMinutes must be an integer >= 5");
      }
    }

    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  },

  async onHealth() {
    return { status: "ok", message: "Circuit breaker plugin operational" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
