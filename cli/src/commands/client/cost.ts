import { Command } from "commander";
import {
  createCostEventSchema,
  type CostByAgent,
  type CostByAgentModel,
  type CostByBiller,
  type CostByProject,
  type CostByProviderModel,
  type CostEvent,
  type CostSummary,
  type IssueCostSummary,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface CostRangeOptions extends BaseClientOptions {
  companyId?: string;
  from?: string;
  to?: string;
}

interface CostReportOptions extends BaseClientOptions {
  companyId?: string;
  agentId: string;
  issueId?: string;
  projectId?: string;
  goalId?: string;
  heartbeatRunId?: string;
  billingCode?: string;
  provider: string;
  biller?: string;
  billingType?: string;
  model: string;
  inputTokens?: string;
  cachedInputTokens?: string;
  outputTokens?: string;
  costCents: string;
  occurredAt?: string;
}

function buildRangeQuery(opts: { from?: string; to?: string }): string {
  const params = new URLSearchParams();
  if (opts.from) params.set("from", opts.from);
  if (opts.to) params.set("to", opts.to);
  const s = params.toString();
  return s ? `?${s}` : "";
}

function addRangeOptions(cmd: Command): Command {
  return cmd
    .option("--from <iso>", "Start of date range (ISO 8601)")
    .option("--to <iso>", "End of date range (ISO 8601)");
}

function parseIntOpt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return n;
}

