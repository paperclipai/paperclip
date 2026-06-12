import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
  type ScopeKey,
} from "@paperclipai/plugin-sdk";
import {
  DATA_KEYS,
  DEFAULT_CONFIG,
  MAX_RECENT_ANOMALIES,
  METRIC_NAMES,
  PLUGIN_ID,
  STATE_KEYS,
  type CostClipperConfig,
} from "./constants.js";
import { parseCostEvent, type CostAnomaly } from "./contracts.js";
import {
  applyEvent,
  detect,
  emptyCompanyAggregates,
  type CompanyAggregates,
} from "./detector.js";

const PLUGIN_NAME = "cost-clipper";

interface BudgetIncident {
  scopeType: string | null;
  scopeId: string | null;
  reason: string | null;
  openedAt: string | null;
}

function companyScope(companyId: string, stateKey: string): ScopeKey {
  return { scopeKind: "company", scopeId: companyId, stateKey };
}

async function getConfig(ctx: PluginContext): Promise<CostClipperConfig> {
  const raw = (await ctx.config.get()) as Partial<CostClipperConfig>;
  return {
    minSamples: numberOr(raw.minSamples, DEFAULT_CONFIG.minSamples),
    zThreshold: numberOr(raw.zThreshold, DEFAULT_CONFIG.zThreshold),
    absoluteCentsCeiling: numberOr(raw.absoluteCentsCeiling, DEFAULT_CONFIG.absoluteCentsCeiling),
    commentOnAnomaly:
      typeof raw.commentOnAnomaly === "boolean" ? raw.commentOnAnomaly : DEFAULT_CONFIG.commentOnAnomaly,
  };
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function loadAggregates(ctx: PluginContext, companyId: string): Promise<CompanyAggregates> {
  const stored = (await ctx.state.get(companyScope(companyId, STATE_KEYS.aggregates))) as
    | CompanyAggregates
    | null;
  if (stored && typeof stored === "object" && stored.agents) return stored;
  return emptyCompanyAggregates();
}

async function loadAnomalies(ctx: PluginContext, companyId: string): Promise<CostAnomaly[]> {
  const stored = (await ctx.state.get(companyScope(companyId, STATE_KEYS.anomalies))) as
    | CostAnomaly[]
    | null;
  return Array.isArray(stored) ? stored : [];
}

async function loadBudgetIncidents(ctx: PluginContext, companyId: string): Promise<BudgetIncident[]> {
  const stored = (await ctx.state.get(companyScope(companyId, STATE_KEYS.budgetIncidents))) as
    | BudgetIncident[]
    | null;
  return Array.isArray(stored) ? stored : [];
}

function anomalyComment(anomaly: CostAnomaly): string {
  const lines = [
    "**💸 Cost Clipper — anomalous spend detected**",
    "",
    anomaly.reason,
    "",
    `- Agent: \`${anomaly.agentId}\``,
    `- Model / provider: \`${anomaly.model}\` (${anomaly.provider})`,
    `- This event: **$${(anomaly.costCents / 100).toFixed(2)}**`,
  ];
  if (anomaly.meanCents !== null) {
    lines.push(`- Rolling mean for this agent: $${(anomaly.meanCents / 100).toFixed(2)}`);
  }
  if (anomaly.zScore !== null) {
    lines.push(`- Spike size: ${anomaly.zScore}σ`);
  }
  lines.push(`- Rule: \`${anomaly.rule}\``);
  lines.push("");
  lines.push(
    "_This is an early-warning breadcrumb from the Cost Clipper plugin. It does not pause the agent or override budgets._",
  );
  return lines.join("\n");
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} plugin setup`, { pluginId: PLUGIN_ID });

    // --- Cost lens: watch the cost stream, aggregate, and detect anomalies. ---
    ctx.events.on("cost_event.created", async (event: PluginEvent) => {
      const costEvent = parseCostEvent(event.payload, event.companyId);
      if (!costEvent) {
        ctx.logger.warn("Skipping unparseable cost_event.created payload", { eventId: event.eventId });
        return;
      }
      const { companyId } = costEvent;
      const config = await getConfig(ctx);

      const aggregates = await loadAggregates(ctx, companyId);
      const prior = aggregates.agents[costEvent.agentId];

      // Detect against the PRIOR baseline (before folding this event in).
      const detectedAt = event.occurredAt ?? new Date().toISOString();
      const anomaly = detect(prior, costEvent, config, detectedAt);

      // Always fold the event into the rolling aggregate, then persist.
      applyEvent(aggregates, costEvent);
      await ctx.state.set(companyScope(companyId, STATE_KEYS.aggregates), aggregates);

      await ctx.metrics.write(METRIC_NAMES.costEvent, costEvent.costCents, {
        agent: costEvent.agentId,
        model: costEvent.model,
        provider: costEvent.provider,
      });

      if (!anomaly) return;

      ctx.logger.warn("Cost anomaly detected", {
        rule: anomaly.rule,
        agentId: anomaly.agentId,
        costCents: anomaly.costCents,
        zScore: anomaly.zScore,
      });

      await ctx.metrics.write(METRIC_NAMES.anomaly, 1, {
        rule: anomaly.rule,
        agent: anomaly.agentId,
        model: anomaly.model,
        provider: anomaly.provider,
      });

      // Record for the dashboard (newest first, capped).
      const anomalies = await loadAnomalies(ctx, companyId);
      anomalies.unshift(anomaly);
      if (anomalies.length > MAX_RECENT_ANOMALIES) anomalies.length = MAX_RECENT_ANOMALIES;
      await ctx.state.set(companyScope(companyId, STATE_KEYS.anomalies), anomalies);

      // Leave a breadcrumb on the offending issue when we can attribute one.
      if (config.commentOnAnomaly && costEvent.issueId) {
        try {
          await ctx.issues.createComment(costEvent.issueId, anomalyComment(anomaly), companyId);
        } catch (error) {
          ctx.logger.error("Failed to post cost anomaly comment", {
            issueId: costEvent.issueId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });

    // --- Correlate with real budget hard-stops so the dashboard lines up. ---
    ctx.events.on("budget.incident.opened", async (event: PluginEvent) => {
      const companyId = event.companyId;
      if (!companyId) return;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const incidents = await loadBudgetIncidents(ctx, companyId);
      incidents.unshift({
        scopeType: stringOrNull(payload.scopeType),
        scopeId: stringOrNull(payload.scopeId),
        reason: stringOrNull(payload.reason) ?? stringOrNull(payload.pauseReason),
        openedAt: event.occurredAt ?? null,
      });
      if (incidents.length > MAX_RECENT_ANOMALIES) incidents.length = MAX_RECENT_ANOMALIES;
      await ctx.state.set(companyScope(companyId, STATE_KEYS.budgetIncidents), incidents);
      ctx.logger.warn("Budget incident opened", { companyId });
    });

    ctx.events.on("budget.incident.resolved", async (event: PluginEvent) => {
      const companyId = event.companyId;
      if (!companyId) return;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const resolvedScopeId = stringOrNull(payload.scopeId);
      const incidents = await loadBudgetIncidents(ctx, companyId);
      const remaining = resolvedScopeId
        ? incidents.filter((incident) => incident.scopeId !== resolvedScopeId)
        : [];
      await ctx.state.set(companyScope(companyId, STATE_KEYS.budgetIncidents), remaining);
      ctx.logger.info("Budget incident resolved", { companyId });
    });

    // --- Dashboard data handler backing the widget. ---
    ctx.data.register(DATA_KEYS.overview, async (params) => {
      const companyId = stringOrNull(params.companyId);
      if (!companyId) {
        return { configured: false, topSpenders: [], recentAnomalies: [], openBudgetIncidents: [] };
      }
      const config = await getConfig(ctx);
      const aggregates = await loadAggregates(ctx, companyId);
      const anomalies = await loadAnomalies(ctx, companyId);
      const incidents = await loadBudgetIncidents(ctx, companyId);

      const topSpenders = Object.values(aggregates.agents)
        .map((agg) => ({
          agentId: agg.agentId,
          totalCents: agg.totalCents,
          count: agg.count,
          meanCents: Math.round(agg.mean),
          byModel: agg.byModel,
          byProvider: agg.byProvider,
          lastOccurredAt: agg.lastOccurredAt,
        }))
        .sort((a, b) => b.totalCents - a.totalCents)
        .slice(0, 10);

      return {
        configured: true,
        config,
        topSpenders,
        recentAnomalies: anomalies.slice(0, 20),
        openBudgetIncidents: incidents,
      };
    });
  },

  async onHealth() {
    return { status: "ok", message: `${PLUGIN_NAME} ready` };
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    const c = config as Partial<CostClipperConfig>;
    if (c.minSamples !== undefined && (!Number.isFinite(Number(c.minSamples)) || Number(c.minSamples) < 2)) {
      errors.push("minSamples must be an integer >= 2");
    }
    if (c.zThreshold !== undefined && (!Number.isFinite(Number(c.zThreshold)) || Number(c.zThreshold) < 1)) {
      errors.push("zThreshold must be a number >= 1");
    }
    if (
      c.absoluteCentsCeiling !== undefined &&
      (!Number.isFinite(Number(c.absoluteCentsCeiling)) || Number(c.absoluteCentsCeiling) < 1)
    ) {
      errors.push("absoluteCentsCeiling must be an integer >= 1");
    }
    return { ok: errors.length === 0, errors };
  },
});

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export default plugin;
runWorker(plugin, import.meta.url);
