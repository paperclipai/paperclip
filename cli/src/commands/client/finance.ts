import { Command } from "commander";
import {
  createFinanceEventSchema,
  type FinanceEvent,
  type FinanceSummary,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface FinanceRangeOptions extends BaseClientOptions {
  companyId?: string;
  from?: string;
  to?: string;
  limit?: string;
}

interface FinanceReportOptions extends BaseClientOptions {
  companyId?: string;
  eventKind: string;
  biller: string;
  amountCents: string;
  occurredAt?: string;
  agentId?: string;
  issueId?: string;
  projectId?: string;
  goalId?: string;
  heartbeatRunId?: string;
  costEventId?: string;
  billingCode?: string;
  description?: string;
  direction?: string;
  provider?: string;
  executionAdapterType?: string;
  pricingTier?: string;
  region?: string;
  model?: string;
  quantity?: string;
  unit?: string;
  currency?: string;
  estimated?: boolean;
  externalInvoiceId?: string;
  metadata?: string;
}

function buildRangeQuery(opts: { from?: string; to?: string; limit?: string }): string {
  const params = new URLSearchParams();
  if (opts.from) params.set("from", opts.from);
  if (opts.to) params.set("to", opts.to);
  if (opts.limit) params.set("limit", opts.limit);
  const s = params.toString();
  return s ? `?${s}` : "";
}

function parseIntOpt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return n;
}

export function registerFinanceCommands(program: Command): void {
  const finance = program.command("finance").description("Finance event tracking and breakdowns");

  addCommonClientOptions(
    finance
      .command("list")
      .description("List finance events for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--from <iso>", "Start of date range (ISO 8601)")
      .option("--to <iso>", "End of date range (ISO 8601)")
      .option("--limit <n>", "Max results (1-500, default 100)")
      .action(async (opts: FinanceRangeOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<FinanceEvent[]>(
            `/api/companies/${ctx.companyId}/costs/finance-events${buildRangeQuery(opts)}`,
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
            console.log(
              formatInlineRecord({
                id: row.id,
                eventKind: row.eventKind,
                biller: row.biller,
                amountCents: row.amountCents,
                currency: row.currency,
                direction: row.direction,
                estimated: row.estimated,
                occurredAt: row.occurredAt instanceof Date
                  ? row.occurredAt.toISOString()
                  : (row.occurredAt as unknown as string),
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    finance
      .command("summary")
      .description("Aggregated finance event spend")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--from <iso>", "Start of date range (ISO 8601)")
      .option("--to <iso>", "End of date range (ISO 8601)")
      .action(async (opts: FinanceRangeOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.get<FinanceSummary>(
            `/api/companies/${ctx.companyId}/costs/finance-summary${buildRangeQuery(opts)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  for (const dim of [
    { name: "by-biller", path: "finance-by-biller", description: "Finance spend grouped by biller" },
    { name: "by-kind", path: "finance-by-kind", description: "Finance spend grouped by event kind" },
  ]) {
    addCommonClientOptions(
      finance
        .command(dim.name)
        .description(dim.description)
        .requiredOption("-C, --company-id <id>", "Company ID")
        .option("--from <iso>", "Start of date range (ISO 8601)")
        .option("--to <iso>", "End of date range (ISO 8601)")
        .action(async (opts: FinanceRangeOptions) => {
          try {
            const ctx = resolveCommandContext(opts, { requireCompany: true });
            const rows = (await ctx.api.get<unknown[]>(
              `/api/companies/${ctx.companyId}/costs/${dim.path}${buildRangeQuery(opts)}`,
            )) ?? [];
            printOutput(rows, { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
        }),
      { includeCompany: false },
    );
  }

  addCommonClientOptions(
    finance
      .command("report")
      .description("Report a finance event (board only)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--event-kind <kind>", "Finance event kind")
      .requiredOption("--biller <biller>", "Biller")
      .requiredOption("--amount-cents <n>", "Amount in cents (integer)")
      .option("--occurred-at <iso>", "Event timestamp (ISO 8601, defaults to now)")
      .option("--agent-id <id>", "Agent UUID")
      .option("--issue-id <id>", "Issue UUID")
      .option("--project-id <id>", "Project UUID")
      .option("--goal-id <id>", "Goal UUID")
      .option("--heartbeat-run-id <id>", "Heartbeat run UUID")
      .option("--cost-event-id <id>", "Linked cost event UUID")
      .option("--billing-code <code>", "Billing code")
      .option("--description <text>", "Description (max 500 chars)")
      .option("--direction <direction>", "Direction (debit, credit)")
      .option("--provider <provider>", "Provider")
      .option("--execution-adapter-type <type>", "Execution adapter type")
      .option("--pricing-tier <tier>", "Pricing tier")
      .option("--region <region>", "Region")
      .option("--model <model>", "Model identifier")
      .option("--quantity <n>", "Quantity (non-negative integer)")
      .option("--unit <unit>", "Unit")
      .option("--currency <code>", "ISO currency code (default USD)")
      .option("--estimated", "Mark event as estimated")
      .option("--external-invoice-id <id>", "External invoice ID")
      .option("--metadata <json>", "Metadata as JSON object")
      .action(async (opts: FinanceReportOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });

          let metadata: Record<string, unknown> | undefined;
          if (opts.metadata !== undefined) {
            try {
              const parsed = JSON.parse(opts.metadata);
              if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("must be a JSON object");
              }
              metadata = parsed as Record<string, unknown>;
            } catch (err) {
              throw new Error(`--metadata must be valid JSON object: ${(err as Error).message}`);
            }
          }

          const payload: Record<string, unknown> = {
            eventKind: opts.eventKind,
            biller: opts.biller,
            amountCents: parseIntOpt(opts.amountCents, "amount-cents")!,
            occurredAt: opts.occurredAt ?? new Date().toISOString(),
          };
          if (opts.agentId !== undefined) payload.agentId = opts.agentId;
          if (opts.issueId !== undefined) payload.issueId = opts.issueId;
          if (opts.projectId !== undefined) payload.projectId = opts.projectId;
          if (opts.goalId !== undefined) payload.goalId = opts.goalId;
          if (opts.heartbeatRunId !== undefined) payload.heartbeatRunId = opts.heartbeatRunId;
          if (opts.costEventId !== undefined) payload.costEventId = opts.costEventId;
          if (opts.billingCode !== undefined) payload.billingCode = opts.billingCode;
          if (opts.description !== undefined) payload.description = opts.description;
          if (opts.direction !== undefined) payload.direction = opts.direction;
          if (opts.provider !== undefined) payload.provider = opts.provider;
          if (opts.executionAdapterType !== undefined)
            payload.executionAdapterType = opts.executionAdapterType;
          if (opts.pricingTier !== undefined) payload.pricingTier = opts.pricingTier;
          if (opts.region !== undefined) payload.region = opts.region;
          if (opts.model !== undefined) payload.model = opts.model;
          const quantity = parseIntOpt(opts.quantity, "quantity");
          if (quantity !== undefined) payload.quantity = quantity;
          if (opts.unit !== undefined) payload.unit = opts.unit;
          if (opts.currency !== undefined) payload.currency = opts.currency;
          if (opts.estimated) payload.estimated = true;
          if (opts.externalInvoiceId !== undefined) payload.externalInvoiceId = opts.externalInvoiceId;
          if (metadata !== undefined) payload.metadataJson = metadata;

          const parsed = createFinanceEventSchema.parse(payload);
          const row = await ctx.api.post<FinanceEvent>(
            `/api/companies/${ctx.companyId}/finance-events`,
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