export function registerCostCommands(program: Command): void {
  const cost = program.command("cost").description("LLM cost tracking and breakdowns");

  addCommonClientOptions(
    addRangeOptions(
      cost
        .command("summary")
        .description("Total spend, budget, and utilization for a company")
        .requiredOption("-C, --company-id <id>", "Company ID"),
    ).action(async (opts: CostRangeOptions) => {
      try {
        const ctx = resolveCommandContext(opts, { requireCompany: true });
        const row = await ctx.api.get<CostSummary>(
          `/api/companies/${ctx.companyId}/costs/summary${buildRangeQuery(opts)}`,
        );
        printOutput(row, { json: ctx.json });
      } catch (err) {
        handleCommandError(err);
      }
    }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    cost
      .command("issue-summary")
      .description("Aggregated cost for an issue tree")
      .argument("<issueId>", "Issue ID or identifier (e.g. ENG-12)")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<IssueCostSummary>(
            `/api/issues/${encodeURIComponent(issueId)}/cost-summary`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  const by = cost.command("by").description("Cost breakdowns by dimension");

  const byDimensions: Array<{
    name: string;
    path: string;
    description: string;
    keys: (row: any) => Record<string, unknown>;
  }> = [
    {
      name: "agent",
      path: "by-agent",
      description: "Cost grouped by agent",
      keys: (r: CostByAgent) => ({
        agentId: r.agentId,
        agentName: r.agentName ?? null,
        costCents: r.costCents,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        apiRunCount: r.apiRunCount,
        subscriptionRunCount: r.subscriptionRunCount,
      }),
    },
    {
      name: "agent-model",
      path: "by-agent-model",
      description: "Cost grouped by agent + provider + model",
      keys: (r: CostByAgentModel) => ({
        agentId: r.agentId,
        agentName: r.agentName ?? null,
        provider: r.provider,
        model: r.model,
        costCents: r.costCents,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
      }),
    },
    {
      name: "provider",
      path: "by-provider",
      description: "Cost grouped by provider + model",
      keys: (r: CostByProviderModel) => ({
        provider: r.provider,
        biller: r.biller,
        model: r.model,
        costCents: r.costCents,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        apiRunCount: r.apiRunCount,
      }),
    },
    {
      name: "biller",
      path: "by-biller",
      description: "Cost grouped by biller",
      keys: (r: CostByBiller) => ({
        biller: r.biller,
        costCents: r.costCents,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        providerCount: r.providerCount,
        modelCount: r.modelCount,
      }),
    },
    {
      name: "project",
      path: "by-project",
      description: "Cost attributed to projects",
      keys: (r: CostByProject) => ({
        projectId: r.projectId ?? null,
        projectName: r.projectName ?? null,
        costCents: r.costCents,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
      }),
    },
  ];

  for (const dim of byDimensions) {
    addCommonClientOptions(
      addRangeOptions(
        by
          .command(dim.name)
          .description(dim.description)
          .requiredOption("-C, --company-id <id>", "Company ID"),
      ).action(async (opts: CostRangeOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows =
            (await ctx.api.get<unknown[]>(
              `/api/companies/${ctx.companyId}/costs/${dim.path}${buildRangeQuery(opts)}`,
            )) ?? [];

          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }
          for (const row of rows) {
            console.log(formatInlineRecord(dim.keys(row)));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
      { includeCompany: false },
    );
  }

  addCommonClientOptions(
    cost
      .command("windows")
      .description("Rolling-window spend per provider")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: CostRangeOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<unknown[]>(
            `/api/companies/${ctx.companyId}/costs/window-spend`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    cost
      .command("quota-windows")
      .description("Provider-side quota window snapshots (board only)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: CostRangeOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<unknown[]>(
            `/api/companies/${ctx.companyId}/costs/quota-windows`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    cost
      .command("report")
      .description("Report a cost event (agents may only report their own)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--agent-id <id>", "Agent ID that incurred the cost")
      .requiredOption("--provider <provider>", "Provider (e.g. anthropic, openai)")
      .requiredOption("--model <model>", "Model identifier")
      .requiredOption("--cost-cents <n>", "Cost in cents (integer)")
      .option("--issue-id <id>", "Issue UUID")
      .option("--project-id <id>", "Project UUID")
      .option("--goal-id <id>", "Goal UUID")
      .option("--heartbeat-run-id <id>", "Heartbeat run UUID")
      .option("--billing-code <code>", "Billing code")
      .option("--biller <biller>", "Biller (defaults to provider)")
      .option("--billing-type <type>", "Billing type (e.g. api, subscription, unknown)")
      .option("--input-tokens <n>", "Input tokens")
      .option("--cached-input-tokens <n>", "Cached input tokens")
      .option("--output-tokens <n>", "Output tokens")
      .option("--occurred-at <iso>", "Event timestamp (ISO 8601, defaults to now)")
      .action(async (opts: CostReportOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });

          const payload: Record<string, unknown> = {
            agentId: opts.agentId,
            provider: opts.provider,
            model: opts.model,
            costCents: parseIntOpt(opts.costCents, "cost-cents")!,
            occurredAt: opts.occurredAt ?? new Date().toISOString(),
          };
          if (opts.issueId !== undefined) payload.issueId = opts.issueId;
          if (opts.projectId !== undefined) payload.projectId = opts.projectId;
          if (opts.goalId !== undefined) payload.goalId = opts.goalId;
          if (opts.heartbeatRunId !== undefined) payload.heartbeatRunId = opts.heartbeatRunId;
          if (opts.billingCode !== undefined) payload.billingCode = opts.billingCode;
          if (opts.biller !== undefined) payload.biller = opts.biller;
          if (opts.billingType !== undefined) payload.billingType = opts.billingType;
          const inputTokens = parseIntOpt(opts.inputTokens, "input-tokens");
          if (inputTokens !== undefined) payload.inputTokens = inputTokens;
          const cached = parseIntOpt(opts.cachedInputTokens, "cached-input-tokens");
          if (cached !== undefined) payload.cachedInputTokens = cached;
          const outputTokens = parseIntOpt(opts.outputTokens, "output-tokens");
          if (outputTokens !== undefined) payload.outputTokens = outputTokens;

          const parsed = createCostEventSchema.parse(payload);
          const row = await ctx.api.post<CostEvent>(
            `/api/companies/${ctx.companyId}/cost-events`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
