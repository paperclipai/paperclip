import { definePlugin, runWorker, type PluginContext, type PluginApiRequestInput } from "@paperclipai/plugin-sdk";

type AgentTokenRow = {
  agentId: string;
  agentName: string;
  inputTokensMonthly: number;
  cachedInputTokensMonthly: number;
  outputTokensMonthly: number;
  subscriptionRunCount: number;
  apiRunCount: number;
};

type RunRow = {
  id: string;
  agentId: string;
  agentName: string;
  status: string;
  model: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  startedAt: string | null;
  finishedAt: string | null;
};

function currentUtcMonthWindow() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)).toISOString(),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)).toISOString(),
  };
}

async function fetchTokenTotals(ctx: PluginContext, companyId: string): Promise<{ rows: AgentTokenRow[] }> {
  const { start, end } = currentUtcMonthWindow();

  const rows = await ctx.db.query<{
    agent_id: string;
    agent_name: string;
    input_tokens_monthly: string;
    cached_input_tokens_monthly: string;
    output_tokens_monthly: string;
    subscription_run_count: string;
    api_run_count: string;
  }>(
    `SELECT
       ce.agent_id,
       a.name AS agent_name,
       COALESCE(SUM(ce.input_tokens), 0)::bigint AS input_tokens_monthly,
       COALESCE(SUM(ce.cached_input_tokens), 0)::bigint AS cached_input_tokens_monthly,
       COALESCE(SUM(ce.output_tokens), 0)::bigint AS output_tokens_monthly,
       COUNT(*) FILTER (WHERE ce.billing_type = 'subscription_included') AS subscription_run_count,
       COUNT(*) FILTER (WHERE ce.billing_type IN ('metered_api', 'subscription_overage')) AS api_run_count
     FROM cost_events ce
     JOIN agents a ON a.id = ce.agent_id
     WHERE ce.company_id = $1
       AND ce.occurred_at >= $2::timestamptz
       AND ce.occurred_at < $3::timestamptz
     GROUP BY ce.agent_id, a.name
     ORDER BY a.name`,
    [companyId, start, end],
  );

  return {
    rows: rows.map((r) => ({
      agentId: r.agent_id,
      agentName: r.agent_name,
      inputTokensMonthly: Number(r.input_tokens_monthly),
      cachedInputTokensMonthly: Number(r.cached_input_tokens_monthly),
      outputTokensMonthly: Number(r.output_tokens_monthly),
      subscriptionRunCount: Number(r.subscription_run_count),
      apiRunCount: Number(r.api_run_count),
    })),
  };
}

async function fetchRuns(
  ctx: PluginContext,
  companyId: string,
  agentId?: string,
): Promise<{ rows: RunRow[] }> {
  const bindParams: string[] = agentId ? [companyId, agentId] : [companyId];
  const agentFilter = agentId ? `AND hr.agent_id = $2` : "";

  const rows = await ctx.db.query<{
    id: string;
    agent_id: string;
    agent_name: string;
    status: string;
    model: string | null;
    input_tokens: string;
    cached_input_tokens: string;
    output_tokens: string;
    cost_usd: string | null;
    started_at: string | null;
    finished_at: string | null;
  }>(
    `SELECT
       hr.id,
       hr.agent_id,
       a.name AS agent_name,
       hr.status,
       (hr.usage_json ->> 'model') AS model,
       COALESCE((hr.usage_json ->> 'input_tokens')::bigint, 0) AS input_tokens,
       COALESCE((hr.usage_json ->> 'cache_read_input_tokens')::bigint, 0) AS cached_input_tokens,
       COALESCE((hr.usage_json ->> 'output_tokens')::bigint, 0) AS output_tokens,
       COALESCE(
         (hr.result_json ->> 'costUsd')::numeric,
         (hr.result_json ->> 'cost_usd')::numeric,
         (hr.result_json ->> 'total_cost_usd')::numeric
       ) AS cost_usd,
       hr.started_at,
       hr.finished_at
     FROM heartbeat_runs hr
     JOIN agents a ON a.id = hr.agent_id
     WHERE hr.company_id = $1 ${agentFilter}
     ORDER BY hr.started_at DESC NULLS LAST
     LIMIT 200`,
    bindParams,
  );

  return {
    rows: rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      agentName: r.agent_name,
      status: r.status,
      model: r.model ?? null,
      inputTokens: Number(r.input_tokens),
      cachedInputTokens: Number(r.cached_input_tokens),
      outputTokens: Number(r.output_tokens),
      costUsd: r.cost_usd != null ? Number(r.cost_usd) : null,
      startedAt: r.started_at ?? null,
      finishedAt: r.finished_at ?? null,
    })),
  };
}

let _ctx: PluginContext | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    _ctx = ctx;
    ctx.logger.info("agent-token-monitor plugin ready");

    ctx.data.register("token-totals", async (params) => {
      const companyId = String(params?.companyId ?? "");
      if (!companyId) return { rows: [] };
      return fetchTokenTotals(ctx, companyId);
    });

    ctx.data.register("runs", async (params) => {
      const companyId = String(params?.companyId ?? "");
      const agentId = params?.agentId ? String(params.agentId) : undefined;
      if (!companyId) return { rows: [] };
      return fetchRuns(ctx, companyId, agentId);
    });
  },

  async onApiRequest(input: PluginApiRequestInput) {
    const ctx = _ctx;
    if (!ctx) return { status: 503, body: { error: "worker_not_ready" } };

    const { routeKey, params, query } = input;
    const companyId = String(params.companyId ?? "");

    if (routeKey === "token-totals") {
      return { status: 200, body: await fetchTokenTotals(ctx, companyId) };
    }

    if (routeKey === "runs") {
      const agentId = typeof query.agentId === "string" ? query.agentId : undefined;
      return { status: 200, body: await fetchRuns(ctx, companyId, agentId) };
    }

    return { status: 404, body: { error: "not_found" } };
  },

  async onHealth() {
    return { status: "ok", message: "agent-token-monitor worker running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
